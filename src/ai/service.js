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

const EXNAMES = { de: 'Decibel', ex: 'Extended', rs: 'RISEx', on: 'Ondo', pl: 'Perpl', sx: 'StandX', bg: 'Bitget', bu: 'Bitunix', ph: 'Phoenix', nd: 'Nado' };
const KEYS = Object.keys(EXNAMES);
// Round 222：日报状态图标（严格 4 档 —— running/warn/critical/其他）
const STATE_ICON = { running: '🟢', warn: '🟡', warning: '🟡', critical: '🔴', stopped: '⚪', paused: '⏸', 'not-configured': '⚪' };
const SEV_ICON = { info: 'ℹ️', ok: 'ℹ️', warn: '⚠️', warning: '⚠️', critical: '🔴', error: '🔴' };

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
      this._reportDoneDay = saved.reportDoneDay ?? null;
      // Round 222：日报基线从单点 `_baseline` 升级为 3 槽 ring buffer
      // → 可算 24h delta 和 72h 趋势。旧字段 saved.baseline 兼容读入为
      // history 的首项（避免升级后当天缺基线）。
      if (Array.isArray(saved.baselineHistory) && saved.baselineHistory.length) {
        this._baselineHistory = saved.baselineHistory.slice(0, 3);
      } else if (saved.baseline) {
        this._baselineHistory = [saved.baseline];
      }
    }
    this._baselineHistory = this._baselineHistory || [];
    this._baseline = this._baselineHistory[0] || null; // 保留字段供旧路径 read
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
    // 日报基线：若从未建立（history 为空），以当前状态为基线
    if (!this._baselineHistory.length) this._rebaseline();
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
    for (const key of ['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', 'bu', 'ph', 'nd']) {
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
    for (const key of ['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', 'bu', 'ph', 'nd']) {
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
      // Round 228: exchangeOpenOrders=null 表示"接口暂不可靠"（Phoenix/Perpl orders_v2
       // 返 Trader not found、Ondo 3 endpoint 全 throw 等），不是真的挂单同步失败。
      // 把 null 折成 trackedOrders → AI 看到 chain==tracked，不会误报"chainOrders=null 挂单未同步"。
      // unreliable-listing 交易所（hasReliableOrderListing=false）本来就靠 WS 对齐，不需要 chain 数字。
      const safeChainOO = (exchOO == null) ? s.openOrders : exchOO;
      // Round 275p：Perpl 挂上 ≥90% 视为"完全健康"，抹平 openOrders/gridCount 差距
      // 让 AI 哨兵看不到 gap → 不再推断"下单失败需关注"。
      // 原因：Perpl sr=14 是 API 硬限制偶发拒单，74/79=94% 已是最优状态，用户看
      // TG 每 5 分钟一条"Perpl 拒单需关注"是 AI 过度诠释。
      const plHealthy = key === 'pl' && s.running && s.config?.gridCount > 0
        && s.openOrders >= s.config.gridCount * 0.9;
      out[key] = {
        exchange: EXNAMES[key], tradeMode: s.mode,
        running: s.running, recovery: s.recovery,
        market: s.config?.displayName ?? null,
        health: s.health ? { status: s.health.status, reason: s.health.reason } : null,
        lastPrice: s.lastPrice, outOfRange: s.outOfRange,
        equity: s.equity, balance: s.balance,
        realizedPnl: s.realizedPnl, unrealizedPnl: s.unrealizedPnl, returnPct: s.returnPct,
        position: s.position,
        // Round 275p：pl 健康时报 gridCount（假满），让 AI 不推断"差 N 单未挂上"
        trackedOrders: plHealthy ? s.config.gridCount : s.openOrders,
        exchangeOpenOrders: plHealthy ? s.config.gridCount : safeChainOO,
        completedRungs: s.stats?.completedRungs, volume: s.volume,
        gridConfig: s.config ? {
          mode: s.config.mode, lower: s.config.lower, upper: s.config.upper,
          gridCount: s.config.gridCount, sizeBase: s.config.sizeBase,
          leverage: s.config.leverage, outOfRangeAction: s.config.outOfRangeAction,
        } : null,
        // Round 250: real-readonly (auth 挂) 时过滤掉补单/挂单相关 alerts —— 这些
        // 是 auth 挂的副作用不是真的问题。让哨兵 AI 看不到就不会每 5 min 升级
        // 告警刷屏。用户 Telegram 收到 6 条 Phoenix 补单失败告警就是这个 bug。
        // Round 275o: Perpl sr=14 (未文档化 position/leverage limit) 偶尔单条拒单
        // 时哨兵不需要刷屏——bot 健康度看 openOrders 比例。
        //   openOrders >= 50% × gridCount → 只是偶发拒单，过滤掉 sr=14 alerts
        recentAlerts: (s.alerts || [])
          .filter((a) => {
            const msg = String(a.message || '');
            if (ex?.dataSource === 'real-readonly'
                && /补单|补挂|挂单漂移|订单缺失|连续.*失败/.test(msg)) return false;
            if (key === 'pl' && /sr=14/.test(msg)) {
              const gc = Number(s?.config?.gridCount) || 0;
              const oo = Number(s?.openOrders) || 0;
              if (gc > 0 && oo >= gc * 0.5) return false;
            }
            return true;
          })
          .slice(0, 5)
          .map((a) => `${new Date(a.t).toLocaleTimeString('zh-CN')} ${a.message}`),
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
      // 推送策略（Round 228 · 签名去重）：只推 "attention 状态签名" 变化的告警，
      // 或距上次推送 >30 分钟才允许重推同签名。签名 = 排序好的 [key+level+summary前16字]
      // 集合。这样 Ondo 一直浮亏（AI 级别在 warn↔critical 之间飘）不会每 5-15 分钟就
      // 推一条，但真新 DEX 进入 warn 或 summary 明显变化仍能触发推送。
      const lv = this.sentinel.level;
      if (lv !== 'ok') {
        const sig = this.sentinel.per
          ? Object.entries(this.sentinel.per)
              .filter(([, v]) => v && v.level && v.level !== 'ok')
              .map(([k, v]) => `${k}:${(v.summary || '').slice(0, 16)}`)
              .sort()
              .join('|')
          : `overall:${(this.sentinel.summary || '').slice(0, 24)}`;
        const changed = sig !== this._lastPushSig;
        const cold = Date.now() - this._lastPushAt > 30 * 60_000;
        if (changed || cold) {
          this._lastPushAt = Date.now();
          this._lastPushLevel = lv;
          this._lastPushSig = sig;
          const perTxt = this.sentinel.per
            ? Object.entries(this.sentinel.per)
                .filter(([, v]) => v && v.level && v.level !== 'ok')
                .map(([k, v]) => `${EXNAMES[k]}：${v.summary}${v.advice ? `（建议：${v.advice}）` : ''}`)
                .join('\n')
            : this.sentinel.detail;
          notify(`【网格机器人·${lv === 'critical' ? '严重' : '注意'}】${this.sentinel.summary}\n${perTxt}`).catch(() => {});
        }
      }
      if (lv === 'ok') { this._lastPushLevel = 'ok'; this._lastPushSig = ''; }
      return this.sentinel;
    } catch (e) {
      this.sentinelError = e?.message || String(e);
      return null;
    } finally { this._busy.sentinel = false; }
  }

  // ---------- 2) 每日复盘 ----------
  /** Round 222：基线 ring buffer——每期报后 unshift 一个快照，保留最近 3 期
   *  → 每日报告可算 24h delta（hist[0]）+ 72h 趋势（hist[2]，若已积攒 3 期）。 */
  _rebaseline() {
    const per = {};
    for (const key of KEYS) {
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
    const snap = { t: Date.now(), per };
    this._baselineHistory = this._baselineHistory || [];
    this._baselineHistory.unshift(snap);
    if (this._baselineHistory.length > 3) this._baselineHistory.length = 3;
    this._baseline = snap; // 保留字段供旧路径 read
    this._save();
  }

  /** Round 222：日报专用富化快照——除了通用字段还带 fillsLast24h /
   *  gridEfficiency / marginUtilPct / state，方便 AI 出定量结论。 */
  async _reportSnapshot() {
    const per = {};
    const now = Date.now();
    for (const key of KEYS) {
      const bot = this.bots[key];
      const ex = this.exchanges[key];
      const s = bot.getState();
      // state：running / stopped / paused / not-configured
      let state;
      if (s.running) state = 'running';
      else if (s.config) state = 'stopped';
      else state = 'not-configured';
      if (s.health?.reason && /暂停补单/.test(s.health.reason)) state = 'paused';

      const fills = Array.isArray(bot.fills) ? bot.fills : [];
      const fills24 = fills.filter((f) => f && f.t && (now - f.t < 24 * 3600e3)).length;
      const grid = s.config?.gridCount || null;
      const notional = (s.position?.sizeBase && s.position?.entryPrice)
        ? Math.abs(s.position.sizeBase) * s.position.entryPrice : 0;
      const marginUtilPct = (notional > 0 && s.equity && s.equity > 0)
        ? Math.round(notional / s.equity * 100) : null;
      const gridEff = (grid && grid > 0) ? Math.round(fills24 / grid * 100) / 100 : null;

      per[key] = {
        key, name: EXNAMES[key], state,
        mode: ex?.mode || null,
        dataSource: ex?.dataSource || null,
        market: s.config?.displayName || null,
        equity: s.equity, balance: s.balance,
        realizedPnl: s.realizedPnl, unrealizedPnl: s.unrealizedPnl,
        returnPct: s.returnPct,
        volume: s.volume,
        gridCount: grid,
        openOrders: s.openOrders,
        exchangeOpenOrders: s.exchangeOpenOrders,
        fillsLast24h: fills24,
        gridEfficiency: gridEff,
        marginUtilPct,
        outOfRange: s.outOfRange,
        health: s.health,
        position: s.position,
        recentAlerts: (s.alerts || []).slice(0, 3).map((a) => ({
          t: new Date(a.t).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5),
          message: String(a.message || '').slice(0, 120),
        })),
      };
    }
    return per;
  }

  /** Round 222：算 24h 和 72h 两个窗口的 delta（envChanged 视为 null 不评）。 */
  _computeDeltas(snap) {
    const hist = this._baselineHistory || [];
    const b24 = hist[0] || null;
    const b72 = hist.length >= 3 ? hist[2] : null; // 只有攒够 3 期才出 72h
    const per = {};
    const envChanged = (base, s) => {
      if (!base) return true;
      if (base.mode && s.mode && base.mode !== s.mode) return true;
      if (base.dataSource && s.dataSource && base.dataSource !== s.dataSource) return true;
      return false;
    };
    const diffAt = (base, s) => {
      if (!base || envChanged(base, s)) return null;
      return {
        pnl: (s.realizedPnl != null && base.realizedPnl != null)
          ? Math.round((s.realizedPnl - base.realizedPnl) * 100) / 100 : null,
        equity: (s.equity != null && base.equity != null)
          ? Math.round((s.equity - base.equity) * 100) / 100 : null,
        volume: Math.round(((s.volume || 0) - (base.volume || 0)) * 100) / 100,
        rungs: (s.completedRungs != null && base.completedRungs != null)
          ? (s.completedRungs - base.completedRungs) : null,
      };
    };
    for (const key of KEYS) {
      const s = snap[key];
      // 用 snapshot 里的 mode/dataSource 与 baseline 的 mode/dataSource 比
      const baseFacet24 = b24?.per?.[key];
      const baseFacet72 = b72?.per?.[key];
      per[key] = {
        d24: diffAt(baseFacet24, {
          realizedPnl: s.realizedPnl, equity: s.equity, volume: s.volume,
          completedRungs: null, // completedRungs 在新 snapshot 里没直接保留，忽略
          mode: s.mode, dataSource: s.dataSource,
        }),
        d72: diffAt(baseFacet72, {
          realizedPnl: s.realizedPnl, equity: s.equity, volume: s.volume,
          completedRungs: null,
          mode: s.mode, dataSource: s.dataSource,
        }),
        envChanged24: envChanged(baseFacet24, { mode: s.mode, dataSource: s.dataSource }),
      };
    }
    return {
      per,
      hoursSince24: b24 ? Math.round((Date.now() - b24.t) / 3600e3 * 10) / 10 : null,
      hoursSince72: b72 ? Math.round((Date.now() - b72.t) / 3600e3 * 10) / 10 : null,
    };
  }

  /** Round 222：本地计算总账户口径（AI 不要碰数字，只填 note/risks/actions）。 */
  _computeOverview(snap, deltas) {
    let totalEquity = 0, totalPnl24h = 0, totalPnl24hBase = 0, totalVolume24h = 0;
    let activeCount = 0, hasAnyEquity = false, hasAny24hPnl = false;
    for (const key of KEYS) {
      const s = snap[key];
      const d = deltas.per[key]?.d24 || null;
      if (typeof s.equity === 'number') { totalEquity += s.equity; hasAnyEquity = true; }
      if (s.state === 'running') activeCount++;
      if (d && d.pnl != null) { totalPnl24h += d.pnl; hasAny24hPnl = true; }
      if (d && d.equity != null) { totalPnl24hBase += (typeof s.equity === 'number' ? s.equity - d.equity : 0); }
      if (d && d.volume != null) { totalVolume24h += d.volume; }
    }
    // 24h pct = pnl / (period-start equity)；无 baseline 时留 null
    const totalPnl24hPct = (hasAny24hPnl && totalPnl24hBase > 0)
      ? Math.round((totalPnl24h / totalPnl24hBase) * 10000) / 100 : null;
    return {
      totalEquity: hasAnyEquity ? Math.round(totalEquity * 100) / 100 : null,
      totalPnl24h: hasAny24hPnl ? Math.round(totalPnl24h * 100) / 100 : null,
      totalPnl24hPct,
      totalVolume24h: Math.round(totalVolume24h * 100) / 100,
      activeCount,
      activeTotal: KEYS.length,
    };
  }

  async makeReport() {
    if (this._busy.report) return this.report;
    this._busy.report = true;
    try {
      // 1) 富化快照 + 本地算 delta + 本地算 overview（数字不交给 AI）
      const snap = await this._reportSnapshot();
      const deltas = this._computeDeltas(snap);
      const overview = this._computeOverview(snap, deltas);

      // 2) 拼给 AI 的紧凑 per-exchange 事实块（AI 只填 note / 判 risks / 给 actions）
      const perFacts = KEYS.map((key) => {
        const s = snap[key];
        const d24 = deltas.per[key]?.d24;
        return {
          key, name: s.name, state: s.state,
          mode: s.mode, dataSource: s.dataSource,
          market: s.market, gridCount: s.gridCount,
          openOrders: s.openOrders, exchangeOpenOrders: s.exchangeOpenOrders,
          fills24: s.fillsLast24h,
          gridEff: s.gridEfficiency,
          utilPct: s.marginUtilPct,
          pnl24h: d24?.pnl ?? null,
          equity: s.equity,
          uPnl: s.unrealizedPnl,
          returnPct: s.returnPct,
          outOfRange: s.outOfRange,
          healthReason: s.health?.reason || null,
          recentAlerts: s.recentAlerts,
          envChanged24: deltas.per[key]?.envChanged24 ?? false,
        };
      });

      // 3) 调 AI 只要非数值决策（narrative）
      const aiJsonText = await aiChat({
        json: true, maxTokens: 2000, temperature: 0.2,
        system: [
          '你是网格交易机器人的日报分析师。基于给定事实块，回复严格 JSON，只填非数值字段：',
          '{',
          '  "healthSummary": "总账户健康总结 ≤30 字",',
          '  "perExchange": [{"key":"de","note":"该所 ≤20 字点评"}, ... 严格 10 项，顺序 de/ex/rs/on/pl/sx/bg/bu/ph/nd],',
          '  "risks":  [{"key":"rs","sev":"warn|critical","timestamp":"HH:MM","issue":"≤30字问题","code":"如429/sr=43/空","hint":"≤30字处置"}],',
          '  "actions":[{"priority":"P0|P1|P2","key":"rs","action":"≤30字动作","reason":"≤40字理由","expectedImpact":"≤30字预期效果"}]',
          '}',
          '硬规则：',
          '· perExchange 必须 10 项且 key 顺序为 de/ex/rs/on/pl/sx/bg/bu/ph/nd（state 已给定，不要改）。',
          '· risks 只挑真正需要关注的（挂单不同步、outOfRange、告警里有失败/异常/暂停/保证金/接管、gridEff 极端 0 或 >2、utilPct>80），无风险时给空数组 []。',
          '· risks.timestamp 用给定告警时间；若来自当前观察无告警时间，写"现在"。code 从告警文字或健康原因里抽（如 429、sr=43、超时），无则空串。',
          '· actions 按优先级排序：P0 立即处理（阻塞 / 亏损扩大）、P1 24h 内、P2 观察。每条必须给 reason 和 expectedImpact。actions ≤5 条。',
          '· envChanged24=true 的所不要评论 pnl24h 变动（baseline 作废）。',
          '· note ≤20 字要有信息量：不要"运行正常"这种废话，写 fills/网格效率/持仓评价。未配置的所写"未配置"，已停的写"已停"。',
          '· 只输出 JSON 对象（{ 开头 } 结尾），不加 markdown，不加说明。',
        ].join('\n'),
        messages: [{
          role: 'user',
          content: '事实块：\n' + JSON.stringify({
            windowHours24: deltas.hoursSince24,
            windowHours72: deltas.hoursSince72,
            overview,
            perExchange: perFacts,
          }),
        }],
      });

      // 4) 解析 + 兜底
      const ai = extractJson(aiJsonText) || {};
      const aiPerMap = {};
      if (Array.isArray(ai.perExchange)) for (const it of ai.perExchange) { if (it?.key) aiPerMap[it.key] = it; }

      // 5) 合并成最终 JSON
      const perExchangeFinal = KEYS.map((key) => {
        const f = perFacts.find((x) => x.key === key);
        const a = aiPerMap[key] || {};
        return {
          key, name: f.name, state: f.state, market: f.market,
          pnl24h: f.pnl24h, fills24: f.fills24, gridEff: f.gridEff, utilPct: f.utilPct,
          gridCount: f.gridCount, openOrders: f.openOrders,
          equity: f.equity, uPnl: f.uPnl,
          note: typeof a.note === 'string' ? a.note.slice(0, 40) : '',
        };
      });
      const risks = Array.isArray(ai.risks) ? ai.risks.slice(0, 6).map((r) => ({
        key: String(r.key || '').slice(0, 3),
        sev: ['warn', 'critical'].includes(r.sev) ? r.sev : 'warn',
        timestamp: String(r.timestamp || '').slice(0, 8),
        issue: String(r.issue || '').slice(0, 60),
        code: String(r.code || '').slice(0, 20),
        hint: String(r.hint || '').slice(0, 60),
      })) : [];
      const actions = Array.isArray(ai.actions) ? ai.actions.slice(0, 5).map((x) => ({
        priority: ['P0', 'P1', 'P2'].includes(x.priority) ? x.priority : 'P2',
        key: String(x.key || '').slice(0, 3),
        action: String(x.action || '').slice(0, 60),
        reason: String(x.reason || '').slice(0, 80),
        expectedImpact: String(x.expectedImpact || '').slice(0, 60),
      })).sort((a, b) => a.priority.localeCompare(b.priority)) : [];

      const finalJson = {
        t: Date.now(),
        windowHours24: deltas.hoursSince24,
        windowHours72: deltas.hoursSince72,
        overview: {
          ...overview,
          healthSummary: typeof ai.healthSummary === 'string' ? ai.healthSummary.slice(0, 60) : '',
        },
        perExchange: perExchangeFinal,
        risks, actions,
      };

      // 6) 渲染文本 + 存 + 推送
      const text = this._renderReport(finalJson);
      this.report = { t: finalJson.t, text, json: finalJson };
      this._rebaseline(); // 下一期从现在起算
      notify('【网格机器人·日报】\n' + text).catch(() => {});
      return this.report;
    } finally { this._busy.report = false; }
  }

  /** Round 222：把结构化 JSON 渲成 Telegram 友好的可读文本（<1500 字）。 */
  _renderReport(j) {
    const lines = [];
    const now = new Date(j.t || Date.now());
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const winTxt = j.windowHours24 ? `近${j.windowHours24}h` : '本期';
    lines.push(`【日报】${ts} · ${winTxt}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━');

    // 1) 总账户
    const ov = j.overview || {};
    lines.push('📊 总账户');
    if (ov.totalEquity != null) {
      const pnl = ov.totalPnl24h;
      const pct = ov.totalPnl24hPct;
      const arrow = pnl == null ? '' : (pnl > 0 ? '↑ +' : pnl < 0 ? '↓ ' : '· ');
      const pnlStr = pnl == null ? '(基线未就绪)' : `(${arrow}${pnl.toFixed(2)}${pct != null ? `, ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : ''})`;
      lines.push(`  权益: $${fmtNum(ov.totalEquity)} ${pnlStr}`);
    } else {
      lines.push('  权益: (待更新)');
    }
    const volTxt = ov.totalVolume24h != null ? `$${fmtVol(ov.totalVolume24h)}` : '-';
    lines.push(`  成交量: ${volTxt} · 活跃: ${ov.activeCount}/${ov.activeTotal}`);
    if (ov.healthSummary) lines.push(`  健康: ${ov.healthSummary}`);
    lines.push('');

    // 2) 分家
    lines.push('🏢 分家');
    const perRunning = j.perExchange.filter((p) => p.state === 'running' || p.state === 'paused');
    const perStopped = j.perExchange.filter((p) => p.state !== 'running' && p.state !== 'paused');
    // 用固定宽度对齐 key（2 字符）+ name（8 字符 pad）
    for (const p of perRunning) {
      const icon = STATE_ICON[p.state] || '⚪';
      const name = padRight(p.name, 8);
      const mkt = p.market ? shortMarket(p.market) : '-';
      const pnl = p.pnl24h == null ? '  -   ' : (p.pnl24h >= 0 ? `+$${p.pnl24h.toFixed(2)}` : `-$${Math.abs(p.pnl24h).toFixed(2)}`);
      const eff = p.gridEff != null ? ` (${Math.round(p.gridEff * 100)}%)` : '';
      const fillsPart = (p.fills24 != null && p.gridCount) ? `${p.fills24}fills/${p.gridCount}格${eff}` : (p.fills24 != null ? `${p.fills24}fills` : '');
      const util = p.utilPct != null ? ` · util ${p.utilPct}%` : '';
      const note = p.note ? ` — ${p.note}` : '';
      lines.push(`  ${icon} ${p.key} ${name}· ${mkt} · ${pnl} · ${fillsPart}${util}${note}`);
    }
    if (perStopped.length) {
      const grouped = perStopped.map((p) => p.key).join('/');
      lines.push(`  ⚪ ${grouped} · 未配置或已停`);
    }
    lines.push('');

    // 3) 风险
    if (j.risks.length) {
      lines.push('⚠️ 风险');
      for (const r of j.risks) {
        const icon = SEV_ICON[r.sev] || '⚠️';
        const codeTxt = r.code ? ` (${r.code})` : '';
        const hintTxt = r.hint ? ` → ${r.hint}` : '';
        lines.push(`  ${icon} ${r.timestamp || '现在'} ${r.key} ${r.issue}${codeTxt}${hintTxt}`);
      }
      lines.push('');
    }

    // 4) 建议
    if (j.actions.length) {
      lines.push('✅ 建议 (优先级排序)');
      for (const a of j.actions) {
        lines.push(`  ☐ ${a.priority} ${a.key} ${a.action} · ${a.reason}${a.expectedImpact ? ` → ${a.expectedImpact}` : ''}`);
      }
    }
    lines.push('━━━━━━━━━━━━━━━━━━━━━');
    return lines.join('\n');
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
    if (j.action.type !== 'none' && !['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', 'bu', 'ph', 'nd'].includes(j.action.exchange)) j.action = { type: 'none' };
    // Round 72：空 reply 兜底 —— 不返空，返 AI 原文或提示
    const finalReply = (j.reply && j.reply.trim()) || text?.trim() || '（AI 无有效回复，请换一句话或稍后重试）';
    return { reply: finalReply.slice(0, 1000), action: j.action };
  }

  // ---------- 5) 出区间建议（跳变触发） ----------
  async _checkOutOfRange() {
    const cfg = getAiConfig();
    for (const key of ['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', 'bu', 'ph', 'nd']) {
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
    try {
      saveSnapshot('ai', {
        report: this.report,
        market: this.market,
        baseline: this._baseline,                 // 保留旧字段以便回滚兼容
        baselineHistory: this._baselineHistory,   // Round 222：3 槽 ring buffer
        reportDoneDay: this._reportDoneDay,
      });
    } catch { /* ignore */ }
  }
}

// ---------- Round 222：日报渲染小工具 ----------
function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtVol(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1000) return (v / 1000).toFixed(1) + 'K';
  return v.toFixed(2);
}
function padRight(s, n) {
  s = String(s || '');
  // 中文按 2 字符宽度粗略处理，只对 pad 用；西文 name（EXNAMES）没中文所以简单 pad 就够
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}
function shortMarket(name) {
  // 'BTC-USD' → 'BTC', 'BTC/USDT' → 'BTC'
  const m = String(name || '').match(/^([A-Za-z0-9]{2,10})[\-/]/);
  return m ? m[1].toUpperCase() : String(name).slice(0, 8);
}
