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
import { aiChat, extractJson, notify, getAiConfig } from './provider.js';
import { analyzeTrend } from '../trend.js';
import { loadSnapshot, saveSnapshot } from '../persist.js';

const EXNAMES = { de: 'Decibel', ex: 'Extended', rs: 'RISEx', on: 'Ondo', pl: 'Perpl', sx: 'StandX', bg: 'Bitget', bu: 'Bitunix' };
const KEYS = ['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', 'bu'];

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
    rangePct: 0.03,
    gridCount: 24,
    // Round 119：用户要每格 ~$30 notional。fraction 0.04 → 0.10 (×2.5)：
    //   $300 balance × 0.10 = $30/grid（EX/PL/其他）
    //   $700 Bitget × 0.10 = $70/grid（受惠更多，Bitget 高余额充分利用）
    // 24 格总 notional：24 × $30 = $720 (EX/PL), 24 × $70 = $1680 (BG)
    // 保证金占用：10x → 24%, 12x → 20%, 15x → 16%（BG 因 15x + 高余额，占 11%）
    sizeFractionOfBalance: 0.10,
    maxLeverage: 15,   // Round 81：用户要 15x（Round 37 是 10x, 更早 8x）。
                       // 15x × 3% 区间边缘 = 45% 亏损，护栏 dailyLossPctLimit 必须
                       // 放宽给 15x 网格留跑动空间。
                       // Round 123：8% → 12%。Round 119 每格 $30 (0.10 fraction)
                       // 让 total notional × 3x，一次 4% 反向 = 8% equity loss 就
                       // 触发熔断（SX 03:09 就这样炸了）。12% 允许 6% 反向单边
                       // 才熔断，对应网格走到 1/3 区间——仍在 exceed 前拦住雪崩。
                       // 单币 maxLeverage 上限仍由 exchange 决定（很多币 <=20x）。
    dailyLossPctLimit: 12,
    consecutiveLossLimit: 4,
    outOfRangeAction: 'recover',
  },
};

// 默认配置：主开关 off，五所全部 enabled=false。用户在 UI 里勾选启用。
const DEFAULT_CFG = () => ({
  masterEnabled: false,
  riskStyle: 'conservative',
  decisionIntervalMin: 15,
  perExchange: Object.fromEntries(KEYS.map((k) => [k, { enabled: false, maxCapitalUsdc: 1000 }])),
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
    // 启动时立即跑一次日基线更新（如果需要）
    this._maybeRebaseline();
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
      if (now - this._lastTickAt < this.cfg.decisionIntervalMin * 60_000) return;
      this._lastTickAt = now;
      for (const k of KEYS) {
        if (!this.cfg.perExchange[k].enabled) continue;
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
    const s = STYLES[this.cfg.riskStyle] || STYLES.conservative;
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
    if (stale) {
      this._log(key, 'skip', `交易所数据 ${Math.round((now - ex.lastOkAt) / 1000)}s 未更新，跳过本轮`);
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

    // 3. Bot 已跑同一市场？V1：不换币，只在冲出区间时才干预。
    //    仅动 Autopilot 自己启动的网格；用户手动开的网格 Autopilot 绝不会 stop/reopen，
    //    避免把用户手动挂的策略意外平掉。
    if (cur.running) {
      if (!st.startedByAutopilot) {
        this._log(key, 'skip', `${cur.config.displayName} 由用户手动启动，Autopilot 不接管`);
        return;
      }
      if (cur.outOfRange) {
        this._log(key, 'stop', `${cur.config.displayName} 冲出区间，停网格准备重开`);
        await bot.stop({ closePosition: true }).catch(() => {});
        st.startedByAutopilot = false;
      } else {
        // Round 121：30 分钟未成交 → 停 bot + 换币重选
        // 用最近 fill 时间 vs 起单时间的更晚者做基准。cur.fills 已按时间倒序（fills[0] 最新）。
        const lastActivity = Number(cur.fills?.[0]?.t) || st.startedAt || 0;
        const noFillMinutes = lastActivity > 0 ? Math.round((now - lastActivity) / 60_000) : 0;
        if (lastActivity > 0 && noFillMinutes >= 30) {
          this._log(key, 'stop-idle', `${cur.config.displayName} ${noFillMinutes} 分钟无成交，停网格换币重选`);
          await bot.stop({ closePosition: true }).catch(() => {});
          st.startedByAutopilot = false;
          st.startedAt = 0;
          // 继续往下走选币逻辑，直接重开
        } else {
          // Round 88：仍在区间内 → 检查是否需要"收窄区间"应对趋势反转。
          // conservative 已经全平（outOfRangeAction=close），只对 balanced/aggressive
          // 做这个中间态干预。narrowed 就 skip 本 tick（等下一 tick 再评估）。
          const narrowed = await this._maybeNarrowRange(key, cur, ex).catch(() => false);
          if (narrowed) return;
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
    const candidates = [];
    for (const m of markets.slice(0, 8)) {   // 限 top-8 减少 API 压力
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
          minOrderSize: m.minOrderSize, stepSize: m.stepSize, maxLeverage: m.maxLeverage,
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
          minOrderSize: m.minOrderSize, stepSize: m.stepSize, maxLeverage: m.maxLeverage,
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
      if (c.atrPct != null && c.atrPct >= 0.5 && c.atrPct <= 3.0) c.score += 2;   // 波动率适中
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
    candidates.sort((a, b) => b.score - a.score);
    const shortlist = candidates.slice(0, 5);

    // 4c. AI 从 shortlist 里挑一个 + 出参数（可选，AI 挂了也能 fallback）
    let pick = null;
    let aiReasoning = '';
    try {
      const cfg = getAiConfig();
      if (cfg.apiKey) {
        const text = await aiChat({
          small: true, json: true, maxTokens: 1500, temperature: 0.2,
          system: [
            '你是自动网格交易的 AI 选币器。从候选里挑一个最适合网格的市场。',
            '返回 JSON：{"marketId":<数字>,"mode":"neutral|long|short","reason":"<20字内中文>"}',
            '规则（Round 109 重写）：',
            '① 如有候选 strength >= 0.4 且 recommended 是 long/short，优先挑它 + 用 recommended 做 mode（跟趋势）。',
            '② 否则选 recommended=neutral 且 atrPct 0.5-3.0 的做中性网格。',
            '③ 不确定就选第一个（分数最高的）。',
          ].join(''),
          messages: [{ role: 'user', content: '候选：\n' + JSON.stringify(shortlist) }],
        });
        const j = extractJson(text);
        if (j && j.marketId != null) {
          pick = shortlist.find((c) => String(c.marketId) === String(j.marketId));
          aiReasoning = String(j.reason || '').slice(0, 80);
          if (pick && ['neutral', 'long', 'short'].includes(j.mode)) pick._aiMode = j.mode;
        }
      }
    } catch { /* AI 挂了没关系，走 fallback */ }
    // 把 AI/规则选中的 pick 放到 shortlist 最前面，其他按分数留在后面作为 fallback。
    // Perpl 那种「首选 BTC 但 $210 只够 MON/SOL/ETH」的场景：主选不 afford 就依次
    // 往下试，选出第一个能塞进保证金的市场。
    const rankedList = pick ? [pick, ...shortlist.filter((c) => c !== pick)] : shortlist.slice();

    // 4d. 代码钳制参数到风格允许区间（AI 永远不能自伤）
    const capitalUsdc = Math.min(this.cfg.perExchange[key].maxCapitalUsdc || 1000, cur.balance || 1000);
    const budget = capitalUsdc * 0.8;   // 保留 20% buffer

    let params = null;
    let picked = null;
    let pickedGridCount = s.gridCount;
    let pickedSizeBase = 0;
    let pickedLower = 0, pickedUpper = 0;
    let pickedLeverage = s.maxLeverage;
    const rejections = [];   // 记每个候选被 skip 的原因，方便最后统一 log

    for (const c of rankedList) {
      const price = c.price || 0;
      if (!(price > 0)) { rejections.push(`${c.name}:无价格`); continue; }
      // Round 133：近 1h 跌 >2% 跳过这个候选（不整轮 return，往下一个试）。
      // 之前 Round 20 在 rankedList 循环外单独 check，一个候选跌就整轮 skip；
      // 结果 Bitunix 因 ADAUSDT 跌 6% 一整个 tick 都没起，剩 4 个不下跌的没试。
      if (c.hour1DropPct != null && c.hour1DropPct < -2) {
        rejections.push(`${c.name}:近1h跌${c.hour1DropPct.toFixed(2)}%`);
        continue;
      }
      // Round 140：死鱼盘 skip —— 若市场自身近 1h 成交 < $5k，中性网格挂两侧
      // 大概率吃不到，浪费保证金 + 30 分钟 idle 才会 stop-idle 换币。前置拒。
      if (c.hour1Vol != null && c.hour1Vol > 0 && c.hour1Vol < 5000) {
        rejections.push(`${c.name}:1h 成交仅 $${c.hour1Vol.toFixed(0)}，市场太冷`);
        continue;
      }
      const rangePct = s.rangePct;
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
      const leverage = Math.min(s.maxLeverage, c.maxLeverage || s.maxLeverage);
      const stepUnit = c.stepSize || c.minOrderSize || 1e-6;
      const rawSizeBase = (capitalUsdc * s.sizeFractionOfBalance) / price;
      let sizeBase = Math.max(c.minOrderSize || 0, _stepAlign(rawSizeBase, stepUnit));
      if (sizeBase <= 0 || !Number.isFinite(sizeBase)) { rejections.push(`${c.name}:单量异常`); continue; }

      const mid = (lower + upper) / 2;
      let gridCount = s.gridCount;
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
        this._log(key, 'skip', `${pick.name} 起单前清残留失败：${e?.message || e}，跳过本轮避免叠加挂单`);
        return;
      }
      const res = await bot.start(params);
      // 起单后 3s 让适配器同步 place 结果，再读实际挂上多少
      await new Promise((r) => setTimeout(r, 3000));
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
      }
      const rateNote = (actual < gridCount * 0.75)
        ? `（仅挂上 ${actual}/${gridCount}，成功率低${failReason}）` : '';
      st.lastActionReason = `选 ${pick.name}（${mode}，${aiReasoning || '规则排序 top1'}），区间 ${lower}~${upper}，${gridCount} 格 x ${sizeBase}${rateNote}`;
      // lastDecisionAt 已在函数入口刷新（Round 50），这里不再重复设置
      st.lastAppliedEquity = cur.equity;
      st.startedByAutopilot = true;
      st.startedAt = Date.now();   // Round 121：给 no-fill-timeout 30 分钟计时起点
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
    try { await bot.stop({ closePosition: true }); } catch { /* best effort */ }
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
      notify(`【网格 Autopilot·⚠ 熔断】${EXNAMES[key]}\n${reason}\n已停网格并平仓（24h 内第 ${st.emergencyHistory.length} 次熔断），未来 24 小时不会自动重启。请人工复核后到 UI 里点"解除熔断"恢复。`).catch(() => {});
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
  return Math.round(v / step) * step;
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
    startedAt: 0,             // Round 121：Autopilot 起单时间戳，用于 no-fill-timeout 计算
  };
}
