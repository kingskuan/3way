// StandX Perps LIVE 适配器 · Phase 1 骨架
//
// docs: https://docs.standx.com/standx-api/standx-api
//
// 认证流程（3 步）：
//   1. POST https://api.standx.com/v1/offchain/prepare-signin?chain=bsc
//      → { signedData: <JWT> }, 解出 payload.message
//   2. 用 BSC 钱包私钥 personal_sign(message) → 65 字节签名
//   3. POST /v1/offchain/login?chain=bsc { signature, signedData }
//      → { token: <JWT 7 天有效> }
//   4. 所有后续 GET/POST 加 header: Authorization: Bearer <token>
//   5. 修改类接口（new_order/cancel_order/change_leverage/...）另外还要
//      x-request-signature 用 Ed25519 签 "{version},{id},{timestamp},{payload}"
//
// Phase 1 只做：auth flow、getMarkets、getPrice、getCandles、getBalance、
// getPositions 这些"读"接口；placeLimitOrder / cancelOrder 等"写"接口
// 先 throw，等 Phase 2 联调过再放开（避免 Perpl 那种下单错字段名 10
// 轮 debug 的血泪）。
//
// 环境变量：
//   SX_PRIVATE_KEY   — BSC 钱包私钥（0x... 64 位 hex），必需
//   SX_CHAIN         — 默认 'bsc'（也支持 'solana'，但当前只实现 BSC）

import { EventEmitter } from 'events';
import { randomFillSync, generateKeyPairSync, createSign, sign as cryptoSign } from 'crypto';

const AUTH_BASE = 'https://api.standx.com';
const REST_BASE = 'https://perps.standx.com';
const WS_MARKET = 'wss://perps.standx.com/ws-stream/v1';

// Base58（bitcoin alphabet）—— requestId 需要
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  if (!bytes.length) return '';
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) {
    const r = Number(num % 58n);
    out = B58_ALPHABET[r] + out;
    num /= 58n;
  }
  return '1'.repeat(leadingZeros) + out;
}

// 简单 UUID v4
function uuidv4() {
  const b = Buffer.alloc(16); randomFillSync(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// EIP-191 personal_sign（BSC/EVM 用）
// 消息 = keccak256("\x19Ethereum Signed Message:\n" + len + msg)
// 再用 secp256k1 私钥 ECDSA 签名（65 字节 r+s+v）
// Node 20 crypto 有 secp256k1 但要手拼 EIP-191 前缀 + keccak。
// keccak256 用 keccak.js 太重；直接手写 keccak1600 又 200 行。
// 现实做法：加 `ethers` 依赖，一行 wallet.signMessage(msg) 搞定。
// 但为了不增加 package.json，Phase 1 先把 personalSign 留 throw，让
// LIVE 走 fallback 到 paper（有 SX_PRIVATE_KEY 但没 ethers → 报错）。
async function bscPersonalSign(privateKeyHex, message) {
  let ethers;
  try { ethers = (await import('ethers')).ethers || (await import('ethers')); }
  catch { throw new Error('BSC 签名需要 ethers 包。npm install ethers@6 后重启。'); }
  const wallet = new ethers.Wallet(privateKeyHex);
  return await wallet.signMessage(message);
}

export class StandXExchange extends EventEmitter {
  constructor({ chain = 'bsc', privateKey } = {}) {
    super();
    this.mode = 'live';
    this.dataSource = 'connecting';
    this.chain = chain;
    this._privateKey = privateKey;
    this._token = null;
    this._sessionId = uuidv4();
    this.balance = 0;
    this.realizedPnl = 0;
    this.lastOkAt = Date.now();
    this.lastError = null;
    // 每次进程启动生成 ephemeral Ed25519 keypair（body signing 用）
    const kp = generateKeyPairSync('ed25519');
    this._edPrivate = kp.privateKey;
    // 提取 32 字节公钥（DER-SPKI 尾 32 字节 = raw pubkey）
    const pubDer = kp.publicKey.export({ format: 'der', type: 'spki' });
    this._edPubRaw = pubDer.slice(-32);
    this._requestId = base58Encode(this._edPubRaw);
    // 数据缓存
    this.markets = new Map();
    this.prices = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this._priceScales = new Map();
    this._sizeScales = new Map();
    this._pollTimer = null;
    // Phase 1：REST 不可靠时不做 massVanish 逻辑（沿用 Perpl 教训）
    this.hasReliableOrderListing = false;   // 等 Phase 2 联调完 order-history 再改 true
  }

  async init() {
    if (!this._privateKey) throw new Error('StandX LIVE 需要 SX_PRIVATE_KEY env（BSC 钱包私钥）');
    await this._authenticate();
    await this._loadMarkets();
    this.dataSource = 'real';
    this.lastOkAt = Date.now();
    this.start();
  }

  /** 3 步 JWT 换取流程。 */
  async _authenticate() {
    // Step 1: 请求签名数据
    const prepRes = await fetch(`${AUTH_BASE}/v1/offchain/prepare-signin?chain=${this.chain}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: await this._deriveAddress(), requestId: this._requestId }),
    });
    const prepJson = await prepRes.json();
    if (!prepJson?.signedData) throw new Error(`StandX prepare-signin 失败：${JSON.stringify(prepJson).slice(0,200)}`);
    // Step 2: 从 JWT payload 里抽 message
    const jwt = prepJson.signedData;
    const parts = jwt.split('.');
    if (parts.length < 2) throw new Error('StandX signedData 不是合法 JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.message) throw new Error('StandX signedData payload 缺 message 字段');
    // Step 3: 用 BSC 钱包私钥 personal_sign
    const signature = await bscPersonalSign(this._privateKey, payload.message);
    // Step 4: 换 access token
    const loginRes = await fetch(`${AUTH_BASE}/v1/offchain/login?chain=${this.chain}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature, signedData: jwt, expiresSeconds: 604800 }),
    });
    const loginJson = await loginRes.json();
    if (!loginJson?.token) throw new Error(`StandX login 失败：${JSON.stringify(loginJson).slice(0,200)}`);
    this._token = loginJson.token;
    console.log(`[StandX] 认证成功（chain=${this.chain}, address=${loginJson.address}）`);
  }

  async _deriveAddress() {
    let ethers;
    try { ethers = (await import('ethers')).ethers || (await import('ethers')); }
    catch { throw new Error('推导 BSC 地址需要 ethers 包'); }
    const wallet = new ethers.Wallet(this._privateKey);
    return wallet.address;
  }

  /** 走 JWT 认证的 GET/POST。 */
  async _authGet(path, timeoutMs = 8000) {
    if (!this._token) throw new Error('StandX 未认证');
    const res = await fetch(`${REST_BASE}${path}`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + this._token, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`StandX GET ${path} → HTTP ${res.status}`);
    return await res.json();
  }

  /** POST + Body Signing（写接口用）。参见 Body Signature Flow 章节。 */
  async _authPostSigned(path, body, timeoutMs = 8000) {
    if (!this._token) throw new Error('StandX 未认证');
    const xRequestId = uuidv4();
    const xRequestTs = String(Date.now());
    const payloadStr = JSON.stringify(body);
    const signMsg = `v1,${xRequestId},${xRequestTs},${payloadStr}`;
    const sig = cryptoSign(null, Buffer.from(signMsg, 'utf-8'), this._edPrivate);
    const sigB64 = sig.toString('base64');
    const res = await fetch(`${REST_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + this._token,
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'x-request-sign-version': 'v1', 'x-request-id': xRequestId,
        'x-request-timestamp': xRequestTs, 'x-request-signature': sigB64,
        'x-session-id': this._sessionId,
      },
      body: payloadStr, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(`StandX POST ${path} → HTTP ${res.status}: ${text.slice(0,200)}`);
    return j;
  }

  async _loadMarkets() {
    // Round 45：StandX 原生用 symbol 字符串（BTC-USD/ETH-USD/XAU-USD/XAG-USD）
    // 但 bot.js 用 Number(marketId) 比对，Number("BTC-USD") = NaN 匹配不上。
    // 内部映射 symbol → 数字 id（1-N），公共接口一律用数字 id，走 API 时
    // 从 _idToSymbol 反查回来。跟其他所（Perpl/Ondo）marketId 类型一致。
    this._idToSymbol = new Map();
    this._symbolToId = new Map();
    const j = await this._authGet('/api/query_market_overview');
    let nextId = 1;
    for (const s of (j.symbols || [])) {
      const marketId = nextId++;
      this._idToSymbol.set(marketId, s.symbol);
      this._symbolToId.set(s.symbol, marketId);
      const price = Number(s.last_price) || Number(s.mark_price) || 0;
      let info = null;
      try { info = (await this._authGet(`/api/query_symbol_info?symbol=${encodeURIComponent(s.symbol)}`))?.[0]; } catch {}
      this.markets.set(marketId, {
        marketId, displayName: s.symbol, symbol: s.base,
        lastPrice: price,
        minOrderSize: Number(info?.min_order_qty) || 0.0001,
        stepSize: Math.pow(10, -Number(info?.qty_tick_decimals ?? 4)),
        stepPrice: Math.pow(10, -Number(info?.price_tick_decimals ?? 2)),
        maxLeverage: Number(info?.max_leverage) || 10,
      });
      this.prices.set(marketId, price);
      this._priceScales.set(marketId, 1);
      this._sizeScales.set(marketId, 1);
    }
  }

  /** 内部：数字 marketId → StandX symbol 字符串。 */
  _sym(marketId) {
    return this._idToSymbol?.get(Number(marketId)) || null;
  }

  async getMarkets() {
    return [...this.markets.values()];
  }

  async getPrice(marketId) {
    return this.prices.get(Number(marketId)) ?? null;
  }

  async getCandles(marketId, sec, n = 200) {
    const symbol = this._sym(marketId);
    if (!symbol) return [];
    // GET /api/kline/history — resolution 对应关系
    const resMap = { 60: '1', 180: '3S', 300: '5', 900: '15', 3600: '60', 86400: '1D' };
    const resolution = resMap[sec] || String(Math.round(sec / 60));
    const to = Math.floor(Date.now() / 1000);
    const from = to - sec * n;
    try {
      const j = await this._authGet(`/api/kline/history?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&resolution=${resolution}`);
      if (j?.s !== 'ok') return [];
      const { t = [], o = [], h = [], l = [], c = [], v = [] } = j;
      return t.map((tt, i) => ({ time: tt, open: o[i], high: h[i], low: l[i], close: c[i], volume: v[i] || 0 }));
    } catch { return []; }
  }

  async _refreshBalance() {
    try {
      const j = await this._authGet('/api/query_balance');
      const eq = Number(j?.equity ?? j?.balance);
      if (Number.isFinite(eq)) this.balance = eq;
    } catch { /* transient */ }
  }

  async fetchPositions() {
    try {
      const arr = await this._authGet('/api/query_positions');
      return (arr || []).map((p) => ({
        marketId: this._symbolToId?.get(p.symbol) ?? null,
        sizeBase: Number(p.qty), entryPrice: Number(p.entry_price),
      }));
    } catch { return []; }
  }

  getPosition(marketId) {
    return this.positions.get(Number(marketId)) || null;
  }

  getOpenOrders(marketId) {
    const mId = Number(marketId);
    return [...this.orders.values()].filter((o) => Number(o.marketId) === mId);
  }

  async fetchOpenOrders(marketId) {
    const symbol = this._sym(marketId);
    if (!symbol) return [];
    try {
      const j = await this._authGet(`/api/query_open_orders?symbol=${encodeURIComponent(symbol)}`);
      return (j?.result || []).map((o) => ({
        orderId: String(o.id ?? o.cl_ord_id), price: Number(o.price),
        side: o.side === 'sell' ? 'sell' : 'buy',
      }));
    } catch { return []; }
  }

  // ── 写接口（Phase 2 联调） ──────────────────────────────────────
  /** 下限价单。POST /api/new_order body-signed。 */
  async placeLimitOrder(o) {
    const symbol = this._sym(o.marketId);
    if (!symbol) throw new Error(`StandX 找不到 marketId=${o.marketId} 对应 symbol`);
    // cl_ord_id 我们生成，24 位 base58 uuid。之后 cancel 用这个也能。
    const cl_ord_id = 'qnv-' + uuidv4().replace(/-/g, '').slice(0, 20);
    const payload = {
      symbol,
      side: o.side === 'sell' ? 'sell' : 'buy',
      order_type: 'limit',
      qty: String(o.sizeBase),
      price: String(o.price),
      time_in_force: 'gtc',                       // Good til canceled
      reduce_only: !!o.reduceOnly,
      cl_ord_id,
      // margin_mode / leverage: 走账户默认；bot 起单前会调 change_leverage 设成 config.leverage
    };
    const r = await this._authPostSigned('/api/new_order', payload, 8000);
    if (r?.code !== 0) throw new Error(`StandX 下单失败 code=${r?.code} ${r?.message || ''}`);
    // Perpl/Ondo 返回真单号；StandX new_order 是异步的，返回只有 request_id。
    // 用 cl_ord_id 当 orderId 存本地——cancel 也能用 cl_ord_id 撤。
    this.orders.set(cl_ord_id, {
      orderId: cl_ord_id, marketId: Number(o.marketId), side: payload.side,
      price: Number(o.price), sizeBase: Number(o.sizeBase),
      levelIndex: o.levelIndex, clientOrderId: cl_ord_id,
      reduceOnly: payload.reduce_only,
    });
    return { orderId: cl_ord_id };
  }

  /** 撤一单：POST /api/cancel_order { cl_ord_id }。 */
  async cancelOrder(marketId, orderId) {
    const clOrdId = String(orderId);
    try {
      // 优先 cl_ord_id（我们下单时生成的）；REST 应该两种都认，出错就 fallback 尝试 order_id 数字
      const r = await this._authPostSigned('/api/cancel_order', { cl_ord_id: clOrdId }, 4000);
      if (r?.code !== 0 && Number.isFinite(Number(orderId))) {
        // 有可能这是收养的真单号，用 order_id 数字再试一次
        await this._authPostSigned('/api/cancel_order', { order_id: Number(orderId) }, 4000);
      }
    } catch (e) {
      if (!/not\s?found|already/i.test(e.message)) throw e;
    }
    this.orders.delete(String(orderId));
    return true;
  }

  /** 撤该市场所有单：先 fetchOpenOrders 拉真实、逐个 cancel。 */
  async cancelAll(marketId) {
    const marketIdN = Number(marketId);
    const symbol = this._sym(marketIdN);
    if (!symbol) return true;
    // 先从 REST 拉真单
    const exchangeOrders = await this.fetchOpenOrders(marketIdN).catch(() => []);
    for (const o of exchangeOrders) {
      const oid = String(o.orderId ?? '');
      if (oid && oid !== '0') await this.cancelOrder(marketIdN, oid).catch(() => {});
    }
    // 兜底：本地跟踪但 exchange 没返回的（时序错开）
    for (const [id, o] of [...this.orders]) {
      if (Number(o.marketId) === marketIdN) {
        await this.cancelOrder(marketIdN, id).catch(() => {});
      }
    }
    return true;
  }

  /** 市价平仓：先 fetchPositions 拉真持仓，再反向 IOC 市价单收掉。 */
  async closePosition(marketId) {
    const symbol = this._sym(marketId);
    if (!symbol) return null;
    const positions = await this.fetchPositions().catch(() => []);
    const p = positions.find((x) => Number(x.marketId) === Number(marketId));
    if (!p || !p.sizeBase) return null;
    const side = p.sizeBase > 0 ? 'sell' : 'buy';   // 反手关
    const cl_ord_id = 'qnv-cls-' + uuidv4().replace(/-/g, '').slice(0, 18);
    return await this._authPostSigned('/api/new_order', {
      symbol, side, order_type: 'market',
      qty: String(Math.abs(p.sizeBase)),
      time_in_force: 'ioc', reduce_only: true,
      cl_ord_id,
    }, 8000);
  }

  async reconcileOpenOrders() {
    if (!this.orders.size) return true;
    // 收集本地跟踪的市场
    const marketIds = new Set();
    for (const o of this.orders.values()) marketIds.add(Number(o.marketId));
    for (const mid of marketIds) {
      const real = await this.fetchOpenOrders(mid).catch(() => []);
      const stillOpen = new Set(real.map((o) => String(o.orderId)));
      for (const [id, o] of [...this.orders]) {
        if (Number(o.marketId) !== mid) continue;
        if (!stillOpen.has(id)) this.orders.delete(id);
      }
    }
    return true;
  }

  start() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._poll().catch(() => {}), 5000);
    this._pollTimer.unref?.();
  }

  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async _poll() {
    this.lastOkAt = Date.now();
    // 刷价格：poll REST 用 symbol 字符串查
    for (const [id, market] of this.markets) {
      const symbol = market.displayName;   // 比如 "BTC-USD"
      try {
        const j = await this._authGet(`/api/query_symbol_price?symbol=${encodeURIComponent(symbol)}`);
        const p = Number(j?.last_price ?? j?.mark_price);
        if (Number.isFinite(p) && p > 0) {
          this.prices.set(id, p);
          market.lastPrice = p;
          this.emit('price', { marketId: id, price: p });
        }
      } catch { /* transient */ }
    }
    // 刷余额
    await this._refreshBalance();
  }

  async reconnect() {
    this.stop();
    this._token = null;
    await this.init();
    return true;
  }
}
