// Autopilot：AI 无脑一键托管模式（V1）
//
// 设计原则（安全优先，绝不越界）：
//   1. 所有硬约束在代码里卡死；AI 只在"允许范围内"选择。AI 出的任何越界值一律被
//      钳制（clamp）到安全区间，不是拒绝就是纠正后使用——AI 永远不能自伤。
//   2. 三层护栏必须全部通过，否则该所暂停：
//        a. 日累计亏损 <= 阈值（默认 -2%）
//        b. 连续亏损笔数 < 阈值（默认 2）
//        c. 保证金/未实现亏损未击穿最低值
//   3. 每次决策记流水（决策日志），关键动作推 Telegram/Webhook。
//   4. Bot 已在跑同一市场时，只做参数微调（V1 保守：不换币，除非明确失效）。
//
// V1 决策流程（每 decisionIntervalMin 分钟触发一次；每个交易所独立）：
//   1. 若被熔断（pausedUntil 未到）→ skip
//   2. 检查护栏；触发 → 停网格 + 平仓 + 熔断 + notify
//   3. 若 bot 已运行 → 拉最新趋势，判断是否需要 adjust 或 stop
//   4. 若 bot 未运行 → 走 "选币 + 出参数 + start" 完整流程
//        a. 拉该所全部市场 + 每个最近 K 线做 ATR/趋势 → 候选打分
//        b. 让 AI 从 TOP-N 候选里挑 1 个，出 mode/range%/gridCount/reasoning
//        c. 代码钳制所有参数到 riskStyle 定义的安全区间
//        d. bot.start(params) 调用 → 成功则记录，失败则记 alert
// Round 202: 删掉 AI selector 后 aiChat/extractJson/getAiConfig 都不再用
import { notify } from './provider.js';
import { analyzeTrend } from '../trend.js';
import { loadSnapshot, saveSnapshot } from '../persist.js';

const EXNAMES = { de: 'Decibel', ex: 'Extended', rs: 'RISEx', on: 'Ondo', pl: 'Perpl', sx: 'StandX', bg: 'Bitget', bu: 'Bitunix', ph: 'Phoenix', nd: 'Nado', lt: 'Lighter' };
const KEYS = ['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', 'bu', 'ph', 'nd', 'lt'];

// 风格参数：越保守区间越宽（成交少但安全）、格距/单量越小、日亏熔断越紧。
const STYLES = {
  conservative: {
    rangePct: 0.05,        // 现价上下 5% 为网格边界（total 10% 幅宽）
    gridCount: 20,
    sizeFractionOfBalance: 0.02,  // 每格用 2% 余额（20 格 x 2% = 40% 满仓上限）
    maxLeverage: 3,
    dailyLossPctLimit: 2,
    consecutiveLossLimit: 2,
    outOfRangeAction: 'close',
  },
  balanced: {
    rangePct: 0.04,
    gridCount: 20,
    sizeFractionOfBalance: 0.03,
    maxLeverage: 5,
    dailyLossPctLimit: 3,
    consecutiveLossLimit: 3,
    outOfRangeAction: 'recover',
  },
  aggressive: {
    // Round 201: 全 copy @zaijin338191 (16 天 +50% return) 策略。
    // 核心：BTC 挂着不换币 + 80 格密网格 + 30x + 主动 re-center 保仓。
    // Round 281: 更彻底靠拢 @zaijin338191 "绝不手动平仓" 原则 · dailyLossPct 15→25 ·
    //   consecutiveLoss 4→10 · 让 grid 有真的 drawdown 空间等回调 · 配合下面
    //   _emergencyStop 改 closePosition:false 死扛不平仓。
    rangePct: 0.05,
    gridCount: 80,
    sizeFractionOfBalance: 0.20,
    maxLeverage: 30,
    dailyLossPctLimit: 25,
    consecutiveLossLimit: 10,
    outOfRangeAction: 'recover',
  },
};

// 默认配置：主开关 off，五所全部 enabled=false。用户在 UI 里勾选启用。
const DEFAULT_CFG = () => ({
  masterEnabled: false,
  riskStyle: 'conservative',
  decisionIntervalMin: 30,  // Round 202: 8→30。挂 BTC 不换币策略下不需要密集决策；
                            // 主动动作只剩 re-center/narrow/emergency，30 min 已足够。
  perExchange: Object.fromEntries(KEYS.map((k) => [k, {
    enabled: false,
    maxCapitalUsdc: 1000,
    // Round 177：farm mode。true 时跳过 grid，改成周期性 buy-sell 循环生成
    // volume（delta 中性化：每 cycle net 位 0）。airdrop 农场用。
    farmMode: false,
    farmNotional: 100,    // 每 cycle 每边 $ 名义值（15x lev → 每 fill $100 volume）
    farmCycleSec: 90,     // 一 cycle 时长（buy → wait → sell）
    // Round 194：farm 4 层自动化
    farmModeStrategy: 'auto',   // 'auto' | 'aggressive' | 'moderate' | 'maker' | 'disabled'
    maxFarmLossDaily: 50,       // 单家单日亏 > $50 → 自动 disable farm
    maxFarmLossHourly: 5,       // pnl/h < -$5 连续 20 cycles → 换 strategy
  }])),
});

export function createAutopilot(deps) { return new Autopilot(deps); }

class Autopilot {
  constructor({ bots, exchanges }) {
    this.bots = bots;
    this.exchanges = exchanges;
    const saved = loadSnapshot('autopilot') || {};
    this.cfg = { ...DEFAULT_CFG(), ...(saved.cfg || {}) };
    // Ensure perExchange has an entry for every key (in case config was saved before a new ex was added)
    for (const k of KEYS) this.cfg.perExchange[k] ||= { enabled: false, maxCapitalUsdc: 1000 };
    this.state = saved.state || {};        // per-exchange runtime state
    for (const k of KEYS) this.state[k] = { ..._freshExState(), ...(this.state[k] || {}) };
    // Round 6 迁移：Round 5 之前的存档没有 dayStartMode / dayStartDataSource 字段。
    // 那些 baseline 可能是 paper 模式下打的（dayStartEquity=10000），切 LIVE 之后
    // 真实余额=200 → 触发 100%/98% 假熔断。清掉旧 baseline + 挂着的 paused，让下一
    // tick 用新逻辑重新落基线。
    let migrated = 0;
    for (const k of KEYS) {
      const st = this.state[k];
      if (st.dayStartEquity > 0 && !st.dayStartMode) {
        st.dayStartEquity = 0;
        st.dayStartDate = '';
        st.pausedUntil = 0;
        st.pausedReason = '';
        st.consecutiveLosses = 0;
        migrated++;
      }
    }
    if (migrated) {
      console.log(`[Autopilot] Round 6 迁移：清 ${migrated} 家陈旧基线（paper→live 假熔断的根因）`);
    }
    this.decisions = saved.decisions || [];    // rolling log (~50)
    this._lastTickAt = 0;
    this._busy = false;
  }

  /**
   * 迁移补丁：Round 1 加了 startedByAutopilot 字段，旧存档没这字段（默认 false）。
   * 如果 resume 之后某所 bot 已经在跑、且这一所在 Autopilot 里托管着，就认领它——
   * 避免「用户手动启动」误判触发假熔断链。
   *
   * 必须在 server.js 里 resumeIfWasRunning 完成 **之后** 调用（否则 bot.running 还是
   * false）。改到构造函数里做认领是错的（bots 那时都还没 resume）。
   */
  adoptRunningBots() {
    let adopted = 0;
    for (const k of KEYS) {
      const bot = this.bots[k];
      const running = !!(bot?.getState?.()?.running);
      if (running && this.cfg.perExchange[k]?.enabled && !this.state[k].startedByAutopilot) {
        this.state[k].startedByAutopilot = true;
        this.state[k].adoptedOnBoot = true;   // 打个标记方便日后排查
        // Round 146 Bug 4：认领时给 startedAt 打时间戳，否则 Round 121 stop-idle
        // 判断用的 `lastActivity = fills[0]?.t || startedAt || 0` 永远为 0（认领的
        // bot 若 boot 后一直没成交，认领态就永远不会 rotate）。
        if (!this.state[k].startedAt) this.state[k].startedAt = Date.now();
        adopted++;
      }
    }
    if (adopted) {
      this._log('all', 'resume', `启动认领 ${adopted} 家已在跑的托管网格（迁移旧存档）`);
      this._save();
    }
  }

  start() {
    // 1 分钟节拍器；实际决策频率由 decisionIntervalMin 控制。
    this._timer = setInterval(() => this._tick().catch(() => {}), 60_000);
    this._timer.unref?.();
    // Round 178：farm 用独立 timer + 独立 busy flag，不受 grid busy 影响。
    // grid _tick 里的 AI 调用可能 hang（无超时），会锁住 _busy → farm 也停。
    // farm 频率 60s，跟 grid tick 分开。
    this._farmTimer = setInterval(() => this._farmTick().catch(() => {}), 60_000);
    this._farmTimer.unref?.();
    // 启动时立即跑一次日基线更新（如果需要）
    this._maybeRebaseline();
  }

  /** Round 178: 独立 farm tick，不共享 _busy */
  async _farmTick() {
    if (this._farmBusy) return;
    this._farmBusy = true;
    try {
      if (!this.cfg.masterEnabled) return;
      const farmKeys = KEYS.filter((k) => this.cfg.perExchange[k].enabled && this.cfg.perExchange[k].farmMode);
      for (const k of farmKeys) {
        try { await this._farmDecideForExchange(k); }
        catch (e) { this._log(k, 'error', `farm 决策异常：${e?.message || e}`); }
      }
    } finally { this._farmBusy = false; }
  }

  status() {
    return {
      cfg: this.cfg,
      state: this.state,
      decisions: this.decisions.slice(0, 30),
      nextTickIn: Math.max(0, this.cfg.decisionIntervalMin * 60_000 - (Date.now() - this._lastTickAt)),
    };
  }

  updateConfig(patch) {
    // 白名单式合并，防止用户从前端塞奇怪字段
    const c = this.cfg;
    const wasEnabled = c.masterEnabled;
    if (typeof patch.masterEnabled === 'boolean') c.masterEnabled = patch.masterEnabled;
    if (['conservative', 'balanced', 'aggressive'].includes(patch.riskStyle)) c.riskStyle = patch.riskStyle;
    if (Number.isFinite(patch.decisionIntervalMin)) c.decisionIntervalMin = Math.max(5, Math.min(120, Number(patch.decisionIntervalMin)));
    if (patch.perExchange && typeof patch.perExchange === 'object') {
      for (const k of KEYS) {
        const p = patch.perExchange[k];
        if (!p) continue;
        if (typeof p.enabled === 'boolean') c.perExchange[k].enabled = p.enabled;
        if (Number.isFinite(p.maxCapitalUsdc)) c.perExchange[k].maxCapitalUsdc = Math.max(0, Number(p.maxCapitalUsdc));
        // Round 177 farm mode fields
        if (typeof p.farmMode === 'boolean') c.perExchange[k].farmMode = p.farmMode;
        if (Number.isFinite(p.farmNotional)) c.perExchange[k].farmNotional = Math.max(10, Math.min(1000, Number(p.farmNotional)));
        if (p.farmMarketId != null) c.perExchange[k].farmMarketId = p.farmMarketId;
        if (Number.isFinite(p.farmCycleSec)) c.perExchange[k].farmCycleSec = Math.max(30, Math.min(600, Number(p.farmCycleSec)));
        // Round 194: farm auto-strategy fields
        if (typeof p.farmModeStrategy === 'string' && ['auto','aggressive','moderate','maker','disabled'].includes(p.farmModeStrategy)) {
          c.perExchange[k].farmModeStrategy = p.farmModeStrategy;
        }
        if (Number.isFinite(p.maxFarmLossDaily)) c.perExchange[k].maxFarmLossDaily = Math.max(1, Math.min(10000, Number(p.maxFarmLossDaily)));
        if (Number.isFinite(p.maxFarmLossHourly)) c.perExchange[k].maxFarmLossHourly = Math.max(0.1, Math.min(1000, Number(p.maxFarmLossHourly)));
      }
    }
    // 主开关从 off 切 on：清所有 pausedUntil + 日基线，相当于"用户已复核并重新开始"。
    // 只清 pausedUntil 不清 dayStartEquity 会立刻被日亏损护栏再次熔断——因为已实现
    // 的亏损存在 balance 里但 baseline 还是老值。
    if (!wasEnabled && c.masterEnabled) {
      let cleared = 0;
      for (const k of KEYS) {
        if (this.state[k].pausedUntil) {
          _clearBreakerAndBaseline(this.state[k]);
          cleared++;
        }
      }
      if (cleared) this._log('all', 'resume', `主开关重启：清除 ${cleared} 家历史熔断状态 + 日基线`);
    }
    this._save();
    return this.status();
  }

  /** 手动清除某所的熔断状态（用户在 UI 上"我已复核，继续跑"） */
  resumeExchange(key) {
    if (!this.state[key]) return { error: 'unknown exchange: ' + key };
    _clearBreakerAndBaseline(this.state[key]);
    this._log(key, 'resume', `已解除熔断 + 重置日基线`);
    this._save();
    return this.status();
  }

  /** 一键清除所有熔断状态。UI 兜底按钮。 */
  resumeAll() {
    let cleared = 0;
    for (const k of KEYS) {
      if (this.state[k].pausedUntil) {
        _clearBreakerAndBaseline(this.state[k]);
        cleared++;
      }
    }
    if (cleared) this._log('all', 'resume', `一键清除 ${cleared} 家熔断状态 + 日基线`);
    this._save();
    return this.status();
  }

  async _tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      this._maybeRebaseline();
      if (!this.cfg.masterEnabled) return;
      const now = Date.now();
      // Round 178：farm 已移到独立 _farmTick，这里只处理 grid。
      if (now - this._lastTickAt < this.cfg.decisionIntervalMin * 60_000) return;
      this._lastTickAt = now;
      // Round 155 C：跨 DEX 币种去重计数器（每 tick 归零）
      // 每家挑选时看这个 map（baseSymbol → 已被几家选中），做软性避让 + 3 家硬上限。
      this._tickPickedSymbols = new Map();
      // 已在跑的家先记进 map —— 别的家挑币时得看到这些"占位"
      {
        const baseOf = (name) => String(name || '').replace(/[-_/]?(usdc|usdt|usd|perp)$/i, '').replace(/[-_/]?\.p$/i, '').toUpperCase();
        for (const k of KEYS) {
          const bot = this.bots[k];
          const state = bot?.getState?.();
          if (state?.running && state.config?.displayName) {
            const pb = baseOf(state.config.displayName);
            if (pb) this._tickPickedSymbols.set(pb, (this._tickPickedSymbols.get(pb) || 0) + 1);
          }
        }
      }
      for (const k of KEYS) {
        if (!this.cfg.perExchange[k].enabled) continue;
        if (this.cfg.perExchange[k].farmMode) continue;   // farm 已在上面跑了
        try { await this._decideForExchange(k); }
        catch (e) { this._log(k, 'error', `决策异常：${e?.message || e}`); }
      }
    } finally { this._busy = false; }
  }

  /** 每日 00:00 之后首次 tick：重置日基线（用于日亏计算）*/
  _maybeRebaseline() {
    const today = new Date().toISOString().slice(0, 10);
    for (const k of KEYS) {
      const st = this.state[k];
      const bot = this.bots[k];
      const ex = this.exchanges[k];
      const s = bot?.getState();
      const eq = s?.equity;
      const healthy = ex?.dataSource === 'real' && (!ex.lastOkAt || Date.now() - ex.lastOkAt < 120_000);
      // 环境变了（paper↔live 或 real↔synthetic）→ 旧 baseline 作废、强制 rebaseline。
      // ⚠ 只在 NEW dataSource 是"稳定态"（real/synthetic）时才判断——'connecting'/undefined
      // 是重启时的过渡态，误当环境变会每次 redeploy 都清一次基线（Round 7 抓到的坑）。
      const stableCur = ex?.dataSource === 'real' || ex?.dataSource === 'synthetic';
      const envChanged = st.dayStartEquity > 0 && stableCur
        && (st.dayStartMode !== ex?.mode || st.dayStartDataSource !== ex?.dataSource);
      if (envChanged) {
        st.dayStartEquity = 0;
        st.dayStartDate = '';
        this._log(k, 'skip', `环境切换（${st.dayStartMode || '?'}/${st.dayStartDataSource || '?'} → ${ex?.mode}/${ex?.dataSource}），旧 baseline 作废，重新校准`);
      }
      if (st.dayStartDate === today) continue;
      // 只在读到合法权益时才落基线；LIVE 适配器连接中 / balance 还没同步过来时
      // eq 可能是 0 或 null——这时先不设日期，下一 tick 再试，避免"0 基线永远
      // 触发 100% 亏损"的陷阱。
      if (!healthy || !Number.isFinite(eq) || eq <= 0) continue;
      st.dayStartEquity = eq;
      st.dayStartDate = today;
      st.dayStartMode = ex.mode;
      st.dayStartDataSource = ex.dataSource;
      st.consecutiveLosses = 0;
    }
    this._save();
  }

  async _decideForExchange(key) {
    const bot = this.bots[key];
    const ex = this.exchanges[key];
    const st = this.state[key];
    let s = STYLES[this.cfg.riskStyle] || STYLES.conservative;
    // Round 163→165：SX hybrid style。
    //   Round 163 让 SX 走 conservative（低 lev + 大 spacing 压手续费），
    //   但副作用是 dailyLossPctLimit=2% 太严 —— SX 高 fee 慢烧，一次
    //   rotate 换币的滑点就够亏 2%（$262 × 2% = $5）→ 熔断 → 24h 内 3
    //   次 → auto-disable（Round 158）→ 用户手动 resume → 又熔断 → 死循环。
    //   Round 165：SX 走 hybrid —— 保留 conservative 的低 lev + 大 spacing
    //   （防爆仓），但放宽 dailyLossPctLimit 5% + consecutiveLossLimit 4，
    //   给 SX 一天亏损缓冲空间，避免慢烧触发。
    if (key === 'sx' && this.cfg.riskStyle === 'aggressive') {
      s = {
        ...STYLES.conservative,
        gridCount: 30,              // Round 170：conservative 20 → 30，SX 也
                                     // 跟着冲 volume。SX 高 fee 但 conservative
                                     // 3x lev + 小 sizeBase，30 格总 notional 仍
                                     // <30% capital。fill 密度 +50% 拉 volume。
        // Round 275au：SX 策略无效熔断（gridProfit $190 vs realized -$18 = $209 差）
        // 根因 —— sizeFraction 0.02 太小 → 0.0001 BTC/单 × $63500 = $6.35 notional/rung
        // × StandX taker 0.05% × 2 = $0.0064 fee，per-rung 理论利润 spacing $211 × 0.0001
        // = $0.021 · 净 $0.015 · 太脆 · 单边行情就翻脸。放大 sizeFraction 到 0.04
        // (2x)，每 rung notional $12.7 · fee 相对比例减半 · 抗单边能力翻倍。同时
        // rangePct 0.05 → 0.03 收窄区间 · spacing $211 → $127 · fill 密度 +67% ·
        // 让 grid 更贴近现价吃震荡。总 notional 30 × 0.04 × 3x = 360% capital · 大约
        // 12 单同时 fill 才占 40% margin · 可控。
        sizeFractionOfBalance: 0.04,
        rangePct: 0.03,
        dailyLossPctLimit: 8,       // Round 169：5% → 8%（SX 仍熔断中，5% 也
                                     // 打不过高 fee + 慢烧）。8% 是 conservative 2%
                                     // 与 aggressive 12% 中间挡，让 SX 少熔断多跑
                                     // 提 volume，最坏亏 8% 才停。
        consecutiveLossLimit: 5,    // 4 → 5（同理）
      };
    }
    // Round 275k：Nado 有硬 min notional ($100) + margin-health check。
    //   Round 275j adapter 已经 bump 每格到 $105 min notional，但当 gridCount
    //   高时 total order margin (gridCount × $105 / lev) 会撞 Nado 的 initial
    //   margin health threshold → 引擎全拒 2006: Insufficient account health。
    //   实测 $250 equity + 40 格 × $105 × 20x → 全 40 单 rejected 0/40 挂上。
    //   降 Nado gridCount 到 20，同时 leverage 从 30x/aggressive 也降到 10x
    //   给 Nado 更保守配置（Nado initial-margin-weight 严于其他所）。
    if (key === 'nd') {
      s = {
        ...s,
        // Round 275n：20→12。实测 ZHIPU-PERP 20 格 × $105 min notional = $2100
        // notional × 1/10 lev = $210 margin，但 Nado initial-margin-weight ~0.6-0.7
        // 打折让 $303 balance 只撑得起 ~$180 effective margin → 只挂上 2/20 单，
        // 剩 18 单全拒 2006 → 哨兵刷屏「补单频繁失败」。
        // 12 格 × $105 × 10x = $126 margin < $180 effective，全 12 格能挂上。
        gridCount: Math.min(s.gridCount, 12),
        maxLeverage: Math.min(s.maxLeverage, 10),
      };
    }
    // Round 280：Lighter (RH Chain) 有较严 rate limit —— aggressive 默认 80 格
    // 密集下单会 429 (Too Many Requests)，实测 79 单只挂上 1/79。降到 20 格 +
    // 每单间隔 200ms（adapter 层实现）够 grid 用 · 后续观察再调。
    if (key === 'lt') {
      s = {
        ...s,
        gridCount: Math.min(s.gridCount, 20),
      };
    }
    const now = Date.now();
    // Round 50: 每次 tick 都刷新 lastDecisionAt，让 UI"决策时间"反映最近一次评估
    // 而不是最近一次 start（之前只在 start 分支更新，skip / stop / err 都不更→
    // Extended 已经 skip 28h 没 start，UI 一直显示 7/17 起单时间）。
    st.lastDecisionAt = now;

    // Round 107：清 stale startedByAutopilot —— bot 因平仓失败/超时/外部 stop
    // 停了，但 flag 卡在 true → Autopilot 每 tick 报"网格运行中，保持"，永远
    // 不重开。用户在 QC 里看到 Perpl "决策日志说运行中但 bot state running=false"
    // 就是这个 bug。startedByAutopilot 描述我方期望，bot.running 是链上真相，
    // 不一致时相信真相。
    if (st.startedByAutopilot && bot && bot.running === false) {
      st.startedByAutopilot = false;
      this._log(key, 'reset', `bot 实际停了但 startedByAutopilot 卡 true，重置 flag 让本 tick 重新评估起单`);
    }

    // Round 275w：低余额 auto-disable 优先判定（提前到所有 skip 分支之前）。
    // Round 275u 原本放在 Round 248 后面，但被 Round 275o (Nado 30min cooldown)
    // 之类的 early return 挡住 → tick 计数从来不动 → auto-disable 永远不触发。
    // QC 实证：Nado 已 3+ tick 余额=0 但 _lowBalTickCount=null。
    // 提到函数开头，任何 tick 都能累计；tick 满且 enabled → 直接 disable + return。
    //
    // Round 275aa：adapter API 挂了（rate_limited/429/timeout/backoff）时 balance
    // 拉不到会显示 0，但账户实际有钱。不能 count 这种 tick 计数否则误关有钱账户
    // （QC 实证：Phoenix rate_limited 20 min，balance $336→$0，_lowBalTickCount 已 1，
    // 再 2 tick 就会被误 auto-disable）。区分「确认 $0」vs「拉不到」：
    // ex.lastError 含 transient 关键字 → 跳过本 tick 的 low-bal 计数（不 count 不 clear）。
    {
      const curForBal = bot.getState();
      const errStr = ex?.lastError ? String(ex.lastError) : '';
      const transientErr = /rate_limited|429|timeout|backoff|ETIMEDOUT|ECONNRESET/i.test(errStr);
      const lowBal = !curForBal.running
        && Number(curForBal.balance || 0) < 5
        && Number(curForBal.equity || 0) < 5;
      if (lowBal && !transientErr) {
        st._lowBalTickCount = (st._lowBalTickCount || 0) + 1;
        if (st._lowBalTickCount >= 3 && this.cfg.perExchange[key]?.enabled) {
          this.cfg.perExchange[key].enabled = false;
          this._log(key, 'auto-disable', `连续 ${st._lowBalTickCount} tick 余额≈0，自动取消托管（跟 BG/BU/SX 手动 disable 一致策略）。充值后回 Autopilot 页勾选恢复。`);
          try { this._notify?.(`⚠️ ${key.toUpperCase()} 余额=$${(curForBal.balance || 0).toFixed(2)}，autopilot 已自动取消托管`); } catch {}
          return;
        }
      } else if (!lowBal && st._lowBalTickCount) {
        // 余额恢复 → 清计数（transient 时保持现有计数不动）
        st._lowBalTickCount = 0;
      }
    }

    // 1. 熔断中？
    if (st.pausedUntil && now < st.pausedUntil) {
      this._log(key, 'skip', `熔断中（${st.pausedReason}），剩 ${Math.round((st.pausedUntil - now) / 60_000)} 分钟`);
      return;
    }

    // 2. 交易所健康门槛：适配器还在 connecting、走合成行情、或数据陈旧（>2min）→ 一律
    //    跳过本轮，不做任何护栏判断。假熔断的根因就是 balance sync 窗口 balance=0 触发
    //    "日亏损 100%"，健康门槛把这窗口挡在外面。
    const stale = ex?.lastOkAt ? (now - ex.lastOkAt > 120_000) : false;
    if (ex?.dataSource === 'connecting') {
      this._log(key, 'skip', '交易所连接中，等就绪再决策');
      return;
    }
    if (ex?.dataSource === 'synthetic') {
      this._log(key, 'skip', '走合成行情（未连真实交易所），Autopilot 不接管');
      return;
    }
    // Round 242: real-readonly = auth 挂了/backoff 中，只能读不能写。若还起单
    // 会走 80 次 place-order 全被 backoff 拒 → 挂上 0/80 → 熔断循环。
    // Round 260: Phoenix 例外 —— Round 256 起 place-limit-order 已经会先跳
    // Bearer（真授权在 Solana 签名），auth 挂了未必影响下单。放行 ph，让
    // no-Bearer 路径试；成功了照常算 start，失败了 place 层内部 skip（Round 250
    // return {skipped:true}）不会打爆 rate limit。其他所无 no-Bearer 兜底，保 skip。
    if (ex?.dataSource === 'real-readonly') {
      if (key !== 'ph') {
        this._log(key, 'skip', `${key} auth 挂了（real-readonly），等 auth 恢复再起单 · ${ex.lastError || ''}`.slice(0, 200));
        return;
      }
      this._log(key, 'proceed-noauth', `Phoenix real-readonly，试 no-Bearer 路径起单（真授权靠 Solana 签名）· ${ex.lastError || ''}`.slice(0, 200));
    }
    if (stale) {
      this._log(key, 'skip', `交易所数据 ${Math.round((now - ex.lastOkAt) / 1000)}s 未更新，跳过本轮`);
      return;
    }

    // Round 254: Phoenix chain 有孤儿仓位/挂单时，autopilot 不接管。
    // 用户报告 QnV 显示 Phoenix BNB · 0/32 挂上，但 Phoenix 网页有 BTC 短仓
    // + 41 BTC 老单 = QnV 跟 chain 完全脱节。因为 auth 挂 (Round 249 cancelAll
    // rethrow) → rotate abort → bot 卡在错误 market；autopilot 又选新 market
    // 起单但 chain 老残留一直不清。改：只要 Phoenix chain 有任何 position/order
    // 而 bot 又不是在跑那些的，autopilot 静默 skip，等用户手动去 phoenix.trade
    // 撤干净或平仓再接管。
    // Round 275x：Phoenix API IP 级 rate limit 导致 _refreshBalance 拉不到 trader
    // state → positions Map 空 → Round 275v anyPos=0 放行起单 → start-failed 刷屏。
    // 解决：ex.lastError 含 rate_limited 或 trader-state 拉取失败关键字 → skip 本轮。
    // 拿不到 chain 真实位置就不敢盲开，等 5min 后 balance refresh 再试。
    if (key === 'ph' && ex?.lastError) {
      const errStr = String(ex.lastError);
      // Round 275al + 275ao：只把「交易关键」rate_limit（trader-state / balance / auth）算成 skip 理由。
      // getStats/pollFills 都是 volume 统计接口（trades-history endpoint），rate_limit
      // 不影响下单/仓位；之前只白名单 getStats 前缀，pollFills 前缀被误判成关键错误
      // → autopilot 死循环 skip 3h+ 不敢起 grid（QC 现场实证：lastError='pollFills: ...→rate_limited'
      // + reconnect OK + balance/positions API 正常，但 autopilot 一直 skip）。
      const isNonCriticalVolPoll = /^(getStats|pollFills):/.test(errStr);
      const isRateLimit = !isNonCriticalVolPoll && /rate_limited|429|trader state|trader-state/i.test(errStr);
      if (isRateLimit) {
        // Round 275ak：Round 275ad 1h 阈值太激进——farm 期烧 IP 后 Phoenix 每所 30min
        // window 里 rate_limit 反复 tick，autopilot 累计 1h 就误关。用户明确要 Phoenix
        // 「像其他所一样跑」，不要动不动 auto-disable。改：阈值 1h → 6h（真正 IP 死才关），
        // 且遇到成功 tick（无 lastError 或非 rate_limit 错误）就归零，不再持续累积。
        if (!st._phRateLimitStartedAt) st._phRateLimitStartedAt = now;
        const stuckMs = now - st._phRateLimitStartedAt;
        if (stuckMs >= 6 * 60 * 60_000 && this.cfg.perExchange[key]?.enabled) {
          this.cfg.perExchange[key].enabled = false;
          this._log(key, 'auto-disable', `Phoenix rate_limit 持续 ${Math.round(stuckMs/60_000)} 分钟未释放，自动取消托管（建议 Railway restart 换 IP，恢复后再勾选）。`);
          try { this._notify?.(`⚠️ Phoenix API rate_limit 挂了 ${Math.round(stuckMs/60_000)} 分钟，autopilot 已自动取消托管`); } catch {}
          st._phRateLimitStartedAt = 0;
          return;
        }
        const lastLogAt = st._lastPhRateLimitLogAt || 0;
        if (now - lastLogAt > 30 * 60_000) {
          st._lastPhRateLimitLogAt = now;
          this._log(key, 'skip', `Phoenix trader-state 拉不到（rate limited / IP 挂，已持续 ${Math.round(stuckMs/60_000)} 分钟，6h 后自动 disable），autopilot 暂不接管 · ${errStr.slice(0, 100)}`);
        }
        return;
      }
      // 非 rate-limit 错误 → 清 rate-limit 计时器（Phoenix API 已恢复）
      if (st._phRateLimitStartedAt) st._phRateLimitStartedAt = 0;
    } else if (key === 'ph' && st._phRateLimitStartedAt) {
      // ex 无 lastError → Phoenix 也恢复了 → 清计时器
      st._phRateLimitStartedAt = 0;
    }

    if (key === 'ph' && ex && typeof ex.positions?.forEach === 'function') {
      // Round 275v：Phoenix 检测到 ANY 位置（不管什么 marketId、不管是谁开的）→ skip。
      // 用户明确表达："Phoenix 检测到任何位置（不管什么 marketId）就 skip"。
      // 理由：
      //   1. cross-margin 池 → autopilot 新 grid 分保证金跟用户手动仓争 → 一方吃紧另
      //      一方要爆
      //   2. QC 场景实证：用户 short BTC + 挂 9 保护单，Round 254 的 curMktId==mid 兜底
      //      + Round 275s symbol 兜底 都放行 → autopilot 起了 grid → cancelAll blanket
      //      清了 9 保护单 → 单裸持。彻底切断这条路。
      //   3. 平仓后 positions Map 空 → 自动恢复决策。
      let anyPos = 0;
      const posMarkets = [];
      ex.positions.forEach((p, mid) => {
        if (!p || !Number.isFinite(p.sizeBase) || p.sizeBase === 0) return;
        anyPos++;
        const m = ex.markets?.get?.(Number(mid));
        posMarkets.push(`${m?.displayName || `mid=${mid}`}:${p.sizeBase.toFixed(3)}`);
      });
      if (anyPos > 0) {
        const lastLogAt = st._lastPhAnyPosLogAt || 0;
        if (now - lastLogAt > 30 * 60_000) {
          st._lastPhAnyPosLogAt = now;
          this._log(key, 'skip', `Phoenix 链上有 ${anyPos} 个仓位 (${posMarkets.slice(0, 3).join(', ')})，autopilot 暂不接管（Round 275v：链上任何仓 → skip，防跟用户手动仓争 cross-margin + 防 cancelAll 误撤）—— 平仓后自动恢复`);
        }
        return;
      }
    }

    // Round 275o: Nado 上次 tick 起单失败 30min 内直接 skip（冷却）。
    // Round 275m 判据 (|equity-balance|>$5) 在 tick 瞬间 delta 归零窗口会漏
    // → Autopilot 冲进去 start，起 12 单又全失败 → 又循环。加冷却兜底。
    if (key === 'nd' && st.lastAction === 'start-failed' && (now - (st.lastDecisionAt || 0)) < 30 * 60_000) {
      const lastLogAt = st._lastNdCooldownLogAt || 0;
      if (now - lastLogAt > 30 * 60_000) {
        st._lastNdCooldownLogAt = now;
        this._log(key, 'skip', `Nado 上次起单失败，冷却 30 分钟避免循环撞 2006`);
      }
      return;
    }
    // Round 275m: Nado 有链上仓位/挂单时 skip，防"start-failed"死循环。
    // Round 275i-k merge 后，若 Autopilot 起一波 Nado 网格 fills 出仓位，rotate
    // 到新市场时老仓没清 → 新起 20 格 × $105 × 10x = $210 margin > 剩余 health
    // buffer → 每 tick 全 20 单被拒 2006 → placeFails 累积 1700+。
    // 判据：|equity - balance| > $5 视为有 unrealized position（Nado adapter 没
    // 主动 populate positions Map，用 equity-balance delta 是唯一信号）。
    // 同 Round 254 phoenix：静默 skip 让用户手动去 nado 网页清仓，30min log 一次。
    if (key === 'nd') {
      const curState = bot.getState();
      const bal = Number(curState.balance || 0);
      const eq = Number(curState.equity || 0);
      const posDelta = Math.abs(eq - bal);
      if (!curState.running && bal > 5 && posDelta > 5) {
        const lastLogAt = st._lastNdPosLogAt || 0;
        if (now - lastLogAt > 30 * 60_000) {
          st._lastNdPosLogAt = now;
          this._log(key, 'skip', `Nado 链上有仓位残留（equity $${eq.toFixed(2)} vs balance $${bal.toFixed(2)}，delta $${posDelta.toFixed(2)}），autopilot 暂不接管——请到 nado.xyz 平仓后自动恢复`);
        }
        return;
      }
    }
    // Round 248: 零余额 skip —— Round 275w 已把 auto-disable 提前到函数开头，
    // 走到这里说明 balance<$5 但 enabled=false（已被 275w 或用户 disable）。
    // 保留 skip log 兜底，每 30min 一次不刷屏。
    const curForBal = bot.getState();
    if (!curForBal.running && Number(curForBal.balance || 0) < 5 && Number(curForBal.equity || 0) < 5) {
      const lastOffboardLog = st._lastOffboardLogAt || 0;
      if (now - lastOffboardLog > 30 * 60_000) {
        st._lastOffboardLogAt = now;
        this._log(key, 'skip', `${key} 余额=$${(curForBal.balance || 0).toFixed(2)} equity=$${(curForBal.equity || 0).toFixed(2)}（已 offboarded 无资金），autopilot 不接管`);
      }
      return;
    }
    // 3. 护栏：日亏损
    //    额外要求 cur.balance > 0：LIVE 适配器 init 窗口偶尔 balance=0，
    //    dayStartEquity>0 会误判成 100% 亏损，直接给假熔断。用 balance 兜底。
    const cur = bot.getState();
    if (st.dayStartEquity > 0 && cur.equity != null && cur.balance > 0) {
      const dailyLossPct = (st.dayStartEquity - cur.equity) / st.dayStartEquity * 100;
      if (dailyLossPct >= s.dailyLossPctLimit) {
        await this._emergencyStop(key, `日亏损 ${dailyLossPct.toFixed(2)}% 达阈值 ${s.dailyLossPctLimit}%，紧急熔断`);
        return;
      }
    }
    // 护栏：连续亏损（简单启发：realizedPnl 从上次决策起没涨反跌了）
    //
    // Round 146 Bug 1：把 `st.consecutiveLosses` 的实际计数补上。原代码 5 处
    // reset、1 处判读，**0 处增量**，护栏永远不会触发，只剩日亏损兜底。
    //
    // 只对 Autopilot 自己开的、running 的 bot 计数（用户手动开的不算）。
    // 用 realized（已实现盈亏）对比：涨了 → 归 0；跌了 → +1；持平 → 不动。
    if (cur.running && st.startedByAutopilot && Number.isFinite(cur.realized)) {
      const prev = Number.isFinite(st.lastCheckPnl) ? st.lastCheckPnl : null;
      if (prev != null) {
        if (cur.realized < prev) st.consecutiveLosses = (st.consecutiveLosses || 0) + 1;
        else if (cur.realized > prev) st.consecutiveLosses = 0;
      }
      st.lastCheckPnl = cur.realized;
    }
    if (st.consecutiveLosses >= s.consecutiveLossLimit) {
      await this._emergencyStop(key, `连续亏损 ${st.consecutiveLosses} 次，暂停等人工复核`);
      return;
    }
    // Round 154：策略无效熔断
    //
    // 用户 QC 发现 StandX 网格利润(理论)+160，账户实际亏 -160，差 321 全被
    // fees/adverse move 吃掉。原日损护栏只看今日 (dayStartEquity vs equity)，
    // 累计几天 slow bleed 每天 <12% → 永远不熔断，累计巨亏。
    //
    // 补一个信号：**网格 fires 但账户在亏 = 手续费大于价差利润 → 策略无效**。
    //   - gridProfit（理论）远大于账户变化的绝对值 = 每格赚的比不上 fees + adverse
    //   - 且账户实际亏损值得注意（≥ startBalance × 5%）
    // 触发即换币（跟其他熔断走同一路径：停 + 24h paused）。
    // Round 157 Bug 1：Round 154 触发条件加 `cur.running && startedByAutopilot`。
    //
    // 上一版没这检查 → SX 停了但 gridProfit/equityDelta 是旧数据（bot.stats
    // 一直没重置），每次 tick 都触发策略无效熔断 → pausedUntil 又推 24h →
    // 用户"解除熔断"没用（resumeExchange 只清 pausedUntil，没清 bot.stats）→
    // 死循环。修法：bot 停了就不评估这个信号。
    // Round 281: 阈值放宽 5%→15% loss · 0.5→3.0 ratio · 从"敏感"改"严重才熔断"。
    //   原阈值触发 SX 熔断（+$190 理论 / -$18 实际 · 5% × $364 = $18 卡线上）·
    //   但 grid 天生就是先付 fee 再赚 spacing · 短期账户会小亏很正常。
    //   3x 意味着 gridProfit 得比 loss 大 300% 才算"策略无效" · loss 得达 15%
    //   startBalance 才触发 · 给 grid 完整周期空间等 mean revert。
    const gp = Number(cur.stats?.gridProfit) || 0;
    const ed = cur.equityDelta;
    const sb = Number(cur.startBalance) || 0;
    if (cur.running && st.startedByAutopilot
        && sb > 0 && Number.isFinite(ed) && ed < 0
        && Math.abs(ed) >= sb * 0.15
        && gp >= Math.abs(ed) * 3.0) {
      await this._emergencyStop(key, `策略无效：网格理论利润 +${gp.toFixed(2)} 但账户实际亏 ${ed.toFixed(2)}（差 ${(gp - ed).toFixed(2)} = fees+adverse 吃掉），换币`);
      return;
    }

    // 3. Bot 已跑同一市场？V1：不换币，只在冲出区间时才干预。
    //    仅动 Autopilot 自己启动的网格；用户手动开的网格 Autopilot 绝不会 stop/reopen，
    //    避免把用户手动挂的策略意外平掉。
    if (cur.running) {
      if (!st.startedByAutopilot) {
        this._log(key, 'skip', `${cur.config.displayName} 由用户手动启动，Autopilot 不接管`);
        return;
      }
      // Round 267/268: 自适应重启 —— 探测「bot config 被 undersized 起了」的场景。
      // 病理：Extended 多币种漏读时用 $1.67 起了 6 grid（config.gridCount=6），Round 266 修好
      // 后 autopilot 下 tick 走 running 分支「保持」不 rotate → 12h 天花板前白锁 $359。
      //
      // Round 267 v1 用 `equity > startBalance × 2` 作判据，但 autopilot 起 bot 前会调
      // `bot.rebaselinePnl()` 把 startBalance 更新到当前 equity，导致 startBal 永远 ≈ equity，
      // 判据永远不触发。QC 实盘 Extended startBal=$361.08 equity=$361.04 即是。
      //
      // Round 268 改判据：**bot.config.gridCount << 风格默认 gridCount**（配置本身证明起单
      // 时 undersized）。避开 startBalance 陷阱 + 直接反映 bot 实际配置。
      // 触发条件（全满足）：
      //   1. `bot.config.gridCount < style.gridCount × 0.5`（比默认少一半以上）
      //   2. 且不是 exchangeGridCap 上限市场（RS 硬 cap 50，属正常，不能重开）
      //   3. openOrders > 0（避免和 Round 266 phantom 0-order 分支重叠）
      //   4. 30min 冷却（防抖动）
      const configGrid = Number(cur.config?.gridCount) || 0;
      const orders = Number(cur.openOrders) || 0;
      const styleGrid = Number(s?.gridCount) || 0;
      const capForKey = { rs: 50 }[key];   // 跟主流 code 里 exchangeGridCap 保持一致
      const atCap = capForKey && configGrid >= capForKey;
      const lastAutoRestart = st.lastAutoRestartAt || 0;
      const cooledDown = now - lastAutoRestart > 30 * 60_000;
      if (cooledDown && configGrid > 0 && orders > 0 && styleGrid > 0
          && configGrid < styleGrid * 0.5 && !atCap) {
        st.lastAutoRestartAt = now;
        this._log(key, 'auto-restart', `${cur.config.displayName} config gridCount=${configGrid} 远低于风格默认 ${styleGrid}（<50%），起单时 capital 被低估 → stop 重开用新算 capital`);
        await bot.stop({ closePosition: false }).catch(() => {});
        st.startedByAutopilot = false;
        st.startedAt = 0;
        // fall through 到选币 + start 逻辑（跟 outOfRange 分支同款 pattern）
      } else if (cur.outOfRange) {
        this._log(key, 'stop', `${cur.config.displayName} 冲出区间，停网格准备重开`);
        await bot.stop({ closePosition: true }).catch(() => {});
        st.startedByAutopilot = false;
        // Round 197：记冷却，30 min 内本所不再选这个市场（RS 反复挑 HYPE 就是这里堵）
        // Round 205: aggressive 挂 BTC 不换 —— 冲出区间也不加冷却，让 autopilot
        // 下 tick 再挑 BTC (Round 204 全池) + 主动 re-center 保仓。
        if (this.cfg.riskStyle !== 'aggressive') {
          st.stoppedMarkets = st.stoppedMarkets || {};
          st.stoppedMarkets[cur.config.displayName] = Date.now();
        }
      } else {
        // Round 121→164c→166→171：stop-idle 30 → 15 → 10 → 8 min。用户 $1M/周
        // 目标需要每家都长期跑在活跃市场，冷市场不能耽误超过 8 分钟。8 min 已接近
        // 换币开销的下限（~30-40s API + close fee 占单次 rotation 6-8% 时间），
        // 一小时 7-8 次换币机会。
        // Round 200：ON 死鱼盘天生慢（AMD/COIN/CRCL 一格 5-10min 才 hit），5min
        // 阈值太紧 → 35min 换 4 次币 rungs=0，纯烧手续费。ON 用 15min 让死鱼盘
        // 有时间成交；PL/RS 保持 5min（活跃币可以快速轮换）。
        // Round 201: 全部 60min，学 @zaijin338191 挂 BTC 不换币。stop-idle 变防呆
        // 兜底：BTC 一小时真的无成交才认命换。正常震荡时永不换币。
        // Round 205: aggressive 完全禁 stop-idle rotate。之前 60min 无成交仍
        // rotate → BTC 冷却 30min → autopilot 重挑 fallback 到 AAPL/HYPE，破坏
        // 挂 BTC 不换策略。aggressive 就是"挂着不换"，让 re-center/narrow 处理。
        // Round 265: aggressive Infinity → 720min (12h)。用户 QC /api/autopilot/status
        // 看到 ex/on aggressive 状态下 5963/5997 min 无成交（~4 天）= 死鱼盘白锁保证金
        // 白烧 fee/funding。给个天花板：12h 是"挂 BTC 不换"策略下 BTC 也真的死了的
        // 阈值（震荡日 BTC 3-4h 至少 1 fill），触发后 rotate 挑更活跃市场，30min
        // 冷却期让当前 stuck 市场进冷却池，autopilot 下 tick 选别的。
        const noFillFloor = this.cfg.riskStyle === 'aggressive' ? 720 : 60;
        const lastActivity = Number(cur.fills?.[0]?.t) || st.startedAt || 0;
        const noFillMinutes = lastActivity > 0 ? Math.round((now - lastActivity) / 60_000) : 0;
        if (lastActivity > 0 && noFillMinutes >= noFillFloor) {
          this._log(key, 'stop-idle', `${cur.config.displayName} ${noFillMinutes} 分钟无成交，停网格换币重选`);
          await bot.stop({ closePosition: true }).catch(() => {});
          st.startedByAutopilot = false;
          st.startedAt = 0;
          // Round 197：stop-idle 的市场也 30 min 冷却（ON 反复选 BTC 就是这里堵）
          st.stoppedMarkets = st.stoppedMarkets || {};
          st.stoppedMarkets[cur.config.displayName] = Date.now();
          // 继续往下走选币逻辑，直接重开
        } else {
          // Round 88：仍在区间内 → 检查是否需要"收窄区间"应对趋势反转。
          // conservative 已经全平（outOfRangeAction=close），只对 balanced/aggressive
          // 做这个中间态干预。narrowed 就 skip 本 tick（等下一 tick 再评估）。
          const narrowed = await this._maybeNarrowRange(key, cur, ex).catch(() => false);
          if (narrowed) return;
          // Round 155 B：价格漂离中心 > 5% 就自动 re-center（不停网格、持仓保留）
          // 用 adjustRange 平移到当前价 ±（原宽度/2），2h 冷却防抖动。跟趋势走。
          const recentered = await this._maybeRecenter(key, cur).catch(() => false);
          if (recentered) return;
          this._log(key, 'skip', `${cur.config.displayName} 网格运行中，指标正常，保持（无成交 ${noFillMinutes} 分钟）`);
          return;
        }
      }
    } else if (st.startedByAutopilot) {
      // Bot 停了（用户手动停 / 崩了 / 上一轮自己停的），清标志
      st.startedByAutopilot = false;
    }

    // 4. Bot 未运行 → 选币 + 出参数 + 启动
    const markets = await ex.getMarkets().catch(() => []);
    if (!markets.length) {
      this._log(key, 'skip', '暂无可用市场');
      return;
    }

    // 4a. 拉每个市场的近期 K 线打分（震荡强度高 + 有波动 = 网格友好）
    // Round 124：多时间框架 —— 同时拉 1h + 15m，两个时间框架一致才算 high
    // confidence。1h up + 15m down（短线反转）→ 判 neutral，避免追涨杀跌。
    //   · 1h 100 bars = 4 天多，反映中期趋势
    //   · 15m 100 bars = 25 小时，反映短线动量
    // strength 取两者平均，atrPct 用 15m（波动率更实时）。
    // Round 220: Phoenix 62 市场按 API 顺序 top-8 是 NVDA/CRCL/DOGE/ZEC/XLM/AMZN/NEAR/ASML，
    // BTC 在 30+ 位进不了候选池 → aggressive BTC-hold 逻辑白搭。而且股票市场（NVDA/MU/TSM/
    // AMZN 等）Phoenix 用缩放 tick，K 线返 $835 实际 UI 显 $201，网格区间跟真价对不上。
    // 修法：Phoenix 特殊选池 —— 强制 BTC/ETH/SOL/HYPE/DOGE 优先 + 过滤股票市场。
    const STOCK_SYMBOLS = /^(NVDA|MU|TSM|AMZN|AAPL|GOOGL|META|CRCL|COIN|ASML|CRWV|MSTR|GOLD|WTIOIL|COST|BABA|WMT|LLY|HOOD|NFLX|UBER|MELI|PLTR|IBIT|SPX|SPY|QQQ)$/i;
    let scanList;
    if (key === 'ph') {
      const crypto = markets.filter((m) => !STOCK_SYMBOLS.test(m.displayName));
      const priority = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE'];
      const pri = crypto.filter((m) => priority.includes(m.displayName));
      const rest = crypto.filter((m) => !priority.includes(m.displayName));
      scanList = [...pri, ...rest].slice(0, 8);
    } else if (key === 'nd') {
          // Round 277: Nado's on-chain min_size is a flat 100 units for every perp
          // (verified against gateway.prod.nado.xyz), so majors like BTC/ETH/AAVE
          // need 100 x price margin which always exceeds this account's balance.
          // Sort by affordability (minOrderSize x price ascending) instead of
          // taking the first 8 markets, so cheap/affordable coins get scanned.
          const affordable = markets.filter((m) => Number(m.lastPrice) > 0)
            .sort((a, b) => (Number(a.minOrderSize || 1) * Number(a.lastPrice)) - (Number(b.minOrderSize || 1) * Number(b.lastPrice)));
          scanList = affordable.slice(0, 8);
    } else {
      scanList = markets.slice(0, 8);
    }
    const candidates = [];
    for (const m of scanList) {
      try {
        const [c1h, c15m] = await Promise.all([
          ex.getCandles(m.marketId, 3600, 100).catch(() => []),
          ex.getCandles(m.marketId, 900, 100).catch(() => []),
        ]);
        if (!c1h || c1h.length < 50) continue;
        const t1h = analyzeTrend(c1h);
        // 15m 数据不足就退化为纯 1h（Ondo/Perpl 冷市场可能拉不到短线）
        const t15m = c15m && c15m.length >= 50 ? analyzeTrend(c15m) : null;
        const agreement = t15m ? (t1h.recommended === t15m.recommended) : true;
        const trend = {
          trend: agreement ? t1h.trend : 'range',
          recommended: agreement ? t1h.recommended : 'neutral',   // 时间框架不一致 → 保守中性
          strength: t15m
            ? Number(((t1h.strength + t15m.strength) / 2).toFixed(2))
            : t1h.strength,
          atrPct: t15m?.atrPct ?? t1h.atrPct,   // 短线 ATR 更实时
          agreement,
          _detail: t15m ? `1h=${t1h.recommended}(${t1h.strength}) · 15m=${t15m.recommended}(${t15m.strength})` : `1h-only=${t1h.recommended}(${t1h.strength})`,
        };
        // Round 133：近 1h 走势（不用再单独拉一次 K 线），供下游候选筛选用
        const lastBar = c1h[c1h.length - 1];
        const prevBar = c1h[c1h.length - 2];
        const hour1DropPct = prevBar && prevBar.close > 0
          ? (lastBar.close - prevBar.close) / prevBar.close * 100
          : 0;
        // Round 140：hour1Vol —— 最近 1h 该市场自身成交量（USDT notional）。
        // 避开死鱼盘（Ondo ETH-USD.P 型），bot 挂了单也不会成交。
        // 用最近 4 根 c1h 平均 × close 估 hourly notional，防单根 outlier。
        const recent = c1h.slice(-4);
        const avgBaseVol = recent.reduce((s, b) => s + (Number(b.volume) || 0), 0) / Math.max(1, recent.length);
        const hour1Vol = avgBaseVol * (lastBar.close || 0);
        candidates.push({
          marketId: m.marketId, name: m.displayName, price: m.lastPrice,
          minOrderSize: m.minOrderSize, stepSize: m.stepSize, maxLeverage: m.maxLeverage, stepPrice: m.stepPrice,
          trend: trend.trend, recommended: trend.recommended,
          strength: trend.strength, atrPct: trend.atrPct,
          agreement: trend.agreement,   // Round 124：两个时间框架是否一致
          tfDetail: trend._detail,      // Round 124：AI 能看到 1h + 15m 分别的判断
          hour1DropPct,                 // Round 133：负值 = 近 1h 下跌
          hour1Vol,                     // Round 140：市场自身近 1h 成交量 USDT
        });
      } catch { /* skip */ }
    }
    // 该所 K 线 API 全线返空（例如 Ondo history 端点当前就返 t=[]）：不能只
    // 因为拿不到打分数据就 skip 整所——用 lastPrice + market metadata 直接
    // 组 5 个候选，趋势保守当"range/neutral"，让下游 margin check 决定能否起。
    if (!candidates.length) {
      this._log(key, 'skip-nocandles', `${key} K 线 API 返空，用 lastPrice fallback 选币`);
      for (const m of markets.slice(0, 5)) {
        if (!(Number(m.lastPrice) > 0)) continue;
        candidates.push({
          marketId: m.marketId, name: m.displayName, price: Number(m.lastPrice),
          minOrderSize: m.minOrderSize, stepSize: m.stepSize, maxLeverage: m.maxLeverage, stepPrice: m.stepPrice,
          trend: 'range', recommended: 'neutral',
          strength: 0, atrPct: null,
        });
      }
      if (!candidates.length) {
        this._log(key, 'skip', '无 K 线且无有效 lastPrice，跳过本轮');
        return;
      }
    }

    // 4b. 简单规则打分
    // Round 109：全部开仓都中性的根因——range +3 vs others +1 的偏置太重，
    // 打分后 range 总占 top，AI prompt 又强化 neutral，strongTrend override
    // 只查 picked 一个候选（已经 neutral 了）→ 三层叠加永远出 neutral。
    // 新打分：range +2, others +1, 强趋势 (strength >= 0.4) +3。
    // 强趋势能真正打赢 range，跟趋势方向做 long/short 网格。
    for (const c of candidates) {
      c.score = 0;
      if (c.trend === 'range') c.score += 2;
      else c.score += 1;
      // Round 164b：atrPct 分档打分（不再一刀切 +2）。QC 发现选到 LTCUSDT
      // 59 分钟无成交、GOOGL-USD.P 完全不动 → 用户 volume 上不来。改成"越活跃越
      // 加分"，1.5-4% 是网格甜蜜点（既有波动又不至于爆炸）。
      //   atrPct 1.5-4.0%  → +4（甜蜜点）
      //   atrPct 4.0-6.0%  → +3（波动大但可控）
      //   atrPct 0.8-1.5%  → +2（原甜蜜点，还算能吃）
      //   atrPct 0.3-0.8%  → +1（冷但不算死）
      //   其他            → 0（太冷或极端波动）
      if (c.atrPct != null) {
        if (c.atrPct >= 1.5 && c.atrPct <= 4.0) c.score += 4;
        else if (c.atrPct > 4.0 && c.atrPct <= 6.0) c.score += 3;
        else if (c.atrPct >= 0.8 && c.atrPct < 1.5) c.score += 2;
        else if (c.atrPct >= 0.3 && c.atrPct < 0.8) c.score += 1;
      }
      if (Number(c.strength) >= 0.4 && c.recommended !== 'neutral') c.score += 3; // 强趋势加分
      // Round 140：hour1Vol 打分 —— 避开死鱼盘（Ondo ETH-USD.P 型，QC 数据显示
      // 挂网格 26 分钟一次没成交）。分档：
      //   > $1M/h → +3 (深水市场，好网格)
      //   > $100k/h → +2
      //   > $10k/h → +1
      //   < $10k/h → 0（不加分，容易成为死鱼）
      // 该市场自身活跃度直接决定挂单能否被吃。
      if (c.hour1Vol != null) {
        if (c.hour1Vol > 1_000_000) c.score += 3;
        else if (c.hour1Vol > 100_000) c.score += 2;
        else if (c.hour1Vol > 10_000) c.score += 1;
      }
    }
    // Round 175：BTC/ETH 强制降级 —— 用户实测 BTC-USD/BTC-USD.P/HYPE/USDC
    // 一小时零 fills。BTC atrPct 0.2-0.5% 低于 grid spacing 0.075%（Round 174）
    // 太多倍，不会击穿。冷家（EX/RS/ON/PL）必须挑波动市场才能出 fills。
    // 硬 penalty: BTC/ETH 类候选 score -5 → 排到最后（除非全部候选都是 BTC/ETH）。
    const majorLowVolCoins = /^(BTC|ETH)($|USDT|USDC|USD|PERP|\-)/i;
    for (const c of candidates) {
      const base = String(c.name || '').replace(/[-_/]?(usdc|usdt|usd|perp)$/i, '').toUpperCase();
      if (['BTC', 'ETH'].includes(base)) c.score -= 5;
    }
    candidates.sort((a, b) => b.score - a.score);
    // Round 155 C：跨 DEX 软性币种去重
    //   base = 去掉 -USD/USDT/-PERP 等后缀，例："BTCUSDT" → "BTC"
    //   硬上限：一个币最多 3 家跑（防 8/8 都 BTC 相关风险拉满）
    //   软让：一个币已被 1+ 家选 && 该家该 tick 第一名分数优势 ≤ 2 分 → 让给第二名
    //   优势 > 3 分：允许该家吃这个币（BTC 全局最优时不牺牲质量）
    const usedMap = this._tickPickedSymbols || new Map();
    const baseOf = (name) => String(name || '').replace(/[-_/]?(usdc|usdt|usd|perp)$/i, '').replace(/[-_/]?\.p$/i, '').toUpperCase();
    // Round 171：用户 /goal 明确"最重要 ondo & perpl & extended & risex" — 这 4 家
    // 优先享 top 候选，不参与让币逻辑。SX/BG/BU 会看到"这些币被 priority 家占了"
    // 主动让开，反过来加大 priority 4 拿到最活跃市场的概率。
    const PRIORITY_KEYS = new Set(['on', 'pl', 'ex', 'rs']);
    if (PRIORITY_KEYS.has(key)) {
      this._log(key, 'priority', `优先家（ON/PL/EX/RS），跳过 dedup 让币直接吃 top`);
      // 跳过整个 while，直接用 candidates[0]
    } else {
    // Round 163：让币前先看剩下的 candidates 里有没有"下游 rankedList 循环能过关"
    // 的。如果没有 —— 全都会被 hour1DropPct/hour1Vol/tick 拒掉 —— 就别让，
    // 允许吃这个热门币。之前 BU 场景：BTC/ETH/BNB 三个热门都让给别家，剩下
    // ADAUSDT (太冷 $44K) + XRPUSDT (tick 太粗) 全被 rejections 拒掉 → BU
    // 整个 tick skip，15 分钟没起单。
    const isViable = (c) => (c.hour1Vol == null || c.hour1Vol >= 50000)
                         && (c.hour1DropPct == null || c.hour1DropPct >= -2)
                         && Number(c.price) > 0;
    while (candidates.length > 1) {
      const top = candidates[0];
      const second = candidates[1];
      const topBase = baseOf(top.name);
      const used = usedMap.get(topBase) || 0;
      const gap = Number(top.score) - Number(second.score);
      const hasViableAlt = candidates.slice(1).some(isViable);
      if (used >= 3) {
        // 硬上限：跳到下一个候选（但没 viable 替代就允许 4 家共享，防空转）
        if (hasViableAlt) {
          this._log(key, 'diversify', `${top.name}(${topBase}) 已 3 家在跑，跳过 → ${second.name}`);
          candidates.shift();
          continue;
        }
        this._log(key, 'diversify-override', `${top.name}(${topBase}) 3 家占满但无 viable 替代（全太冷/tick 粗），破例允许第 4 家吃`);
        break;
      }
      if (used >= 1 && gap <= 2) {
        // 软让：优势不明显，让给别家（但没 viable 替代就保留 top）
        if (hasViableAlt) {
          this._log(key, 'diversify', `${top.name}(${topBase}) 已被 ${used} 家选，本家优势仅 +${gap}，让给 ${second.name}`);
          candidates.shift();
          continue;
        }
        this._log(key, 'diversify-override', `${top.name}(${topBase}) 已被 ${used} 家选但让币后无 viable 替代（避免空转），保留 top`);
        break;
      }
      break;   // top 可接受
    }
    }  // end else (non-priority key)
    const shortlist = candidates.slice(0, 5);

    // Round 202: 简化 —— 删掉 AI 选币 + 规则挑币。aggressive 就是 BTC，其他保底
    // shortlist top1。AI 选币曾经的价值在 Round 109/155 用 strength 挑趋势时有意
    // 义；Round 201 后 3 家都挂 BTC 不换币，AI selector 每次都得挑 BTC —— 白白
    // 花 API cost + log 噪音。
    // Round 204: BTC 查找从 shortlist (top-5) 扩到 candidates (全池)。RS 的
    // BTC/USDC 可能因分数排在 6+ 位没进 shortlist，导致 fallback 到 HYPE。
    let pick = null;
    let aiReasoning = '';
    if (this.cfg.riskStyle === 'aggressive') {
      pick = candidates.find((c) => /^BTC/i.test(c.name));
      aiReasoning = pick ? 'BTC 挂着不换（@zaijin338191 策略）' : '';
    }
    // 非 aggressive 或 candidates 里没 BTC 就用 top1 规则打分
    if (!pick) {
      pick = shortlist[0];
      aiReasoning = pick ? '规则排序 top1' : '';
    }
    // 把 AI/规则选中的 pick 放到 shortlist 最前面，其他按分数留在后面作为 fallback。
    // Perpl 那种「首选 BTC 但 $210 只够 MON/SOL/ETH」的场景：主选不 afford 就依次
    // 往下试，选出第一个能塞进保证金的市场。
    const rankedList = pick ? [pick, ...shortlist.filter((c) => c !== pick)] : shortlist.slice();

    // 4d. 代码钳制参数到风格允许区间（AI 永远不能自伤）
    // Round 206: balance=0 但 equity>0 用 equity 兜底 —— Extended API 返 balance=0
    // 但 futures 里有钱（$231），旧代码 fallback 到 1000 导致算出 $533 保证金要求，
    // bot start 用真实 $231 检查一律拒。equity fallback 让参数反映真实可用资金。
    // Round 266: `balance>0 ? balance : equity` 漏掉多币种账户 —— Extended 用户
    // USDC=$1.66 + USDT=$378 → balance 只算 USDC 返 $1.66 但 equity=$361（含 USDT）。
    // 结果 autopilot 用 $1.66 算出只 6/80 单能挂，白白浪费 $360 保证金。
    // 修：max(balance, equity)。equity 是全部 collateral 加总，永远 >= balance，
    // 单币种账户 balance≈equity（max 结果一样），多币种 equity 更大（选对）。
    const realCapital = Math.max(cur.balance || 0, cur.equity || 0) || 1000;
    const capitalUsdc = Math.min(this.cfg.perExchange[key].maxCapitalUsdc || 1000, realCapital);
    const budget = capitalUsdc * 0.8;   // 保留 20% buffer

    let params = null;
    let picked = null;
    let pickedGridCount = s.gridCount;
    let pickedSizeBase = 0;
    let pickedLower = 0, pickedUpper = 0;
    let pickedLeverage = s.maxLeverage;
    const rejections = [];   // 记每个候选被 skip 的原因，方便最后统一 log

    // Round 197：清 30 min 之前的冷却记录（防 map 无限增长）
    st.stoppedMarkets = st.stoppedMarkets || {};
    const cdCutoff = now - 30 * 60_000;
    for (const [m, t] of Object.entries(st.stoppedMarkets)) {
      if (t < cdCutoff) delete st.stoppedMarkets[m];
    }

    for (const c of rankedList) {
      const price = c.price || 0;
      if (!(price > 0)) { rejections.push(`${c.name}:无价格`); continue; }
      // Round 197：30 min 内被 stop/stop-idle 过的市场跳过 —— RS 反复挑 HYPE 循环。
      // 让 autopilot 强制换到 fallback 候选，即便得分低一档也比反复挑烂币好。
      // Round 205: aggressive 挂 BTC 不换 —— 跳过冷却池检查，让 BTC 永远 pickable。
      if (this.cfg.riskStyle !== 'aggressive' && st.stoppedMarkets[c.name]) {
        const agoMin = Math.round((now - st.stoppedMarkets[c.name]) / 60_000);
        rejections.push(`${c.name}:${agoMin}min 前刚 stop，冷却中`);
        continue;
      }
      // Round 133：近 1h 跌 >2% 跳过这个候选（不整轮 return，往下一个试）。
      // 之前 Round 20 在 rankedList 循环外单独 check，一个候选跌就整轮 skip；
      // 结果 Bitunix 因 ADAUSDT 跌 6% 一整个 tick 都没起，剩 4 个不下跌的没试。
      if (c.hour1DropPct != null && c.hour1DropPct < -2) {
        rejections.push(`${c.name}:近1h跌${c.hour1DropPct.toFixed(2)}%`);
        continue;
      }
      // Round 140/155：死鱼盘 skip 阈值 $5k → $50k。QC 实测 EX 起 WTI-USD
      // 后 81 分钟才 stop-idle rotate，GOOGL-USD.P、WTI-USD 等 <$50k 类
      // "非典型加密 perp" 挂网格效率极差。50k/h 相当于每格能一小时吃到 1-2 次。
      // Round 198：$50k → $20k，给 RS/ON 死鱼盘小池子放宽准入。
      // 副作用：BNB/AMD/COIN 等 20-50k 的市场会被选中，网格效率一般但不至于死鱼。
      if (c.hour1Vol != null && c.hour1Vol > 0 && c.hour1Vol < 20000) {
        rejections.push(`${c.name}:1h 成交仅 $${c.hour1Vol.toFixed(0)}，市场太冷`);
        continue;
      }
      // Round 156：策略切换 · 根据 trend regime 动态调参数
      //   - 强趋势 (strength >= 0.6)：wider range (×1.4), fewer grids (×0.75), lower lev (×0.7)
      //     → 网格拉宽让趋势跑进来，格数减少每格 notional 更大，杠杆降低减风险
      //   - 弱趋势 (0.3 ≤ strength < 0.6)：中度调整 (×1.2, ×0.85, ×0.85)
      //   - 震荡市 (strength < 0.3)：用配置的原参数
      // 只有 mode != neutral（即真趋势 long/short）才生效，neutral 不动。
      const strength = Number(c.strength) || 0;
      const isTrend = c.recommended === 'long' || c.recommended === 'short';
      let rMult = 1, gMult = 1, lMult = 1;
      let regimeLabel = '震荡';
      if (isTrend && strength >= 0.6) {
        rMult = 1.4; gMult = 0.75; lMult = 0.7;
        regimeLabel = '强趋势';
      } else if (isTrend && strength >= 0.3) {
        rMult = 1.2; gMult = 0.85; lMult = 0.85;
        regimeLabel = '弱趋势';
      }
      const rangePct = s.rangePct * rMult;
      const gridCountBase = Math.max(8, Math.round(s.gridCount * gMult));
      const leverageMult = lMult;
      if (regimeLabel !== '震荡') {
        this._log(key, 'regime-switch', `${c.name} ${regimeLabel} · strength=${strength} → range ${(s.rangePct*100).toFixed(1)}%→${(rangePct*100).toFixed(1)}%, 格数 ${s.gridCount}→${gridCountBase}, 杠杆×${leverageMult}`);
      }
      // stepPrice 是价格 tick（每档差多少），stepSize 是订单量 tick（每张多少）——
      // lower/upper 必须对齐 stepPrice！之前用 stepSize 对齐，Ondo 报
      // "doesn't snap to min price increment 0.1" 就是这个原因。
      const priceTick = c.stepPrice || c.stepSize || 0;
      // Round 59：如果 stepPrice 相对 price 太粗（e.g. LIT-USD price=2.21
      // stepPrice=1，一个 tick 就是 45% price），网格根本没法跑。之前 fallback
      // 会强撑 `upper = lower + tick * gridCount` = [2, 26]，价格 2.21 永远
      // 贴下轨。直接 skip 这类候选。
      if (priceTick > 0 && priceTick > price * rangePct * 0.5) {
        rejections.push(`${c.name}:tick 太粗(${priceTick} vs price ${price} * ${(rangePct*100).toFixed(1)}%)`);
        continue;
      }
      let lower = _stepAlign(price * (1 - rangePct), priceTick);
      let upper = _stepAlign(price * (1 + rangePct), priceTick);
      if (!(upper > lower)) {
        rejections.push(`${c.name}:step 太大`);
        continue;
      }
      // Round 59：兜底 sanity check——若对齐后的范围明显偏离 intended（比如
      // ±10% 以上偏差），也 skip（防 stepPrice 极端小/大导致的浮点异常）
      const intendedWidth = price * rangePct * 2;
      const actualWidth = upper - lower;
      if (actualWidth > intendedWidth * 3 || actualWidth < intendedWidth * 0.3) {
        rejections.push(`${c.name}:range 异常(实际 ${actualWidth.toFixed(4)} vs 期望 ${intendedWidth.toFixed(4)})`);
        continue;
      }
      // Round 156：应用 regime multipliers
      const adjustedMaxLev = Math.max(3, Math.round(s.maxLeverage * leverageMult));
      const leverage = Math.min(adjustedMaxLev, c.maxLeverage || adjustedMaxLev);
      const stepUnit = c.stepSize || c.minOrderSize || 1e-6;
      const rawSizeBase = (capitalUsdc * s.sizeFractionOfBalance) / price;
      let sizeBase = Math.max(c.minOrderSize || 0, _stepAlign(rawSizeBase, stepUnit));
      if (sizeBase <= 0 || !Number.isFinite(sizeBase)) { rejections.push(`${c.name}:单量异常`); continue; }

      const mid = (lower + upper) / 2;
      let gridCount = gridCountBase;   // Round 156：用 regime-adjusted gridCount
      // Round 203: 交易所硬性 open-orders/market 上限。
      // RISEx 每个市场最多 50 单，Round 201 想开 80 格触发 "429: max open orders"
      // + 30 单 3 次重试全失败，UI 全是 alert。硬 cap 到 50。
      // Round 275an：Phoenix 用 Solana，每单是 chain tx（1-2s 一笔 + rate_limit
      // 半分钟 window）。80 单一次起 = 80 tx 打过去 IP 秒挂。降到 20 让每次起单
      // 稳稳落 chain。
      const exchangeGridCap = { rs: 50, ph: 20 };
      if (exchangeGridCap[key] && gridCount > exchangeGridCap[key]) {
        gridCount = exchangeGridCap[key];
      }
      let required = gridCount * sizeBase * mid / leverage;
      if (required > budget) {
        const affordable = Math.floor(budget * leverage / (sizeBase * mid));
        if (affordable >= 6) {
          gridCount = affordable;
          required = gridCount * sizeBase * mid / leverage;
        } else {
          rejections.push(`${c.name}:$${required.toFixed(0)}>$${capitalUsdc.toFixed(0)}`);
          continue;   // 保证金不够 → 换下一个候选
        }
      }
      // 通过所有 check：锁定这个候选
      picked = c;
      pickedLower = lower; pickedUpper = upper;
      pickedSizeBase = sizeBase; pickedGridCount = gridCount;
      pickedLeverage = leverage;
      // Round 109：strongTrend override 完整版。
      // 门槛 0.3（跟 Round 80 一致），三种覆盖顺序：
      //   ① 该候选自己 strongTrend → 直接跟 recommended
      //   ② AI 明确给了 long/short → 用 AI 的（AI 看得到 shortlist 全貌）
      //   ③ 兜底 recommended 或 neutral
      const strongTrend = Number(c.strength) >= 0.3 && c.recommended && c.recommended !== 'neutral';
      const chosenMode = strongTrend
        ? c.recommended
        : (c._aiMode && c._aiMode !== 'neutral' ? c._aiMode : (c._aiMode || c.recommended || 'neutral'));
      params = {
        marketId: c.marketId, mode: chosenMode,
        lower, upper, gridCount, sizeBase, leverage,
        outOfRangeAction: s.outOfRangeAction,
      };
      if (strongTrend) {
        this._log(key, 'trend-follow', `${c.name} 强趋势 (强度 ${c.strength})，覆盖 AI/规则默认，改为跟趋势 ${c.recommended}`);
      }
      if (gridCount !== s.gridCount) {
        this._log(key, 'adjusted', `${c.name} 保证金压力：格数 ${s.gridCount}→${gridCount}（约需 $${required.toFixed(0)} / 可用 $${capitalUsdc.toFixed(0)}）`);
      }
      break;
    }

    if (!picked) {
      this._log(key, 'skip', `全部 ${rankedList.length} 个候选都不适合：${rejections.slice(0, 5).join('; ')}`);
      return;
    }
    pick = picked;   // 让下方 log/notify 沿用旧命名
    const mode = params.mode;
    const lower = pickedLower, upper = pickedUpper;
    const sizeBase = pickedSizeBase, gridCount = pickedGridCount;
    const leverage = pickedLeverage;

    // Round 133：Round 20 的市况前置 check 已内移到候选循环里（if hour1DropPct < -2 continue），
    // 让 pick fallback 到 rankedList 下一个不下跌的候选，而不是整轮 return skip。
    try {
      // Round 51 pre-flight：起单前显式 cancelAll 清链上残留。用户报告 StandX
      // 一键停止后本地 map 清了但链上还挂着 24 单，autopilot 再起 24 单 =
      // 链上 48 单越来越多。这里做 belt-and-suspenders：不信本地状态，直接问
      // exchange 清干净。cancelAll 内部会自己 loop 直到真的空。
      try {
        await ex.cancelAll(pick.marketId);
      } catch (e) {
        // Round 261/264/270: Phoenix cancelAll 挂时 —— 可能是 auth backoff、rate_limited、
        // 429 等各种。之前 Round 264 只在 dataSource='real-readonly' 时放行，但 Round 269
        // 让 auth 恢复回 'real' 后，Phoenix API 仍能返 rate_limited（IP 级 rate limit 独立
        // 于 auth）→ 走 skip 分支 → 死循环恢复。
        // 简化：**Phoenix 只要走到这条路径 (cur.running=false → bot.active 空)，任何 cancelAll
        // 错都放行**。Round 258 保证 bot.active 空，Round 234 防抱头 + Round 254 stray-check
        // 兜底防重复挂单。dataSource 状态 fluctuate 不该影响放行判据。
        const msg = String(e?.message || e);
        if (key !== 'ph') {
          this._log(key, 'skip', `${pick.name} 起单前清残留失败：${msg}，跳过本轮避免叠加挂单`);
          return;
        }
        this._log(key, 'warn-nocancel', `${pick.name} cancelAll 挂 (Phoenix，bot 未运行下安全)，继续起单让 place 层试 · ${msg}`.slice(0, 200));
      }
      // Round 159 → 161：新市场开仓前清 gridProfit + 重打 startBalance 基线。
      // 否则 bot.stats.gridProfit / startBalance 从上一市场累积过来，Round 154
      // 策略无效熔断会立刻二次触发（SX 死循环：gp=161 老数据 + ed=-24 新市场 →
      // gp >= |ed|*0.5 && |ed| >= sb*5% → 开仓 3s 后就熔断）。
      // rebaselinePnl 只清 gridProfit + startBalance + _pnlBase，保留 volume/
      // buys/sells/completedRungs/volumeBaseline —— Round 159 用的 resetStats
      // 把用户攒的 SX 15 万交易量 + BU volumeBaseline 一起清了，副作用太大。
      //
      // Round 275r：**只在真正切市场时 rebaseline**。之前每次 Autopilot start 都清
      // 一次，导致 6 次 Railway 部署重启 = pl 累积 905 rungs × $0.156 = $141 gridProfit
      // 被清 0，用户对比别人网格显示大量 realizedPnl，自己 $0，误以为策略不赚。
      // 判据：新市场 pick.marketId 跟 bot 当前 config.marketId 一致 → 同市场
      // 重启（如 recovery / restart 同市场）→ 不 rebaseline，保留累积 gridProfit。
      const curMarketId = bot.config?.marketId;
      const isNewMarket = curMarketId == null || Number(curMarketId) !== Number(pick.marketId);
      if (isNewMarket) {
        try { bot.rebaselinePnl(); }
        catch (e) { this._log(key, 'reset-warn', `rebaselinePnl 失败：${e?.message || e}（继续起单）`); }
      }
      const res = await bot.start(params);
      // 起单后让适配器同步 place 结果，再读实际挂上多少。
      // Round 275an：Phoenix 等 30s 让 Solana chain adopt（Round 259 deferred 流程需
      // reconcile 从 chain fetchOpenOrders 拿 orderSequenceNumber）；其他所 3s 够。
      await new Promise((r) => setTimeout(r, key === 'ph' ? 30_000 : 3_000));
      const finalState = bot.getState();
      const actual = Number(finalState.openOrders) || 0;
      st.lastAction = 'started';
      // Round 54：成功率低时，从 bot alerts 里 filter"下单失败"消息附到
      // 决策日志——用户在 Autopilot 页看得到 Extended "仅挂上 0/20"背后
      // 的真实原因（Insufficient margin / tick 对不上 / API 返错等），
      // 不用切到 Extended tab 翻 alerts。
      let failReason = '';
      if (actual < gridCount * 0.75) {
        const recentAlerts = (finalState.alerts || [])
          .filter((a) => /下单失败|挂单失败|order.*fail|reject/i.test(a.message))
          .slice(0, 3);
        if (recentAlerts.length > 0) {
          const uniq = new Set();
          for (const a of recentAlerts) {
            const m = String(a.message).replace(/^.*?下单失败:\s*/i, '').slice(0, 150);
            uniq.add(m);
          }
          failReason = ` · 失败原因：${[...uniq].join(' | ')}`;
        }
        // Round 261: Phoenix real-readonly 时 place 层 return {skipped:true} 不 alert，
        // recentAlerts 上面的 regex 匹配不到。补一条明确的 backoff 反馈让用户知道原因，
        // 而不是看到"仅挂上 0/80 成功率低"没上下文。
        if (!failReason && key === 'ph' && ex?.dataSource === 'real-readonly') {
          failReason = ` · 失败原因：Phoenix auth backoff 中（${String(ex.lastError || '').slice(0, 80)}），no-Bearer 路径也没通`;
        }
        // Round 263: Round 259 让 Phoenix placeLimitOrder return {orderId:null, deferred:true}
        // 让 reconcile 从 chain adopt orderSequenceNumber。若 chain fetchOpenOrders 拉不到
        // （unreliable listing / 分页盲区），active.size 一直 0，用户看到 "仅挂上 0/80" 但
        // 实际上 tx 已经 submit 到 Solana 了。明确告诉用户 deferred 状态别再当 fail。
        const deferred = Number(finalState.startDeferred) || 0;
        const skipped = Number(finalState.startSkipped) || 0;
        if (!failReason && (deferred > 0 || skipped > 0)) {
          const parts = [];
          if (deferred > 0) parts.push(`${deferred} 单 deferred（tx 已提交 chain，等 reconcile adopt orderId）`);
          if (skipped > 0) parts.push(`${skipped} 单 adapter skip（防抱头/auth）`);
          failReason = ` · ${parts.join(' · ')}`;
        }
      }
      const rateNote = (actual < gridCount * 0.75)
        ? `（仅挂上 ${actual}/${gridCount}，成功率低${failReason}）` : '';
      st.lastActionReason = `选 ${pick.name}（${mode}，${aiReasoning || '规则排序 top1'}），区间 ${lower}~${upper}，${gridCount} 格 x ${sizeBase}${rateNote}`;
      // Round 266: phantom running 防护 —— actual=0 表示 bot.start() "成功"但一单都没挂上
      // （Phoenix rate_limit 全 skip / 其他所全部失败）。之前 autopilot 无脑设 startedByAutopilot=true
      // → 下 tick 走 running 分支「网格运行中，指标正常，保持」→ Round 265 12h 天花板前不 rotate
      // → phantom running 空等 12h。修：actual=0 立即 stop bot（不平仓 —— 没仓可平）+ 不设
      // startedByAutopilot，让下 tick 重新决策。若原因是 rate_limit 持续，会 5min 后再试；若缓过
      // 来，正常挂单。避免 12h 空烧 fee/funding。
      // Round 275an：Phoenix 特殊——deferred>0 表示 tx 已提交 chain，30s 内没被 reconcile
      // adopt 但下几次 reconcile（bot 内部 60s 一次）会 adopt。actual=0 但 deferred>0
      // 时别 stop bot，让 reconcile 慢慢 pick up。否则 stop 会撤掉 chain 上的 40 单
      // → 用户重新遇到 phantom orders 问题（chain 上有单 QnV 看不见）。
      const deferredCount = Number(finalState.startDeferred) || 0;
      const hasDeferredOnChain = key === 'ph' && deferredCount > 0;
      if (actual === 0 && !hasDeferredOnChain) {
        try { await bot.stop({ closePosition: false }); } catch { /* best-effort */ }
        st.lastAction = 'start-failed';
        st.startedByAutopilot = false;
        st.startedAt = 0;
        this._log(key, 'start-failed', `${pick.name} start 完成但 openOrders=0（${rateNote.slice(1, -1) || '所有 seed 失败'}），已 stop bot 等下 tick 重试`);
        this._save();
        return;
      }
      // lastDecisionAt 已在函数入口刷新（Round 50），这里不再重复设置
      st.lastAppliedEquity = cur.equity;
      st.startedByAutopilot = true;
      st.startedAt = Date.now();   // Round 121：给 no-fill-timeout 30 分钟计时起点
      // Round 155 C：记录该 tick 已选币（跨 DEX 计数），后续家的候选打分时看这个 map
      if (this._tickPickedSymbols) {
        const baseOf = (name) => String(name || '').replace(/[-_/]?(usdc|usdt|usd|perp)$/i, '').replace(/[-_/]?\.p$/i, '').toUpperCase();
        const pb = baseOf(pick.name);
        this._tickPickedSymbols.set(pb, (this._tickPickedSymbols.get(pb) || 0) + 1);
      }
      this._log(key, 'start', st.lastActionReason);
      const successHint = (actual < gridCount * 0.75) ? `⚠ 起单成功率低：${actual}/${gridCount}${failReason}\n` : '';
      notify(`【网格 Autopilot·${EXNAMES[key]}】已启动：${pick.name}\n${successHint}模式：${_modeLabel(mode)} · 区间 ${lower} ~ ${upper}\n${gridCount} 格 × ${sizeBase} · ${leverage}x 杠杆\nAI：${aiReasoning || '规则排序'}`).catch(() => {});
      this._save();
    } catch (e) {
      st.lastAction = 'error';
      st.lastActionReason = e?.message || String(e);
      this._log(key, 'error', `启动失败：${st.lastActionReason}`);
    }
  }

  /**
   * Round 88：趋势反转但仍在区间内 → 收窄逆势侧边界，砍掉逆势方向的挂单，
   * 持仓保留自然消化。不停网格、不平仓（比 stop+reopen 温和很多）。
   *
   * 规则：
   *   下跌趋势 → shrink lower UP（砍掉当前价以下的 BUY 挂单）
   *   上升趋势 → shrink upper DOWN（砍掉当前价以上的 SELL 挂单）
   *   震荡     → 不动
   *
   * 4 层护栏防频繁抽动：
   *   1. 只对 balanced/aggressive（conservative 已 close on 出区间）
   *   2. strength ≥ 0.4 才认真（避免弱趋势噪音）
   *   3. 冷却 2 小时（每所每次收窄间隔）
   *   4. 收窄后新区间宽度不能 < price × 0.5%（太紧就跳过）
   *
   * @returns true if 已收窄（本 tick 不再做后续决策）
   */
  /**
   * Round 155 B：自动 re-center —— 价格漂离原 grid 中心 > 5% 就 adjustRange
   * 到当前价 ±(原宽度/2)，跟趋势走。持仓保留（adjustRange 不平仓）。
   *
   * 护栏：
   *   1. 2 小时冷却（每所每次 recenter 间隔，跟 narrow 独立）
   *   2. 只在 balanced/aggressive 生效（conservative 冲区间就 close 了）
   *   3. 需要 running + inRange + 有 lastPrice
   *
   * @returns true if 已 recenter（本 tick 不再评估）
   */
  async _maybeRecenter(key, cur) {
    if (this.cfg.riskStyle === 'conservative') return false;
    const st = this.state[key];
    const now = Date.now();
    if (st.lastRecenterAt && now - st.lastRecenterAt < 2 * 3600_000) return false;
    const price = Number(cur.lastPrice);
    const lower = Number(cur.config?.lower);
    const upper = Number(cur.config?.upper);
    if (!(price > 0) || !(upper > lower)) return false;
    const mid = (lower + upper) / 2;
    const drift = Math.abs(price - mid) / mid;
    // Round 201: 5% → 3.3% —— 在金 距边界 <1000/3000 就 rebalance（drift 3.17%），
    // 主动 re-center 保仓 = 网格永远围绕当前价，避免冲出去 close 亏损
    if (drift < 0.033) return false;
    const w = upper - lower;
    const newLower = price - w / 2;
    const newUpper = price + w / 2;
    try {
      await this.bots[key].adjustRange({ lower: newLower, upper: newUpper });
      st.lastRecenterAt = now;
      const oldC = ((mid).toFixed(4));
      const newC = ((price).toFixed(4));
      const msg = `${cur.config.displayName} 价格漂离中心 ${(drift * 100).toFixed(1)}%（原中心 ${oldC} → 新中心 ${newC}），adjustRange 平移到 [${newLower.toFixed(4)}, ${newUpper.toFixed(4)}]，持仓保留`;
      st.lastAction = 'recenter';
      st.lastActionReason = msg;
      this._log(key, 'recenter', msg);
      notify(`【网格 Autopilot·跟趋势 recenter】${EXNAMES[key]}\n${msg}\n2 小时冷却期内不再 recenter。`).catch(() => {});
      this._save();
      return true;
    } catch (e) {
      this._log(key, 'recenter-fail', `${cur.config.displayName} recenter 失败：${e?.message || e}`);
      return false;
    }
  }

  async _maybeNarrowRange(key, cur, ex) {
    if (this.cfg.riskStyle === 'conservative') return false;
    const st = this.state[key];
    const now = Date.now();
    if (st.lastNarrowAt && now - st.lastNarrowAt < 2 * 3600_000) return false;
    const marketId = cur.config?.marketId;
    const price = cur.lastPrice;
    const oldLower = Number(cur.config?.lower);
    const oldUpper = Number(cur.config?.upper);
    if (!(price > 0) || !(oldUpper > oldLower)) return false;

    let trend;
    try {
      const candles = await ex.getCandles(marketId, 3600, 200);
      if (!candles || candles.length < 60) return false;
      trend = analyzeTrend(candles);
    } catch { return false; }
    if (!trend || Number(trend.strength) < 0.4) return false;
    if (trend.recommended !== 'long' && trend.recommended !== 'short') return false;

    // Round 146 Bug 2：只在 neutral 模式 OR 趋势跟 bot 方向反了的时候 narrow。
    // 原逻辑不看 bot.config.mode，直接按 trend 方向砍：
    //   long 模式 + 上升趋势 → 砍上方 sell = 砍止盈单 → 多头堆积没退出
    //   short 模式 + 下跌趋势 → 砍下方 buy = 砍止盈单 → 空头堆积没退出
    // 只在下面两种情况才安全 narrow：
    //   (a) neutral：两侧都是 opening + closing 混合，砍逆势侧减风险
    //   (b) 反转：bot=long 但趋势变 short（or vice versa），逆势侧本就该砍
    const botMode = cur.config?.mode || 'neutral';
    const reversed = (botMode === 'long' && trend.recommended === 'short')
                  || (botMode === 'short' && trend.recommended === 'long');
    if (botMode !== 'neutral' && !reversed) {
      this._log(key, 'narrow-skip', `${cur.config?.displayName} ${botMode} 模式跟趋势 ${trend.recommended} 同向，不 narrow（防砍止盈单）`);
      return false;
    }

    let newLower = oldLower, newUpper = oldUpper, dir;
    if (trend.recommended === 'short') {
      // 下跌 → 砍掉当前价以下的挂单（防继续接刀）
      newLower = Math.max(oldLower, price * 0.995);
      if (newLower <= oldLower * 1.001) return false;   // 已经很紧
      dir = '下跌';
    } else {
      // 上升 → 砍掉当前价以上的挂单（防继续追高做空）
      newUpper = Math.min(oldUpper, price * 1.005);
      if (newUpper >= oldUpper * 0.999) return false;
      dir = '上升';
    }
    // 收窄后宽度 sanity check
    if ((newUpper - newLower) / price < 0.005) return false;

    try {
      await this.bots[key].adjustRange({ lower: newLower, upper: newUpper });
      st.lastNarrowAt = now;
      const oldW = ((oldUpper - oldLower) / price * 100).toFixed(2);
      const newW = ((newUpper - newLower) / price * 100).toFixed(2);
      const msg = `${cur.config.displayName} 趋势 ${dir} (strength ${trend.strength})，收窄区间 [${oldLower.toFixed(4)}, ${oldUpper.toFixed(4)}] (${oldW}%) → [${newLower.toFixed(4)}, ${newUpper.toFixed(4)}] (${newW}%)，砍逆势侧挂单，持仓保留`;
      st.lastAction = 'narrow';
      st.lastActionReason = msg;
      this._log(key, 'narrow', msg);
      notify(`【网格 Autopilot·收窄区间】${EXNAMES[key]}\n${msg}\n2 小时冷却期内不再收窄。`).catch(() => {});
      this._save();
      return true;
    } catch (e) {
      this._log(key, 'narrow-fail', `${cur.config.displayName} 收窄失败：${e?.message || e}`);
      return false;
    }
  }

  /**
   * Round 177: Farm mode — delta neutral buy-sell 循环生成 volume。
   *
   * 每 tick 做一 cycle:
   *   1. 选活跃市场（用户配置的 farmMarketId 或自动挑 top hour1Vol）
   *   2. 市价 buy $farmNotional (下限价单，price 1% 高于市价 → 立刻吃)
   *   3. 等 farmCycleSec/2 秒
   *   4. 市价 sell $farmNotional * 2（关多头 + 开空头 = net -$X）
   *   5. 等 farmCycleSec/2 秒
   *   6. 市价 buy $farmNotional * 2（关空头 + 开多头 = net +$X）→ 循环
   *   ...
   *
   * 每 cycle 产生 4 × $farmNotional volume。
   *
   * 简化：不追踪 position，让 exchange 自己算 net。每 tick 只 fire 一对
   * buy-sell（$farmNotional 各一）→ 2 × $farmNotional volume/tick。
   *
   * 15 min tick 间隔 + $100 notional → 4 tick/hour × $200 = $800/hour = $134K/周
   * 缩到 1 min tick + $100 → $12K/hour × 24 × 7 = $2M/周（理论上限，看 fee 够不够撑）。
   *
   * 但 tick 定时器现在是 15 min。Farm 需要更快节拍。用 setInterval per-家。
   */
  async _farmDecideForExchange(key) {
    const ex = this.exchanges[key];
    const bot = this.bots[key];
    const st = this.state[key];
    const cfg = this.cfg.perExchange[key];
    const now = Date.now();
    st.lastDecisionAt = now;

    // 检查交易所健康
    if (ex?.dataSource === 'connecting') { this._log(key, 'farm-skip', '交易所连接中'); return; }
    if (ex?.dataSource === 'synthetic') { this._log(key, 'farm-skip', '合成行情，farm 不能跑'); return; }
    if (ex?.dataSource === 'real-readonly') { this._log(key, 'farm-skip', 'auth 挂了（real-readonly），farm 也别烧'); return; }

    // Round 186：balance guard。BG/BU 用户撤资后 balance=0，farm cycle 每 60s
    // 打一次拒单 log 污染决策面板。$0 直接 skip 并 15min 内不再重试，给用户
    // 明确提示需要充值。避免无限循环 "buy=ERR:insufficient balance"。
    const bal = Number(ex?.balance) || 0;
    // Round 192：farmPnl 跟踪。首次 farm 起始时 snapshot balance，之后每 cycle
    // 计算 pnl = current - startBalance。让用户实时看到 farm mode 的成本累积
    // （spread + fees 摩擦，理论 delta neutral 但不 zero cost）。
    if (!st.farmStartBalance && bal > 0) {
      st.farmStartBalance = bal;
      st.farmStartAt = now;
    }
    const minBalNeeded = Number(cfg.farmNotional || 100) / 10;   // 至少 10x 杠杆能开
    if (bal < minBalNeeded) {
      if (!st.lastLowBalLogAt || now - st.lastLowBalLogAt > 15 * 60_000) {
        this._log(key, 'farm-skip', `余额 $${bal.toFixed(2)} < 需要 $${minBalNeeded.toFixed(2)}（10× 杠杆开 $${cfg.farmNotional}），充值后自动恢复`);
        st.lastLowBalLogAt = now;
      }
      return;
    }

    // Round 179：farm mode 打开时先停 grid bot，防止 40 挂单 grid + farm 双开
    // 导致 API 限流（429）。之前 QC 显示 EX/RS/PL 都有 40 grid orders 挂着 + farm
    // 每 60s 又 fire 2 单，超过所有交易所的 rate limit。
    if (bot?.running) {
      this._log(key, 'farm-stop-grid', `farm mode 打开，停 grid bot 让出 rate limit`);
      try { await bot.stop({ closePosition: true }); }
      catch (e) { this._log(key, 'farm-stop-err', `停 grid 失败：${e?.message || e}`); }
      st.startedByAutopilot = false;
    }

    // Round 179：farm cycle 间隔加长到 180s，避免 rate limit 触发 429
    if (st.lastFarmCycleAt && now - st.lastFarmCycleAt < 180_000) {
      // 180s 内已经跑过，skip
      return;
    }
    st.lastFarmCycleAt = now;

    // 选市场：优先用户配置的 farmMarketId，否则自动挑
    let marketId = cfg.farmMarketId;
    let marketMeta = null;
    if (marketId != null && ex.markets?.get) {
      marketMeta = ex.markets.get(Number(marketId));
    }
    if (!marketMeta) {
      // 自动挑：hour1Vol 最高的（fill 概率高、slippage 少）
      const markets = await ex.getMarkets().catch(() => []);
      if (!markets.length) { this._log(key, 'farm-skip', '无可用市场'); return; }
      // 取第一个有价格的作为兜底
      marketMeta = markets.find((m) => Number(m.lastPrice) > 0) || markets[0];
      marketId = marketMeta.marketId;
    }
    const price = Number(marketMeta.lastPrice);
    if (!(price > 0)) { this._log(key, 'farm-skip', `${marketMeta.displayName} 无价格`); return; }

    // 尺寸：$notional / price = base 量
    const notional = Math.max(10, Math.min(cfg.farmNotional || 100, cfg.maxCapitalUsdc || 500));
    const rawSize = notional / price;
    const stepSize = Number(marketMeta.stepSize) || 1e-6;
    const sizeBase = Math.max(marketMeta.minOrderSize || 0, Math.round(rawSize / stepSize) * stepSize);
    if (!(sizeBase > 0)) { this._log(key, 'farm-skip', `${marketMeta.displayName} 单量为 0`); return; }

    // Round 194: 4 层自动化。
    // Layer 1: farmModeStrategy 每家可配 aggressive/moderate/maker/auto/disabled
    // Layer 2: 'auto' → 每 20 cycles 看 pnl/h，若 < -maxFarmLossHourly 换 mode
    // Layer 4: Circuit breaker - 单日亏 > maxFarmLossDaily 自动 disable
    //
    // Layer 4: 单日亏损熔断
    if (st.farmPnl && st.farmPnl < -Number(cfg.maxFarmLossDaily || 50)) {
      this._log(key, 'farm-disable', `单日亏 $${(-st.farmPnl).toFixed(2)} > $${cfg.maxFarmLossDaily}，自动 disable farmMode`);
      notify(`⚠ ${EXNAMES[key]} farm 单日亏 $${(-st.farmPnl).toFixed(2)} 触发熔断，已自动关闭 farmMode`).catch(() => {});
      this.cfg.perExchange[key].farmMode = false;
      this._save();
      return;
    }
    // Layer 1+2: 从 strategy 选 crossPct
    const MODE_CROSS = { aggressive: 0.01, moderate: 0.001, maker: 0 };
    let strategy = cfg.farmModeStrategy || 'auto';
    if (strategy === 'disabled') { this._log(key, 'farm-skip', 'strategy=disabled'); return; }
    if (strategy === 'auto') {
      // 用 st.autoFarmStrategy 记住当前尝试；初次默认 'moderate'
      strategy = st.autoFarmStrategy || 'moderate';
    }
    const stepPrice = Number(marketMeta.stepPrice) || 0;
    const alignPrice = (p) => stepPrice > 0 ? Math.round(p / stepPrice) * stepPrice : p;
    const crossPct = MODE_CROSS[strategy] ?? 0.001;
    // Layer 2: 每 20 cycles 检查 pnl/h，若太亏就轮换 strategy
    if (cfg.farmModeStrategy === 'auto' && st.farmCycleCount >= 20 && st.farmCycleCount % 20 === 0) {
      const pph = st.farmPnlPerHour || 0;
      if (pph < -Number(cfg.maxFarmLossHourly || 5)) {
        const modes = ['aggressive', 'moderate', 'maker'];
        const cur = modes.indexOf(strategy);
        const next = modes[(cur + 1) % modes.length];
        st.autoFarmStrategy = next;
        st.farmStartBalance = 0;   // reset baseline for new strategy
        st.farmStartAt = 0;
        this._log(key, 'farm-strategy-switch', `pnl/h $${pph.toFixed(2)} < -$${cfg.maxFarmLossHourly}，切 ${strategy}→${next}`);
      }
    }
    const buyPrice = alignPrice(price * (1 + crossPct));
    const sellPrice = alignPrice(price * (1 - crossPct));

    // 用一个自增 coid seq 防重
    if (!st.farmSeq) st.farmSeq = 0;
    st.farmSeq = (st.farmSeq + 1) % 1_000_000;
    const now7 = Date.now() % 1_000_000_0;

    // Round 191: 回归 Round 188 的 buy+sell 同开逻辑。Round 189 让 buy=reduceOnly
    // close short 但账户里没仓 → Round 190 部署后 buy timeout（服务端不响应）。
    // 结论：Perpl netting 允许 buy(t=1)+sell(t=2) 双开（不冲突），关键是 Round 190
    // auto-retry on sr=43 处理"first-fail warmup" pattern。
    const results = { buy: null, sell: null };
    try {
      const buyCoid = Number(`${now7}${String(st.farmSeq).padStart(6, '0')}`);
      results.buy = await ex.placeLimitOrder({
        marketId, side: 'buy', price: buyPrice, sizeBase,
        reduceOnly: false, levelIndex: 0,
        clientOrderId: buyCoid, leverage: 3,
      }).catch((e) => ({ error: e?.message || String(e) }));
    } catch (e) { results.buy = { error: e?.message || String(e) }; }

    // 短暂等，让 buy 上链
    await new Promise((r) => setTimeout(r, 500));

    try {
      st.farmSeq = (st.farmSeq + 1) % 1_000_000;
      const sellCoid = Number(`${now7}${String(st.farmSeq).padStart(6, '0')}`);
      results.sell = await ex.placeLimitOrder({
        marketId, side: 'sell', price: sellPrice, sizeBase,
        reduceOnly: false, levelIndex: 0,
        clientOrderId: sellCoid, leverage: 3,
      }).catch((e) => ({ error: e?.message || String(e) }));
    } catch (e) { results.sell = { error: e?.message || String(e) }; }

    // Round 179：明确暴露 error 全文让用户能诊断（之前 buy=OK 但实际 rate-limited）
    const buyErr = results.buy?.error || (results.buy?.code && results.buy.code !== 0 ? `code=${results.buy.code}` : null);
    const sellErr = results.sell?.error || (results.sell?.code && results.sell.code !== 0 ? `code=${results.sell.code}` : null);
    st.lastAction = 'farm-cycle';
    st.lastActionReason = `${marketMeta.displayName} · $${notional}/边 · buy=${buyErr ? 'ERR:'+String(buyErr).slice(0,50) : 'OK'} · sell=${sellErr ? 'ERR:'+String(sellErr).slice(0,50) : 'OK'}`;
    st.startedByAutopilot = true;
    if (!st.farmCycleCount) st.farmCycleCount = 0;
    st.farmCycleCount++;
    // Round 183：intent volume 跟踪。每次 cycle 双边下单成功 → +2×notional。
    // 独立于 exchange getStats（可能限 500 单窗口 rolling），给用户实时可信指标。
    // 只在两边都 OK 时计数（不然是拒单不是 volume）。
    if (!st.farmIntentVolume) st.farmIntentVolume = 0;
    if (!buyErr && !sellErr) {
      st.farmIntentVolume += notional * 2;
    }
    // Round 192：更新 farmPnl（每次 cycle 后重算 balance drift）
    if (st.farmStartBalance) {
      st.farmPnl = Math.round((bal - st.farmStartBalance) * 100) / 100;
      const hours = Math.max(0.01, (now - (st.farmStartAt || now)) / 3600_000);
      st.farmPnlPerHour = Math.round((st.farmPnl / hours) * 100) / 100;
    }
    this._log(key, 'farm-cycle', st.lastActionReason);
    // Round 180：cycle 后 sync exchange 侧的 volume → stats.volume 增长可见。
    // 之前 farm 走 ex.placeLimitOrder 不经过 bot._handleFill → stats.volume 从
    // 不更新。让 bot._syncExchangeStats 拉 exchange getStats（30d volume window）
    // 覆盖进 stats.volume，用户看到的 volume 数字才涨。
    if (bot && typeof bot._syncExchangeStats === 'function') {
      setImmediate(() => bot._syncExchangeStats().catch(() => {}));
    }
    this._save();
  }

  async _emergencyStop(key, reason) {
    const bot = this.bots[key];
    const st = this.state[key];
    // 只熔断 Autopilot 自己启动的 bot；用户手动开的网格护栏交给用户自己看
    if (!st.startedByAutopilot) {
      st.pausedUntil = Date.now() + 24 * 3600_000;
      st.pausedReason = reason + '（手动网格未平仓，请人工处理）';
      this._log(key, 'skip', st.pausedReason);
      notify(`【网格 Autopilot·⚠ 熔断】${EXNAMES[key]}\n${st.pausedReason}\n未来 24 小时不会自动重启。`).catch(() => {});
      this._save();
      return;
    }
    // Round 281: closePosition true → false · 学 @zaijin338191「绝不手动平仓」·
    //   撤挂单但**保留仓位** · 让市场自己 mean revert 回来吃回损失。24h 后
    //   autopilot 会试重启 grid 环绕当前价 · 让老仓位跟新 grid 一起吃震荡。
    //   风险：BTC 单边下跌不回来 · 仓位 unrealized loss 无限扩大。收益：BTC
    //   通常震荡 · grid 一停一开一次能收回 30-70% 损失。zaijin 16 天 +50%
    //   就是靠这个 hold-through-drawdown 逻辑。
    try { await bot.stop({ closePosition: false }); } catch { /* best effort */ }
    st.startedByAutopilot = false;
    st.pausedUntil = Date.now() + 24 * 3600_000;
    st.pausedReason = reason;
    st.lastAction = 'emergency_stop';
    st.lastActionReason = reason;
    // 24h 熔断复发追踪：3 次以上说明真的市况差，自动取消该所托管，别让用户
    // 陷入「清熔断 → 又熔断 → 又清 → 又熔断」的循环。
    const now = Date.now();
    st.emergencyHistory = (st.emergencyHistory || []).filter((t) => now - t < 24 * 3600_000);
    st.emergencyHistory.push(now);
    this._log(key, 'emergency_stop', reason);
    if (st.emergencyHistory.length >= 3) {
      this.cfg.perExchange[key].enabled = false;
      st.emergencyHistory = [];   // reset 计数：等用户重新勾选托管
      const msg = `24 小时内 3 次熔断，自动取消 ${EXNAMES[key]} 托管`;
      this._log(key, 'auto_disable', msg);
      notify(`【网格 Autopilot·🚫 自动取消托管】${EXNAMES[key]}\n${msg}\n最后一次原因：${reason}\n请人工评估市场情况，确认继续跑再到 UI 里重新勾选托管。`).catch(() => {});
    } else {
      notify(`【网格 Autopilot·⚠ 熔断】${EXNAMES[key]}\n${reason}\n已停网格但**保留仓位**（Round 281 zaijin-style hold）· 24h 内第 ${st.emergencyHistory.length} 次熔断 · 未来 24 小时不自动重启 · 请人工评估是否手动平仓或等回调 · 解除熔断到 UI 点。`).catch(() => {});
    }
    this._save();
  }

  _log(key, action, message) {
    const item = { t: Date.now(), key, exchange: EXNAMES[key] || key, action, message };
    this.decisions.unshift(item);
    if (this.decisions.length > 50) this.decisions.length = 50;
    this._save();
  }

  _save() {
    saveSnapshot('autopilot', { cfg: this.cfg, state: this.state, decisions: this.decisions });
  }
}

// ── 工具 ────────────────────────────────────────────────────────────────────
function _stepAlign(v, step) {
  if (!step || step <= 0) return v;
  const aligned = Math.round(v / step) * step;
  // Round 203: 修 IEEE 754 精度尾巴。9 * 0.0001 = 0.0009000000000000001，
  // Ondo API 严格拒绝，返 "invalid - doesn't snap to min size increment 0.0001"。
  // 用 toFixed 到 step 的小数位截断（step=0.0001 → 4 位）。
  const decimals = String(step).split('.')[1]?.length || 0;
  return Number(aligned.toFixed(decimals));
}
function _modeLabel(m) { return m === 'long' ? '做多' : m === 'short' ? '做空' : '中性'; }
// 清熔断状态 + 日基线：解除熔断时必须一并清 dayStartEquity，否则历史已实现
// 亏损锁在旧 baseline 里，下一 tick 立刻会被日亏损护栏再次触发（Round 20 root cause）。
function _clearBreakerAndBaseline(st) {
  st.pausedUntil = 0;
  st.pausedReason = '';
  st.consecutiveLosses = 0;
  st.lastCheckPnl = null;         // Round 146 Bug 1：重置连亏跟踪基准
  st.dayStartEquity = 0;
  st.dayStartDate = '';
  st.dayStartMode = '';
  st.dayStartDataSource = '';
  st.stoppedMarkets = {};         // Round 197：解除熔断时也清冷却池，让 autopilot 重新自由挑币
}

function _freshExState() {
  return {
    lastDecisionAt: 0,
    lastAction: 'none',
    lastActionReason: '',
    emergencyHistory: [],   // 滚动 24h 熔断时间戳；3 次以上自动取消托管
    dayStartEquity: 0,
    dayStartDate: '',
    dayStartMode: '',        // baseline 打时 ex.mode（paper|live）
    dayStartDataSource: '',  // baseline 打时 ex.dataSource（real|synthetic|connecting）
    lastAppliedEquity: 0,
    consecutiveLosses: 0,
    lastCheckPnl: null,       // Round 146 Bug 1：上次 tick 的 realized，用于连亏计数
    pausedUntil: 0,
    pausedReason: '',
    startedByAutopilot: false,
    lastNarrowAt: 0,          // Round 88 收窄区间冷却
    lastRecenterAt: 0,        // Round 155 B 自动 re-center 冷却
    startedAt: 0,             // Round 121：Autopilot 起单时间戳，用于 no-fill-timeout 计算
    stoppedMarkets: {},       // Round 197：{marketName: stoppedAtMs}，30 分钟冷却防止连选烂币
  };
}
