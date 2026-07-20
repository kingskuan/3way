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
    // 立刻拉一次余额，避免 restore 后 /api/sx/state 返 balance=0（poll 5s 才追上）
    await this._refreshBalance().catch(() => {});
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

  /**
   * 走 JWT 认证的 GET。
   * Round 58：401 (missing/invalid jwt) 时自动重登录一次（token 7d 有效期
   * 过期 → 撤单失败链条根源之一）。重登录失败才抛。
   */
  async _authGet(path, timeoutMs = 8000, _retried = false) {
    if (!this._token) {
      if (_retried) throw new Error('StandX 未认证');
      await this._authenticate().catch(() => {});
      if (!this._token) throw new Error('StandX 未认证');
    }
    const res = await fetch(`${REST_BASE}${path}`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + this._token, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 && !_retried) {
      // JWT 过期 → 重新登录再试一次
      this._token = null;
      try { await this._authenticate(); } catch { throw new Error(`StandX GET ${path} → 401 且重登录失败`); }
      return this._authGet(path, timeoutMs, true);
    }
    if (!res.ok) throw new Error(`StandX GET ${path} → HTTP ${res.status}`);
    return await res.json();
  }

  /**
   * POST + Body Signing（写接口用）。参见 Body Signature Flow 章节。
   * Round 58：401 自动重登录一次。
   */
  async _authPostSigned(path, body, timeoutMs = 8000, _retried = false) {
    if (!this._token) {
      if (_retried) throw new Error('StandX 未认证');
      await this._authenticate().catch(() => {});
      if (!this._token) throw new Error('StandX 未认证');
    }
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
    if (res.status === 401 && !_retried) {
      this._token = null;
      try { await this._authenticate(); } catch { throw new Error(`StandX POST ${path} → 401 且重登录失败`); }
      return this._authPostSigned(path, body, timeoutMs, true);
    }
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
      const qtyDecimals = Number(info?.qty_tick_decimals ?? 4);
      const priceDecimals = Number(info?.price_tick_decimals ?? 2);
      this.markets.set(marketId, {
        marketId, displayName: s.symbol, symbol: s.base,
        lastPrice: price,
        minOrderSize: Number(info?.min_order_qty) || 0.0001,
        stepSize: Math.pow(10, -qtyDecimals),
        stepPrice: Math.pow(10, -priceDecimals),
        maxLeverage: Number(info?.max_leverage) || 10,
        // Round 48：Autopilot 可能给 0.00019999999999999998（float 残留），
        // 存起来 placeLimitOrder 里用 toFixed 强制 snap
        qtyDecimals, priceDecimals,
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
    // StandX 支持: 1T/3S/1/5/15/60/1D/1W/1M（分钟数字形式；4h/30m 都不支持）
    // 4h（14400s）没原生粒度 —— 回退用 1h（60）多取，但请求足够长时间窗口
    const resMap = { 60: '1', 300: '5', 900: '15', 3600: '60', 14400: '60', 86400: '1D' };
    const resolution = resMap[sec] || '60';
    const to = Math.floor(Date.now() / 1000);
    // 请求窗口按 sec × n 算（4h/1h 都能拿到 200 根足够）
    const from = to - Math.max(sec * n, 3600 * 200);
    // Round 57：Round 49 的 URL 少了 countback 参数 → StandX 默认只返 5 根
    // K 线 → analyzeTrend 需要 >=51 根走 fallback 分支。加 countback=n 就
    // 拿到 200 根。curl 验证：不加 countback 返 5，加了 countback=200 返 201。
    const countback = Math.max(60, Number(n) || 200);
    try {
      // kline/history 是公开端点，不需要 auth 但发 Bearer 也没关系
      const j = await this._authGet(`/api/kline/history?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&resolution=${resolution}&countback=${countback}`);
      if (j?.s !== 'ok') {
        if (!this._klineErrLogged) {
          this._klineErrLogged = true;
          try { console.log(`[StandX] getCandles ${symbol} sec=${sec} res=${resolution} → s=${j?.s}, keys=${Object.keys(j || {}).join(',')}`); } catch {}
        }
        return [];
      }
      const { t = [], o = [], h = [], l = [], c = [], v = [] } = j;
      return t.map((tt, i) => ({ time: tt, open: o[i], high: h[i], low: l[i], close: c[i], volume: v[i] || 0 }));
    } catch (e) {
      if (!this._klineErrLogged) {
        this._klineErrLogged = true;
        try { console.log(`[StandX] getCandles ${symbol} sec=${sec} 抛错: ${e?.message || e}`); } catch {}
      }
      return [];
    }
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
      // Round 51：不同版本 API 响应结构可能不同（{result:[]} / {orders:[]} /
      // {data:[]} / 直接 []）——用户报告链上 48 单但 QnV 只见 24 单，很可能
      // 就是 fetchOpenOrders 拉不全。兼容多形 + 首次日志诊断结构。
      const raw = Array.isArray(j) ? j
        : (Array.isArray(j?.result) ? j.result
        : (Array.isArray(j?.orders) ? j.orders
        : (Array.isArray(j?.data) ? j.data
        : [])));
      if (!this._openOrdersLogged) {
        this._openOrdersLogged = true;
        try {
          const shape = Array.isArray(j) ? 'array' : `obj{${Object.keys(j || {}).join(',')}}`;
          const sample = raw[0] ? JSON.stringify(raw[0]).slice(0, 240) : '(empty)';
          console.log(`[StandX] fetchOpenOrders ${symbol} 首次响应: shape=${shape}, len=${raw.length}, sample=${sample}`);
        } catch {}
      }
      return raw.map((o) => ({
        orderId: String(o.id ?? o.order_id ?? o.cl_ord_id ?? o.client_id ?? o.orderId ?? ''),
        price: Number(o.price),
        side: o.side === 'sell' ? 'sell' : 'buy',
        raw: o,   // Round 51：保留原始字段供 cancelOrder 找对参数名
      }));
    } catch (e) {
      if (!this._openOrdersErrLogged) {
        this._openOrdersErrLogged = true;
        try { console.log(`[StandX] fetchOpenOrders ${symbol} 抛错: ${e?.message || e}`); } catch {}
      }
      return [];
    }
  }

  /** 改杠杆：POST /api/change_leverage body-signed。 */
  async setLeverage(marketId, leverage) {
    const symbol = this._sym(marketId);
    if (!symbol) return false;
    const lev = Math.max(1, Math.round(Number(leverage) || 1));
    try {
      const r = await this._authPostSigned('/api/change_leverage', { symbol, leverage: lev }, 4000);
      // code=0 OK；某些情况服务端会 code=0 但 msg 提示"leverage unchanged"，都算成功
      return r?.code === 0;
    } catch (e) {
      // 部分接口"当前和目标一致"会返 400，视为已生效
      if (/already|same|unchanged/i.test(e.message)) return true;
      console.log('[StandX] setLeverage 失败：' + (e?.message || e));
      return false;
    }
  }

  // ── 写接口（Phase 2 联调） ──────────────────────────────────────
  /** 下限价单。POST /api/new_order body-signed。 */
  async placeLimitOrder(o) {
    const marketIdN = Number(o.marketId);
    const symbol = this._sym(marketIdN);
    if (!symbol) throw new Error(`StandX 找不到 marketId=${o.marketId} 对应 symbol`);
    // Round 48：StandX 要求 qty/price 严格 snap 到 tick 小数位数——
    // Autopilot 传 0.00019999999999999998（float 残留）会被拒
    // "invalid order qty: not follow qty tick"。用 market.qtyDecimals/
    // priceDecimals 强制 toFixed 后再 String。
    const market = this.markets.get(marketIdN);
    const qtyDp = market?.qtyDecimals ?? 4;
    const priceDp = market?.priceDecimals ?? 2;
    const cl_ord_id = 'qnv-' + uuidv4().replace(/-/g, '').slice(0, 20);
    const payload = {
      symbol,
      side: o.side === 'sell' ? 'sell' : 'buy',
      order_type: 'limit',
      qty: Number(o.sizeBase).toFixed(qtyDp),
      price: Number(o.price).toFixed(priceDp),
      time_in_force: 'gtc',                       // Good til canceled
      reduce_only: !!o.reduceOnly,
      cl_ord_id,
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

  /**
   * 撤一单：POST /api/cancel_order。
   * Round 51：以前不管 API 返啥都本地 delete → 假死。链上 48 单 QnV 只见
   * 24 单就是这里"每个都当撤成功"造成的。现在严格看 code：
   *   - code=0 或 msg 匹配 not found/already/filled → 真的撤了 → 本地 delete
   *   - 其他情况 throw → 让 cancelAll 循环重试到真的清干净
   */
  async cancelOrder(marketId, orderId) {
    const clOrdId = String(orderId);
    const symbol = this._sym(marketId);
    let cancelled = false;
    let lastErr = null;
    // Round 58：placeLimitOrder / setLeverage / new_order 所有 write 端点
    // body 都带 symbol——cancelOrder 也应该带。之前 attempts 缺 symbol 全部
    // 401/400 → 所有尝试失败 → 用户按撤单一直失败。加上 symbol 后正常。
    // 同时 fetchOpenOrders 返的 orderId 可能是 numeric id 或 cl_ord_id，试全
    // 顺序：symbol+cl_ord_id > symbol+client_id > symbol+order_id > symbol+id
    const attempts = [];
    if (symbol) {
      attempts.push({ symbol, cl_ord_id: clOrdId });
      attempts.push({ symbol, client_id: clOrdId });
      if (/^\d+$/.test(clOrdId)) {
        attempts.push({ symbol, order_id: Number(clOrdId) });
        attempts.push({ symbol, id: Number(clOrdId) });
      }
    }
    // Fallback: 无 symbol 也试一遍（若上面全 fail）
    attempts.push({ cl_ord_id: clOrdId });
    if (/^\d+$/.test(clOrdId)) attempts.push({ order_id: Number(clOrdId) });
    else attempts.push({ client_id: clOrdId });

    // Round 58：首次 cancel_order 调用的原始错误 log 一次，帮定位真实 API 拒绝原因
    let firstErrLogged = !!this._cancelErrLogged;
    for (const body of attempts) {
      try {
        const r = await this._authPostSigned('/api/cancel_order', body, 4000);
        if (!firstErrLogged) {
          firstErrLogged = true;
          this._cancelErrLogged = true;
          try { console.log(`[StandX] cancel_order 首次尝试 body=${JSON.stringify(body)} → code=${r?.code} msg=${r?.message || r?.msg || ''}`); } catch {}
        }
        if (r?.code === 0) { cancelled = true; break; }
        const msg = String(r?.message || r?.msg || '');
        // Round 55: 只 match"确定已消失"关键词（不含单独的 |cancel 避免宽泛匹配）
        if (/not\s?found|already\s*(cancel|fill|close|done)|filled|closed/i.test(msg)) {
          cancelled = true; break;
        }
        lastErr = `code=${r?.code} ${msg}`.trim();
      } catch (e) {
        if (!firstErrLogged) {
          firstErrLogged = true;
          this._cancelErrLogged = true;
          try { console.log(`[StandX] cancel_order 首次尝试 body=${JSON.stringify(body)} 抛错: ${e?.message || e}`); } catch {}
        }
        if (/not\s?found|already\s*(cancel|fill|close)|filled|closed/i.test(e.message)) { cancelled = true; break; }
        lastErr = e?.message || String(e);
      }
    }
    if (cancelled) {
      this.orders.delete(String(orderId));
      return true;
    }
    throw new Error(`StandX cancelOrder ${orderId} 全部字段名尝试失败: ${lastErr || '未知'}`);
  }

  /**
   * 尝试批量撤单端点。StandX 可能有以下几种命名：
   *   /api/cancel_all_orders     (Bybit-style)
   *   /api/cancel_all             (Backpack-style)
   *   /api/cancel_orders          (无 order_id 参数 = 批量)
   * 依次尝试，第一个返 code=0 就用。都 404/400 就走 fallback loop。
   * Round 52：新增。
   */
  async _tryBatchCancel(symbol) {
    const attempts = [
      { path: '/api/cancel_all_orders', body: { symbol } },
      { path: '/api/cancel_all', body: { symbol } },
      { path: '/api/cancel_orders', body: { symbol } },
      { path: '/api/mass_cancel', body: { symbol } },
    ];
    for (const { path, body } of attempts) {
      try {
        const r = await this._authPostSigned(path, body, 6000);
        if (r?.code === 0) {
          if (!this._batchCancelLogged) {
            this._batchCancelLogged = true;
            console.log(`[StandX] batch cancel 命中端点：${path}`);
          }
          return { ok: true, path };
        }
      } catch (e) {
        // 404 = 端点不存在；跳过。其他错误也跳过（下一个端点也许行）
      }
    }
    return { ok: false };
  }

  /**
   * 撤该市场所有单。Round 52 策略：
   *   1. 先试 batch cancel（一次搞定几十单，避免签名节流）
   *   2. Fallback: 循环 6 轮 fetchOpenOrders → 撤 → sleep 700ms
   *   3. 兼容 fetchOpenOrders 拉不到的场景：拿本地 map 逐个 cancel
   *   4. 最后 finalCheck，还有残留 throw（让上层 UI 看到）
   */
  async cancelAll(marketId) {
    const marketIdN = Number(marketId);
    const symbol = this._sym(marketIdN);
    if (!symbol) return true;

    // Step 1: batch cancel
    const batch = await this._tryBatchCancel(symbol).catch(() => ({ ok: false }));
    if (batch.ok) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Step 2: fallback loop
    let lastLen = -1;
    for (let round = 0; round < 6; round++) {
      const exchangeOrders = await this.fetchOpenOrders(marketIdN).catch(() => []);
      // Round 52：即使 fetchOpenOrders 返 []，也把本地 map 里未撤的单尝试撤
      // 防止 API 分页/字段名不对拉不全时"看着干净其实链上还有"
      const localOnly = [...this.orders.values()]
        .filter((o) => Number(o.marketId) === marketIdN)
        .filter((o) => !exchangeOrders.find((e) => String(e.orderId) === String(o.orderId)))
        .map((o) => ({ orderId: o.orderId, price: o.price, side: o.side }));
      const combined = [...exchangeOrders, ...localOnly];
      if (combined.length === 0) break;

      if (round === 0 || combined.length !== lastLen) {
        console.log(`[StandX] cancelAll ${symbol} round ${round + 1}: 链上 ${exchangeOrders.length} + 本地 ${localOnly.length} = ${combined.length} 单待撤`);
      }
      lastLen = combined.length;

      const results = await Promise.allSettled(
        combined.slice(0, 24).map((o) => {
          const oid = String(o.orderId ?? '');
          if (!oid || oid === '0' || oid === 'undefined' || oid === 'null') return Promise.resolve();
          return this.cancelOrder(marketIdN, oid);
        })
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0 && round === 0) {
        // 只 log 第 1 个 error message（其他大概率一样），别刷屏
        const errMsg = failed[0].reason?.message || String(failed[0].reason);
        console.log(`[StandX] cancelAll ${symbol}: ${failed.length}/${results.length} 撤单失败，首条错误：${errMsg}`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }

    // 本地 map 兜底
    for (const [id, o] of [...this.orders]) {
      if (Number(o.marketId) === marketIdN) this.orders.delete(id);
    }

    // 最后 finalCheck
    const finalCheck = await this.fetchOpenOrders(marketIdN).catch(() => []);
    if (finalCheck.length > 0) {
      throw new Error(`StandX cancelAll ${symbol}：6 轮 + batch 后链上仍剩 ${finalCheck.length} 单未撤（请到 standx.com Cancel All，或用 UI 上"诊断 StandX 挂单"看 API 字段名）`);
    }
    return true;
  }

  /**
   * 市价平仓：先 fetchPositions 拉真持仓，再反向 IOC 市价单收掉。
   * Round 51：qty 必须 toFixed 到 qtyDecimals（Round 48 教训——float 残留
   * 会被 "not follow qty tick" 拒），返回前 check code=0（之前不看，下失败
   * 也返成功假象）。
   */
  async closePosition(marketId) {
    const marketIdN = Number(marketId);
    const symbol = this._sym(marketIdN);
    if (!symbol) return null;
    const positions = await this.fetchPositions().catch(() => []);
    const p = positions.find((x) => Number(x.marketId) === marketIdN);
    // Round 55：empty:true 让 server 区分"本来就空"vs"真平仓"，避免"11 个市场
    // 已平仓"的假象（只有 BTC-USD 有仓，其他 10 个市场从没开过）
    if (!p || !p.sizeBase) return { closed: true, size: 0, empty: true };
    const market = this.markets.get(marketIdN);
    const qtyDp = market?.qtyDecimals ?? 4;
    const side = p.sizeBase > 0 ? 'sell' : 'buy';    // 反手关
    const cl_ord_id = 'qnv-cls-' + uuidv4().replace(/-/g, '').slice(0, 18);
    const r = await this._authPostSigned('/api/new_order', {
      symbol, side, order_type: 'market',
      qty: Math.abs(p.sizeBase).toFixed(qtyDp),
      time_in_force: 'ioc', reduce_only: true,
      cl_ord_id,
    }, 8000);
    if (r?.code !== 0) {
      throw new Error(`StandX 平仓下单失败 code=${r?.code} ${r?.message || r?.msg || ''}`);
    }
    return { closed: true, size: p.sizeBase, cl_ord_id, result: r };
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

  /**
   * Round 52：暴露 raw API 响应给 /api/sx/debug 端点，让用户在 UI 上直接
   * 看链上真实数据（不用 tail Railway 日志）。用于诊断 fetchOpenOrders /
   * cancel_order 字段名不对导致的假死。
   */
  /**
   * Round 76：从 StandX web bundle JS 里扒到真实的用户交易端点是
   * /api/query_trades (auth)——这是用户自己的 fill 历史。sum qty*price 就是 volume。
   * 我 curl standx.com 的 next.js chunks 抓的完整 endpoint list 里没有专门
   * 的 volume/portfolio_summary 端点，只能靠 trade history 累加。
   */
  async getStats() {
    try {
      const j = await this._authGet('/api/query_trades?limit=500', 6000);
      // 响应结构猜测：{code:0, data|result: [{symbol, qty, price, side, ts, ...}]}
      const raw = Array.isArray(j) ? j
        : (Array.isArray(j?.data) ? j.data
        : (Array.isArray(j?.result) ? j.result
        : (Array.isArray(j?.trades) ? j.trades : null)));
      if (!raw) {
        if (!this._statsShapeLogged) {
          this._statsShapeLogged = true;
          try { console.log(`[StandX] query_trades 响应结构未识别: keys=${Object.keys(j || {}).join(',')}, first item=${JSON.stringify((j && (j.data || j.result || j.trades || [])[0]) || j).slice(0, 200)}`); } catch {}
        }
        return null;
      }
      let volume = 0;
      for (const t of raw) {
        const qty = Number(t.qty ?? t.size ?? t.amount ?? t.filled_qty ?? 0);
        const price = Number(t.price ?? t.avg_price ?? t.fill_price ?? 0);
        if (qty > 0 && price > 0) volume += qty * price;
      }
      if (!this._statsSampleLogged && raw.length > 0) {
        this._statsSampleLogged = true;
        try { console.log(`[StandX] query_trades ${raw.length} 单，累计 volume=${volume.toFixed(2)}, first sample: ${JSON.stringify(raw[0]).slice(0, 200)}`); } catch {}
      }
      return { volume: Math.round(volume * 100) / 100 };
    } catch (e) {
      if (!this._statsErrLogged) {
        this._statsErrLogged = true;
        try { console.log(`[StandX] getStats 抛错: ${e?.message || e}`); } catch {}
      }
      return null;
    }
  }

  async getDebugSnapshot() {
    const symbol = this._sym(1) || 'BTC-USD';
    const snap = {
      symbol,
      chain: this.chain,
      dataSource: this.dataSource,
      hasToken: !!this._token,
      localOrders: [...this.orders.values()].map((o) => ({
        orderId: o.orderId, marketId: o.marketId, price: o.price, side: o.side,
      })),
      localOrdersCount: this.orders.size,
    };
    // openOrders raw
    try {
      const j = await this._authGet(`/api/query_open_orders?symbol=${encodeURIComponent(symbol)}`);
      snap.openOrdersRaw = j;
      snap.openOrdersRawType = Array.isArray(j) ? 'array' : typeof j;
      snap.openOrdersRawKeys = j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j) : null;
      snap.openOrdersRawLen = Array.isArray(j) ? j.length
        : (Array.isArray(j?.result) ? j.result.length
        : (Array.isArray(j?.orders) ? j.orders.length
        : (Array.isArray(j?.data) ? j.data.length : null)));
    } catch (e) { snap.openOrdersRaw = { error: e.message }; }
    // positions raw
    try {
      const j = await this._authGet('/api/query_positions');
      snap.positionsRaw = j;
    } catch (e) { snap.positionsRaw = { error: e.message }; }
    // balance raw
    try {
      const j = await this._authGet('/api/query_balance');
      snap.balanceRaw = j;
    } catch (e) { snap.balanceRaw = { error: e.message }; }
    return snap;
  }
}
