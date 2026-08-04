// Nado Paper (synthetic) adapter — 展示为 ND: PAPER。
// Nado 是 Ink Chain 上的永续 DEX，架构 fork 自 Vertex Protocol（gateway/engine/indexer + EIP-712 签名）。
// paper 提供 BTC/ETH/SOL/HYPE 4 市场的合成价格。
// LIVE 走 nado.js —— 需要 EVM wallet 私钥（NADO_WALLET_PRIVATE_KEY）+ @nadohq/client SDK。
import { EventEmitter } from 'events';

const MARKETS = [
  { marketId: 1, symbol: 'BTC', displayName: 'BTC-PERP',  basePrice: 63000,  priceTick: 0.1,   sizeTick: 0.0001, minSize: 0.0001, maxLev: 25 },
  { marketId: 2, symbol: 'ETH', displayName: 'ETH-PERP',  basePrice: 2100,   priceTick: 0.01,  sizeTick: 0.001,  minSize: 0.001,  maxLev: 25 },
  { marketId: 3, symbol: 'SOL', displayName: 'SOL-PERP',  basePrice: 200,    priceTick: 0.001, sizeTick: 0.01,   minSize: 0.01,   maxLev: 20 },
  { marketId: 4, symbol: 'HYPE',displayName: 'HYPE-PERP', basePrice: 30,     priceTick: 0.001, sizeTick: 0.1,    minSize: 0.1,    maxLev: 20 },
];

export class NadoPaper extends EventEmitter {
  constructor({ startBalance = 10000 } = {}) {
    super();
    this.mode = 'paper';
    this.dataSource = 'synthetic';
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.balance = startBalance;
    this.equity = startBalance;
    this.realizedPnl = 0;
    this.orders = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this.markets = new Map();
    this._pxWalkTimer = null;
    for (const m of MARKETS) {
      this.markets.set(m.marketId, {
        marketId: m.marketId, displayName: m.displayName, symbol: m.symbol,
        lastPrice: m.basePrice, minOrderSize: m.minSize, stepSize: m.sizeTick,
        stepPrice: m.priceTick, maxLeverage: m.maxLev,
      });
      this.prices.set(m.marketId, m.basePrice);
    }
  }

  async init() {
    this.dataSource = 'synthetic';
    this.lastOkAt = Date.now();
    return true;
  }

  async getMarkets() { return [...this.markets.values()]; }
  async getPrice(marketId) { return this.prices.get(Number(marketId)) ?? null; }

  async getCandles(marketId, sec, n) {
    const price = this.prices.get(Number(marketId)) ?? 100;
    const now = Math.floor(Date.now() / 1000);
    const step = sec || 3600;
    const out = [];
    let last = price;
    for (let i = n - 1; i >= 0; i--) {
      const t = now - i * step;
      const drift = (Math.sin(i * 0.5) + Math.cos(i * 0.3)) * 0.003;
      const noise = (Math.random() - 0.5) * 0.005;
      const close = last * (1 + drift + noise);
      const open = last;
      const high = Math.max(open, close) * (1 + Math.random() * 0.002);
      const low = Math.min(open, close) * (1 - Math.random() * 0.002);
      out.push({ time: t, open, high, low, close, volume: Math.random() * 100 });
      last = close;
    }
    return out;
  }

  async setLeverage(_marketId, _leverage) { return true; }

  async placeLimitOrder(o) {
    const marketId = Number(o.marketId);
    const orderId = 'nd-paper-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    this.orders.set(orderId, {
      orderId, marketId, side: o.side,
      price: Number(o.price), sizeBase: Number(o.sizeBase),
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      reduceOnly: !!o.reduceOnly,
    });
    return { orderId };
  }

  async cancelOrder(_marketId, orderId) {
    this.orders.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    const mid = Number(marketId);
    for (const [id, o] of this.orders) {
      if (o.marketId === mid) this.orders.delete(id);
    }
    return true;
  }

  async fetchOpenOrders(marketId) {
    const mid = Number(marketId);
    return [...this.orders.values()].filter((o) => o.marketId === mid)
      .map((o) => ({ orderId: String(o.orderId), price: o.price, side: o.side }));
  }

  async fetchPositions() { return [...this.positions.values()]; }

  getOpenOrders(marketId) {
    const mid = Number(marketId);
    return [...this.orders.values()].filter((o) => o.marketId === mid);
  }
  getPosition(marketId) { return this.positions.get(Number(marketId)) || null; }

  async closePosition(marketId) {
    this.positions.delete(Number(marketId));
    return { closed: true };
  }

  async reconcileOpenOrders() { return true; }

  start() {
    if (this._pxWalkTimer) return;
    this._pxWalkTimer = setInterval(() => {
      this.lastOkAt = Date.now();
      for (const [id, price] of this.prices) {
        const next = price * (1 + (Math.random() - 0.5) * 0.002);
        this.prices.set(id, next);
        const m = this.markets.get(id);
        if (m) m.lastPrice = next;
        this.emit('price', { marketId: id, price: next });
      }
    }, 3000);
    this._pxWalkTimer.unref?.();
  }

  stop() {
    if (this._pxWalkTimer) { clearInterval(this._pxWalkTimer); this._pxWalkTimer = null; }
  }

  async reconnect() { return this.init(); }
}
