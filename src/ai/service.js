// AI 服务：风控哨兵 / 每日复盘 / 市况分析 / 对话操控 / 出区间建议。
//
// 设计原则（安全第一）：
//  1. AI 永远不进交易快回路 —— 下单/补单/对账全部保持纯规则。
//  2. AI 永远不直接执行写操作 —— 对话操控里 AI 只能"提议"动作，由前端弹确认框、
//     用户点确认后走【现有 REST 接口】执行；保证金/杠杆等硬约束仍在 bot 里卡死。
//  3. 所有 AI 调用失败均安全降级（记录错误、不影响交易）。
import { aiChat, extractJson, notify, getAiConfig } from './provider.js';
import { analyzeTrend } from '../trend.js';
import { loadSnapshot, saveSnapshot } from '../persist.js';

const EXNAMES = { de: 'Decibel', ex: 'Extended', rs: 'RISEx', on: 'Ondo', pl: 'Perpl', sx: 'StandX' };

export function createAiService({ bots, exchanges }) {
  return new AiService(bots, exchanges);
}

class AiService {
  constructor(bots, exchanges) {
    this.bots = bots;             // { de, ex, rs, on, pl } -> GridBot
    this.exchanges = exchanges;   // { de, ex, rs, on, pl } -> adapter
    this.sentinel = null;         // 最近一次巡检 {t, level, summary, detail, advice}
    this.sentinelHistory = [];    // 最近 20 条
    this.sentinelError = null;
    this.report = null;           // 最近一次日报 {t, text}
    this.market = null;           // 最近一次 BTC 市况报告 {t, source, market, price, regime, ...}
    this.marketError = null;
    this.oorAdvice = {};          // key -> {t, suggestion, reasoning} 出区间建议
    this._busy = { sentinel: false, report: false, market: false };
    this._lastPushLevel = 'ok';
    this._lastPushAt = 0;
    this._prevOor = {};           // 出区间跳变检测
    this._reportDoneDay = null;
    const saved = loadSnapshot('ai');
    if (saved) {
      this.report = saved.report ?? null;
      this.market = saved.market ?? null;
      this._baseline = saved.baseline ?? null; // 日报基线 {t, per: {de:{equity,stats}}}
      this._reportDoneDay = saved.reportDoneDay ?? null;
    }
    this._baseline = this._baseline || null;
    // Round 71：async analyze/chat 结果缓存
    this._analysisByEx = {};       // { de: {t, result, error?}, ex: {...} }
    this._chatResults = {};         // { jobId: {t, result, error?} }
  }

  /** Round 71：analyze async wrapper — 结果存 _analysisByEx[key] 供前端 poll */
  async analyzeAsync(key, startedAt) {
    this._analysisByEx[key] = { t: startedAt, pending: true };
    try {
      const r = await this.analyze(key);
      this._analysisByEx[key] = { t: Date.now(), result: r };
    } catch (e) {
      this._analysisByEx[key] = { t: Date.now(), error: e?.message || String(e) };
    }
  }

  /** Round 71：chat async wrapper */
  async chatControlAsync(jobId, message, history) {
    this._chatResults[jobId] = { t: Date.now(), pending: true };
    try {
      const r = await this.chatControl(message, history);
      this._chatResults[jobId] = { t: Date.now(), result: r };
    } catch (e) {
      this._chatResults[jobId] = { t: Date.now(), error: e?.message || String(e) };
    }
    // 只保留最近 10 个结果，防内存泄漏
    const keys = Object.keys(this._chatResults);
    if (keys.length > 10) {
      const sorted = keys.map((k) => [k, this._chatResults[k].t]).sort((a, b) => b[1] - a[1]);
      for (const [k] of sorted.slice(10)) delete this._chatResults[k];
    }
  }

  start() {
    // 哨兵主循环：间隔从 env 实时读取（0 = 关闭）；用 1 分钟节拍器驱动，
    // 修改间隔后无需重启。
    this._lastSentinelAt = 0;
    this._timer = setInterval(() => this._tick().catch(() => {}), 60_000);
    this._timer.unref?.();
    // 出区间跳变检测：30s 一次，纯本地比对，只有跳变才调 AI
    this._oorTimer = setInterval(() => this._checkOutOfRange().catch(() => {}), 30_000);
    this._oorTimer.unref?.();
    // 日报基线：若从未建立，以当前状态为基线
    if (!this._baseline) this._rebaseline();
  }

  async _tick() {
    const cfg = getAiConfig();
    if (!cfg.apiKey) return;
    const now = Date.now();
    if (cfg.sentinelMin > 0 && now - this._lastSentinelAt >= cfg.sentinelMin * 60_000) {
      this._lastSentinelAt = now;
      await this.runSentinel().catch(() => {});
    }
    // BTC 市况报告：按设定间隔（重启后若上一份还"新鲜"则等到到期再出，避免重启即刷一次）
    const lastMkt = Math.max(this._lastMarketAt || 0, this.market?.t || 0);
    if (cfg.marketMin > 0 && now - lastMkt >= cfg.marketMin * 60_000) {
      this._lastMarketAt = now;
      await this.runMarketAnalysis().catch(() => {});
    }
    // 日报：到点且今天没生成过
    const d = new Date();
    const day = d.toISOString().slice(0, 10);
    if (cfg.reportHour >= 0 && d.getHours() === cfg.reportHour && this._reportDoneDay !== day) {
      this._reportDoneDay = day;
      this._save();
      await this.makeReport().catch(() => {});
    }
  }

  /**
   * Round 71：kimi/moonshot 处理大 payload 慢（30s+），iOS Safari 30s 硬超时
   * → Load failed。给 kimi 用超简版 snapshot（关键字段），减 70% payload 大小
   * → kimi ~10-15s 返回避免超时。GLM/OpenAI/Claude 支持 response_format 更快，
   * 用完整 snapshot 无压力。
   */
  _isSlowModel() {
    const cfg = getAiConfig();
    // Round 72：apikey.fun 中转平台无论啥 model 都对大 payload 慢+挑剔——
    // 用 compact snapshot 让请求快，避免 iOS 30s Load failed 和 400 Upstream
    // failed。GLM/Claude 走 apikey.fun 也一样。
    if (/apikey\.fun/i.test(cfg.baseUrl || '')) return true;
    return /^(kimi|moonshot|k[23])[-.\/_]?/i.test(cfg.model);
  }

  async _snapshotCompact() {
    const out = {};
    for (const key of ['de', 'ex', 'rs', 'on', 'pl', 'sx']) {
      const s = this.bots[key].getState();
      const pos = s.position?.sizeBase
        ? `${s.position.sizeBase > 0 ? 'long' : 'short'} ${Math.abs(s.position.sizeBase)} @${s.position.entryPrice}`
        : null;
      out[key] = {
        exchange: EXNAMES[key], running: s.running,
        market: s.config?.displayName ?? null,
        health: s.health?.status ?? null, healthReason: s.health?.reason ?? null,
        lastPrice: s.lastPrice, outOfRange: s.outOfRange,
        equity: s.equity, balance: s.balance,
        pnl: s.realizedPnl, uPnl: s.unrealizedPnl, retPct: s.returnPct,
        position: pos,
        openOrders: s.openOrders, chainOrders: s.exchangeOpenOrders,
        completedRungs: s.stats?.completedRungs,
        recentAlert: (s.alerts || [])[0]?.message?.slice(0, 80),
      };
    }
    return out;
  }

  // ---------- 状态快照（喂给 AI 的紧凑上下文） ----------
  async _snapshot() {
    const out = {};
    for (const key of ['de', 'ex', 'rs', 'on', 'pl', 'sx']) {
      const bot = this.bots[key];
      const ex = this.exchanges[key];
      const s = bot.getState();
      // Round 60: bot 停止后 reconcile 定时器停，s.exchangeOpenOrders 保留旧值
      // → sentinel 报"已停止但仍剩 23 单"陈旧信息，用户手动清了也不知道。
      // 停止时若 config 还在（有 marketId 可查），主动 fetchOpenOrders 拉真值。
      let exchOO = s.exchangeOpenOrders;
      if (!s.running && s.config?.marketId != null && typeof ex?.fetchOpenOrders === 'function') {
        try {
          const arr = await Promise.race([
            ex.fetchOpenOrders(s.config.marketId),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
          ]);
          if (Array.isArray(arr)) exchOO = arr.length;
        } catch { /* keep stale value */ }
      }
      out[key] = {
        exchange: EXNAMES[key], tradeMode: s.mode,
        running: s.running, recovery: s.recovery,
        market: s.config?.displayName ?? null,
        health: s.health ? { status: s.health.status, reason: s.health.reason } : null,
        lastPrice: s.lastPrice, outOfRange: s.outOfRange,
        equity: s.equity, balance: s.balance,
        realizedPnl: s.realizedPnl, unrealizedPnl: s.unrealizedPnl, returnPct: s.returnPct,
        position: s.position,
        trackedOrders: s.openOrders, exchangeOpenOrders: exchOO,
        completedRungs: s.stats?.completedRungs, volume: s.volume,
        gridConfig: s.config ? {
          mode: s.config.mode, lower: s.config.lower, upper: s.config.upper,
          gridCount: s.config.gridCount, sizeBase: s.config.sizeBase,
          leverage: s.config.leverage, outOfRangeAction: s.config.outOfRangeAction,
        } : null,
        recentAlerts: (s.alerts || []).slice(0, 5).map((a) => `${new Date(a.t).toLocaleTimeString('zh-CN')} ${a.message}`),
      };
    }
    return out;
  }

  // ---------- 1) 风控哨兵 ----------
  async runSentinel() {
    if (this._busy.sentinel) {
      // Round 70：busy 分支之前不设 sentinelError，服务端 fallback 出现"巡检失败: 巡检失败"
      this.sentinelError = '另一巡检正在运行中（可能上一次未完成或 AI 响应慢），请稍等 30 秒再点。';
      return this.sentinel;
    }
    this._busy.sentinel = true;
    try {
      const snap = this._isSlowModel() ? await this._snapshotCompact() : await this._snapshot();
      const text = await aiChat({
        small: true, json: true, maxTokens: 4000, temperature: 0.1,
        system: [
          '你是五所网格交易机器人的风控值守 AI。根据状态快照，对每个交易所分别给出巡检结论，并给一句整体结论。',
          '重点关注：health.status 为 error/warn 及其 reason；trackedOrders 与 exchangeOpenOrders 明显不一致（挂单同步漂移）；',
          '保证金/权益吃紧（未实现亏损占权益比例大、returnPct 恶化）；outOfRange=true（价格冲出网格区间）；',
          '告警里的关键词（保证金不足、频繁取消、未确认成交、接口异常、暂停补单）；数据长时间未更新。',
          '注意：paper 是模拟盘，问题降级处理；未运行的交易所 level 用 ok、summary 写"未运行"即可。',
          '严格控制字数：整体 summary ≤30 字，每所 summary ≤25 字，advice ≤25 字（无则空串）。JSON 必须完整闭合。',
          // Round 70：Kimi 不支持 response_format=json_object，需要 prompt 强约束
          '⚠ 极其重要：直接从 { 字符开始输出，不要有任何前置文字、不要 markdown 代码块、不要解释。整个响应必须是且仅是一个 JSON 对象。',
          '示例格式：{"overall":{"level":"ok","summary":"..."},',
          '"per":{"de":{"level":"ok|warn|critical","summary":"...","advice":"..."},"ex":{...},"rs":{...},"on":{...},"pl":{...},"sx":{...}}}',
        ].join('\n'),
        messages: [{ role: 'user', content: '状态快照：\n' + JSON.stringify(snap) + '\n\n直接返回 JSON 对象（{ 开始，} 结束），不要任何其他文字。' }],
      });
      const j = extractJson(text);
      // 解析失败（模型截断/格式跑偏）不是"风险事件"，别推 Telegram 假警报。
      // 落到 sentinelError 让 UI 能看到；本轮 sentinel 保留上次结果不覆盖。
      if (!j || !j.overall) {
        // Round 70：把 raw text 前 300 字符 return 给用户看，方便定位是 kimi
        // 返自然语言 / 被截断 / 空返回
        const preview = (text || '').slice(0, 300).replace(/\s+/g, ' ');
        this.sentinelError = `AI 返回无法解析为 JSON（${text ? text.length + '字' : '空返回'}）：${preview || '(无内容)'}`;
        return this.sentinel;
      }
      const overall = j.overall;
      this.sentinel = {
        t: Date.now(),
        level: overall.level || 'ok', summary: overall.summary || '',
        detail: j.detail || '', advice: j.advice || '',
        per: (j.per && typeof j.per === 'object') ? j.per : null,
      };
      this.sentinelHistory.unshift(this.sentinel);
      if (this.sentinelHistory.length > 20) this.sentinelHistory.pop();
      this.sentinelError = null;
      // 推送策略：非 ok 且（级别变化 或 距上次推送>30分钟）才推，避免刷屏
      const lv = this.sentinel.level;
      if (lv !== 'ok' && (lv !== this._lastPushLevel || Date.now() - this._lastPushAt > 30 * 60_000)) {
        this._lastPushAt = Date.now(); this._lastPushLevel = lv;
        const perTxt = this.sentinel.per
          ? Object.entries(this.sentinel.per)
              .filter(([, v]) => v && v.level && v.level !== 'ok')
              .map(([k, v]) => `${EXNAMES[k]}：${v.summary}${v.advice ? `（建议：${v.advice}）` : ''}`)
              .join('\n')
          : this.sentinel.detail;
        notify(`【网格机器人·${lv === 'critical' ? '严重' : '注意'}】${this.sentinel.summary}\n${perTxt}`).catch(() => {});
      }
      if (lv === 'ok') this._lastPushLevel = 'ok';
      return this.sentinel;
    } catch (e) {
      this.sentinelError = e?.message || String(e);
      return null;
    } finally { this._busy.sentinel = false; }
  }

  // ---------- 2) 每日复盘 ----------
  _rebaseline() {
    const per = {};
    for (const key of ['de', 'ex', 'rs', 'on', 'pl', 'sx']) {
      const s = this.bots[key].getState();
      const ex = this.exchanges[key];
      per[key] = {
        equity: s.equity,
        realizedPnl: s.realizedPnl,
        completedRungs: s.stats?.completedRungs || 0,
        volume: s.volume || 0,
        mode: ex?.mode || null,               // Round 50: paper/live
        dataSource: ex?.dataSource || null,   // Round 50: real/synthetic
      };
    }
    this._baseline = { t: Date.now(), per };
    this._save();
  }

  async makeReport() {
    if (this._busy.report) return this.report;
    this._busy.report = true;
    try {
      const snap = this._isSlowModel() ? await this._snapshotCompact() : await this._snapshot();
      const base = this._baseline;
      const diff = {};
      for (const key of ['de', 'ex', 'rs', 'on', 'pl', 'sx']) {
        const b = base?.per?.[key] || {};
        const s = snap[key];
        const ex = this.exchanges[key];
        // Round 50: baseline 打时是 paper（equity=10000 默认值），期间切到 LIVE
        // （equity=$285）→ diff=-$9714 → AI 误判"疑为出金"。检出环境切换后
        // 把该所 diff 全清 null，让 AI 只看当前快照不算增量。
        const modeChanged = b.mode && ex?.mode && b.mode !== ex.mode;
        const dsChanged = b.dataSource && ex?.dataSource && b.dataSource !== ex.dataSource;
        const envChanged = modeChanged || dsChanged;
        diff[key] = envChanged ? {
          equityChange: null, realizedChange: null,
          rungsDone: null, volumeDone: null,
          envChangeNote: `本期内环境从 ${b.mode || '?'}/${b.dataSource || '?'} 切到 ${ex?.mode || '?'}/${ex?.dataSource || '?'}，baseline 作废（勿评论权益变动）`,
        } : {
          equityChange: (s.equity != null && b.equity != null) ? Math.round((s.equity - b.equity) * 100) / 100 : null,
          realizedChange: (s.realizedPnl != null && b.realizedPnl != null) ? Math.round((s.realizedPnl - b.realizedPnl) * 100) / 100 : null,
          rungsDone: (s.completedRungs || 0) - (b.completedRungs || 0),
          volumeDone: Math.round(((s.volume || 0) - (b.volume || 0)) * 100) / 100,
        };
      }
      const sinceHrs = base ? Math.round((Date.now() - base.t) / 3600_000 * 10) / 10 : null;
      const text = await aiChat({
        json: false, maxTokens: 3000, temperature: 0.4,
        system: [
          '你是网格交易机器人的复盘分析师。用简洁的中文写一份运行日报（纯文本,不用 markdown 标题符号）。',
          '内容：1)五所各自的盈亏归因（网格已实现 vs 持仓浮动）；2)成交活跃度与网格参数是否匹配（完成格数、间距）；',
          '3)风险点（保证金、区间边缘、挂单异常）；4)下一步的 1-3 条可执行建议。',
          '数字保留两位小数；paper 为模拟盘要注明；没跑的交易所一句话带过。总长 300 字以内。',
          '如果某所 diff 里带 envChangeNote，说明期内 paper↔live 切换过，baseline 已作废——只报当前快照的状态，绝对不要评论其权益/浮盈"变动"（那是切换假象、不是真出入金）。',
        ].join('\n'),
        messages: [{ role: 'user', content: `统计周期：${sinceHrs != null ? '近 ' + sinceHrs + ' 小时' : '本期'}\n当前快照：${JSON.stringify(snap)}\n周期增量：${JSON.stringify(diff)}` }],
      });
      this.report = { t: Date.now(), text: text.trim() };
      this._rebaseline(); // 下一期从现在起算
      notify('【网格机器人·日报】\n' + this.report.text).catch(() => {});
      return this.report;
    } finally { this._busy.report = false; }
  }

  // ---------- 3) 市况分析 ----------
  /** 核心分析：给定交易所+市场，多周期指标 -> AI 市况判断（analyze 与定时 BTC 报告共用）。 */
  async _regime(key, marketId, ctx = {}) {
    const _t0 = Date.now();
    const ex = this.exchanges[key];
    const market = (await ex.getMarkets()).find((m) => m.marketId === Number(marketId));
    // Round 73：3 个周期 K 线并发拉（原本 sequential 24s，parallel 8s）
    const frames = {};
    const framePairs = [['4小时', 14400], ['1小时', 3600], ['15分钟', 900]];
    await Promise.all(framePairs.map(async ([label, sec]) => {
      try {
        const candles = await ex.getCandles(marketId, sec, 200);
        if (candles?.length >= 30) {
          const a = analyzeTrend(candles);
          frames[label] = { trend: a.trend, slopePct: a.slopePct, atrPct: a.atrPct, emaGap: a.emaFast && a.emaSlow ? Math.round((a.emaFast - a.emaSlow) / a.emaSlow * 10000) / 100 : null };
        }
      } catch { /* 单周期失败可容忍 */ }
    }));
    try { console.log(`[AI] _regime ${key}/${marketId} K 线并发拉完 ${Date.now() - _t0}ms, frames=${Object.keys(frames).length}`); } catch {}
    const price = await ex.getPrice(marketId).catch(() => null);
    // Round 56：K 线全空时不 throw ——用 price + market metadata 出简易分析。
    // Ondo 曾遇 `/v1/perps/history` 端点返 t=[] 空（Round 56 已加 fallback），
    // StandX 也可能因 auth token 过期 / 4h 分辨率不支持导致 3 个周期都空。
    // 与其 UI 弹"拿不到 K 线无法分析"，不如告诉用户"K 线不可用，基于当前价的
    // 通用建议"，仍然有用。
    if (!Object.keys(frames).length) {
      if (!Number.isFinite(price) || !(price > 0)) {
        throw new Error('拿不到足够的K线数据，也拿不到当前价，无法分析。');
      }
      const rangePct = 0.03;
      const lower = Math.round(price * (1 - rangePct) * 100) / 100;
      const upper = Math.round(price * (1 + rangePct) * 100) / 100;
      return {
        t: Date.now(), source: EXNAMES[key], market: market?.displayName, price,
        frames: {},
        regime: '无法判断', suitable: true, recommendMode: 'neutral', confidence: 0.3,
        suggestedRange: { lower, upper }, suggestedGridCount: 20, suggestedSpacingPct: 0.3,
        reasoning: `⚠ 交易所 K 线接口暂时拉不到数据（Ondo/StandX 常见），基于当前价 ${price} 给出通用中性网格建议：区间 ±3%、20 格。请人工核实当前市况是否适合跑网格（震荡好、单边坏）。`,
        caution: 'K 线数据源不可用，无法用指标做严格判断——参数仅供参考，建议等 K 线恢复再决定。',
        fallback: true,
      };
    }
    const text = await aiChat({
      json: true, maxTokens: 2500, temperature: 0.3,
      system: [
        '你是网格交易策略顾问。根据多周期技术指标判断当前市况，并给出网格参数建议。',
        '牢记网格策略的数学本质：震荡市赚钱、单边市亏钱（持仓积累+浮亏）。你的首要任务是判断"当前适不适合跑网格"。',
        '回复 JSON：{"regime":"震荡|上升趋势|下降趋势|剧烈波动","suitable":true/false,',
        '"recommendMode":"neutral|long|short","confidence":0到1,',
        '"suggestedRange":{"lower":数字,"upper":数字},"suggestedGridCount":数字,"suggestedSpacingPct":数字,',
        '"reasoning":"中文分析(150字内)","caution":"中文风险提示(80字内)"}',
        '建议区间要贴合当前价格与波动率（ATR），间距要能覆盖约 0.1% 的往返手续费。',
      ].join('\n'),
      messages: [{
        role: 'user',
        content: `交易所：${EXNAMES[key]}；市场：${market?.displayName}；当前价：${price}\n多周期指标：${JSON.stringify(frames)}`
          + (ctx.gridCfg ? `\n当前网格（若在跑）：${JSON.stringify(ctx.gridCfg)}；运行中：${ctx.running}` : ''),
      }],
    });
    const j = extractJson(text);
    if (!j) throw new Error('AI 返回无法解析：' + text.slice(0, 150));
    return { t: Date.now(), source: EXNAMES[key], market: market?.displayName, price, frames, ...j };
  }

  /** 按需触发：分析某交易所当前配置的市场。 */
  async analyze(key) {
    const bot = this.bots[key], ex = this.exchanges[key];
    if (!bot || !ex) throw new Error('未知交易所: ' + key);
    let marketId = bot.config?.marketId;
    if (marketId == null) marketId = (await ex.getMarkets())[0]?.marketId;
    if (marketId == null) throw new Error('该交易所没有可分析的市场。');
    const st = bot.getState();
    return this._regime(key, marketId, { gridCfg: st.config, running: st.running });
  }

  /** 定时 BTC 市况报告：自动挑一个有真实行情的交易所做数据源。 */
  async runMarketAnalysis() {
    if (this._busy.market) return this.market;
    this._busy.market = true;
    try {
      let src = null, marketId = null;
      for (const key of ['ex', 'de', 'rs', 'on', 'pl']) {
        const ex = this.exchanges[key];
        if (ex.dataSource !== 'real') continue; // 合成行情分析没有意义
        try {
          const ms = await ex.getMarkets();
          const m = ms.find((x) => String(x.symbol || '').toUpperCase() === 'BTC'
            || /^BTC[-/]/.test(String(x.displayName || '').toUpperCase()));
          if (m) { src = key; marketId = m.marketId; break; }
        } catch { /* 换下一个所 */ }
      }
      if (!src) throw new Error('没有可用的真实行情来源（五所均未连接或没有 BTC 市场）。');
      this.market = await this._regime(src, marketId, {});
      this.marketError = null;
      this._save();
      return this.market;
    } catch (e) {
      this.marketError = e?.message || String(e);
      throw e;
    } finally { this._busy.market = false; }
  }

  // ---------- 4) 对话操控（AI 只提议，前端确认后走现有 REST 执行） ----------
  async chatControl(message, history = []) {
    const snap = this._isSlowModel() ? await this._snapshotCompact() : await this._snapshot();
    const text = await aiChat({
      json: true, maxTokens: 2500, temperature: 0.3,
      system: [
        '你是网格交易机器人的操作助手。用户会用中文和你对话，你可以直接回答（基于提供的实时状态快照），',
        '也可以在需要执行操作时提出一个 action 提议（由用户在界面上确认后才会执行，你自己无法执行任何操作）。',
        '可用 action.type：adjust_range(params:{lower,upper}) | stop_grid(params:{closePosition:true/false}) |',
        'cancel_orders | close_position | reconnect | start_recovery(params:{aboveEntryOnly}) |',
        'start_grid(params:{marketId,mode,lower,upper,gridCount,sizeBase,leverage,outOfRangeAction}) | none',
        'action.exchange 取 de|ex|rs|on|pl。一次最多提议一个 action；用户没有明确要操作时 type 用 none。',
        '涉及平仓/停止等不可逆操作时，在 reply 里先说明后果。',
        '回复 JSON：{"reply":"给用户的中文回复","action":{"type":"none","exchange":"de","params":{}}}',
      ].join('\n'),
      messages: [
        ...history.slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) })),
        { role: 'user', content: `【实时状态快照】${JSON.stringify(snap)}\n\n【用户】${String(message).slice(0, 2000)}` },
      ],
    });
    const j = extractJson(text);
    if (!j) {
      // Round 72：extractJson 失败 → AI 返自然语言。返自然语言而不是空回复
      const reply = text?.trim() || '（AI 返回为空，可能上游超时或被拒。换一句话或稍后再试）';
      return { reply: reply.slice(0, 1000), action: { type: 'none' } };
    }
    // 白名单过滤：任何未知 action 一律置为 none
    const ALLOWED = ['adjust_range', 'stop_grid', 'cancel_orders', 'close_position', 'reconnect', 'start_recovery', 'start_grid', 'none'];
    if (!j.action || !ALLOWED.includes(j.action.type)) j.action = { type: 'none' };
    if (j.action.type !== 'none' && !['de', 'ex', 'rs', 'on', 'pl', 'sx'].includes(j.action.exchange)) j.action = { type: 'none' };
    // Round 72：空 reply 兜底 —— 不返空，返 AI 原文或提示
    const finalReply = (j.reply && j.reply.trim()) || text?.trim() || '（AI 无有效回复，请换一句话或稍后重试）';
    return { reply: finalReply.slice(0, 1000), action: j.action };
  }

  // ---------- 5) 出区间建议（跳变触发） ----------
  async _checkOutOfRange() {
    const cfg = getAiConfig();
    for (const key of ['de', 'ex', 'rs', 'on', 'pl', 'sx']) {
      const bot = this.bots[key];
      const cur = !!(bot.running && bot.outOfRange);
      const prev = !!this._prevOor[key];
      this._prevOor[key] = cur;
      if (!cur || prev || !cfg.apiKey) continue; // 只在 false->true 跳变且配了 AI 时触发
      this._adviseOutOfRange(key).catch(() => {});
    }
  }

  async _adviseOutOfRange(key) {
    const bot = this.bots[key], ex = this.exchanges[key];
    const st = bot.getState();
    let frames = {};
    try {
      const candles = await ex.getCandles(bot.config.marketId, 3600, 120);
      if (candles?.length >= 30) { const a = analyzeTrend(candles); frames = { trend: a.trend, slopePct: a.slopePct, atrPct: a.atrPct }; }
    } catch { /* ignore */ }
    const text = await aiChat({
      json: true, maxTokens: 1500, temperature: 0.2,
      system: [
        '网格价格刚冲出区间。根据趋势强度判断最优处置，回复 JSON：',
        '{"suggestion":"close|recover|extend|hold","suggestionText":"中文一句话","reasoning":"中文理由(100字内)"}',
        'close=止损平仓（强单边趋势）；recover=挂只减仓回收阶梯等回调（趋势可能衰竭）；',
        'extend=扩大区间继续跑（假突破/波动放大）；hold=已配置的策略合理无需干预。',
        `注意：该网格已配置的自动策略是 ${st.config?.outOfRangeAction === 'recover' ? '只减仓回收阶梯' : '冲破区间平仓'}，正在自动执行；你的建议是给人工复核参考。`,
      ].join('\n'),
      messages: [{ role: 'user', content: `状态：${JSON.stringify({ market: st.config?.displayName, lastPrice: st.lastPrice, lower: st.config?.lower, upper: st.config?.upper, position: st.position, unrealizedPnl: st.unrealizedPnl, trend: frames })}` }],
    });
    const j = extractJson(text);
    if (!j) return;
    this.oorAdvice[key] = { t: Date.now(), ...j };
    notify(`【网格机器人·出区间】${EXNAMES[key]} ${st.config?.displayName} 价格冲出区间（现价 ${st.lastPrice}）。\nAI 建议：${j.suggestionText || j.suggestion}\n理由：${j.reasoning || ''}\n（已配置的自动策略正在执行，此建议供复核）`).catch(() => {});
  }

  // ---------- 状态/测试 ----------
  async test() {
    const t0 = Date.now();
    const cfg = getAiConfig();
    // Round 66：apikey.fun kimi-k3 依然 Upstream failed（model 名对、temp 0.3
    // 也对）→ 可能是 max_tokens 或某个参数上游拒。用最裸的 payload 直接 fetch
    // 绕开 aiChat 的默认参数，尝试多种组合并返回第一个成功 + 完整 raw response
    // 让用户看清上游到底说啥。
    if (cfg.provider === 'openai' && cfg.apiKey) {
      const attempts = [
        { name: '标准', body: { model: cfg.model, messages: [{ role: 'user', content: '回复"连接正常"四个字。' }], max_tokens: 50, temperature: 0.3 } },
        { name: '无 max_tokens', body: { model: cfg.model, messages: [{ role: 'user', content: '回复"连接正常"四个字。' }], temperature: 0.3 } },
        { name: '大 max_tokens', body: { model: cfg.model, messages: [{ role: 'user', content: '回复"连接正常"四个字。' }], max_tokens: 1024, temperature: 0.7 } },
        { name: '最裸', body: { model: cfg.model, messages: [{ role: 'user', content: 'hi' }] } },
      ];
      const attemptLog = [];
      for (const a of attempts) {
        try {
          const r = await fetch(cfg.baseUrl + '/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(a.body),
            signal: AbortSignal.timeout(30000),
          });
          const text = await r.text();
          let j = null; try { j = JSON.parse(text); } catch {}
          if (r.ok && j?.choices?.[0]?.message?.content) {
            return {
              ok: true, ms: Date.now() - t0,
              model: cfg.model, provider: cfg.provider,
              reply: String(j.choices[0].message.content).slice(0, 100),
              variant: a.name,
              attempts: attemptLog.concat([`${a.name}: HTTP ${r.status} ✓`]),
            };
          }
          attemptLog.push(`${a.name}: HTTP ${r.status} - ${text.slice(0, 200)}`);
        } catch (e) {
          attemptLog.push(`${a.name}: 抛错 ${e?.message || e}`);
        }
      }
      // 全失败 → 拉 /v1/models 附上 available list
      let availableModels = null;
      try {
        const r = await fetch(cfg.baseUrl + '/models', {
          headers: { Authorization: 'Bearer ' + cfg.apiKey },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = await r.json();
          availableModels = (j?.data || []).map((m) => m.id).filter(Boolean);
        }
      } catch { /* skip */ }
      const err = new Error(`4 种 payload 组合全失败\n\n${attemptLog.join('\n\n')}${availableModels ? `\n\n服务商实际可用 model (${availableModels.length}):\n${availableModels.slice(0, 15).join('\n')}` : ''}`);
      throw err;
    }
    // 非 openai 兼容协议：走原来的 aiChat 路径（Anthropic/Gemini）
    try {
      const text = await aiChat({ small: false, maxTokens: 50, temperature: 0.3, messages: [{ role: 'user', content: '回复"连接正常"四个字。' }] });
      return { ok: true, ms: Date.now() - t0, model: cfg.model, provider: cfg.provider, reply: text.slice(0, 50) };
    } catch (e) {
      // Round 64：失败时尝试拉 /v1/models（OpenAI 兼容）列出实际可用 model 名。
      // 用户常见问题："apikey.fun 填了 kimi-k3 报 Upstream request failed"——
      // 大概率是聚合服务的 model id 是 kimi-k2-turbo-preview / moonshot-v1-128k
      // 之类，用户猜的 kimi-k3 不对。返回可用 model 名让用户对照修正。
      let availableModels = null;
      if (cfg.provider === 'openai' && cfg.apiKey) {
        try {
          const r = await fetch(cfg.baseUrl + '/models', {
            headers: { Authorization: 'Bearer ' + cfg.apiKey },
            signal: AbortSignal.timeout(8000),
          });
          if (r.ok) {
            const j = await r.json();
            const ids = (j?.data || []).map((m) => m.id).filter(Boolean);
            if (ids.length > 0) availableModels = ids;
          }
        } catch { /* skip */ }
      }
      const err = new Error(e?.message || String(e));
      if (availableModels) {
        // 优先展示跟当前 model 相关的候选（同前缀 / 同关键词）
        const kw = String(cfg.model || '').toLowerCase().split(/[-_./]/).filter((s) => s.length >= 2);
        const scored = availableModels.map((id) => {
          const low = id.toLowerCase();
          const score = kw.reduce((n, k) => n + (low.includes(k) ? 1 : 0), 0);
          return { id, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, 15).map((x) => x.id);
        err.availableModels = top;
        err.allModelsCount = availableModels.length;
        err.message += `\n\n此服务商实际可用 model 名（Top 15，全部 ${availableModels.length} 个）：\n${top.join('\n')}\n\n若当前配置的 model="${cfg.model}" 不在其中，改成上面某个再测试连接。`;
      }
      throw err;
    }
  }

  status() {
    const cfg = getAiConfig();
    return {
      configured: !!cfg.apiKey,
      provider: cfg.provider, model: cfg.model, modelSmall: cfg.modelSmall,
      baseUrl: cfg.baseUrl,
      // 表单回显用：密钥只回传掩码（绝不回传明文），其余配置原样回传
      apiKeyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 3) + '…' + cfg.apiKey.slice(-4) : '',
      telegramTokenMasked: cfg.telegramToken ? cfg.telegramToken.slice(0, 4) + '…' + cfg.telegramToken.slice(-4) : '',
      telegramChat: cfg.telegramChat, webhook: cfg.webhook,
      sentinelMin: cfg.sentinelMin, marketMin: cfg.marketMin, reportHour: cfg.reportHour,
      notifyChannels: [cfg.telegramToken && cfg.telegramChat ? 'telegram' : null, cfg.webhook ? 'webhook' : null].filter(Boolean),
      sentinel: this.sentinel, sentinelError: this.sentinelError,
      sentinelHistory: this.sentinelHistory.slice(0, 10),
      report: this.report,
      market: this.market, marketError: this.marketError,
      oorAdvice: this.oorAdvice,
    };
  }

  _save() {
    try { saveSnapshot('ai', { report: this.report, market: this.market, baseline: this._baseline, reportDoneDay: this._reportDoneDay }); } catch { /* ignore */ }
  }
}
