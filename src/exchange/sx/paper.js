// StandX Paper (synthetic) adapter — 展示为 SX: PAPER。
// 提供 BTC/ETH/XAU/XAG 4 个市场的模拟价格 + 余额，方便 UI 联调。
// 真正 LIVE 走 standx.js（需 SX_PRIVATE_KEY env）。

import { EventEmitter } from 'events';

const MARKETS = [
  { marketId: 1, symbol: 'BTC', displayName: 'BTC-USD', basePrice: 72000, priceTick: 0.01, sizeTick: 0.0001, minSize: 0.0001, maxLev: 20 },
  { marketId: 2, symbol: 'ETH', displayName: 'ETH-USD', basePrice: 2200, priceTick: 0.01, sizeTick: 0.0001, minSize: 0.0001, maxLev: 20 },
  { marketId: 3, symbol: 'XAU', displayName: 'XAU-USD', basePrice: 2600, priceTick: 0.01, sizeTick: 0.001, minSize: 0.001, maxLev: 10 },
  { marketId: 4, symbol: 'XAG', displayName: 'XAG-USD', basePrice: 31, priceTick: 0.001, sizeTick: 0.01, minSize: 0.01, maxLev: 10 },
];

export class StandXPaper extends EventEmitter {
  constructor({ startBalance = 10000 } = {}) {
    super();
    this.mode = 'paper';
    this.dataSource = 'synthetic';
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.balance = startBalance;
    this.realizedPnl = 0;
    this.orders = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this.markets = new Map();
    this._priceScales = new Map();
    this._sizeScales = new Map();
    this._pollTimer = null;
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
    // 合成模式：立即 ready
    this.dataSource = 'synthetic';
    this.lastOkAt = Date.now();
    return true;
  }

  async getMarkets() {
    return [...this.markets.values()];
  }

  async getPrice(marketId) {
    return this.prices.get(Number(marketId)) ?? null;
  }

  async getCandles(marketId, sec, n) {
    // 合成 n 根 K 线，围绕当前价 ±0.5% 随机游走
    const price = this.prices.get(Number(marketId)) ?? 100;
    const now = Math.floor(Date.now() / 1000);
    const step = sec || 3600;
    const out = [];
    let last = price;
    for (let i = n - 1; i >= 0; i--) {
      const t = now - i * step;
      const drift = (Math.sin(i * 0.7) + Math.cos(i * 0.4)) * 0.003;
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

  async placeLimitOrder(o) {
    const marketId = Number(o.marketId);
    const orderId = 'sx-paper-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    this.orders.set(orderId, {
      orderId, marketId, side: o.side,
      price: Number(o.price), sizeBase: Number(o.sizeBase),
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      reduceOnly: !!o.reduceOnly,
    });
    return { orderId };
  }

  async cancelOrder(marketId, orderId) {
    this.orders.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    const marketIdN = Number(marketId);
    for (const [id, o] of this.orders) {
      if (o.marketId === marketIdN) this.orders.delete(id);
    }
    return true;
  }

  async fetchOpenOrders(marketId) {
    const marketIdN = Number(marketId);
    return [...this.orders.values()]
      .filter((o) => o.marketId === marketIdN)
      .map((o) => ({ orderId: String(o.orderId), price: o.price, side: o.side }));
  }

  async fetchPositions() {
    return [...this.positions.values()];
  }

  getOpenOrders(marketId) {
    const marketIdN = Number(marketId);
    return [...this.orders.values()].filter((o) => o.marketId === marketIdN);
  }

  getPosition(marketId) {
    return this.positions.get(Number(marketId)) || null;
  }

  async closePosition(marketId) {
    this.positions.delete(Number(marketId));
    return { closed: true };
  }

  async reconcileOpenOrders() { return true; }

  start() {
    // 慢慢的价格随机游走（每 3s）+ 数据健康度更新
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
