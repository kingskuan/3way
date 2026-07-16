// OndoExchange (LIVE) —— Ondo Perps 实盘适配器（HMAC-SHA256 认证 · REST 轮询版）
//
// 认证方案：每个请求带 3 个 header
//   ONDO-KEY-ID     形如 "ondoKeyId_..."
//   ONDO-TIMESTAMP  当前毫秒时间戳（30 秒内有效）
//   ONDO-SIGN       HMAC-SHA256(timestamp + method + path + body).hex
//
// 关键设计：
// • marketId 沿用 paper.js 的数字 ID + symbol displayName 方案，GridBot 无缝
// • 采用 3 秒 REST 轮询代替 WebSocket 私有流（单向依赖更简单，先跑通再上 WS）
// • fill 检测：跟踪本地下过的单，轮询 open orders，消失的 orderId 去查详情
// • 所有 fetch 超时 10s，防止卡死
// • 网络异常降级：静默跳过本轮，等下一 tick，不 crash 主进程
//
// 文档：https://docs.ondoperps.xyz/api-reference/integration_guide
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';

const POLL_MS = 3000;

export class OndoExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.apiKeyId = opts.apiKeyId;
    this.apiSecret = opts.apiSecret;
    this.apiUrl = (opts.apiUrl || 'https://api.ondoperps.xyz').replace(/\/$/, '');
    this.wsUrl = opts.wsUrl || this.apiUrl.replace(/^http/, 'ws') + '/ws';
    this.builderCode = opts.builderCode || '';
    this.dataSource = 'connecting';
    this.network = this.apiUrl.includes('sandbox') ? 'testnet' : 'mainnet';

    this.markets = new Map();       // numericId -> Market
    this.symbolToId = new Map();    // "NVDA-USD.P" -> 3
    this.prices = new Map();
    this.orders = new Map();        // orderId -> { orderId, marketId, side, price, sizeBase, ... }
    this.positions = new Map();
    this.balance = 0;
    this.realizedPnl = 0;
    this.lastOkAt = Date.now();
    this.lastError = null;

    this._pollTimer = null;
  }

  // ── 签名 & 请求 ──────────────────────────────────────────────────────────
  _signHeaders(method, path, body) {
    const ts = String(Date.now());
    const canonical = ts + method.toUpperCase() + path + (body || '');
    const sig = createHmac('sha256', this.apiSecret).update(canonical).digest('hex');
    return {
      'ONDO-KEY-ID': this.apiKeyId,
      'ONDO-TIMESTAMP': ts,
      'ONDO-SIGN': sig,
    };
  }

  async _req(method, path, body = null, timeoutMs = 10000) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      ...this._signHeaders(method, path, bodyStr),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    const opts = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (bodyStr) opts.body = bodyStr;
    const res = await fetch(`${this.apiUrl}${path}`, opts);
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const msg = j?.error || j?.message || text.slice(0, 160) || `HTTP ${res.status}`;
      throw new Error(`Ondo ${method} ${path} → ${msg}`);
    }
    return j;
  }

  // 公开端点无需签名
  async _pubGet(path, timeoutMs = 6000) {
    const res = await fetch(`${this.apiUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    try { return await res.json(); } catch { return null; }
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  async init() {
    // 1. 拉市场（公开端点）
    const list = await this._fetchMarkets();
    if (!list.length) throw new Error('Ondo：拉不到市场列表，check ONDO_API_URL 或网络代理。');
    this._setMarkets(list);
    for (const [id, m] of this.markets) this.prices.set(id, m.lastPrice);

    // 2. 验证签名有效性（拉账户，任何签名有效性问题在这里暴露）
    let acc;
    try {
      acc = await this._req('GET', '/v1/account');
    } catch (e) {
      throw new Error(
        `Ondo LIVE 认证失败：${e.message}\n` +
        `  检查 ONDO_API_KEY_ID / ONDO_API_SECRET 是否正确\n` +
        `  或本地时钟是否偏离 UTC 超过 30 秒（Ondo 硬性要求）`
      );
    }
    this.balance = Number(acc?.balance ?? acc?.usdcBalance ?? acc?.availableBalance ?? 0);

    this.dataSource = 'real';
    this._startPolling();
    return true;
  }

  async reconnect() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    return this.init();
  }

  async _fetchMarkets() {
    // Ondo 公开端点：/v1/markets 或 /v1/perps/markets
    for (const path of ['/v1/markets', '/v1/perps/markets', '/v1/perps/contracts']) {
      const j = await this._pubGet(path);
      if (!j) continue;
      const arr = j.markets || j.data || j.contracts || (Array.isArray(j) ? j : []);
      const out = [];
      let nextId = 1;
      this.symbolToId.clear();
      for (const m of arr) {
        const symbol = m.market || m.symbol || m.name;
        if (!symbol) continue;
        const price = Number(m.markPrice || m.lastPrice || m.mark_price || m.indexPrice || 0);
        if (!price) continue;
        out.push({
          marketId: nextId,
          displayName: symbol,
          symbol: symbol.replace(/-USD\.P$/, ''),
          lastPrice: price,
          stepSize: Number(m.baseIncrement || m.base_increment || 0.01),
          stepPrice: Number(m.quoteIncrement || m.quote_increment || 0.01),
          maxLeverage: Number(m.maxLeverage || m.max_leverage || 20),
          minOrderSize: Number(m.minOrderSize || m.min_order_size || m.baseIncrement || 0.01),
        });
        this.symbolToId.set(symbol, nextId);
        nextId++;
      }
      if (out.length) return out;
    }
    return [];
  }

  _setMarkets(list) { this.markets.clear(); for (const m of list) this.markets.set(m.marketId, m); }

  // ── GridBot 接口 ────────────────────────────────────────────────────────
  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) return [];
    const resolution = intervalSec < 3600 ? String(intervalSec / 60)
                     : intervalSec === 3600 ? '60'
                     : intervalSec === 86400 ? '1D'
                     : '60';
    try {
      const now = Math.floor(Date.now() / 1000);
      const url = `/v1/perps/history?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&to=${now}&countback=${n}`;
      const j = await this._pubGet(url, 8000);
      if (!j?.t?.length) return [];
      const out = [];
      for (let i = 0; i < j.t.length; i++) {
        out.push({
          time: Number(j.t[i]) * 1000,
          open: +j.o[i], high: +j.h[i], low: +j.l[i], close: +j.c[i],
          volume: +(j.v?.[i] ?? 0),
        });
      }
      return out.filter((c) => Number.isFinite(c.close));
    } catch { return []; }
  }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }

  async setLeverage(_marketId, _leverage) {
    // Ondo 目前 API 里没找到独立的 setLeverage 端点；杠杆在下单时通过账户模式生效
    return true;
  }

  async placeLimitOrder(o) {
    const marketId = Number(o.marketId);
    const symbol = this.markets.get(marketId)?.displayName;
    if (!symbol) throw new Error(`Ondo 未知 marketId=${marketId}`);
    const body = {
      market: symbol,
      type: 'limit',
      side: o.side, // 'buy' | 'sell'
      size: String(o.sizeBase),
      price: String(o.price),
      timeInForce: 'GTC',
      reduceOnly: !!o.reduceOnly,
      postOnly: false,
    };
    if (o.clientOrderId) body.clientOrderId = String(o.clientOrderId).slice(0, 64);
    if (this.builderCode) body.builderCode = { code: this.builderCode };
    const j = await this._req('POST', '/v1/perps/orders', body);
    const orderId = String(j.orderId || j.id || j.order?.orderId || j.order?.id);
    if (!orderId || orderId === 'undefined') {
      throw new Error(`Ondo 下单返回无 orderId：${JSON.stringify(j).slice(0, 200)}`);
    }
    this.orders.set(orderId, {
      orderId, marketId, side: o.side,
      price: Number(o.price), sizeBase: Number(o.sizeBase),
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      reduceOnly: !!o.reduceOnly,
    });
    return { orderId };
  }

  async cancelOrder(marketId, orderId) {
    try {
      await this._req('DELETE', `/v1/perps/orders/${encodeURIComponent(orderId)}`);
    } catch (e) {
      // 单可能已经成交或撤销过了，不视为致命
      if (!/not\s?found|already/i.test(e.message)) throw e;
    }
    this.orders.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    const symbol = this.markets.get(Number(marketId))?.displayName;
    if (!symbol) return true;
    // 优先尝试批量撤（market 级）
    try {
      await this._req('DELETE', `/v1/perps/orders?market=${encodeURIComponent(symbol)}`);
    } catch {
      // 降级：逐单撤
      const toKill = [...this.orders.values()].filter((o) => o.marketId === Number(marketId));
      for (const o of toKill) {
        await this.cancelOrder(marketId, o.orderId).catch(() => {});
      }
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
      const j = await this._req('GET', `/v1/perps/orders?market=${encodeURIComponent(symbol)}&open=true`);
      const arr = j.orders || j.data || (Array.isArray(j) ? j : []);
      return arr.map((o) => ({
        orderId: String(o.orderId || o.id),
        price: Number(o.price),
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

  async closePosition(marketId) {
    const marketIdN = Number(marketId);
    const p = this.getPosition(marketIdN);
    if (!p || !p.sizeBase) return null;
    const symbol = this.markets.get(marketIdN)?.displayName;
    const body = {
      market: symbol,
      type: 'market',
      side: p.sizeBase > 0 ? 'sell' : 'buy',
      size: String(Math.abs(p.sizeBase)),
      reduceOnly: true,
    };
    if (this.builderCode) body.builderCode = { code: this.builderCode };
    return await this._req('POST', '/v1/perps/orders', body);
  }

  async reconcileOpenOrders() {
    // 拉一次全部 open orders 并同步本地 tracking
    try {
      const j = await this._req('GET', '/v1/perps/orders?open=true');
      const arr = j.orders || j.data || (Array.isArray(j) ? j : []);
      const stillOpen = new Set(arr.map((o) => String(o.orderId || o.id)));
      for (const id of [...this.orders.keys()]) {
        if (!stillOpen.has(id)) this.orders.delete(id);
      }
    } catch { /* skip */ }
    return true;
  }

  start() { this._startPolling(); }
  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  // ── 轮询：价格 / 持仓 / 成交 ────────────────────────────────────────────
  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._poll().catch(() => {}), POLL_MS);
    this._pollTimer.unref?.();
  }

  async _poll() {
    this.lastOkAt = Date.now();

    // 1) 价格：拉全 markets 一次（公开）
    for (const path of ['/v1/markets', '/v1/perps/markets']) {
      const j = await this._pubGet(path, 5000);
      if (!j) continue;
      const arr = j.markets || j.data || (Array.isArray(j) ? j : []);
      let any = false;
      for (const m of arr) {
        const id = this.symbolToId.get(m.market || m.symbol || m.name);
        if (!id) continue;
        const price = Number(m.markPrice || m.lastPrice || m.mark_price || 0);
        if (price > 0) {
          this.prices.set(id, price);
          this.emit('price', { marketId: id, price });
          any = true;
        }
      }
      if (any) break;
    }

    // 2) 账户 balance
    try {
      const acc = await this._req('GET', '/v1/account');
      const bal = Number(acc?.balance ?? acc?.usdcBalance ?? acc?.availableBalance);
      if (Number.isFinite(bal)) this.balance = bal;
    } catch { /* transient */ }

    // 3) Positions
    try {
      const j = await this._req('GET', '/v1/perps/positions');
      const arr = j.positions || j.data || (Array.isArray(j) ? j : []);
      const seen = new Set();
      for (const p of arr) {
        const id = this.symbolToId.get(p.market || p.symbol);
        if (!id) continue;
        seen.add(id);
        const rawSize = Number(p.size || p.sizeBase || p.baseAsset || 0);
        const isShort = p.side === 'short' || p.side === 'SELL' || rawSize < 0;
        const size = isShort ? -Math.abs(rawSize) : Math.abs(rawSize);
        this.positions.set(id, {
          sizeBase: size,
          entryPrice: Number(p.entryPrice || p.avgEntryPrice || 0),
          unrealizedPnl: Number(p.unrealizedPnl || p.upnl || 0),
        });
      }
      for (const id of [...this.positions.keys()]) if (!seen.has(id)) this.positions.delete(id);
    } catch { /* transient */ }

    // 4) Fill 检测：本地跟踪的 open orders 里，交易所已经不 open 的当作成交/撤销
    if (this.orders.size > 0) {
      try {
        const j = await this._req('GET', '/v1/perps/orders?open=true');
        const arr = j.orders || j.data || (Array.isArray(j) ? j : []);
        const stillOpen = new Set(arr.map((o) => String(o.orderId || o.id)));
        for (const [id, o] of [...this.orders]) {
          if (stillOpen.has(id)) continue;
          // 单不在 open 里了：查详情判断 filled or cancelled
          try {
            const info = await this._req('GET', `/v1/perps/orders/${encodeURIComponent(id)}`);
            const status = String(info?.status || info?.state || '').toLowerCase();
            const filled = /fill/.test(status) || (Number(info?.filledSize || info?.executedSize || 0) > 0);
            if (filled) {
              const avgPrice = Number(info?.avgFillPrice || info?.avgPrice || o.price);
              const filledSize = Number(info?.filledSize || info?.executedSize || o.sizeBase);
              this.emit('fill', {
                orderId: id, marketId: o.marketId, side: o.side,
                price: avgPrice, sizeBase: filledSize,
                levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
              });
            }
          } catch { /* 查不到就当撤了 */ }
          this.orders.delete(id);
        }
      } catch { /* skip */ }
    }
  }
}
