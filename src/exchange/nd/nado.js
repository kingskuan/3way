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
import BigNumber from 'bignumber.js';

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
                              this._client.context.engineClient.getSymbols({}).catch(() => null),
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
              // Round 275i：某些 market（比如 USDJPY-PERP, stock perps）是 isolated-only
              // (isolated_only=true / camelCase isolatedOnly)。我们的 grid 走 cross-margin
              // （equity 背整个组合），所以 isolated-only 单会被引擎拒:
              //   2122: Market is in isolated-only mode. Only isolated orders are accepted.
              // 直接从可选市场列表 filter 掉，让 Autopilot 不会 pick 到。
              if (s.isolatedOnly === true || s.isolated_only === true) continue;
              const productId = Number(s.productId);
              const lastPrice = priceByProductId.get(productId) || 0;
              // Round 275a：Nado 的 s.minSize 返 100 (=$100 USDC 名义值) 而非 base tokens。
              // 实测所有 85 市场都返 100，明显是全局 min notional $100。除以 lastPrice 得 base size。
              const minNotionalUsd = (toNum(s.minSize) / 1e18) || 100;
              const minOrderSize = (lastPrice > 0 ? minNotionalUsd / lastPrice : 0.0001) || 0.0001;
              // stepSize: sizeIncrement 是 base x18（Vertex 标准）→ /1e18
              const stepSize = (toNum(s.sizeIncrement) / 1e18) || 0.0001;
              this.markets.set(idx, {
                marketId: idx,
                displayName: symbol,
                symbol: symbol.replace(/-PERP$/, ''),
                lastPrice,
                minOrderSize,
                stepSize,
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
    // Round 275c/d/g：EIP712OrderParams 真实 shape:
    //   { subaccountOwner, subaccountName, expiration, price, amount, nonce, appendix }
    //   全是 BigNumberish。但 SDK 里 getOrderValues 用两种处理：
    //     price → addDecimals(1e18) → toIntegerString  ← SDK 自动 scale
    //     amount → toIntegerString                     ← 调用方必须 pre-scale
    //   Round 275d 我为了避 128-bit 溢出把两个都传人类小数，结果 amount 传
    //   "-0.002" → toFixed(0) → "-1" 被引擎拒 "must be divisible by size_increment"。
    //   Round 275g：只 pre-scale amount ×1e18；price 让 SDK scale（保持 Round 275d 逻辑）。
    const sizeBase = Number(o.sizeBase) || 0;
    const price = Number(o.price) || 0;
    if (!(sizeBase > 0) || !(price > 0)) {
      throw new Error(`Nado 参数异常 sizeBase=${o.sizeBase} price=${o.price}`);
    }
    // Round 275h：引擎强制 amount 必须能被 size_increment 整除
    //   （market.stepSize 已从 s.sizeIncrement/1e18 算好）。bot 的 grid math 不管
    //   adapter 的 step，所以在这里 snap：sizeBase → floor(sizeBase/step)*step。
    const stepSize = Number(m.stepSize) || 0;
    let snappedSize = sizeBase;
    if (stepSize > 0) {
      const nSteps = new BigNumber(sizeBase).dividedBy(stepSize).integerValue(BigNumber.ROUND_DOWN);
      snappedSize = nSteps.multipliedBy(stepSize).toNumber();
      if (!(snappedSize > 0)) {
        throw new Error(`Nado sizeBase=${sizeBase} < stepSize=${stepSize} snap 后为 0`);
      }
    }
    // amount 再 pre-scale ×1e18（Vertex 约定：buy=正, sell=负）
    const scaled = new BigNumber(snappedSize).multipliedBy(new BigNumber(10).pow(18)).integerValue(BigNumber.ROUND_DOWN);
    const amountStr = (isBuy ? '' : '-') + scaled.toFixed(0);
    // price 同样 snap 到 stepPrice（Nado 也会拒 price 不对 tick）
    const stepPrice = Number(m.stepPrice) || 0;
    let snappedPrice = price;
    if (stepPrice > 0) {
      const nTicks = new BigNumber(price).dividedBy(stepPrice).integerValue(BigNumber.ROUND_HALF_UP);
      snappedPrice = nTicks.multipliedBy(stepPrice).toNumber();
    }
    const priceStr = snappedPrice.toString();
    // expiration: unix seconds; 24h TTL for grid orders
    const expiration = String(Math.floor(Date.now() / 1000) + 24 * 3600);
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const res = await this._client.market.placeOrder({
      productId: m.productId,
      order: {
        subaccountOwner: this._account.address,
        subaccountName: 'default',
        expiration,
        price: priceStr,
        amount: amountStr,
        nonce,
        // Round 275e/f：EIP712OrderParams 的 appendix 是 128-bit packed struct。
        // 从 @nadohq/shared/utils/orders/appendix/packOrderAppendix.cjs 挖到：
        //   value(64) | builderId(16) | builderFeeRate(10) | reserved(24) |
        //   trigger(2) | reduceOnly(1) | orderType(2) | isolated(1) | version(8)
        // 简单 limit-GTC 单（所有 flag=0，version=1）packed 值 = 1（version 占最低 8 bits）。
        // 271e 用 '0' 被拒："order version 0 does not match expected 1"。
        appendix: '1',
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
      // Round 275b：Nado gateway 2024 "no previous deposits" = 该 product 从没交易过。
      // 部署后 marketId 会 re-index（idx 从 getSymbols 顺序而定，跨部署可能不稳定）→
      // 老 config.marketId 指向另一个从未交易的 product → 撤单失败 abort rotate → bot
      // 永远起不了。视为"没老单要撤"静默放行。
      const msg = String(e?.message || e);
      if (/no previous deposits|Invalid subaccount|no orders/i.test(msg)) {
        this.lastError = null;
        for (const [id, o] of this.orders) {
          if (Number(o.marketId) === Number(marketId)) this.orders.delete(id);
        }
        return true;
      }
      this.lastError = `cancelAll: ${msg}`;
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
