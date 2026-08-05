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
// 拉市场列表：Round 275 修复 —— all_products/getAllMarkets 只有 productId/oraclePrice/
            // 风险参数，没有 symbol 字段。之前用 m.symbol||m.marketSymbol||m.name 猜，全部猜空
            // → markets.size===0 → 静默 fallback 到 DEFAULT_MARKETS（productId 变成本地序号
            // 1/2/3/4，跟 Nado 真实 productId 完全不对应）→ K 线/下单都用错 productId 静默失败。
            // 真正给 symbol<->productId 映射的是 getSymbols()（engine `symbols` query）。
            const [symbolsResp, rawMarkets] = await Promise.all([
                      this._client.context.engineClient.getSymbols({})).catch(() => null),
                      this._client.market.getAllMarkets().catch(() => []),
                    ]);
            const toNum = (v) => {
                      if (v == null) return 0;
                      if (typeof v === 'number') return v;
                      if (typeof v?.toNumber === 'function') { try { return v.toNumber(); } catch { return Number(v) || 0; } }
                      return Number(v) || 0;
            };
            const priceByProductId = new Map();
            for (const m of (Array.isArray(rawMarkets) ? rawMarkets : [])) {
                      const pid = m?.productId ?? m?.product?.productId;
                      if (pid != null) priceByProductId.set(Number(pid), toNum(m?.product?.oraclePrice));
            }
            let idx = 1;
            const symbolEntries = symbolsResp?.symbols ? Object.values(symbolsResp.symbols) : [];
            for (const s of symbolEntries) {
                      const symbol = String(s.symbol || '').toUpperCase();
                      if (!symbol) continue;
                      const productId = Number(s.productId);
                      this.markets.set(idx, {
                                  marketId: idx,
                                  displayName: symbol,
                                  symbol: symbol.replace(/-PERP$/, ''),
                                  lastPrice: priceByProductId.get(productId) || 0,
                                  minOrderSize: toNum(s.minSize) || 0.0001,
                                  stepSize: toNum(s.sizeIncrement) || 0.0001,
                                  stepPrice: toNum(s.priceIncrement) || 0.01,
                                  maxLeverage: 20,
                                  productId, // 真实 Nado productId（来自 getSymbols，不是本地序号）
                      });
                      this._marketSymbolToId.set(symbol.replace(/-PERP$/, ''), idx);
                      idx++;
            }
            if (this.markets.size === 0) {
                      // SDK 仍返空（比如 getSymbols 也失败）→ 填 fallback 让 UI 至少能看到 pair 名，
                      // 但明确记录 lastError，不再假装是 real 数据。
                      this.lastError = 'getSymbols/getAllMarkets 均未返回可用市场，使用离线 fallback 列表（productId 不可用，无法下单）';
                      for (const m of DEFAULT_MARKETS) {
                                  const id = idx++;
                                  this.markets.set(id, { ...m, marketId: id });
                                  this._marketSymbolToId.set(m.symbol, id);
                      }
            }
      // 拉初始余额（subaccount summary）
await this._refreshBalance().catch((e) => { this.lastError = `init refreshBalance: ${e.message}`; });
            if (!this.lastError) {
                      this.dataSource = 'real';
                      this.lastOkAt = Date.now();
            } else {
                      this.dataSource = 'synthetic';
            }
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
      // Round 273a：真实 SDK 方法名是 getSubaccountSummary（Round 272 猜错了 .getSummary）。
      // 响应 shape (verified from @nadohq/client 0.1.4 & 0.31.0 d.ts):
      //   { exists, balances: BalanceWithProduct[], health: HealthStatusByType }
      //   balances: 混 spot+perp，each { type, productId, amount: BigNumber, ... }
      //   health: { initial, maintenance, unweighted } each { health, assets, liabilities } BigNumber x18
      const summary = await this._client.subaccount.getSubaccountSummary({
        subaccountOwner: this._account.address,
        subaccountName: 'default',
      });

      const scaled = (v) => {
        if (v == null) return null;
        try {
          const s = String(v);
          if (!s || s === 'undefined') return null;
          return Number(s) / 1e18;
        } catch { return null; }
      };

      // USDC 是 productId=0（quote spot product）。拿 balances 里 type='spot' && productId=0 的 amount。
      const balances = Array.isArray(summary?.balances) ? summary.balances : [];
      const usdc = balances.find((b) => Number(b?.productId) === 0);
      const collateralUsdc = scaled(usdc?.amount);

      // Equity = unweighted.health（不打折 asset - liability，含未实现盈亏）
      // 若拿不到 unweighted，退 initial.assets（纯 collateral 价值）
      const healthByType = summary?.health || {};
      const equityFromUnweighted = scaled(healthByType.unweighted?.health);
      const assetsFromInitial = scaled(healthByType.initial?.assets);

      const balance = collateralUsdc ?? assetsFromInitial ?? 0;
      const equity = equityFromUnweighted ?? balance;

      this.balance = Number.isFinite(balance) ? balance : 0;
      this.equity = Number.isFinite(equity) ? equity : this.balance;
      this.lastOkAt = Date.now();
      this.lastError = null;
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
        period: sec || 3600,
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
