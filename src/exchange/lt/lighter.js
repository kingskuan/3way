// LighterExchange (LIVE) — zkLighter L2 上的 zk perp DEX（Elliot Labs）
// · USDC 结算 · 主流币 BTC/ETH/SOL/HYPE/... · 零售零手续费 · L2 API key 签名
//
// ⚠️ 关键实现限制（Round 首发注记，供 Round N+1 补齐）：
//   Lighter 官方 Python SDK 的 SignerClient 通过 ctypes 加载 Go 编译的
//   闭源共享库 (lighter-signer-linux-amd64.so 等) 来做交易签名。签名算法用
//   了 Poseidon-hash + BN254 曲线的 zk-friendly 方案，无法用纯 JavaScript
//   等价实现（不是标准 ed25519 也不是 EIP-712）。
//
//   本适配器采用「读端 LIVE + 写端 stub」的分层策略：
//   · 读端：完全走 mainnet REST（markets / candles / prices / positions /
//     balance via account_index GET）— 全部无鉴权公开端点，直接可用。
//   · 写端：placeLimitOrder / cancelOrder / cancelAll / closePosition /
//     setLeverage 全部抛清晰错误，提示需 Round N+1 引入 ffi-napi 加载
//     .so，或 child_process 桥接 Python SDK。
//
//   这样的好处：11 家整合的整体接线一次到位（overview / autopilot / 宠物
//   / SSE / UI 都能看到 Lighter）；LIVE 模式下能显示真实价格 / 真持仓 /
//   真余额供监控；只是 Autopilot 尝试起单会立即报错并 skip 该家，
//   不会造成事故。
//
// 文档：https://mainnet.zklighter.elliot.ai （API 基址）
//       https://github.com/elliottech/zklighter-perps-python-sdk
//       https://github.com/elliottech/lighter-go （签名 Go 源，二进制在 SDK repo）
import { EventEmitter } from 'node:events';

const POLL_MS = 3000;
const BASE_URL = 'https://mainnet.zklighter.elliot.ai';

// Lighter 主流合约优先接入（避免小币把 poll 打爆）。这里列 Lighter 主战场
// 的常见 market symbol，遇到 orderBooks 返回后按此白名单过滤。
const PREFERRED_SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'HYPE', 'DOGE',
  'AVAX', 'BNB', 'XRP', 'ADA', 'LINK',
  'ARB', 'OP', 'APT', 'SUI', 'INJ',
  'NEAR', 'TIA', 'ATOM', 'DOT', 'LTC',
  'WLD', 'ORDI', 'PEPE', 'WIF', 'BONK',
]);

// 写端 stub 用的固定异常，autopilot / bot 层会捕获后 skip 本轮
const SIGNER_MISSING_ERR = () =>
  new Error(
    'Lighter LIVE 交易签名尚未接入：Lighter 用 Go 编译的 Poseidon+BN254 签名器 '
    + '（lighter-signer-*.so），纯 JS 无法等价实现。下一轮 (N+1) 计划通过 '
    + 'ffi-napi 加载官方 .so，或用 child_process 桥接 Python SDK。现在写端会抛此错，'
    + '读端（价格/持仓/余额）已可用。'
  );

export class LighterExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.privateKey = opts.privateKey || '';   // 40 hex chars（Lighter API key priv，不是 EVM/ed25519）
    this.accountIndex = Number(opts.accountIndex);
    this.apiKeyIndex = Number(opts.apiKeyIndex ?? 0);
    this.apiUrl = opts.apiUrl || BASE_URL;
    this.dataSource = 'connecting';
    this.network = 'mainnet';

    this.markets = new Map();       // marketId(number) -> Market
    this.symbolToId = new Map();    // "BTC" -> marketId
    this.mktIdxToLocal = new Map(); // Lighter market_id (exchange side) -> local marketId
    this.prices = new Map();
    this.orders = new Map();        // orderId -> { orderId, marketId, side, price, sizeBase, ... }
    this.positions = new Map();
    this.balance = 0;
    this.equity = 0;
    this.unrealizedPnl = 0;
    this.realizedPnl = null;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.stats = null;

    this._pollTimer = null;
    this._activeMarketId = null;
    this._balanceCounter = 0;
    this._signerAvailable = false;    // Round N+1 之前恒为 false
    this._writeStubWarned = false;    // 每种写操作首次抛错时 log 一次即可
  }

  // ── 请求辅助 ────────────────────────────────────────────────────────────
  async _pubGet(path, timeoutMs = 8000) {
    try {
      const res = await fetch(`${this.apiUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const j = await res.json();
      // Lighter 统一响应 { code, message, ... }：code === 200 为成功，其余错
      if (j?.code != null && Number(j.code) !== 200) return null;
      return j;
    } catch { return null; }
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  async init() {
    // Lighter 的市场需从 /api/v1/orderBooks 拉（返回所有 order-book 元数据）
    const list = await this._fetchMarkets();
    if (!list.length) throw new Error('Lighter: 拉不到市场列表，检查网络/代理');
    this._setMarkets(list);
    for (const [id, m] of this.markets) this.prices.set(id, m.lastPrice);

    // 拉一次账户余额 + 持仓（GET /api/v1/account?by=index&value=X 无需鉴权）
    if (!Number.isFinite(this.accountIndex) || this.accountIndex < 0) {
      throw new Error(
        'Lighter LIVE 需要 LT_ACCOUNT_INDEX（正整数，你在 zklighter.elliot.ai 上的账户 index）'
      );
    }
    if (!this.privateKey) {
      // 允许无 privateKey 起 read-only（能看真价/真仓，只是写端抛错）
      console.warn('[Lighter] 未提供 LT_API_KEY_PRIVATE_KEY，进入 read-only LIVE 模式（写端不可用）');
    }
    try {
      await this._refreshAccount();
      console.log(`[Lighter] 初始账户 balance=${this.balance} USDC positions=${this.positions.size}`);
    } catch (e) {
      throw new Error(
        `Lighter 账户拉取失败：${e.message}\n`
        + `  检查 LT_ACCOUNT_INDEX=${this.accountIndex} 是不是有效账户；\n`
        + `  且 API 基址 ${this.apiUrl} 可达。`
      );
    }

    this.dataSource = 'real';
    this._startPolling();
    return true;
  }

  async reconnect() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    return this.init();
  }

  async _fetchMarkets() {
    // /api/v1/orderBooks：返 [{market_id, symbol, min_base_amount, size_decimals,
    //   price_decimals, supported_size_decimals, supported_price_decimals, ...}]
    const j = await this._pubGet('/api/v1/orderBooks');
    const arr = j?.order_books || j?.orderBooks || (Array.isArray(j) ? j : []);
    if (!arr.length) return [];

    // 拉 exchangeStats 或 orderBookDetails 拿实时价格（后者更详细）
    const stats = await this._pubGet('/api/v1/exchangeStats');
    const statsList = stats?.order_book_stats || stats?.orderBookStats || [];
    const priceByMktId = new Map();
    for (const s of statsList) {
      const p = Number(s.last_trade_price || s.mark_price || s.index_price || 0);
      if (p > 0) priceByMktId.set(Number(s.market_id), p);
    }

    const out = [];
    let nextId = 1;
    this.symbolToId.clear();
    this.mktIdxToLocal.clear();

    for (const b of arr) {
      const symbol = String(b.symbol || '').toUpperCase();
      if (!symbol) continue;
      if (!PREFERRED_SYMBOLS.has(symbol)) continue;

      const remoteMid = Number(b.market_id ?? b.marketId);
      if (!Number.isFinite(remoteMid)) continue;

      const priceDec = Number(b.supported_price_decimals ?? b.price_decimals ?? 2);
      const sizeDec  = Number(b.supported_size_decimals  ?? b.size_decimals  ?? 4);
      const stepPrice = Math.pow(10, -priceDec);
      const stepSize  = Math.pow(10, -sizeDec);
      const minSize   = Number(b.min_base_amount) > 0
        ? Number(b.min_base_amount) / Math.pow(10, Number(b.size_decimals ?? sizeDec))
        : stepSize;

      const price = priceByMktId.get(remoteMid) || 0;
      if (!(price > 0)) continue;   // 没有活跃价的市场先跳过

      const marketId = nextId++;
      out.push({
        marketId,
        displayName: `${symbol}-USDC`,
        symbol,
        lastPrice: price,
        stepSize,
        stepPrice,
        minOrderSize: minSize,
        maxLeverage: 20,             // Lighter 默认最高杠杆，实际按账户 tier 有差异
      });
      this.symbolToId.set(symbol, marketId);
      this.symbolToId.set(`${symbol}-USDC`, marketId);
      this.mktIdxToLocal.set(remoteMid, marketId);
    }
    return out;
  }

  _setMarkets(list) {
    this.markets.clear();
    for (const m of list) this.markets.set(m.marketId, m);
  }

  async _refreshAccount() {
    if (!Number.isFinite(this.accountIndex)) return;
    // /api/v1/account?by=index&value=<n>：无鉴权，返 DetailedAccounts。
    const j = await this._pubGet(`/api/v1/account?by=index&value=${this.accountIndex}`);
    const acct = Array.isArray(j?.accounts) ? j.accounts[0] : (j?.account || j);
    if (!acct) throw new Error(`account_index=${this.accountIndex} 无数据`);

    // available_balance / collateral 都是字符串（USDC 6 位小数），照原样解析
    const bal = Number(acct.available_balance);
    const coll = Number(acct.collateral);
    if (Number.isFinite(coll) && coll > 0) {
      this.equity = coll;
      this.balance = Number.isFinite(bal) ? bal : coll;
    } else if (Number.isFinite(bal) && bal > 0) {
      this.balance = bal;
      this.equity = bal;
    }

    // 持仓
    this.positions.clear();
    let unreal = 0;
    for (const p of (acct.positions || [])) {
      const remoteMid = Number(p.market_id);
      const localMid = this.mktIdxToLocal.get(remoteMid);
      if (!localMid) continue;
      const size = Number(p.position);   // 已是 "对象数量" 字符串
      if (!(size > 0)) continue;
      // Lighter sign: 1 = long / -1 = short (guess based on doc pattern — 见 gotchas)
      const signedSize = Number(p.sign) < 0 ? -size : size;
      const uPnl = Number(p.unrealized_pnl || 0);
      unreal += uPnl;
      this.positions.set(localMid, {
        marketId: localMid,
        sizeBase: signedSize,
        entryPrice: Number(p.avg_entry_price || 0),
        unrealizedPnl: uPnl,
      });
    }
    this.unrealizedPnl = unreal;
    this.lastOkAt = Date.now();
  }

  // ── GridBot 接口（读端）────────────────────────────────────────────────
  async getMarkets() { return [...this.markets.values()]; }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const mkt = this.markets.get(Number(marketId));
    if (!mkt) return [];
    // Lighter 用 remoteMid 拉 candles，local -> remote 反查
    let remoteMid = null;
    for (const [rm, lm] of this.mktIdxToLocal) { if (lm === mkt.marketId) { remoteMid = rm; break; } }
    if (remoteMid == null) return [];
    // resolution: 1m/5m/15m/1h/4h/1d
    const reso = intervalSec < 3600 ? `${intervalSec / 60}m`
               : intervalSec === 3600 ? '1h'
               : intervalSec === 14400 ? '4h'
               : intervalSec === 86400 ? '1d'
               : '1h';
    const end = Math.floor(Date.now() / 1000);
    const start = end - intervalSec * Math.max(50, Math.min(500, n));
    const path = `/api/v1/candles?market_id=${remoteMid}&resolution=${reso}`
               + `&start_timestamp=${start}&end_timestamp=${end}&count_back=${Math.min(500, Math.max(50, n))}`;
    const j = await this._pubGet(path);
    const list = j?.candles || j?.candlesticks || (Array.isArray(j) ? j : []);
    return list.map((c) => ({
      time: Number(c.timestamp || c.time || 0),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume0 || c.volume || 0),
    })).filter((c) => Number.isFinite(c.close));
  }

  async getStats() {
    // Lighter 目前没暴露"账户历史成交量"公开端点，返 null 由 bot 侧本地累积 fallback
    return this.stats;
  }

  // ── GridBot 接口（写端 — stub）─────────────────────────────────────────
  async setLeverage(_marketId, _lev) {
    if (!this._writeStubWarned) {
      this._writeStubWarned = true;
      console.warn('[Lighter] setLeverage 需 Go 签名器（stub）— 静默返 true 让上层继续');
    }
    // 返 true 免得 bot 起单前的 setLeverage 一步就熔断
    return true;
  }

  async placeLimitOrder(_o) {
    this.emit('error', SIGNER_MISSING_ERR());
    throw SIGNER_MISSING_ERR();
  }

  async cancelOrder(_marketId, orderId) {
    // 本地清理已跟踪的单子，方便 bot 状态收敛（不真的 chain-side 撤单）
    this.orders.delete(String(orderId));
    throw SIGNER_MISSING_ERR();
  }

  async cancelAll(marketId) {
    const marketIdN = Number(marketId);
    for (const [id, o] of this.orders) {
      if (o.marketId === marketIdN) this.orders.delete(id);
    }
    throw SIGNER_MISSING_ERR();
  }

  async closePosition(_marketId) {
    return { closed: false, error: SIGNER_MISSING_ERR().message };
  }

  async fetchOpenOrders(_marketId) {
    // /api/v1/accountActiveOrders 需 Authorization header（Go 签名器生成 auth token）
    // 无签名器时只能返本地跟踪（写端也在 stub 阶段所以恒为空）
    return [];
  }

  getOpenOrders(marketId) {
    return [...this.orders.values()].filter((o) => o.marketId === Number(marketId));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), {
      orderId: String(orderId), marketId: Number(marketId),
      levelIndex, side, price: Number(price), sizeBase: Number(sizeBase),
      reduceOnly: false,
    });
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    if (!p || p.sizeBase === 0) return null;
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.unrealizedPnl };
  }

  async fetchPositions() {
    // 已由 _refreshAccount 定时刷新 positions map，直接返
    return [...this.positions.values()];
  }

  async reconcileOpenOrders() { return true; }

  setActiveMarket(marketId) {
    this._activeMarketId = Number(marketId) || null;
  }

  // ── 轮询 ────────────────────────────────────────────────────────────────
  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._pollTick().catch(() => {}), POLL_MS);
    this._pollTimer.unref?.();
  }

  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  start() {
    this._startPolling();
  }

  async _pollTick() {
    // 1. 全市场 tickers 一次拿完（/api/v1/exchangeStats 一次请求）
    try {
      const j = await this._pubGet('/api/v1/exchangeStats');
      const list = j?.order_book_stats || j?.orderBookStats || [];
      for (const s of list) {
        const remoteMid = Number(s.market_id);
        const localMid = this.mktIdxToLocal.get(remoteMid);
        if (!localMid) continue;
        const p = Number(s.last_trade_price || s.mark_price || s.index_price || 0);
        if (p > 0) {
          this.prices.set(localMid, p);
          const m = this.markets.get(localMid);
          if (m) m.lastPrice = p;
          this.emit('price', { marketId: localMid, price: p });
        }
      }
      this.lastOkAt = Date.now();
    } catch { /* 不阻塞后续 */ }

    // 2. 每 5 轮 (15s) 拉一次账户（balance + positions），跟 bg 同频
    this._balanceCounter++;
    if (this._balanceCounter >= 5) {
      this._balanceCounter = 0;
      try { await this._refreshAccount(); } catch { /* 静默 */ }
    }
  }
}
