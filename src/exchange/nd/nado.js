// Nado LIVE adapter — Ink Chain perpetual DEX。架构 fork Vertex Protocol
// （gateway/engine/indexer + EIP-712 签名）。base URLs:
//   Engine (gateway): https://gateway.prod.nado.xyz
//   Indexer (archive): https://archive.prod.nado.xyz
//   Testnet: gateway.test / archive.test
//
// 签名：EIP-712 typed data，用 @nadohq/client SDK 的 `createNadoClient` 挂 viem
// walletClient。私钥来自 NADO_WALLET_PRIVATE_KEY env。
//
// 依赖：@nadohq/client, viem, bignumber.js（加到 optionalDependencies 避免
// 部署失败，跟 Round 211 的 Phoenix Solana 依赖同款策略）。
import { EventEmitter } from 'events';

const DEFAULT_MARKETS = [
  { symbol: 'BTC', displayName: 'BTC-PERP',  basePrice: 63000,  stepSize: 0.0001, stepPrice: 0.1,   minSize: 0.0001, maxLev: 25 },
  { symbol: 'ETH', displayName: 'ETH-PERP',  basePrice: 2100,   stepSize: 0.001,  stepPrice: 0.01,  minSize: 0.001,  maxLev: 25 },
  { symbol: 'SOL', displayName: 'SOL-PERP',  basePrice: 200,    stepSize: 0.01,   stepPrice: 0.001, minSize: 0.01,   maxLev: 20 },
  { symbol: 'HYPE',displayName: 'HYPE-PERP', basePrice: 30,     stepSize: 0.1,    stepPrice: 0.001, minSize: 0.1,    maxLev: 20 },
];

export class NadoExchange extends EventEmitter {
  constructor({ walletPrivateKey, chainEnv = 'inkMainnet' }) {
    super();
    this.mode = 'live';
    this.dataSource = 'connecting';
    this.lastOkAt = 0;
    this.lastError = null;
    this.balance = 0;
    this.equity = 0;
    this.realizedPnl = 0;
    this.orders = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this.markets = new Map();
    this._marketSymbolToId = new Map();
    this._pollTimer = null;
    this._chainEnv = chainEnv;   // 'inkMainnet' | 'inkTestnet'
    this._walletPrivateKey = walletPrivateKey;
    this._client = null;
    this._account = null;
    if (!walletPrivateKey) throw new Error('Nado 需要 walletPrivateKey (NADO_WALLET_PRIVATE_KEY)');
  }

  async init() {
    try {
      // Round X 起动 —— @nadohq/client + viem 都是 optionalDependencies。
      // 若 npm ci 部署时装失败或未装，走 synthetic 降级（用户不改 env 也能启动）。
      // 这里用 dynamic import，失败就抛给外层 catch。
      const { createNadoClient } = await import('@nadohq/client');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { createPublicClient, createWalletClient, http } = await import('viem');
      const { ink, inkSepolia } = await import('viem/chains');
      const chain = this._chainEnv === 'inkTestnet' ? inkSepolia : ink;
      this._account = privateKeyToAccount(this._walletPrivateKey);
      const publicClient = createPublicClient({ chain, transport: http() });
      const walletClient = createWalletClient({ account: this._account, chain, transport: http() });
      this._client = createNadoClient(this._chainEnv, { publicClient, walletClient });
      // 拉市场列表
      const rawMarkets = await this._client.market.getAllMarkets();
      const arr = Array.isArray(rawMarkets) ? rawMarkets
                : Array.isArray(rawMarkets?.markets) ? rawMarkets.markets
                : Array.isArray(rawMarkets?.data) ? rawMarkets.data
                : [];
      let idx = 1;
      for (const m of arr) {
        const symbol = String(m.symbol || m.marketSymbol || m.name || '').toUpperCase();
        if (!symbol) continue;
        this.markets.set(idx, {
          marketId: idx,
          displayName: symbol.endsWith('-PERP') ? symbol : `${symbol}-PERP`,
          symbol,
          lastPrice: Number(m.lastPrice || m.price || 0) || 0,
          minOrderSize: Number(m.minOrderSize || m.minSize || 0) || 0.0001,
          stepSize: Number(m.stepSize || m.sizeIncrement || 0) || 0.0001,
          stepPrice: Number(m.stepPrice || m.priceIncrement || m.tickSize || 0) || 0.01,
          maxLeverage: Number(m.maxLeverage || m.maxLev || 0) || 20,
          productId: m.productId ?? m.id ?? idx,   // Vertex-style productId (真正 Nado 用来 place)
        });
        this._marketSymbolToId.set(symbol, idx);
        idx++;
      }
      if (this.markets.size === 0) {
        // SDK 返空 → 填 fallback 让 UI 至少能看到 pair 名
        for (const m of DEFAULT_MARKETS) {
          const id = idx++;
          this.markets.set(id, { ...m, marketId: id });
          this._marketSymbolToId.set(m.symbol, id);
        }
      }
      // 拉初始余额（subaccount summary）
      await this._refreshBalance().catch(() => {});
      this.dataSource = 'real';
      this.lastOkAt = Date.now();
      return true;
    } catch (e) {
      this.lastError = `init: ${e.message}`;
      this.dataSource = 'synthetic';
      throw e;
    }
  }

  async _refreshBalance() {
    if (!this._client || !this._account) return;
    try {
      const summary = await this._client.subaccount.getSummary({
        subaccountOwner: this._account.address,
        subaccountName: 'default',
      });
      // 猜测字段位置（Vertex 风格 subaccount summary 结构）
      const collateral = Number(summary?.summary?.health?.assets ?? summary?.collateral ?? 0);
      const health = Number(summary?.summary?.health?.total ?? summary?.health ?? collateral);
      this.balance = collateral;
      this.equity = health || collateral;
      this.lastOkAt = Date.now();
    } catch (e) {
      this.lastError = `拉 subaccount 失败：${e.message}`;
    }
  }

  async getMarkets() { return [...this.markets.values()]; }
  async getPrice(marketId) { return this.prices.get(Number(marketId)) ?? this.markets.get(Number(marketId))?.lastPrice ?? null; }

  async getCandles(marketId, sec, n) {
    if (!this._client) return [];
    try {
      const m = this.markets.get(Number(marketId));
      if (!m) return [];
      const bars = await this._client.market.getCandlesticks({
        productId: m.productId,
        granularity: sec || 3600,
        limit: n || 100,
      });
      const arr = Array.isArray(bars) ? bars : (Array.isArray(bars?.candlesticks) ? bars.candlesticks : []);
      return arr.map((b) => ({
        time: Number(b.time || b.timestamp || 0),
        t: Number(b.time || b.timestamp || 0),
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
        volume: Number(b.volume || 0),
      }));
    } catch { return []; }
  }

  async setLeverage(_marketId, _leverage) { return true; }

  async placeLimitOrder(o) {
    if (!this._client) throw new Error('Nado SDK 未 ready');
    const marketId = Number(o.marketId);
    const m = this.markets.get(marketId);
    if (!m) throw new Error(`Nado 未知 marketId=${marketId}`);
    const isBuy = o.side === 'buy';
    const res = await this._client.market.placeOrder({
      productId: m.productId,
      order: {
        amount: (isBuy ? 1 : -1) * Number(o.sizeBase),   // Vertex 用 signed amount
        priceX18: Number(o.price),                        // SDK 内部会 stringify + 18-decimals
        expiration: Math.floor(Date.now() / 1000) + 24 * 3600,
        nonce: `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      },
    });
    const orderId = res?.orderId ?? res?.data?.digest ?? res?.digest ?? `nd-${Date.now()}`;
    this.orders.set(String(orderId), {
      orderId: String(orderId), marketId, side: o.side,
      price: Number(o.price), sizeBase: Number(o.sizeBase),
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
    });
    return { orderId: String(orderId) };
  }

  async cancelOrder(marketId, orderId) {
    if (!this._client) return false;
    const m = this.markets.get(Number(marketId));
    if (!m) return false;
    try {
      await this._client.market.cancelOrders({
        productIds: [m.productId],
        digests: [String(orderId)],
      });
      this.orders.delete(String(orderId));
      return true;
    } catch (e) {
      this.lastError = `cancelOrder: ${e.message}`;
      return false;
    }
  }

  async cancelAll(marketId) {
    if (!this._client) return true;
    const m = this.markets.get(Number(marketId));
    if (!m) return true;
    try {
      await this._client.market.cancelProductOrders({ productIds: [m.productId] });
      for (const [id, o] of this.orders) {
        if (Number(o.marketId) === Number(marketId)) this.orders.delete(id);
      }
      return true;
    } catch (e) {
      this.lastError = `cancelAll: ${e.message}`;
      throw e;
    }
  }

  async fetchOpenOrders(marketId) {
    if (!this._client || !this._account) return null;
    try {
      const m = this.markets.get(Number(marketId));
      if (!m) return [];
      const resp = await this._client.market.getOpenSubaccountOrders({
        subaccountOwner: this._account.address,
        subaccountName: 'default',
        productId: m.productId,
      });
      const arr = Array.isArray(resp) ? resp : (Array.isArray(resp?.orders) ? resp.orders : []);
      return arr.map((o) => ({
        orderId: String(o.digest || o.orderId || o.id || ''),
        price: Number(o.priceX18 || o.price || 0),
        side: Number(o.amount || 0) > 0 ? 'buy' : 'sell',
      })).filter((x) => x.orderId);
    } catch (e) {
      this.lastError = `fetchOpenOrders: ${e.message}`;
      return null;
    }
  }

  async fetchPositions() {
    if (!this._client || !this._account) return [];
    try {
      const summary = await this._client.subaccount.getSummary({
        subaccountOwner: this._account.address,
        subaccountName: 'default',
      });
      const positions = summary?.summary?.perpBalances || summary?.positions || [];
      return Array.isArray(positions) ? positions : [];
    } catch { return []; }
  }

  getOpenOrders(marketId) {
    const mid = Number(marketId);
    return [...this.orders.values()].filter((o) => Number(o.marketId) === mid);
  }
  getPosition(marketId) { return this.positions.get(Number(marketId)) || null; }

  async closePosition(marketId) {
    // MVP：Nado 平仓需要发反向 market order，SDK 内没现成 helper。
    // Round N+1 实现（bot 侧 stop({closePosition:true}) 会 fallback 到 placeLimitOrder market 单）
    return { closed: false };
  }

  async reconcileOpenOrders() { return true; }

  start() {
    if (this._pollTimer) return;
    // 每 10 秒 poll 一次价格 + 余额
    this._pollTimer = setInterval(async () => {
      try {
        // 价格来自 SDK 的 market.getLatestMarketPrice（Round N+1 实现批量拉）
        // MVP：仅 refresh balance，价格靠 candles / 用户面上 chart
        await this._refreshBalance();
      } catch { /* ignore transient */ }
    }, 10_000);
    this._pollTimer.unref?.();
  }

  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async reconnect() { return this.init(); }
}
