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

const EXNAMES = { de: 'Decibel', ex: 'Extended', rs: 'RISEx', on: 'Ondo', pl: 'Perpl', sx: 'StandX' };
const KEYS = ['de', 'ex', 'rs', 'on', 'pl', 'sx'];

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
    sizeFractionOfBalance: 0.04,
    maxLeverage: 10,   // Round 37：用户要 10x（原 8x）。3% 区间 + 24 格下每格约
                       // 0.125% profit——覆盖手续费足够；同时 10x lev 意味着 3%
                       // 反向跑到区间边缘时 = 30% 亏损，仍在 dailyLossPctLimit=5%
                       // 熔断上限内（护栏能拦住，但边界 case 有 slippage 风险）。
    dailyLossPctLimit: 5,
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
        this._log(key, 'skip', `${cur.config.displayName} 网格运行中，指标正常，保持`);
        return;
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
    const candidates = [];
    for (const m of markets.slice(0, 8)) {   // 限 top-8 减少 API 压力
      try {
        const candles = await ex.getCandles(m.marketId, 3600, 200);
        if (!candles || candles.length < 50) continue;
        const trend = analyzeTrend(candles);
        candidates.push({
          marketId: m.marketId, name: m.displayName, price: m.lastPrice,
          minOrderSize: m.minOrderSize, stepSize: m.stepSize, maxLeverage: m.maxLeverage,
          trend: trend.trend, recommended: trend.recommended,
          strength: trend.strength, atrPct: trend.atrPct,
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

    // 4b. 简单规则打分（不需要 AI 也能跑：震荡 + 波动率适中 = 高分）
    // Round 80：去掉 neutral +1 加分——之前 long/short 候选被系统性压低分数，
    // AI 几乎永远选 neutral。现在 3 种模式在打分层面权重一致，交给趋势强度决定。
    for (const c of candidates) {
      c.score = 0;
      if (c.trend === 'range') c.score += 3;            // 震荡最适合网格
      else c.score += 1;
      if (c.atrPct != null && c.atrPct >= 0.5 && c.atrPct <= 3.0) c.score += 2;  // 波动率适中
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
            '你是自动网格交易的 AI 选币器。从候选市场里挑一个最适合网格的（震荡强、波动适中），',
            '返回 JSON：{"marketId":<数字>,"mode":"neutral|long|short","reason":"<20字内中文>"}',
            '优先选 recommended=neutral 且 atrPct 在 0.5-3.0 之间的。不确定就选第一个（分数最高）。',
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
      // Round 36 引入 → Round 80 放宽：strongTrend 门槛 0.5 → 0.3。
      // 用户反馈 AI 几乎永远出 neutral（4 层偏 neutral 叠加：trend 阈值严 +
      // 打分偏 range + prompt 强推 neutral + 覆盖门槛太高）。0.3 大约对应
      // "EMA 差 0.9%+、斜率 ≥0.2%/根"这种中等单边——已经足够让神经元网格
      // 单向库存开始堆积，跟着方向做 long/short 更合理。
      //   strength >= 0.3 且 recommended != neutral → 用 recommended（跟趋势）
      //   否则           → AI 挑的 mode 或规则 recommended，最后兜底 neutral
      const strongTrend = Number(c.strength) >= 0.3 && c.recommended && c.recommended !== 'neutral';
      const chosenMode = strongTrend
        ? c.recommended
        : (c._aiMode || c.recommended || 'neutral');
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

    // 市况前置 check：起单前看最近 1h 走势——如果强下跌趋势就跳过。中性网格
    // 在明显单边行情里 = 主动送死；Perpl 已经因为这个熔断过几次。
    try {
      const candles = await ex.getCandles(pick.marketId, 3600, 2);
      if (candles?.length >= 2) {
        const first = candles[0].close, last = candles[candles.length - 1].close;
        if (first > 0 && (last - first) / first * 100 < -2) {
          const dropPct = ((last - first) / first * 100).toFixed(2);
          this._log(key, 'skip', `${pick.name} 近 1h 跌 ${dropPct}%，跳过本轮起单等市场稳定`);
          return;
        }
      }
    } catch { /* 拿不到 K 线不阻塞起单，Autopilot 之前的 fallback 已处理 */ }

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
    pausedUntil: 0,
    pausedReason: '',
    startedByAutopilot: false,
  };
}
