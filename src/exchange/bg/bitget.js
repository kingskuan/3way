// BitgetExchange (LIVE) — Bitget USDT-M 永续合约 · v2 REST · HMAC-SHA256 auth
//
// 认证方案（v2）：每个 signed 请求 4 个 header
//   ACCESS-KEY         API Key
//   ACCESS-SIGN        base64(HMAC-SHA256(secret, timestamp + method + path + body))
//   ACCESS-TIMESTAMP   毫秒时间戳
//   ACCESS-PASSPHRASE  创建 key 时设的口令（第 3 段凭证，Bitget 特色）
//
// 关键设计：
// • marketId 用递增数字（1,2,3...），symbol 存 map（BTCUSDT / ETHUSDT / ...）
// • 3s REST 轮询代替 WS（Ondo/StandX 都是这套，稳）
// • fill 检测：跟踪本地下过的单，轮询 open orders，消失的 orderId 去查详情
// • 所有 fetch 超时 10s，防止卡死
// • 网络异常降级：静默跳过本轮，等下一 tick，不 crash 主进程
// • productType 固定 USDT-FUTURES，marginCoin 固定 USDT
// • marginMode 默认 isolated（安全优先，用户可以在交易所前端手动改）
//
// 文档：https://www.bitget.com/api-doc/contract/intro
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';

const POLL_MS = 3000;
const BASE_URL = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';
const MARGIN_MODE = 'isolated';
const SUCCESS_CODE = '00000';

// Bitget 优先接入的主流币（避免 500+ 冷门币把内存/API 打爆）。
// 通过 markets 拉全列表后过滤：只保留这里列出的 + 有真实成交量的。
const PREFERRED_SYMBOLS = new Set([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT',
  'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'MATICUSDT',
  'DOTUSDT', 'ATOMUSDT', 'LTCUSDT', 'ARBUSDT', 'OPUSDT',
  'APTUSDT', 'SUIUSDT', 'INJUSDT', 'TIAUSDT', 'NEARUSDT',
]);

export class BitgetExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.passphrase = opts.passphrase;
    this.dataSource = 'connecting';
    this.network = 'mainnet';

    this.markets = new Map();       // marketId(number) -> Market
    this.symbolToId = new Map();    // "BTCUSDT" -> 1
    this.prices = new Map();
    this.orders = new Map();        // orderId -> { orderId, marketId, side, price, sizeBase, ... }
    this.positions = new Map();
    this.balance = 0;
    this.equity = 0;             // Round 143：暴露真 equity
    this.unrealizedPnl = 0;
    this.realizedPnl = null;   // Round 148：见 ondo.js 同 comment
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.stats = null;              // 缓存 getStats 结果

    this._pollTimer = null;
    this._activeMarketId = null;    // Bot 起单时会 setActiveMarket 让 poll 只关注当前市场
  }

  // ── 签名 & 请求 ──────────────────────────────────────────────────────────
  _signHeaders(method, requestPath, bodyStr) {
    const ts = String(Date.now());
    // 注意：requestPath 必须包含 query string（GET 请求）
    const prehash = ts + method.toUpperCase() + requestPath + (bodyStr || '');
    const sig = createHmac('sha256', this.apiSecret).update(prehash).digest('base64');
    return {
      'ACCESS-KEY': this.apiKey,
      'ACCESS-SIGN': sig,
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': this.passphrase,
      'locale': 'en-US',
      'Content-Type': 'application/json',
    };
  }

  async _req(method, requestPath, body = null, timeoutMs = 10000) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = this._signHeaders(method, requestPath, bodyStr);
    const opts = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (bodyStr) opts.body = bodyStr;
    const res = await fetch(`${BASE_URL}${requestPath}`, opts);
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const msg = j?.msg || j?.error || text.slice(0, 160) || `HTTP ${res.status}`;
      throw new Error(`Bitget ${method} ${requestPath} → ${msg}`);
    }
    // Bitget 统一响应 { code, msg, data, requestTime }：code != "00000" 就是错
    if (j?.code && j.code !== SUCCESS_CODE) {
      throw new Error(`Bitget ${method} ${requestPath} → [${j.code}] ${j.msg || 'unknown error'}`);
    }
    return j?.data ?? j;
  }

  async _pubGet(path, timeoutMs = 8000) {
    const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    try {
      const j = await res.json();
      if (j?.code && j.code !== SUCCESS_CODE) return null;
      return j?.data ?? j;
    } catch { return null; }
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  async init() {
    // 1. 拉市场（公开端点）
    const list = await this._fetchMarkets();
    if (!list.length) throw new Error('Bitget: 拉不到市场列表，check 网络代理。');
    this._setMarkets(list);
    for (const [id, m] of this.markets) this.prices.set(id, m.lastPrice);

    // 2. 验证签名有效性（拉账户）
    try {
      const accounts = await this._req('GET', `/api/v2/mix/account/accounts?productType=${PRODUCT_TYPE}`);
      const usdt = Array.isArray(accounts) ? accounts.find((a) => a.marginCoin === MARGIN_COIN) : null;
      if (!usdt) {
        throw new Error(`Bitget: 账户里没有 ${MARGIN_COIN} 保证金账户，去交易所充点 USDT`);
      }
      // Round 143：同 Bitunix，别只用 available（Bitget v2 mix/account 返 usdtEquity
      // 才是"总权益"，available 只是"可下单余额"）。以前一开单 balance 就掉 →
      // Autopilot 日亏损护栏假熔断。
      const usdtEq = Number(usdt.usdtEquity);
      const cUnreal = Number(usdt.crossedUnrealizedPL || 0);
      const iUnreal = Number(usdt.isolatedUnrealizedPL || 0);
      const unreal = cUnreal + iUnreal;
      if (Number.isFinite(usdtEq) && usdtEq > 0) {
        this.equity = usdtEq;
        this.balance = Math.round((usdtEq - unreal) * 100) / 100;
      } else {
        this.balance = Number(usdt.available) || 0;
        this.equity = this.balance + unreal;
      }
      this.unrealizedPnl = unreal;
      console.log(`[Bitget] 初始 balance=${this.balance} equity=${this.equity} USDT (usdtEquity=${usdtEq} unreal=${unreal.toFixed(2)})`);
    } catch (e) {
      throw new Error(
        `Bitget LIVE 认证失败：${e.message}\n` +
        `  检查 BG_API_KEY / BG_SECRET_KEY / BG_PASSPHRASE 是否都正确\n` +
        `  Bitget 特色：需要 3 段凭证（key + secret + passphrase），少一个都会 40009`
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
    // 拉全部 USDT-M 合约元数据（含 tick / min size / max leverage）
    const contractsData = await this._pubGet(`/api/v2/mix/market/contracts?productType=${PRODUCT_TYPE}`);
    const contracts = Array.isArray(contractsData) ? contractsData : [];
    if (!contracts.length) return [];

    // 拉 tickers 拿实时价格
    const tickersData = await this._pubGet(`/api/v2/mix/market/tickers?productType=${PRODUCT_TYPE}`);
    const tickers = Array.isArray(tickersData) ? tickersData : [];
    const priceBySymbol = new Map();
    for (const t of tickers) {
      const p = Number(t.lastPr || t.last || t.close || 0);
      if (p > 0) priceBySymbol.set(t.symbol, p);
    }

    const out = [];
    let nextId = 1;
    this.symbolToId.clear();
    for (const c of contracts) {
      const symbol = c.symbol;
      if (!symbol) continue;
      // 只接主流币（PREFERRED_SYMBOLS）——否则 500+ 冷门合约把 tick/candle poll 打爆
      if (!PREFERRED_SYMBOLS.has(symbol)) continue;
      if (c.symbolStatus && c.symbolStatus !== 'normal') continue;
      const price = priceBySymbol.get(symbol);
      if (!price) continue;

      // Bitget 的 pricePlace / volumePlace 是"小数位数"，priceEndStep 是"最小价格增量倍数"。
      // 真实 stepPrice = priceEndStep * 10^(-pricePlace)。
      const pricePlace = Number(c.pricePlace) || 0;
      const priceEndStep = Number(c.priceEndStep) || 1;
      const volumePlace = Number(c.volumePlace) || 0;
      const stepPrice = priceEndStep * Math.pow(10, -pricePlace);
      const stepSize = Math.pow(10, -volumePlace);
      const minSize = Number(c.minTradeNum) || stepSize;
      const maxLev = Number(c.maxLever) || Number(c.maxCrossedLeverage) || 20;

      const marketId = nextId;
      out.push({
        marketId,
        displayName: symbol,
        symbol: symbol.replace(/USDT$/, ''),
        lastPrice: price,
        stepSize, stepPrice,
        minOrderSize: minSize,
        maxLeverage: maxLev,
      });
      this.symbolToId.set(symbol, marketId);
      nextId++;
    }
    return out;
  }

  _setMarkets(list) {
    this.markets.clear();
    for (const m of list) this.markets.set(m.marketId, m);
  }

  // ── GridBot 接口 ────────────────────────────────────────────────────────
  async getMarkets() { return [...this.markets.values()]; }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) return [];
    // Bitget granularity: 1m/3m/5m/15m/30m/1H/4H/6H/12H/1D/1W/1M
    const gran = intervalSec < 3600 ? `${intervalSec / 60}m`
               : intervalSec === 3600 ? '1H'
               : intervalSec === 14400 ? '4H'
               : intervalSec === 86400 ? '1D'
               : '1H';
    const limit = Math.min(1000, Math.max(50, n));
    const path = `/api/v2/mix/market/candles?symbol=${symbol}&productType=${PRODUCT_TYPE}&granularity=${gran}&limit=${limit}`;
    try {
      const raw = await this._pubGet(path);
      const arr = Array.isArray(raw) ? raw : [];
      // Bitget 返格式：[[timestampMs, open, high, low, close, volumeBase, volumeQuote], ...]
      const out = arr.map((r) => ({
        time: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5] || 0),
      })).filter((c) => Number.isFinite(c.close));
      return out;
    } catch { return []; }
  }

  /**
   * Round 75 兼容：返 exchange-side 真实 volume（不依赖本地 fill event 累积）。
   * Bitget 没有像 Ondo 那样的 portfolio/summary 端点，退化到近 7 天成交历史累加。
   */
  async getStats() {
    // 用 fills history 近似（v2 fills 端点）
    try {
      const endTime = Date.now();
      const startTime = endTime - 30 * 24 * 3600_000;   // 近 30 天
      const path = `/api/v2/mix/order/fills?productType=${PRODUCT_TYPE}&startTime=${startTime}&endTime=${endTime}&limit=100`;
      const r = await this._req('GET', path);
      const list = r?.fillList || r?.list || (Array.isArray(r) ? r : []);
      let vol = 0;
      for (const f of list) {
        const qty = Number(f.baseVolume || f.size || 0);
        const price = Number(f.price || f.priceAvg || 0);
        if (qty > 0 && price > 0) vol += qty * price;
      }
      this.stats = { volume: vol };
      return this.stats;
    } catch { return null; }
  }

  async setLeverage(marketId, leverage) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) return false;
    const lev = Math.max(1, Math.min(125, Math.floor(leverage)));
    try {
      await this._req('POST', '/api/v2/mix/account/set-leverage', {
        symbol,
        productType: PRODUCT_TYPE,
        marginCoin: MARGIN_COIN,
        leverage: String(lev),
      });
      return true;
    } catch (e) {
      // 常见非致命：杠杆未变（同值再设）→ 40806/40405 之类，忽略
      if (/no change|already/i.test(e.message)) return true;
      this.emit('error', new Error(`Bitget setLeverage(${symbol}, ${lev}) 失败：${e.message}`));
      return false;
    }
  }

  async placeLimitOrder(o) {
    const marketId = Number(o.marketId);
    const mkt = this.markets.get(marketId);
    const symbol = mkt?.displayName;
    if (!symbol) throw new Error(`Bitget 未知 marketId=${marketId}`);
    // Round 110：Bitget 严格要求 price 是 stepPrice 的倍数，否则返"price must be
    // multiple of 0.1"。补挂平仓单时 seed 价 66183.78375 直接被拒 5 次。
    const stepPrice = Number(mkt?.stepPrice) || 0;
    const priceSnapped = stepPrice > 0
      ? Math.round(Number(o.price) / stepPrice) * stepPrice
      : Number(o.price);
    // 保留小数精度对齐（stepPrice=0.1 → toFixed(1)）
    const decimals = stepPrice > 0 ? Math.max(0, -Math.floor(Math.log10(stepPrice))) : 8;
    const body = {
      symbol,
      productType: PRODUCT_TYPE,
      marginMode: MARGIN_MODE,
      marginCoin: MARGIN_COIN,
      size: String(o.sizeBase),
      price: priceSnapped.toFixed(decimals),
      side: o.side,           // 'buy' | 'sell'
      orderType: 'limit',
      force: 'gtc',           // Good Till Cancel
      reduceOnly: o.reduceOnly ? 'YES' : 'NO',
    };
    if (o.clientOrderId) body.clientOid = String(o.clientOrderId).slice(0, 64);
    const j = await this._req('POST', '/api/v2/mix/order/place-order', body);
    const orderId = String(j?.orderId || j?.clientOid || '');
    if (!orderId) {
      throw new Error(`Bitget 下单返回无 orderId：${JSON.stringify(j).slice(0, 200)}`);
    }
    this.orders.set(orderId, {
      orderId, marketId, side: o.side,
      price: priceSnapped, sizeBase: Number(o.sizeBase),
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      reduceOnly: !!o.reduceOnly,
    });
    return { orderId };
  }

  async cancelOrder(marketId, orderId) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) { this.orders.delete(String(orderId)); return true; }
    try {
      await this._req('POST', '/api/v2/mix/order/cancel-order', {
        symbol,
        productType: PRODUCT_TYPE,
        marginCoin: MARGIN_COIN,
        orderId: String(orderId),
      });
    } catch (e) {
      // 单可能已成交或撤销过 — 不视为致命
      if (!/not\s?found|already|does not exist|22001|43001/i.test(e.message)) throw e;
    }
    this.orders.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) return true;
    // 官方批量撤（按 symbol）
    try {
      await this._req('POST', '/api/v2/mix/order/cancel-all-orders', {
        symbol,
        productType: PRODUCT_TYPE,
        marginCoin: MARGIN_COIN,
      });
    } catch { /* 忽略，下面兜底逐单 */ }
    // 兜底：exchange-side 拉真实 open orders 逐单撤（防批量 silent 遗留 orphan）
    const exchangeOrders = await this.fetchOpenOrders(Number(marketId)).catch(() => []);
    for (const o of exchangeOrders) {
      const oid = String(o.orderId ?? o.id ?? '');
      if (oid) await this.cancelOrder(Number(marketId), oid).catch(() => {});
    }
    // 清本地跟踪
    for (const [id, o] of this.orders) {
      if (o.marketId === Number(marketId)) this.orders.delete(id);
    }
    return true;
  }

  getOpenOrders(marketId) {
    return [...this.orders.values()].filter((o) => o.marketId === Number(marketId));
  }

  async fetchOpenOrders(marketId) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) return [];
    try {
      const j = await this._req('GET',
        `/api/v2/mix/order/orders-pending?symbol=${symbol}&productType=${PRODUCT_TYPE}&marginCoin=${MARGIN_COIN}`);
      const list = j?.entrustedList || j?.list || (Array.isArray(j) ? j : []);
      return list.map((o) => ({
        orderId: String(o.orderId),
        price: Number(o.price || o.priceAvg),
        side: o.side,
      }));
    } catch { return []; }
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
    try {
      const j = await this._req('GET',
        `/api/v2/mix/position/all-position?productType=${PRODUCT_TYPE}&marginCoin=${MARGIN_COIN}`);
      const list = Array.isArray(j) ? j : (j?.list || []);
      return list.map((p) => {
        const size = Number(p.total || p.size || 0);
        // Bitget holdSide: 'long' | 'short'（one-way 也用这个）
        const signedSize = p.holdSide === 'short' ? -size : size;
        return {
          marketId: this.symbolToId.get(p.symbol) || null,
          sizeBase: signedSize,
          entryPrice: Number(p.openPriceAvg || p.averagePrice || 0),
          unrealizedPnl: Number(p.unrealizedPL || p.upl || 0),
        };
      }).filter((p) => p.marketId);
    } catch { return []; }
  }

  async closePosition(marketId) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) return { closed: false, error: 'unknown market' };
    // Bitget v2 提供 flash-close 端点，一键平指定 symbol 的所有仓
    try {
      const j = await this._req('POST', '/api/v2/mix/order/close-positions', {
        symbol,
        productType: PRODUCT_TYPE,
        // holdSide 不传则平仓 long+short 两边（如果有）
      });
      const list = j?.successList || j?.list || [];
      this.positions.delete(Number(marketId));
      return { closed: true, count: list.length };
    } catch (e) {
      // 没有持仓时可能返错，不视为致命
      if (/no position|22002|43025/i.test(e.message)) {
        this.positions.delete(Number(marketId));
        return { closed: true, empty: true };
      }
      this.emit('error', new Error(`Bitget closePosition(${symbol}) 失败：${e.message}`));
      return { closed: false, error: e.message };
    }
  }

  async reconcileOpenOrders() {
    // GridBot 用不到具体实现；轮询已经在同步了
    return true;
  }

  // Autopilot 调用：告诉适配器"当前只关心这个市场"，减少 poll 拉全量的开销
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
    // 兼容 GridBot 接口（一些 paper 走 start，LIVE 已经在 init 起 polling）
    this._startPolling();
  }

  async _pollTick() {
    // 1. 拉全市场 ticker（一次请求，减少 API 压力）
    try {
      const tickersData = await this._pubGet(`/api/v2/mix/market/tickers?productType=${PRODUCT_TYPE}`);
      if (Array.isArray(tickersData)) {
        for (const t of tickersData) {
          const id = this.symbolToId.get(t.symbol);
          if (!id) continue;
          const p = Number(t.lastPr || t.last || t.close || 0);
          if (p > 0) {
            this.prices.set(id, p);
            const m = this.markets.get(id);
            if (m) m.lastPrice = p;
            this.emit('price', { marketId: id, price: p });
          }
        }
        this.lastOkAt = Date.now();
      }
    } catch { /* ticker 失败不阻塞后续 */ }

    // 2. 拉余额（每 5 轮 = 15s 一次，balance 变得慢）
    this._balanceCounter = (this._balanceCounter || 0) + 1;
    if (this._balanceCounter >= 5) {
      this._balanceCounter = 0;
      try {
        const accounts = await this._req('GET', `/api/v2/mix/account/accounts?productType=${PRODUCT_TYPE}`);
        const usdt = Array.isArray(accounts) ? accounts.find((a) => a.marginCoin === MARGIN_COIN) : null;
        if (usdt) {
          // Round 143：同 init 用 usdtEquity 而不是 available
          const usdtEq = Number(usdt.usdtEquity);
          const cUnreal = Number(usdt.crossedUnrealizedPL || 0);
          const iUnreal = Number(usdt.isolatedUnrealizedPL || 0);
          const unreal = cUnreal + iUnreal;
          if (Number.isFinite(usdtEq) && usdtEq > 0) {
            this.equity = usdtEq;
            this.balance = Math.round((usdtEq - unreal) * 100) / 100;
          } else {
            this.balance = Number(usdt.available) || 0;
            this.equity = this.balance + unreal;
          }
          this.unrealizedPnl = unreal;
        }
      } catch { /* balance 失败不阻塞 */ }
    }

    // 3. 拉持仓（同样 15s 一次）+ fill 检测（对比本地 orders 与 exchange orders）
    if (this._balanceCounter === 0) {   // 跟余额同频
      try {
        const positions = await this.fetchPositions();
        for (const p of positions) {
          if (p.marketId) this.positions.set(p.marketId, p);
        }
      } catch { /* ignore */ }

      // Round 90: Fill 检测扫所有 markets with 本地 orders
      // (之前 gate 在 _activeMarketId 上，bot 从不 setActiveMarket → 永远不触发 →
      //  Bitget 成交记录永远空白，只有 unrealizedPnl 从 position poll 更新)
      if (this.orders.size > 0) {
        const marketIds = new Set();
        for (const o of this.orders.values()) marketIds.add(o.marketId);
        for (const mid of marketIds) {
          try {
            const exchangeOrders = await this.fetchOpenOrders(mid);
            const exchangeIds = new Set(exchangeOrders.map((o) => String(o.orderId)));
            for (const [id, lo] of [...this.orders]) {
              if (lo.marketId !== mid) continue;
              if (!exchangeIds.has(String(id))) {
                // 本地有、exchange 没 → 已成交（或被外部撤了）
                this.emit('fill', {
                  orderId: lo.orderId, marketId: lo.marketId,
                  levelIndex: lo.levelIndex, side: lo.side,
                  price: lo.price, sizeBase: lo.sizeBase,
                  fillPrice: lo.price, fillSize: lo.sizeBase,
                  clientOrderId: lo.clientOrderId,
                });
                this.orders.delete(String(lo.orderId));
              }
            }
          } catch { /* skip this market */ }
        }
      }
    }
  }
}
