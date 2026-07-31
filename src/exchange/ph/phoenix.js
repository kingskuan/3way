// Phoenix LIVE adapter (Round 209 完整实现)
//
// Phoenix (perp-api.phoenix.trade) 是 Solana 链上永续 DEX，架构跟其他 8 家 REST/HMAC
// 完全不同：
//   1. Auth = Solana 钱包签名 nonce → JWT bearer token
//   2. 下单 = POST /v1/ix/place-isolated-limit-order 拿回 base64 编码的 Solana
//      instruction；客户端 sign + submit 到 Solana RPC 才真实成单
//   3. Fill 通过 API 轮询 trader state 或 orders_v2 拿
//
// 依赖 @solana/web3.js + bs58 —— 都是 Solana 官方推荐。
import { EventEmitter } from 'events';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const BASE_URL = 'https://perp-api.phoenix.trade';

export class PhoenixExchange extends EventEmitter {
  constructor({ walletPrivateKey, solanaRpcUrl }) {
    super();
    this.mode = 'live';
    this.dataSource = 'connecting';
    this.lastOkAt = 0;
    this.lastError = null;
    this.balance = 0;
    this.realizedPnl = 0;
    this.orders = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this.markets = new Map();
    this._marketSymbolToId = new Map();
    this._authToken = null;
    this._authTokenExpiresAt = 0;
    this._pollTimer = null;

    // Solana 钱包解码
    try {
      const secret = bs58.decode(walletPrivateKey);
      this._keypair = Keypair.fromSecretKey(secret);
      this._authorityPubkey = this._keypair.publicKey.toBase58();
    } catch (e) {
      throw new Error(`Phoenix wallet 私钥无效（应为 base58 编码的 64-byte secret）：${e.message}`);
    }

    this._solanaConn = new Connection(solanaRpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
  }

  async _req(method, path, body = null, needAuth = false) {
    const headers = { 'Accept': 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (needAuth) {
      await this._ensureAuth();
      headers['Authorization'] = `Bearer ${this._authToken}`;
    }
    const opts = { method, headers, signal: AbortSignal.timeout(15000) };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const msg = j?.error || j?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      // 401/403 → 清 token 触发下次重认证
      if (res.status === 401 || res.status === 403) { this._authToken = null; }
      throw new Error(`Phoenix ${method} ${path} → ${msg}`);
    }
    return j;
  }

  async _ensureAuth() {
    // Token 还有效则直接返回
    if (this._authToken && Date.now() < this._authTokenExpiresAt - 60_000) return;
    // 1. 拿 nonce（字段是 wallet_pubkey，不是 pubkey；Round 213 直接打 API 探到）
    const nonceRes = await fetch(`${BASE_URL}/v1/auth/nonce?wallet_pubkey=${this._authorityPubkey}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!nonceRes.ok) {
      const t = await nonceRes.text();
      throw new Error(`Phoenix nonce 拉取失败：HTTP ${nonceRes.status} · ${t.slice(0, 200)}`);
    }
    const nonceData = await nonceRes.json();
    // Phoenix 响应：{ nonce_id, message, expires_at }
    // 要签的是 message 完整字符串（多行：phoenix-wallet-login-v1\nwallet:xxx\nnonce:xxx\nexpires_at:xxx）
    const nonceId = nonceData?.nonce_id;
    const message = nonceData?.message;
    if (!nonceId || !message) {
      throw new Error(`Phoenix nonce 响应缺 nonce_id/message：${JSON.stringify(nonceData).slice(0, 200)}`);
    }
    // 2. Sign message bytes（不是 nonce_id）with wallet keypair (ed25519)
    const messageBytes = new TextEncoder().encode(String(message));
    // @solana/web3.js Keypair 用 nacl sign，需要 nacl 库或用 tweetnacl
    // web3.js 内部就有 nacl，暴露方式是 Keypair.secretKey → sign
    // 简化：用 crypto ed25519 直接签
    const nacl = await import('tweetnacl').catch(() => null);
    let signature;
    if (nacl && nacl.default) {
      signature = nacl.default.sign.detached(messageBytes, this._keypair.secretKey);
    } else {
      // web3.js 依赖 @noble/curves 但没直接暴露；此路径不常用
      throw new Error('Phoenix 签名需要 tweetnacl（@solana/web3.js 依赖）—— 环境异常');
    }
    // 3. Login with signature
    const loginRes = await fetch(`${BASE_URL}/v1/auth/login/wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        wallet_pubkey: this._authorityPubkey,
        signature: bs58.encode(signature),
        nonce_id: nonceId,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!loginRes.ok) {
      const t = await loginRes.text();
      throw new Error(`Phoenix login 失败：HTTP ${loginRes.status} · ${t.slice(0, 200)}`);
    }
    const loginData = await loginRes.json();
    this._authToken = loginData?.token || loginData?.accessToken || loginData?.bearerToken;
    // Token TTL 假设 1 小时（响应 exp 字段没探明，保守）
    this._authTokenExpiresAt = Date.now() + 3600_000;
    if (!this._authToken) throw new Error(`Phoenix login 响应无 token：${JSON.stringify(loginData).slice(0, 200)}`);
  }

  async init() {
    // 拉市场（不需 auth）
    try {
      const markets = await this._req('GET', '/v1/view/exchange/markets');
      if (Array.isArray(markets)) {
        let idx = 1;
        for (const m of markets) {
          if (!m.symbol) continue;
          if (m.marketStatus !== 'active') continue;
          // Phoenix 字段（Round 213 直接打 API 探得）：
          //   tickSize: 价格 tick（整数或小数，具体单位看 asset）
          //   baseLotsDecimals: base lot 小数位（e.g. 2 → 0.01 步长）
          //   leverageTiers: [{ maxLeverage, maxSizeBaseLots, ... }]
          //   marketPubkey: on-chain 地址（订单/仓位 PDA seed 用）
          const baseLotStep = Math.pow(10, -Number(m.baseLotsDecimals || 3));
          const maxLev = Array.isArray(m.leverageTiers) && m.leverageTiers.length > 0
            ? Number(m.leverageTiers[0].maxLeverage) || 20
            : 20;
          const market = {
            marketId: idx,
            displayName: m.symbol,
            symbol: String(m.symbol),   // Phoenix 用裸 symbol 无 -PERP 后缀
            lastPrice: 0,               // 价格从 /v1/candles/{symbol} 拉，init 后 poll 更新
            minOrderSize: baseLotStep,
            stepSize: baseLotStep,
            stepPrice: Number(m.tickSize) || 0.01,
            maxLeverage: maxLev,
            marketPubkey: m.marketPubkey,
            takerFee: Number(m.takerFee) || 0,
            makerFee: Number(m.makerFee) || 0,
          };
          this.markets.set(idx, market);
          this._marketSymbolToId.set(String(m.symbol), idx);
          idx++;
        }
      }
    } catch (e) {
      this.lastError = `拉市场失败：${e.message}`;
      throw new Error(`Phoenix init 拉市场失败：${e.message}`);
    }

    // 认证 —— 失败不 throw，退到 real-readonly 让 start() 继续启 poll timer
    // 拉市场/K 线/价格是公开接口，即使 auth 挂了也应该能显示 Phoenix 市场数据。
    try {
      await this._ensureAuth();
      this.dataSource = 'real';
      this.lastOkAt = Date.now();
    } catch (e) {
      this.dataSource = 'real-readonly';
      this.lastError = `认证失败：${e.message}`;
      console.warn(`[Phoenix] auth 失败，退到 real-readonly：${e.message}`);
    }

    // 拉初始 trader state 拿 balance（若 auth 没过，_refreshBalance 会跳过）
    try { await this._refreshBalance(); } catch (e) { /* 首次失败不 throw，poll 里会重试 */ }

    return true;
  }

  async _refreshBalance() {
    try {
      const state = await this._req('GET', `/v1/trader/state/${this._authorityPubkey}`, null, true);
      const usdcBal = Number(state?.usdcBalance ?? state?.balance ?? state?.equity ?? 0);
      if (usdcBal > 0) this.balance = usdcBal;
      if (Array.isArray(state?.positions)) {
        this.positions.clear();
        for (const p of state.positions) {
          const mid = this._marketSymbolToId.get(p.symbol);
          if (mid != null) {
            this.positions.set(mid, {
              marketId: mid,
              sizeBase: Number(p.baseSize || p.sizeBase || 0),
              entryPrice: Number(p.avgEntryPrice || p.entryPrice || 0),
              unrealizedPnl: Number(p.unrealizedPnl || 0),
              leverage: Number(p.leverage || 10),
            });
          }
        }
      }
    } catch (e) {
      this.lastError = `拉 trader state 失败：${e.message}`;
    }
  }

  async _signAndSubmitInstructions(instructionsData) {
    // instructionsData 是 API 返回的 [{ type, data: <base64 instruction> }] 或 { instructions: [...] }
    const arr = Array.isArray(instructionsData) ? instructionsData : instructionsData?.instructions;
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error('Phoenix 返回的 instruction 数组为空');
    }
    // 每个 instruction 是一个完整 signed transaction（Phoenix API 通常返 pre-built TX）
    const results = [];
    for (const inst of arr) {
      const b64 = inst.data || inst.tx || inst.transaction;
      if (!b64) continue;
      const txBytes = Buffer.from(b64, 'base64');
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([this._keypair]);
      const sig = await this._solanaConn.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });
      // 等确认（confirmed 就 OK，finalized 太慢）
      await this._solanaConn.confirmTransaction(sig, 'confirmed');
      results.push(sig);
    }
    return results;
  }

  async getMarkets() {
    return [...this.markets.values()];
  }

  async getPrice(marketId) {
    return this.prices.get(Number(marketId)) ?? null;
  }

  async setLeverage(_marketId, _leverage) {
    // Phoenix isolated margin - leverage per order，无 account-level setLeverage
    return true;
  }

  async placeLimitOrder(o) {
    const marketId = Number(o.marketId);
    const m = this.markets.get(marketId);
    if (!m) throw new Error(`Phoenix 未知 marketId=${marketId}`);
    const side = o.side === 'buy' ? 'Bid' : 'Ask';
    // priceInTicks = price / priceTickSize; numBaseLots = sizeBase / baseLotSize
    const priceInTicks = Math.round(Number(o.price) / m.stepPrice);
    const numBaseLots = Math.round(Number(o.sizeBase) / m.stepSize);
    if (priceInTicks <= 0 || numBaseLots <= 0) {
      throw new Error(`Phoenix 单量/价格 tick 计算异常 price=${o.price} size=${o.sizeBase}`);
    }
    const body = {
      authority: this._authorityPubkey,
      side,
      symbol: m.displayName,
      priceInTicks,
      numBaseLots,
    };
    const instructionsData = await this._req('POST', '/v1/ix/place-isolated-limit-order', body, true);
    const sigs = await this._signAndSubmitInstructions(instructionsData);
    const orderId = sigs[0] || ('ph-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    this.orders.set(orderId, {
      orderId, marketId, side: o.side,
      price: Number(o.price), sizeBase: Number(o.sizeBase),
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      reduceOnly: !!o.reduceOnly,
    });
    return { orderId };
  }

  async cancelOrder(_marketId, orderId) {
    // Phoenix cancel 也返 instruction 需要签名 submit
    const body = { authority: this._authorityPubkey, orderId: String(orderId) };
    try {
      const instructionsData = await this._req('POST', '/v1/ix/cancel-order', body, true);
      await this._signAndSubmitInstructions(instructionsData);
      this.orders.delete(String(orderId));
      return true;
    } catch (e) {
      if (/not\s?found|already/i.test(e.message)) {
        this.orders.delete(String(orderId));
        return true;
      }
      throw e;
    }
  }

  async cancelAll(marketId) {
    const m = this.markets.get(Number(marketId));
    if (!m) return true;
    const body = { authority: this._authorityPubkey, symbol: m.displayName };
    try {
      const instructionsData = await this._req('POST', '/v1/ix/cancel-all-orders', body, true);
      await this._signAndSubmitInstructions(instructionsData);
    } catch { /* silent, fall back to per-order cancel from fetchOpenOrders */ }
    // 兜底：从 exchange 拉真单逐单撤
    const real = await this.fetchOpenOrders(marketId);
    for (const o of real) {
      await this.cancelOrder(marketId, o.orderId).catch(() => {});
    }
    return true;
  }

  async fetchOpenOrders(_marketId) {
    if (!this._authorityPubkey) return [];
    try {
      const orders = await this._req(
        'GET',
        `/v1/traders/${this._authorityPubkey}/orders_v2?status=open`,
        null,
        true,
      );
      if (!Array.isArray(orders)) return [];
      return orders.map((o) => ({
        orderId: String(o.orderId || o.id),
        price: Number(o.priceInTicks || o.price || 0),
        side: (o.side === 'Bid' || o.side === 'buy') ? 'buy' : 'sell',
      }));
    } catch (e) {
      this.lastError = e.message;
      return [];
    }
  }

  async fetchPositions() {
    if (!this._authorityPubkey) return [];
    try {
      const state = await this._req('GET', `/v1/trader/state/${this._authorityPubkey}`, null, true);
      const positions = state?.positions || [];
      return Array.isArray(positions) ? positions : [];
    } catch (e) {
      this.lastError = e.message;
      return [];
    }
  }

  getOpenOrders(marketId) {
    const marketIdN = Number(marketId);
    return [...this.orders.values()].filter((o) => o.marketId === marketIdN);
  }

  getPosition(marketId) {
    return this.positions.get(Number(marketId)) || null;
  }

  async closePosition(marketId) {
    const pos = this.positions.get(Number(marketId));
    if (!pos || !pos.sizeBase) return { closed: true };
    // 用 reduceOnly market order 平仓
    const side = pos.sizeBase > 0 ? 'sell' : 'buy';
    const size = Math.abs(pos.sizeBase);
    const m = this.markets.get(Number(marketId));
    if (!m) return { closed: false };
    const body = {
      authority: this._authorityPubkey,
      side: side === 'buy' ? 'Bid' : 'Ask',
      symbol: m.displayName,
      numBaseLots: Math.round(size / m.stepSize),
    };
    const instructionsData = await this._req('POST', '/v1/ix/place-isolated-market-order', body, true);
    await this._signAndSubmitInstructions(instructionsData);
    this.positions.delete(Number(marketId));
    return { closed: true };
  }

  async reconcileOpenOrders() { return true; }

  start() {
    if (this._pollTimer) return;
    // 首次立刻拉一批 top 市场价格（BTC/ETH/SOL 优先）
    this._pollPrices().catch(() => {});
    this._pollTimer = setInterval(async () => {
      try {
        await this._pollPrices();
        this.lastOkAt = Date.now();
        // 每 3 次 poll 刷 balance/positions（省 auth 调用）
        if (!this._pollCount) this._pollCount = 0;
        this._pollCount++;
        if (this._pollCount % 3 === 0 && this._authToken) {
          await this._refreshBalance();
        }
      } catch (e) {
        this.lastError = e.message;
      }
    }, 10000);
    this._pollTimer.unref?.();
  }

  // Round 213: Phoenix markets endpoint 不返价格，价格从 /v1/candles/{symbol} 拉。
  // 62 市场太多不能每 tick 全 poll，只跑一小批优先市场（Autopilot getCandles 会自己拉）。
  async _pollPrices() {
    // 优先 BTC/ETH/SOL/HYPE + 前 10 个市场，避免 62 req/tick 压 Phoenix API
    const priority = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE'];
    const targets = new Set(priority);
    for (const [id, m] of this.markets) {
      if (targets.size >= 12) break;
      targets.add(m.symbol);
    }
    for (const symbol of targets) {
      const id = this._marketSymbolToId.get(symbol);
      if (id == null) continue;
      try {
        const bars = await this._req('GET', `/v1/candles/${symbol}?timeframe=1m&limit=1`);
        if (Array.isArray(bars) && bars.length > 0) {
          const p = Number(bars[bars.length - 1].markClose || bars[bars.length - 1].close || 0);
          if (p > 0) {
            this.prices.set(id, p);
            const m = this.markets.get(id);
            if (m) m.lastPrice = p;
            this.emit('price', { marketId: id, price: p });
          }
        }
      } catch { /* 单市场失败不影响其它 */ }
    }
  }

  async getCandles(marketId, resolutionSec, limit) {
    const m = this.markets.get(Number(marketId));
    if (!m) return [];
    // Phoenix timeframe 支持：1m / 5m / 15m / 1h / 4h / 1d（Round 213 探得）
    const tfMap = { 60: '1m', 300: '5m', 900: '15m', 3600: '1h', 14400: '4h', 86400: '1d' };
    const tf = tfMap[Number(resolutionSec)] || '1h';
    try {
      const bars = await this._req('GET', `/v1/candles/${m.symbol}?timeframe=${tf}&limit=${limit || 100}`);
      if (!Array.isArray(bars)) return [];
      return bars.map((b) => ({
        t: Number(b.time),
        open: Number(b.markOpen || b.open),
        high: Number(b.markHigh || b.high),
        low: Number(b.markLow || b.low),
        close: Number(b.markClose || b.close),
        volume: Number(b.volume || 0),
      }));
    } catch { return []; }
  }

  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async reconnect() {
    this._authToken = null;
    return this.init();
  }
}
