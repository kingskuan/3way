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

const EXNAMES = { de: 'Decibel', ex: 'Extended', rs: 'RISEx', on: 'Ondo', pl: 'Perpl' };
const KEYS = ['de', 'ex', 'rs', 'on', 'pl'];

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
    maxLeverage: 8,
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
    // 主开关从 off 切 on：清所有 pausedUntil，相当于"用户已复核并重新开始"。
    // 否则历史熔断（可能来自 balance sync 时的假警报）会永远吊住 Autopilot 不动。
    if (!wasEnabled && c.masterEnabled) {
      let cleared = 0;
      for (const k of KEYS) {
        if (this.state[k].pausedUntil) {
          this.state[k].pausedUntil = 0;
          this.state[k].pausedReason = '';
          this.state[k].consecutiveLosses = 0;
          cleared++;
        }
      }
      if (cleared) this._log('all', 'resume', `主开关重启：清除 ${cleared} 家历史熔断状态`);
    }
    this._save();
    return this.status();
  }

  /** 手动清除某所的熔断状态（用户在 UI 上"我已复核，继续跑"） */
  resumeExchange(key) {
    if (!this.state[key]) return { error: 'unknown exchange: ' + key };
    this.state[key].pausedUntil = 0;
    this.state[key].pausedReason = '';
    this.state[key].consecutiveLosses = 0;
    this._save();
    return this.status();
  }

  /** 一键清除所有熔断状态。UI 兜底按钮。 */
  resumeAll() {
    let cleared = 0;
    for (const k of KEYS) {
      if (this.state[k].pausedUntil) {
        this.state[k].pausedUntil = 0;
        this.state[k].pausedReason = '';
        this.state[k].consecutiveLosses = 0;
        cleared++;
      }
    }
    if (cleared) this._log('all', 'resume', `一键清除 ${cleared} 家熔断状态`);
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
      if (st.dayStartDate !== today) {
        const bot = this.bots[k];
        const ex = this.exchanges[k];
        const s = bot?.getState();
        const eq = s?.equity;
        // 只在读到合法权益时才落基线；LIVE 适配器连接中 / balance 还没同步过来时
        // eq 可能是 0 或 null——这时先不设日期，下一 tick 再试，避免"0 基线永远
        // 触发 100% 亏损"的陷阱。
        const healthy = ex?.dataSource === 'real' && (!ex.lastOkAt || Date.now() - ex.lastOkAt < 120_000);
        if (!healthy || !Number.isFinite(eq) || eq <= 0) continue;
        st.dayStartEquity = eq;
        st.dayStartDate = today;
        st.consecutiveLosses = 0;
      }
    }
    this._save();
  }

  async _decideForExchange(key) {
    const bot = this.bots[key];
    const ex = this.exchanges[key];
    const st = this.state[key];
    const s = STYLES[this.cfg.riskStyle] || STYLES.conservative;
    const now = Date.now();

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
    if (!candidates.length) {
      this._log(key, 'skip', '拉不到 K 线数据，跳过本轮');
      return;
    }

    // 4b. 简单规则打分（不需要 AI 也能跑：震荡 + 波动率适中 = 高分）
    for (const c of candidates) {
      c.score = 0;
      if (c.trend === 'range') c.score += 3;            // 震荡最适合网格
      else c.score += 1;
      if (c.atrPct != null && c.atrPct >= 0.5 && c.atrPct <= 3.0) c.score += 2;  // 波动率适中
      if (c.recommended === 'neutral') c.score += 1;
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
          small: true, json: true, maxTokens: 500, temperature: 0.2,
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
    if (!pick) pick = shortlist[0];
    const mode = pick._aiMode || pick.recommended || 'neutral';

    // 4d. 代码钳制参数到风格允许区间（AI 永远不能自伤）
    const price = pick.price || 0;
    if (!(price > 0)) {
      this._log(key, 'skip', `${pick.name} 暂无有效价格，跳过`);
      return;
    }
    const rangePct = s.rangePct;
    const lower = _stepAlign(price * (1 - rangePct), pick.stepSize);
    const upper = _stepAlign(price * (1 + rangePct), pick.stepSize);
    const capitalUsdc = Math.min(this.cfg.perExchange[key].maxCapitalUsdc || 1000, cur.balance || 1000);
    // 每格数量：capitalUsdc * fraction / price → 转 base asset 单位
    const rawSizeBase = (capitalUsdc * s.sizeFractionOfBalance) / price;
    const sizeBase = Math.max(pick.minOrderSize || 0, _stepAlign(rawSizeBase, pick.stepSize || pick.minOrderSize || 1e-6));
    if (sizeBase <= 0 || !Number.isFinite(sizeBase)) {
      this._log(key, 'skip', `${pick.name} 单量计算异常，跳过`);
      return;
    }
    const leverage = Math.min(s.maxLeverage, pick.maxLeverage || s.maxLeverage);

    // 5. 启动网格
    const params = {
      marketId: pick.marketId, mode,
      lower, upper, gridCount: s.gridCount, sizeBase, leverage,
      outOfRangeAction: s.outOfRangeAction,
    };
    try {
      const res = await bot.start(params);
      st.lastAction = 'started';
      st.lastActionReason = `选 ${pick.name}（${mode}，${aiReasoning || '规则排序 top1'}），区间 ${lower}~${upper}，${s.gridCount} 格 x ${sizeBase}`;
      st.lastDecisionAt = now;
      st.lastAppliedEquity = cur.equity;
      st.startedByAutopilot = true;
      this._log(key, 'start', st.lastActionReason);
      notify(`【网格 Autopilot·${EXNAMES[key]}】已启动：${pick.name}\n模式：${_modeLabel(mode)} · 区间 ${lower} ~ ${upper}\n${s.gridCount} 格 × ${sizeBase} · ${leverage}x 杠杆\nAI：${aiReasoning || '规则排序'}`).catch(() => {});
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
    st.pausedUntil = Date.now() + 24 * 3600_000;    // 24 小时熔断
    st.pausedReason = reason;
    st.lastAction = 'emergency_stop';
    st.lastActionReason = reason;
    this._log(key, 'emergency_stop', reason);
    notify(`【网格 Autopilot·⚠ 熔断】${EXNAMES[key]}\n${reason}\n已停网格并平仓，未来 24 小时不会自动重启。请人工复核后到 UI 里点"解除熔断"恢复。`).catch(() => {});
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
function _freshExState() {
  return {
    lastDecisionAt: 0,
    lastAction: 'none',
    lastActionReason: '',
    dayStartEquity: 0,
    dayStartDate: '',
    lastAppliedEquity: 0,
    consecutiveLosses: 0,
    pausedUntil: 0,
    pausedReason: '',
    startedByAutopilot: false,
  };
}
