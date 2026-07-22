// BitunixExchange (LIVE) — Bitunix USDT-M 永续合约 · REST · Double-SHA256 auth
//
// 认证方案（Bitunix 特色，不是标准 HMAC）：
//   digest = SHA256(nonce + timestamp + api-key + queryParams + body)
//   sign   = SHA256(digest + secretKey)
//   两次 hex-encoded SHA256，不带 HMAC。secretKey 只在第二次里当"盐"用。
//   headers 4 个：api-key / nonce / timestamp / sign
//
// 关键设计（跟 Bitget 一致）：
// • marketId 用递增数字（1,2,3...），symbol 存 map（BTCUSDT / ETHUSDT / ...）
// • 3s REST 轮询代替 WS（Bitunix WS 复杂且非必需）
// • fill 检测：跟踪本地下过的单，轮询 open orders，消失的 orderId 触发 fill event
// • 所有 fetch 超时 10s
// • productType/marginCoin 固定 USDT
// • Bitunix responseCode: `code: 0` 是成功，跟 Bitget 的 "00000" 字符串不同
// • K 线返格式是对象数组 [{open, high, close, low, time, ...}]，不是 tuple
// • 订单 side 大写: "BUY"/"SELL"；orderType "LIMIT"；effect "GTC"
//
// 文档：https://www.bitunix.com/api-docs/futures/
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';

const POLL_MS = 3000;
const BASE_URL = 'https://fapi.bitunix.com';
const MARGIN_COIN = 'USDT';

// 主流币白名单（避免 500+ 冷门币把 poll 打爆）
const PREFERRED_SYMBOLS = new Set([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT',
  'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'MATICUSDT',
  'DOTUSDT', 'ATOMUSDT', 'LTCUSDT', 'ARBUSDT', 'OPUSDT',
  'APTUSDT', 'SUIUSDT', 'INJUSDT', 'TIAUSDT', 'NEARUSDT',
]);

export class BitunixExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.dataSource = 'connecting';
    this.network = 'mainnet';

    this.markets = new Map();       // marketId(number) -> Market
    this.symbolToId = new Map();    // "BTCUSDT" -> 1
    this.prices = new Map();
    this.orders = new Map();        // orderId -> { orderId, marketId, side, price, sizeBase, ... }
    this.positions = new Map();
    this.balance = 0;
    this.realizedPnl = 0;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.stats = null;

    this._pollTimer = null;
    this._activeMarketId = null;
    this._balanceCounter = 0;
  }

  // ── 签名（Bitunix 特色 double SHA256）───────────────────────────────────
  //   digest = SHA256(nonce + timestamp + api-key + queryParams + body)
  //   sign   = SHA256(digest + secretKey)
  //   queryParams: sorted-by-key without &/= 字符（doc 里说 "sorted ascending, no spaces"）
  //   body: JSON 去空格
  _sign(queryParams, bodyStr) {
    const nonce = randomBytes(16).toString('hex');   // 32 hex chars
    const timestamp = String(Date.now());
    const cleanBody = (bodyStr || '').replace(/\s+/g, '');
    const digestInput = nonce + timestamp + this.apiKey + (queryParams || '') + cleanBody;
    const digest = createHash('sha256').update(digestInput).digest('hex');
    const sign = createHash('sha256').update(digest + this.apiSecret).digest('hex');
    return {
      'api-key': this.apiKey,
      'nonce': nonce,
      'timestamp': timestamp,
      'sign': sign,
      'language': 'en-US',
      'Content-Type': 'application/json',
    };
  }

  // queryParams 序列化：Bitunix 特色 —— 无分隔符直接拼 key1value1key2value2
  // Round 128 root-cause fix：Round 127 用 URL 惯例 "key=v&key2=v2" → 10007 Signature Error。
  // BitunixOfficial/open-api Node SDK openApiHttpSign.js:87-97 明确写：
  //   Object.keys(params).sort().map(key => key + params[key]).join('')
  _serializeParams(params) {
    if (!params || Object.keys(params).length === 0) return '';
    return Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  }

  async _reqGet(pathBase, params = {}, timeoutMs = 10000) {
    const qs = this._serializeParams(params);
    const url = qs ? `${BASE_URL}${pathBase}?${qs}` : `${BASE_URL}${pathBase}`;
    const headers = this._sign(qs, '');
    const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    return this._parseResp(res, 'GET', pathBase);
  }

  async _reqPost(pathBase, body = {}, timeoutMs = 10000) {
    const bodyStr = JSON.stringify(body || {});
    const headers = this._sign('', bodyStr);
    const res = await fetch(`${BASE_URL}${pathBase}`, {
      method: 'POST', headers, body: bodyStr,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this._parseResp(res, 'POST', pathBase);
  }

  async _parseResp(res, method, pathBase) {
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const msg = j?.msg || j?.message || text.slice(0, 160) || `HTTP ${res.status}`;
      throw new Error(`Bitunix ${method} ${pathBase} → ${msg}`);
    }
    // Bitunix code 是 number 0 = success
    if (j && j.code !== undefined && Number(j.code) !== 0) {
      throw new Error(`Bitunix ${method} ${pathBase} → [${j.code}] ${j.msg || j.message || 'unknown'}`);
    }
    return j?.data ?? j;
  }

  async _pubGet(pathBase, params = {}, timeoutMs = 8000) {
    // 公开端点不用签名（rate limit 10 req/s/IP）
    const qs = this._serializeParams(params);
    const url = qs ? `${BASE_URL}${pathBase}?${qs}` : `${BASE_URL}${pathBase}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const j = await res.json();
      if (j && j.code !== undefined && Number(j.code) !== 0) return null;
      return j?.data ?? j;
    } catch { return null; }
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  async init() {
    // 1. 拉市场元数据（公开端点）
    const list = await this._fetchMarkets();
    if (!list.length) throw new Error('Bitunix: 拉不到市场列表，check 网络代理。');
    this._setMarkets(list);
    for (const [id, m] of this.markets) this.prices.set(id, m.lastPrice);

    // 2. 验证签名有效性 + 拉余额
    try {
      const acc = await this._reqGet('/api/v1/futures/account', { marginCoin: MARGIN_COIN });
      // 返 { code, data: [{marginCoin, available, frozen, ...}] } 或直接是对象
      const usdt = Array.isArray(acc) ? acc.find((a) => a.marginCoin === MARGIN_COIN) : acc;
      if (!usdt) {
        throw new Error(`Bitunix: 账户里没有 ${MARGIN_COIN} 保证金账户，去交易所充点 USDT`);
      }
      this.balance = Number(usdt.available) || 0;
      this.realizedPnl = Number(usdt.crossUnrealizedPNL || 0) + Number(usdt.isolationUnrealizedPNL || 0);
      console.log(`[Bitunix] 初始 balance=${this.balance} USDT`);
    } catch (e) {
      throw new Error(
        `Bitunix LIVE 认证失败：${e.message}\n` +
        `  检查 BU_API_KEY / BU_API_SECRET 是否都正确\n` +
        `  bitunix.com → API Management → Create API 创建`
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
    // 拉全部 trading pairs
    const pairs = await this._pubGet('/api/v1/futures/market/trading_pairs');
    const contracts = Array.isArray(pairs) ? pairs : [];
    if (!contracts.length) return [];

    // 拉 tickers 拿实时价格
    const tickers = await this._pubGet('/api/v1/futures/market/tickers');
    const tickerList = Array.isArray(tickers) ? tickers : [];
    const priceBySymbol = new Map();
    for (const t of tickerList) {
      const p = Number(t.lastPrice || t.last || t.markPrice || 0);
      if (p > 0 && t.symbol) priceBySymbol.set(t.symbol, p);
    }

    const out = [];
    let nextId = 1;
    this.symbolToId.clear();
    for (const c of contracts) {
      const symbol = c.symbol;
      if (!symbol) continue;
      if (!PREFERRED_SYMBOLS.has(symbol)) continue;
      if (c.symbolStatus && c.symbolStatus !== 'OPEN') continue;
      if (c.isApiSupported === false) continue;
      const price = priceBySymbol.get(symbol);
      if (!price) continue;

      // basePrecision = 数量小数位数；quotePrecision = 价格小数位数
      const basePrecision = Number(c.basePrecision) || 4;
      const quotePrecision = Number(c.quotePrecision) || 2;
      const stepSize = Math.pow(10, -basePrecision);
      const stepPrice = Math.pow(10, -quotePrecision);
      const minSize = Number(c.minTradeVolume) || stepSize;
      const maxLev = Number(c.maxLeverage) || 20;

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
    // Bitunix interval: 1m/5m/15m/30m/1h/2h/4h/6h/8h/12h/1d/3d/1w/1M
    const interval = intervalSec < 3600 ? `${intervalSec / 60}m`
                   : intervalSec === 3600 ? '1h'
                   : intervalSec === 14400 ? '4h'
                   : intervalSec === 86400 ? '1d'
                   : '1h';
    const limit = Math.min(200, Math.max(50, n));   // Bitunix 最多 200
    try {
      const raw = await this._pubGet('/api/v1/futures/market/kline', {
        symbol, interval, limit,
      });
      const arr = Array.isArray(raw) ? raw : [];
      // Bitunix 返对象数组 [{open, high, close, low, time, quoteVol, baseVol, type}, ...]
      const out = arr.map((r) => ({
        time: Number(r.time),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.baseVol || 0),
      })).filter((c) => Number.isFinite(c.close));
      return out;
    } catch { return []; }
  }

  /**
   * Round 75 兼容：返 exchange-side 真实 volume。Bitunix 目前用 pending orders 拉不到
   * 累积 vol；用 tickers 里的 baseVol × price 近似（跟 Bitget 同样简化处理）。
   */
  async getStats() {
    try {
      const tickers = await this._pubGet('/api/v1/futures/market/tickers');
      const list = Array.isArray(tickers) ? tickers : [];
      let vol = 0;
      for (const t of list) {
        const q = Number(t.quoteVol || 0);
        if (q > 0) vol += q;
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
      await this._reqPost('/api/v1/futures/account/change_leverage', {
        symbol,
        marginCoin: MARGIN_COIN,
        leverage: lev,
      });
      return true;
    } catch (e) {
      if (/no change|already|same/i.test(e.message)) return true;
      this.emit('error', new Error(`Bitunix setLeverage(${symbol}, ${lev}) 失败：${e.message}`));
      return false;
    }
  }

  async placeLimitOrder(o) {
    const marketId = Number(o.marketId);
    const mkt = this.markets.get(marketId);
    const symbol = mkt?.displayName;
    if (!symbol) throw new Error(`Bitunix 未知 marketId=${marketId}`);
    // Snap price/qty to tick
    const stepPrice = Number(mkt?.stepPrice) || 0;
    const priceSnapped = stepPrice > 0
      ? Math.round(Number(o.price) / stepPrice) * stepPrice
      : Number(o.price);
    const priceDecimals = stepPrice > 0 ? Math.max(0, -Math.floor(Math.log10(stepPrice))) : 8;
    const stepSize = Number(mkt?.stepSize) || 0;
    const qtySnapped = stepSize > 0
      ? Math.round(Number(o.sizeBase) / stepSize) * stepSize
      : Number(o.sizeBase);
    const qtyDecimals = stepSize > 0 ? Math.max(0, -Math.floor(Math.log10(stepSize))) : 8;

    // Round 128：从 SDK openApiHttpFuturePrivate.js:132-158 对齐字段：
    //   symbol / side / orderType / qty / tradeSide (OPEN|CLOSE, default OPEN)
    //   / effect (GTC/POST_ONLY/IOC/FOK, default GTC) / reduceOnly / [price] / [clientId]
    // tradeSide 之前漏了；reduceOnly 走 CLOSE 侧
    const body = {
      symbol,
      qty: qtySnapped.toFixed(qtyDecimals),
      price: priceSnapped.toFixed(priceDecimals),
      side: (o.side || 'buy').toUpperCase(),   // "BUY"/"SELL"
      orderType: 'LIMIT',
      tradeSide: o.reduceOnly ? 'CLOSE' : 'OPEN',
      effect: 'GTC',
      reduceOnly: !!o.reduceOnly,
    };
    if (o.clientOrderId) body.clientId = String(o.clientOrderId).slice(0, 64);

    const j = await this._reqPost('/api/v1/futures/trade/place_order', body);
    const orderId = String(j?.orderId || j?.clientId || '');
    if (!orderId) {
      throw new Error(`Bitunix 下单返回无 orderId：${JSON.stringify(j).slice(0, 200)}`);
    }
    this.orders.set(orderId, {
      orderId, marketId, side: o.side,
      price: priceSnapped, sizeBase: qtySnapped,
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      reduceOnly: !!o.reduceOnly,
    });
    return { orderId };
  }

  async cancelOrder(marketId, orderId) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) { this.orders.delete(String(orderId)); return true; }
    // Bitunix cancel 端点是 /api/v1/futures/trade/cancel_orders (batch, POST)
    // body: { symbol, orderList: [{orderId: "..."}] }
    try {
      await this._reqPost('/api/v1/futures/trade/cancel_orders', {
        symbol,
        orderList: [{ orderId: String(orderId) }],
      });
    } catch (e) {
      if (!/not\s?found|already|does not exist/i.test(e.message)) throw e;
    }
    this.orders.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) return true;
    // Round 128：先试一键 cancel_all_orders（Java SDK path CANCEL_ALL_ORDERS），
    // 失败或残留再退化为 batch cancel_orders 逐单撤。
    try {
      await this._reqPost('/api/v1/futures/trade/cancel_all_orders', { symbol });
    } catch { /* 兜底逐单撤 */ }
    const exchangeOrders = await this.fetchOpenOrders(Number(marketId)).catch(() => []);
    const oids = exchangeOrders.map((o) => String(o.orderId)).filter(Boolean);
    if (oids.length > 0) {
      const CHUNK = 20;
      for (let i = 0; i < oids.length; i += CHUNK) {
        const chunk = oids.slice(i, i + CHUNK);
        try {
          await this._reqPost('/api/v1/futures/trade/cancel_orders', {
            symbol,
            orderList: chunk.map((oid) => ({ orderId: oid })),
          });
        } catch { /* skip chunk */ }
      }
    }
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
      const j = await this._reqGet('/api/v1/futures/trade/get_pending_orders', {
        symbol, limit: 100,
      });
      // response: { orderList: [...], total }
      const list = j?.orderList || (Array.isArray(j) ? j : []);
      return list.map((o) => ({
        orderId: String(o.orderId),
        price: Number(o.price),
        side: (o.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy',
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
      const j = await this._reqGet('/api/v1/futures/position/get_pending_positions', {});
      const list = Array.isArray(j) ? j : (j?.list || []);
      return list.map((p) => {
        const size = Number(p.qty || p.size || 0);
        // Bitunix side: "LONG"/"SHORT"
        const signedSize = String(p.side).toUpperCase() === 'SHORT' ? -size : size;
        return {
          marketId: this.symbolToId.get(p.symbol) || null,
          positionId: String(p.positionId || ''),
          sizeBase: signedSize,
          entryPrice: Number(p.avgOpenPrice || p.entryValue / size || 0),
          unrealizedPnl: Number(p.unrealizedPNL || p.unrealizedPnl || 0),
          leverage: Number(p.leverage || 0),
        };
      }).filter((p) => p.marketId);
    } catch { return []; }
  }

  async closePosition(marketId) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) return { closed: false, error: 'unknown market' };
    // Round 128：Bitunix 有官方一键平仓 flash_close_position（Java SDK 路径 FLASH_CLOSE_POSITION），
    // 不用再自己组 market 反向单。拿 positionId 直接 flash-close。
    try {
      const positions = await this.fetchPositions();
      const pos = positions.find((p) => p.marketId === Number(marketId));
      if (!pos || Math.abs(pos.sizeBase) < 1e-9) {
        this.positions.delete(Number(marketId));
        return { closed: true, empty: true, size: 0 };
      }
      const body = { symbol };
      if (pos.positionId) body.positionId = pos.positionId;
      try {
        await this._reqPost('/api/v1/futures/trade/flash_close_position', body);
      } catch (e) {
        // 兜底：flash close 不 work 就走 market 反向 reduceOnly
        const closeSide = pos.sizeBase > 0 ? 'SELL' : 'BUY';
        const fallback = {
          symbol,
          qty: String(Math.abs(pos.sizeBase)),
          side: closeSide,
          orderType: 'MARKET',
          tradeSide: 'CLOSE',
          reduceOnly: true,
        };
        if (pos.positionId) fallback.positionId = pos.positionId;
        await this._reqPost('/api/v1/futures/trade/place_order', fallback);
      }
      this.positions.delete(Number(marketId));
      return { closed: true, count: 1 };
    } catch (e) {
      if (/no position|no.?position|does not exist|30004/i.test(e.message)) {
        this.positions.delete(Number(marketId));
        return { closed: true, empty: true };
      }
      this.emit('error', new Error(`Bitunix closePosition(${symbol}) 失败：${e.message}`));
      return { closed: false, error: e.message };
    }
  }

  async reconcileOpenOrders() {
    // GridBot 用不到具体实现；轮询已经在同步了
    return true;
  }

  // Autopilot 告诉适配器"当前只关心这个市场"
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

  start() { this._startPolling(); }

  async _pollTick() {
    // 1. 拉全市场 ticker
    try {
      const tickers = await this._pubGet('/api/v1/futures/market/tickers');
      if (Array.isArray(tickers)) {
        for (const t of tickers) {
          const id = this.symbolToId.get(t.symbol);
          if (!id) continue;
          const p = Number(t.lastPrice || t.last || t.markPrice || 0);
          if (p > 0) {
            this.prices.set(id, p);
            const m = this.markets.get(id);
            if (m) m.lastPrice = p;
            this.emit('price', { marketId: id, price: p });
          }
        }
        this.lastOkAt = Date.now();
      }
    } catch { /* ticker 失败不阻塞 */ }

    // 2. 每 5 轮 = 15s 拉一次账户 + 仓位 + fill 检测
    this._balanceCounter = (this._balanceCounter || 0) + 1;
    if (this._balanceCounter >= 5) {
      this._balanceCounter = 0;
      // 余额
      try {
        const acc = await this._reqGet('/api/v1/futures/account', { marginCoin: MARGIN_COIN });
        const usdt = Array.isArray(acc) ? acc.find((a) => a.marginCoin === MARGIN_COIN) : acc;
        if (usdt) this.balance = Number(usdt.available) || 0;
      } catch { /* skip */ }

      // 仓位
      try {
        const positions = await this.fetchPositions();
        // 清老仓（这轮拿到的算真相）
        const seen = new Set();
        for (const p of positions) {
          if (p.marketId) {
            this.positions.set(p.marketId, p);
            seen.add(p.marketId);
          }
        }
        for (const mid of [...this.positions.keys()]) {
          if (!seen.has(mid)) this.positions.delete(mid);
        }
      } catch { /* skip */ }

      // Fill 检测：对比本地 orders 与 exchange orders
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
