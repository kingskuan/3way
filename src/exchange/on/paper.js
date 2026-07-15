// PaperExchange: simulated trading on top of REAL Ondo Perps prices.
// On init it probes the Ondo REST base (production first, sandbox fallback),
// loads real markets, and polls mark prices. Fills are simulated. If the
// exchange is unreachable, falls back to a synthetic random walk.
//
// Ondo Perps trades tokenized RWA (stocks/ETFs/gold/oil) perps in the form
// TICKER-USD.P (e.g. NVDA-USD.P, XAU-USD.P). We enumerate markets from
// GET /v1/markets and poll GET /v1/perps/history for candles + mark price.
import { EventEmitter } from 'node:events';

const FALLBACK_MARKETS = [
  { marketId: 'NVDA-USD.P', displayName: 'NVDA-USD.P', symbol: 'NVDA', lastPrice: 140,  stepSize: 0.01, stepPrice: 0.01, maxLeverage: 20, minOrderSize: 0.01 },
  { marketId: 'AAPL-USD.P', displayName: 'AAPL-USD.P', symbol: 'AAPL', lastPrice: 220,  stepSize: 0.01, stepPrice: 0.01, maxLeverage: 20, minOrderSize: 0.01 },
  { marketId: 'XAU-USD.P',  displayName: 'XAU-USD.P',  symbol: 'XAU',  lastPrice: 2400, stepSize: 0.001, stepPrice: 0.1,  maxLeverage: 20, minOrderSize: 0.001 },
  { marketId: 'QQQ-USD.P',  displayName: 'QQQ-USD.P',  symbol: 'QQQ',  lastPrice: 480,  stepSize: 0.01, stepPrice: 0.01, maxLeverage: 20, minOrderSize: 0.01 },
];

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.balance = opts.startBalance ?? 10000;
    this.candidates = [...new Set((opts.apiUrl ? [opts.apiUrl] : []).concat([
      'https://api.ondoperps.xyz',           // production
      'https://api.ondoperps-sandbox.xyz',   // sandbox fallback
    ]))];
    this.apiUrl = this.candidates[0];
    this.dataSource = 'connecting';
    this.network = null;
    this.tickMs = opts.tickMs ?? 1000;
    this.pollMs = opts.pollMs ?? 5000;
    this.volPerTick = opts.volPerTick ?? 0.0008;  // stocks/gold move slower than crypto
    this.feeRate = Number(opts.feeRate) || 0.0005;
    this.markets = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this.realizedPnl = 0;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.prices = new Map();
    this.realTarget = new Map();
    this._seq = 1;
    this._tickTimer = null;
    this._pollTimer = null;
  }

  async init() {
    let chosen = null;
    for (const url of this.candidates) {
      const list = await this._fetchMarkets(url);
      if (list && list.length) { chosen = url; this._setMarkets(list); break; }
    }
    if (chosen) {
      this.apiUrl = chosen;
      this.dataSource = 'real';
      this.network = chosen.includes('sandbox') ? 'testnet' : 'mainnet';
    } else {
      this.dataSource = 'synthetic';
      this._setMarkets(FALLBACK_MARKETS.map((m) => ({ ...m })));
    }
    for (const [id, m] of this.markets) {
      this.prices.set(id, m.lastPrice || 100);
      this.realTarget.set(id, m.lastPrice || 100);
    }
    this._startLoops();
    return true;
  }

  async reconnect() {
    try {
      for (const url of this.candidates) {
        const list = await this._fetchMarkets(url);
        if (list && list.length) {
          this.apiUrl = url;
          this.network = url.includes('sandbox') ? 'testnet' : 'mainnet';
          if (this.dataSource !== 'real') {
            this.dataSource = 'real';
            this._setMarkets(list);
            for (const [id, m] of this.markets) { this.prices.set(id, m.lastPrice || 100); this.realTarget.set(id, m.lastPrice || 100); }
          }
          break;
        }
      }
    } catch { /* keep current mode */ }
    this._startLoops();
    this.lastOkAt = Date.now();
    return true;
  }

  async _fetchMarkets(url) {
    // Try /v1/markets first (documented), then /v1/perps/markets as fallback.
    for (const path of ['/v1/markets', '/v1/perps/markets', '/v1/perps/contracts']) {
      try {
        const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) continue;
        const j = await res.json();
        const arr = j.result || j.markets || j.data || j.contracts || (Array.isArray(j) ? j : []);
        const out = [];
        for (const m of arr) {
          const symbol = m.market || m.symbol || m.name || m.contract;
          if (!symbol) continue;
          const price = Number(m.markPrice || m.mark_price || m.lastPrice || m.last_price || m.indexPrice || 0);
          if (!price) continue;
          out.push({
            marketId: symbol,  // Ondo uses string symbol as id (e.g. "NVDA-USD.P")
            displayName: symbol,
            symbol: symbol.replace(/-USD\.P$/, ''),
            lastPrice: price,
            stepSize: Number(m.baseIncrement || m.base_increment || 0.01),
            stepPrice: Number(m.quoteIncrement || m.quote_increment || 0.01),
            maxLeverage: Number(m.maxLeverage || m.max_leverage || 20),
            minOrderSize: Number(m.minOrderSize || m.min_order_size || m.baseIncrement || 0.01),
          });
        }
        if (out.length) return out;
      } catch { /* try next path */ }
    }
    return null;
  }

  _setMarkets(list) { this.markets.clear(); for (const m of list) this.markets.set(m.marketId, m); }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    if (this.dataSource === 'real') {
      // Ondo TradingView-compat endpoint: /v1/perps/history?symbol=&resolution=&to=&countback=
      const resolution = intervalSec < 3600 ? String(intervalSec / 60)
                       : intervalSec === 3600 ? '60'
                       : intervalSec === 86400 ? '1D'
                       : '60';
      try {
        const now = Math.floor(Date.now() / 1000);
        const url = `${this.apiUrl}/v1/perps/history?symbol=${encodeURIComponent(marketId)}&resolution=${resolution}&to=${now}&countback=${n}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const j = await res.json();
          // TradingView udf format: {t:[], o:[], h:[], l:[], c:[], v:[]}
          if (j.t && j.c && j.t.length >= 20) {
            const out = [];
            for (let i = 0; i < j.t.length; i++) {
              out.push({ time: Number(j.t[i]) * 1000, open: +j.o[i], high: +j.h[i], low: +j.l[i], close: +j.c[i], volume: +(j.v?.[i] ?? 0) });
            }
            return out.filter((c) => Number.isFinite(c.close));
          }
        }
      } catch { /* fall through */ }
    }
    return synthCandles(this.prices.get(marketId) || 100, n);
  }

  async getPrice(marketId) { return this.prices.get(marketId); }
  async setLeverage() { return true; }

  async placeLimitOrder(o) {
    const id = `paper-${this._seq++}`;
    this.orders.set(id, { orderId: id, ...o });
    return { orderId: id };
  }
  async cancelOrder(_m, orderId) { this.orders.delete(orderId); return true; }
  async cancelAll(marketId) { for (const [id, o] of this.orders) if (o.marketId === marketId) this.orders.delete(id); return true; }
  getOpenOrders(marketId) { return [...this.orders.values()].filter((o) => o.marketId === marketId); }
  async fetchOpenOrders(marketId) {
    return [...this.orders.values()]
      .filter((o) => String(o.marketId) === String(marketId))
      .map((o) => ({ orderId: String(o.orderId), price: Number(o.price), side: o.side }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), { orderId: String(orderId), marketId, levelIndex, side, price: Number(price), sizeBase: Number(sizeBase), reduceOnly: false });
  }

  getPosition(marketId) {
    const p = this.positions.get(marketId);
    if (!p || p.sizeBase === 0) return null;
    const last = this.prices.get(marketId);
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.sizeBase * (last - p.entryPrice) };
  }

  async closePosition(marketId) {
    const p = this.positions.get(marketId);
    if (!p || !p.sizeBase) return null;
    const price = this.prices.get(marketId);
    this._applyFill(marketId, p.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(p.sizeBase));
    return true;
  }

  start() { this._startLoops(); }
  stop() { /* keep price feed alive */ }

  _startLoops() {
    if (!this._tickTimer) { this._tickTimer = setInterval(() => this._tick(), this.tickMs); this._tickTimer.unref?.(); }
    if (this.dataSource === 'real' && !this._pollTimer) {
      this._pollTimer = setInterval(() => this._pollReal(), this.pollMs); this._pollTimer.unref?.();
    }
  }

  async _pollReal() {
    // Poll mark prices for all subscribed markets via bulk markets endpoint.
    for (const path of ['/v1/markets', '/v1/perps/markets']) {
      try {
        const res = await fetch(`${this.apiUrl}${path}`, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) continue;
        const j = await res.json();
        const arr = j.result || j.markets || j.data || (Array.isArray(j) ? j : []);
        let any = false;
        for (const m of arr) {
          const id = m.market || m.symbol || m.name;
          const price = Number(m.markPrice || m.mark_price || m.lastPrice || m.last_price || 0);
          if (id && price && this.realTarget.has(id)) { this.realTarget.set(id, price); any = true; }
        }
        if (any) return;
      } catch { /* transient */ }
    }
  }

  _tick() {
    this.lastOkAt = Date.now();
    for (const [id, price] of this.prices) {
      let next;
      if (this.dataSource === 'real') {
        const target = this.realTarget.get(id) ?? price;
        next = price + (target - price) * 0.25;
        if (Math.abs(next - target) / target < 1e-5) next = target;
      } else {
        const seed = this.markets.get(id)?.lastPrice || price;
        const drift = (seed - price) / seed * 0.02;
        const shock = (Math.random() * 2 - 1) * this.volPerTick;
        next = Math.max(0.0001, price * (1 + drift + shock));
      }
      this.prices.set(id, next);
      this.emit('price', { marketId: id, price: next });
      this._matchFills(id, price, next);
    }
  }

  _matchFills(marketId, prev, cur) {
    for (const o of [...this.orders.values()]) {
      if (String(o.marketId) !== String(marketId)) continue;
      const crossedBuy = o.side === 'buy' && cur <= o.price;
      const crossedSell = o.side === 'sell' && cur >= o.price;
      if (!crossedBuy && !crossedSell) continue;
      if (o.reduceOnly && !this._reduces(marketId, o.side)) { this.orders.delete(o.orderId); continue; }
      this.orders.delete(o.orderId);
      this._applyFill(marketId, o.side, o.price, o.sizeBase);
      this.emit('fill', { orderId: o.orderId, marketId, side: o.side, price: o.price, sizeBase: o.sizeBase, levelIndex: o.levelIndex, clientOrderId: o.clientOrderId });
    }
  }

  _reduces(marketId, side) {
    const p = this.positions.get(marketId);
    if (!p || p.sizeBase === 0) return false;
    return side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0;
  }

  _applyFill(marketId, side, price, qty) {
    const fee = price * qty * this.feeRate;
    this.balance -= fee;
    this.realizedPnl -= fee;
    const p = this.positions.get(marketId) || { sizeBase: 0, entryPrice: 0 };
    const signed = side === 'buy' ? qty : -qty;
    if (p.sizeBase === 0 || Math.sign(p.sizeBase) === Math.sign(signed)) {
      const newSize = p.sizeBase + signed;
      p.entryPrice = (Math.abs(p.sizeBase) * p.entryPrice + Math.abs(signed) * price) / Math.abs(newSize);
      p.sizeBase = newSize;
    } else {
      const closeQty = Math.min(Math.abs(p.sizeBase), Math.abs(signed));
      const pnl = p.sizeBase > 0 ? closeQty * (price - p.entryPrice) : closeQty * (p.entryPrice - price);
      this.realizedPnl += pnl; this.balance += pnl;
      const remaining = p.sizeBase + signed;
      if (Math.sign(remaining) === Math.sign(p.sizeBase) || remaining === 0) { p.sizeBase = remaining; if (remaining === 0) p.entryPrice = 0; }
      else { p.sizeBase = remaining; p.entryPrice = price; }
    }
    this.positions.set(marketId, p);
  }
}

function synthCandles(start, n) {
  const out = []; let price = start; let t = Date.now() - n * 3600_000;
  const regime = Math.random() < 0.34 ? 0.0008 : Math.random() < 0.5 ? -0.0008 : 0;
  for (let i = 0; i < n; i++) {
    const open = price, close = price * (1 + regime + (Math.random() * 2 - 1) * 0.004);
    out.push({ time: t, open, high: Math.max(open, close) * 1.0007, low: Math.min(open, close) * 0.9993, close, volume: 100 });
    price = close; t += 3600_000;
  }
  return out;
}
