// PaperExchange: simulated trading on top of REAL perpl.xyz prices.
// On init it probes perpl REST base (mainnet first, testnet fallback), loads
// markets via /v1/pub/context, and polls historical candles for current price.
// Fills are simulated. If unreachable, falls back to a synthetic random walk.
//
// perpl runs on Monad L1 EVM; markets have numeric ids (BTC=1, ETH=20, SOL=31,
// MON=10 etc). Prices come back as scaled integers — divide by 10^price_decimals.
// Candles endpoint: GET /v1/market-data/{marketId}/candles/{resSec}/{fromMs}-{toMs}
import { EventEmitter } from 'node:events';

const FALLBACK_MARKETS = [
  { marketId: 1,  displayName: 'BTC-PERP', symbol: 'BTC', lastPrice: 65000, stepSize: 0.00001, stepPrice: 0.1, maxLeverage: 20, minOrderSize: 0.00001 },
  { marketId: 20, displayName: 'ETH-PERP', symbol: 'ETH', lastPrice: 1900,  stepSize: 0.0001,  stepPrice: 0.01, maxLeverage: 20, minOrderSize: 0.0001 },
  { marketId: 31, displayName: 'SOL-PERP', symbol: 'SOL', lastPrice: 150,   stepSize: 0.001,   stepPrice: 0.01, maxLeverage: 20, minOrderSize: 0.001 },
  { marketId: 10, displayName: 'MON-PERP', symbol: 'MON', lastPrice: 2,     stepSize: 0.1,     stepPrice: 0.001, maxLeverage: 20, minOrderSize: 0.1 },
];

export class PaperExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.balance = opts.startBalance ?? 10000;
    this.candidates = [...new Set((opts.apiUrl ? [opts.apiUrl] : []).concat([
      'https://app.perpl.xyz/api',        // mainnet
      'https://testnet.perpl.xyz/api',    // testnet fallback
    ]))];
    this.apiUrl = this.candidates[0];
    this.dataSource = 'connecting';
    this.network = null;
    this.tickMs = opts.tickMs ?? 1000;
    this.pollMs = opts.pollMs ?? 5000;
    this.volPerTick = opts.volPerTick ?? 0.0015;
    this.feeRate = Number(opts.feeRate) || 0.0005;
    this.markets = new Map();
    this._priceScales = new Map();  // marketId -> 10^price_decimals
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
      this.network = chosen.includes('testnet') ? 'testnet' : 'mainnet';
    } else {
      this.dataSource = 'synthetic';
      this._setMarkets(FALLBACK_MARKETS.map((m) => ({ ...m })));
      for (const m of FALLBACK_MARKETS) this._priceScales.set(m.marketId, 1);
    }
    for (const [id, m] of this.markets) {
      this.prices.set(id, m.lastPrice || 100);
      this.realTarget.set(id, m.lastPrice || 100);
    }
    // perpl 的 /pub/context 通常没带 last_price，得靠 candle 拉一根最新的填初值，
    // 否则 dashboard 一开始会显示 100 的占位价。同步等一次首轮 poll。
    if (this.dataSource === 'real') {
      await this._pollReal().catch(() => {});
      // Seed displayed prices from the poll so the market list is already accurate.
      for (const [id, target] of this.realTarget) this.prices.set(id, target);
      // Update lastPrice on each market entry so getMarkets() reflects real prices.
      for (const [id, m] of this.markets) {
        const p = this.realTarget.get(id);
        if (p && p !== 100) m.lastPrice = p;
      }
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
          this.network = url.includes('testnet') ? 'testnet' : 'mainnet';
          if (this.dataSource !== 'real') {
            this.dataSource = 'real';
            this._setMarkets(list);
            for (const [id, m] of this.markets) { this.prices.set(id, m.lastPrice || 100); this.realTarget.set(id, m.lastPrice || 100); }
          }
          break;
        }
      }
    } catch { /* keep current */ }
    this._startLoops();
    this.lastOkAt = Date.now();
    return true;
  }

  async _fetchMarkets(url) {
    try {
      const res = await fetch(`${url}/v1/pub/context`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const j = await res.json();
      const out = [];
      for (const m of j.markets || []) {
        const cfg = m.config || {};
        const priceDecimals = Number(cfg.price_decimals ?? 0);
        const sizeDecimals = Number(cfg.size_decimals ?? 4);
        const priceScale = Math.pow(10, priceDecimals);
        this._priceScales.set(Number(m.id), priceScale);
        // Try to read initial mark price from context (may be missing on cold
        // markets — the poll loop will backfill from candles).
        const rawPrice = Number(cfg.last_price || cfg.mark_price || m.last_price || 0);
        const lastPrice = rawPrice > 0 ? rawPrice / priceScale : 0;
        out.push({
          marketId: Number(m.id),
          displayName: `${m.name}-PERP`,
          symbol: m.name,
          lastPrice: lastPrice || 100,
          stepSize: Math.pow(10, -sizeDecimals),
          stepPrice: Math.pow(10, -priceDecimals),
          maxLeverage: Number(cfg.max_leverage || 20),
          minOrderSize: Number(cfg.min_order_size || Math.pow(10, -sizeDecimals)),
        });
      }
      return out.length ? out : null;
    } catch { return null; }
  }

  _setMarkets(list) { this.markets.clear(); for (const m of list) this.markets.set(m.marketId, m); }

  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const mId = Number(marketId);
    if (this.dataSource === 'real') {
      // Valid resolutions per perpl docs: 60/300/900/1800/3600/7200/14400/28800/43200/86400
      const validRes = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400];
      const res = validRes.includes(intervalSec) ? intervalSec : 3600;
      try {
        const toMs = Date.now();
        const fromMs = toMs - res * n * 1000;
        const url = `${this.apiUrl}/v1/market-data/${mId}/candles/${res}/${fromMs}-${toMs}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const j = await r.json();
          const scale = this._priceScales.get(mId) || 1;
          const data = (j.d || []).map((d) => ({
            time: Number(d.t),
            open: Number(d.o) / scale,
            high: Number(d.h) / scale,
            low: Number(d.l) / scale,
            close: Number(d.c) / scale,
            volume: Number(d.v) || 0,
          })).filter((c) => Number.isFinite(c.close));
          if (data.length >= 20) return data;
        }
      } catch { /* fall through */ }
    }
    return synthCandles(this.prices.get(mId) || 100, n);
  }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }
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
      .filter((o) => Number(o.marketId) === Number(marketId))
      .map((o) => ({ orderId: String(o.orderId), price: Number(o.price), side: o.side }));
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), { orderId: String(orderId), marketId: Number(marketId), levelIndex, side, price: Number(price), sizeBase: Number(sizeBase), reduceOnly: false });
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    if (!p || p.sizeBase === 0) return null;
    const last = this.prices.get(Number(marketId));
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.sizeBase * (last - p.entryPrice) };
  }

  async closePosition(marketId) {
    const id = Number(marketId);
    const p = this.positions.get(id);
    if (!p || !p.sizeBase) return null;
    const price = this.prices.get(id);
    this._applyFill(id, p.sizeBase > 0 ? 'sell' : 'buy', price, Math.abs(p.sizeBase));
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
    // perpl has no bulk /tickers — poll the most recent candle per subscribed market
    // (only for markets we're actually watching, to keep this cheap).
    const now = Date.now();
    for (const [id, m] of this.markets) {
      if (!this.realTarget.has(id)) continue;
      try {
        const url = `${this.apiUrl}/v1/market-data/${id}/candles/60/${now - 300_000}-${now}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) continue;
        const j = await r.json();
        const last = (j.d || []).at(-1);
        if (!last) continue;
        const scale = this._priceScales.get(id) || 1;
        const price = Number(last.c) / scale;
        if (Number.isFinite(price) && price > 0) this.realTarget.set(id, price);
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
      if (Number(o.marketId) !== Number(marketId)) continue;
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
    const p = this.positions.get(Number(marketId));
    if (!p || p.sizeBase === 0) return false;
    return side === 'sell' ? p.sizeBase > 0 : p.sizeBase < 0;
  }

  _applyFill(marketId, side, price, qty) {
    const fee = price * qty * this.feeRate;
    this.balance -= fee;
    this.realizedPnl -= fee;
    const p = this.positions.get(Number(marketId)) || { sizeBase: 0, entryPrice: 0 };
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
    this.positions.set(Number(marketId), p);
  }
}

function synthCandles(start, n) {
  const out = []; let price = start; let t = Date.now() - n * 3600_000;
  const regime = Math.random() < 0.34 ? 0.0012 : Math.random() < 0.5 ? -0.0012 : 0;
  for (let i = 0; i < n; i++) {
    const open = price, close = price * (1 + regime + (Math.random() * 2 - 1) * 0.006);
    out.push({ time: t, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 100 });
    price = close; t += 3600_000;
  }
  return out;
}
