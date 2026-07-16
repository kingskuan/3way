// PerplExchange (LIVE) —— perpl.xyz 实盘适配器（Monad L1）
//
// 认证方案（Ed25519 签名，6 段 canonical string 用换行拼接）
//   canonical = [CHAIN_ID, METHOD, PATH, TIMESTAMP, NONCE, BODY_HASH].join('\n')
//   sig = Ed25519.sign(privateKey, canonical) → base64url
//   headers: X-API-Key / X-API-Timestamp / X-API-Nonce / X-API-Signature
//   BODY_HASH = SHA256(body).hex，GET 时 body='' → sha256 of empty
//
// 关键特点：
// • 下单/撤单走 **WebSocket 交易通道** wss://.../ws/v1/trading（不是 REST）
// • 市场数据可选 WS 或 REST 轮询，本适配器用 REST 轮询（简单可靠）
// • 认证 REST 端点用于查询历史订单/成交记录
// • marketId 用 perpl 官方数字 id（BTC=1, ETH=20, SOL=31, MON=10 等）
// • 价格是 scaled 整数，需要 / 10^price_decimals
//
// 文档：https://github.com/PerplFoundation/api-docs
import { EventEmitter } from 'node:events';
import { createHash, createPrivateKey, sign as edSign, randomFillSync } from 'node:crypto';
// Node 20 没有全局 WebSocket（21+ 才有）；用 undici 的实现保证 Railway
// node:20-slim 容器里也能工作
import { WebSocket } from 'undici';

const POLL_MS = 3000;

export class PerplExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.apiKey = opts.apiKey;
    this._privateKeyRaw = opts.privateKey;
    this.apiUrl = (opts.apiUrl || 'https://app.perpl.xyz/api').replace(/\/$/, '');
    this.wsUrl = opts.wsUrl || this.apiUrl.replace(/^http/, 'ws').replace(/\/api$/, '');
    this.chainId = Number(opts.chainId) || 143;   // 官方：143 mainnet, 10143 testnet
    this.dataSource = 'connecting';
    this.network = this.apiUrl.includes('testnet') ? 'testnet' : 'mainnet';

    this.markets = new Map();
    this.symbolToId = new Map();
    this._priceScales = new Map();
    this._sizeScales = new Map();
    this.prices = new Map();
    this.orders = new Map();
    this.positions = new Map();
    this.balance = 0;
    this.realizedPnl = 0;
    this.lastOkAt = Date.now();
    this.lastError = null;

    // Ed25519 私钥对象化（懒解析：init 才做）
    this._privateKey = null;
    this._ws = null;
    this._wsReady = false;
    this._wsAuthed = false;
    this._pendingReplies = new Map();  // rq -> {resolve, reject, timer}
    this._reqSeq = Math.floor(Date.now() / 1000) * 1000;  // 单调递增：官方要求 rq 严格递增
    this._pollTimer = null;
    this._reconnectDelay = 1000;
    // Perpl 官方协议要素：
    //   accountId — 从 mt=21 (Account) 消息里提取，下单时 acc 字段必填
    //   headBlock — 从 mt=100 (Heartbeat) 消息里提取，下单时 lb=headBlock+ttl
    //   orderTtlBlocks — /v1/pub/context 里给的默认 order 有效期（块数）
    //   marketAccMap — 有些账号是分市场的，一个账号对应一个 marketId
    this.accountId = null;
    this._headBlock = 0;
    this._orderTtlBlocks = 200;    // 保守默认，init 时从 context 读实际值
    // WS 世代号：每次显式 reconnect()/stop() 或 _connectTradingWs() 都自增。
    // 老 socket 的 close handler 只有在世代号仍匹配时才会拉起下一次重连——
    // 避免 reconnect() 期间「老 close handler + 新 init」两条重连并发。
    this._wsGen = 0;
  }

  // ── 签名工具 ────────────────────────────────────────────────────────────
  _parsePrivateKey(pk) {
    // 官方文档：hex 64 字符（可选 0x 前缀）；兼容 base64/base64url 43-44 字符
    const stripped = pk.replace(/^0x/i, '').trim();
    let raw;
    if (/^[0-9a-fA-F]{64}$/.test(stripped)) {
      raw = Buffer.from(stripped, 'hex');
    } else {
      // base64 or base64url
      let s = stripped.replace(/-/g, '+').replace(/_/g, '/');
      const padLen = (4 - (s.length % 4)) % 4;
      s = s + '='.repeat(padLen);
      raw = Buffer.from(s, 'base64');
    }
    if (raw.length !== 32) {
      throw new Error(`Perpl PRIVATE_KEY 长度 ${raw.length} 字节，Ed25519 私钥应为 32 字节。官方推荐 hex 64 字符（可选 0x 前缀）`);
    }
    // 拼 PKCS#8 DER：Ed25519 前缀 + 32 字节私钥
    const pkcs8 = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      raw,
    ]);
    return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  }

  _nonce() {
    const buf = Buffer.alloc(16);
    randomFillSync(buf);
    return buf.toString('base64url');
  }

  _signHeaders(method, path, body = '') {
    const ts = String(Date.now());
    const nonce = this._nonce();
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const canonical = [this.chainId, method.toUpperCase(), path, ts, nonce, bodyHash].join('\n');
    const sig = edSign(null, Buffer.from(canonical), this._privateKey);
    return {
      'X-API-Key': this.apiKey,
      'X-API-Timestamp': ts,
      'X-API-Nonce': nonce,
      'X-API-Signature': sig.toString('base64url'),
    };
  }

  async _req(method, path, body = null, timeoutMs = 10000) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      ...this._signHeaders(method, path, bodyStr),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    const opts = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (bodyStr) opts.body = bodyStr;
    const res = await fetch(`${this.apiUrl}${path}`, opts);
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const msg = j?.error || j?.message || text.slice(0, 160) || `HTTP ${res.status}`;
      throw new Error(`Perpl ${method} ${path} → ${msg}`);
    }
    return j;
  }

  async _pubGet(path, timeoutMs = 6000) {
    const res = await fetch(`${this.apiUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    try { return await res.json(); } catch { return null; }
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  async init() {
    // 0. 解析 Ed25519 私钥
    try {
      this._privateKey = this._parsePrivateKey(this._privateKeyRaw);
    } catch (e) {
      throw new Error(`Perpl LIVE 私钥解析失败：${e.message}`);
    }

    // 1. 拉市场（公开 context）
    const ctx = await this._pubGet('/v1/pub/context');
    if (!ctx?.markets?.length) throw new Error('Perpl 拉不到 pub/context');
    const list = [];
    this.symbolToId.clear();
    this._priceScales.clear();
    this._sizeScales.clear();
    // 从 context 读全局 order TTL blocks（有的话）
    if (Number.isFinite(Number(ctx.order_ttl_blocks))) this._orderTtlBlocks = Number(ctx.order_ttl_blocks);
    for (const m of ctx.markets) {
      const cfg = m.config || {};
      const priceDecimals = Number(cfg.price_decimals ?? 0);
      const sizeDecimals = Number(cfg.size_decimals ?? 4);
      const priceScale = Math.pow(10, priceDecimals);
      const sizeScale = Math.pow(10, sizeDecimals);
      this._priceScales.set(Number(m.id), priceScale);
      this._sizeScales.set(Number(m.id), sizeScale);
      const symbol = `${m.name}-PERP`;
      list.push({
        marketId: Number(m.id),
        displayName: symbol,
        symbol: m.name,
        lastPrice: 100,  // 会被 candle 首次 poll 修正
        stepSize: Math.pow(10, -sizeDecimals),
        stepPrice: Math.pow(10, -priceDecimals),
        maxLeverage: Number(cfg.max_leverage || 20),
        minOrderSize: Number(cfg.min_order_size || Math.pow(10, -sizeDecimals)),
      });
      this.symbolToId.set(symbol, Number(m.id));
      // 每市场自己的 order_ttl_blocks 覆盖全局
      if (Number.isFinite(Number(cfg.order_ttl_blocks))) {
        this.markets.get(Number(m.id));  // will be set later by _setMarkets
      }
    }
    this._setMarkets(list);

    // 2. Backfill 初始价格
    await this._pollPrices();

    // 3. 验证签名（拉一次账户历史，签名有问题会 401/403）
    try {
      await this._req('GET', '/v1/trading/account-history?limit=1');
    } catch (e) {
      // 诊断日志：打认证时用的所有非敏感参数
      console.log(`[Perpl] 认证诊断信息：`);
      console.log(`  chainId = ${this.chainId}  ← 若报错，试着改成 monad-testnet-1 或 perpl-mainnet 之类`);
      console.log(`  apiUrl = ${this.apiUrl}`);
      console.log(`  apiKey 前 8 字符 = ${(this.apiKey || '').slice(0, 8)}...`);
      console.log(`  privateKey 长度 = ${(this._privateKeyRaw || '').length} 字符`);
      // 打一个测试签名的 header（不含 signature 值），让用户/开发者对照
      try {
        const hdr = this._signHeaders('GET', '/v1/trading/account-history', '');
        console.log(`  测试签名 header：X-API-Timestamp=${hdr['X-API-Timestamp']} X-API-Nonce=${hdr['X-API-Nonce']}`);
      } catch (se) {
        console.log(`  签名过程报错：${se.message}`);
      }
      throw new Error(
        `Perpl LIVE 认证失败：${e.message}\n` +
        `  检查 PERPL_API_KEY / PERPL_PRIVATE_KEY / PERPL_CHAIN_ID（当前 ${this.chainId}）\n` +
        `  或本地时钟是否偏离 UTC 过大\n` +
        `  （容器 log 里已打诊断信息）`
      );
    }

    this.dataSource = 'real';

    console.log(`[Perpl] LIVE 认证成功。chainId=${this.chainId} apiUrl=${this.apiUrl}`);

    // 4. 连 trading WS
    this._connectTradingWs();

    // 5. 启动 REST 轮询（价格 / 持仓 / 余额）
    this._startPolling();

    return true;
  }

  async reconnect() {
    // bump 世代号：让老 socket 的 close handler 里排的自动重连失效
    this._wsGen++;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this._wsReady = false;
    this._wsAuthed = false;
    this._reconnectDelay = 1000;
    return this.init();
  }

  _setMarkets(list) { this.markets.clear(); for (const m of list) this.markets.set(m.marketId, m); }

  // ── WebSocket 交易通道 ─────────────────────────────────────────────────
  _connectTradingWs() {
    const url = this.wsUrl + '/ws/v1/trading';
    const myGen = ++this._wsGen;
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { this.emit('error', new Error(`Perpl WS 连接失败：${e.message}`)); return; }

    ws.addEventListener('open', () => {
      this._wsReady = true;
      this._reconnectDelay = 1000;
      // 官方 ApiKeySignIn (mt=29) 认证：canonical 是 4 段（不是 REST 的 6 段）：
      //   [chain_id, 'trading-ws-signin', timestamp_ms, nonce].join('\n')
      // 字段名 snake_case：mt / chain_id / api_key / timestamp / nonce / signature
      const ts = String(Date.now());
      const nonce = this._nonce();
      const canonical = [this.chainId, 'trading-ws-signin', ts, nonce].join('\n');
      let signature;
      try {
        signature = edSign(null, Buffer.from(canonical), this._privateKey).toString('base64url');
      } catch (e) {
        this.emit('error', new Error(`Perpl WS 签名失败：${e.message}`));
        try { ws.close(); } catch {}
        return;
      }
      try {
        ws.send(JSON.stringify({
          mt: 29,
          chain_id: this.chainId,
          api_key: this.apiKey,
          timestamp: ts,
          nonce,
          signature,
        }));
        console.log(`[Perpl] Trading WS auth 已发送（mt=29, chain_id=${this.chainId}）`);
      } catch (e) {
        this.emit('error', new Error(`Perpl WS 发送 auth 失败：${e.message}`));
      }
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this._handleTradingMessage(msg);
    });

    ws.addEventListener('close', () => {
      // 老 socket 关闭：只有当我们还是当前那一代时才安排重连；否则
      // reconnect()/stop() 已经推进了 _wsGen，我们直接静默退出。
      if (myGen !== this._wsGen) return;
      this._wsReady = false;
      this._wsAuthed = false;
      const delay = Math.min(this._reconnectDelay, 30000);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (myGen !== this._wsGen) return;
        if (this.dataSource === 'real') this._connectTradingWs();
      }, delay);
      this._reconnectTimer.unref?.();
    });

    ws.addEventListener('error', (e) => {
      this.emit('error', new Error(`Perpl trading WS 错误：${e?.message || 'unknown'}`));
    });

    this._ws = ws;
  }

  _handleTradingMessage(msg) {
    // mt=100 Heartbeat：更新 head block（下单要用 lb = head + ttl）
    if (msg.mt === 100) {
      if (Number.isFinite(Number(msg.h))) this._headBlock = Number(msg.h);
      return;
    }
    // mt=19 WalletSnapshot：视为 auth 成功 + 抽取 balance
    if (msg.mt === 19) {
      if (!this._wsAuthed) {
        this._wsAuthed = true;
        console.log('[Perpl] Trading WS 认证成功');
      }
      _extractPerplBalance(this, msg);
      // WalletSnapshot 可能带 Accounts 数组：抽第一个 account id
      const accs = Array.isArray(msg.as) ? msg.as : [];
      if (accs.length && accs[0]?.id != null && this.accountId == null) {
        this.accountId = Number(accs[0].id);
        console.log(`[Perpl] accountId=${this.accountId}`);
      }
      return;
    }
    // mt=21 Account：包含 accountId + balance 更新
    if (msg.mt === 21) {
      if (msg.id != null && this.accountId == null) {
        this.accountId = Number(msg.id);
        console.log(`[Perpl] accountId=${this.accountId}`);
      }
      _extractPerplBalance(this, msg);
      return;
    }
    // mt=20 WalletUpdate 也可能带 accountId 更新
    if (msg.mt === 20) {
      _extractPerplBalance(this, msg);
      return;
    }
    // mt=23 OrdersSnapshot / mt=24 OrdersUpdate: 订单响应
    // 官方：rq 回响我们发送时用的 request ID
    if (msg.mt === 23 || msg.mt === 24) {
      // OrdersUpdate/Snapshot 里可能有多条 order 更新，也可能是我们请求的响应
      const orders = Array.isArray(msg.os) ? msg.os : (msg.o ? [msg.o] : []);
      for (const o of orders) {
        const rq = o.rq != null ? Number(o.rq) : (msg.rq != null ? Number(msg.rq) : null);
        if (rq != null && this._pendingReplies.has(rq)) {
          const pending = this._pendingReplies.get(rq);
          this._pendingReplies.delete(rq);
          clearTimeout(pending.timer);
          if (o.err || o.error || o.rj) {
            pending.reject(new Error(o.err || o.error || String(o.rj)));
          } else {
            pending.resolve({ orderId: String(o.id ?? o.oid ?? '') });
          }
        }
        // fills:  o.fs 是 fills 列表, o.ex 是 executed size, o.st 是 status
        if (o.fs && Array.isArray(o.fs) && o.fs.length) {
          const orderId = String(o.id ?? o.oid ?? '');
          const tracked = this.orders.get(orderId);
          if (tracked) {
            const marketId = Number(tracked.marketId);
            const priceScale = this._priceScales.get(marketId) || 1;
            const sizeScale = this._sizeScales.get(marketId) || 1;
            for (const f of o.fs) {
              const px = f.p != null ? Number(f.p) / priceScale : tracked.price;
              const sz = f.s != null ? Number(f.s) / sizeScale : tracked.sizeBase;
              this.emit('fill', {
                orderId, marketId, side: tracked.side, price: px, sizeBase: sz,
                levelIndex: tracked.levelIndex, clientOrderId: tracked.clientOrderId,
              });
            }
            // 完全成交 / 撤销 / 过期 → 移除跟踪
            if (o.st === 2 || o.st === 3 || o.st === 4 || o.remaining === 0) this.orders.delete(orderId);
          }
        }
      }
      // top-level rq 匹配（有些实现响应把 rq 放外面而不是 orders[0].rq）
      if (msg.rq != null && this._pendingReplies.has(Number(msg.rq))) {
        const pending = this._pendingReplies.get(Number(msg.rq));
        this._pendingReplies.delete(Number(msg.rq));
        clearTimeout(pending.timer);
        if (msg.err || msg.error) pending.reject(new Error(msg.err || msg.error));
        else pending.resolve({ orderId: String(orders[0]?.id ?? orders[0]?.oid ?? '') });
      }
      return;
    }
    // 兜底诊断：非 heartbeat、非快照、也没被处理的消息 → 抽样打，防止字段又猜错
    if (!this._diagFirstN) this._diagFirstN = 0;
    if (this._diagFirstN < 5) {
      this._diagFirstN++;
      try { console.log(`[Perpl] 未识别的 WS 消息（诊断 ${this._diagFirstN}/5）：` + JSON.stringify(msg).slice(0, 400)); } catch {}
    }
  }

  /**
   * 发一条 mt=22 OrderRequest，用 `rq`（数字自增）做 idempotency key + 响应匹配。
   * 官方响应会是 mt=24 OrdersUpdate，orders[0].rq 回响我们发出去的 rq。
   */
  _sendOrderRequest(payload, timeoutMs = 8000) {
    if (!this._wsReady) throw new Error('Perpl trading WS 未连接，稍等重试');
    if (!this._wsAuthed) throw new Error('Perpl WS 认证未完成，稍等重试');
    if (this.accountId == null) throw new Error('Perpl accountId 未就绪（等 mt=21 消息）');
    const rq = ++this._reqSeq;
    const msg = { mt: 22, rq, acc: this.accountId, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingReplies.delete(rq);
        reject(new Error(`Perpl WS 请求超时（rq=${rq}, mt=22）`));
      }, timeoutMs);
      this._pendingReplies.set(rq, { resolve, reject, timer });
      try { this._ws.send(JSON.stringify(msg)); }
      catch (e) {
        this._pendingReplies.delete(rq);
        clearTimeout(timer);
        reject(new Error(`Perpl WS 发送失败：${e.message}`));
      }
    });
  }

  // ── GridBot 接口 ────────────────────────────────────────────────────────
  async getMarkets() { return [...this.markets.values()]; }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const mId = Number(marketId);
    const valid = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400];
    const res = valid.includes(intervalSec) ? intervalSec : 3600;
    try {
      const toMs = Date.now();
      const fromMs = toMs - res * n * 1000;
      const j = await this._pubGet(`/v1/market-data/${mId}/candles/${res}/${fromMs}-${toMs}`, 8000);
      if (!j?.d) return [];
      const scale = this._priceScales.get(mId) || 1;
      return (j.d).map((d) => ({
        time: Number(d.t),
        open: Number(d.o) / scale, high: Number(d.h) / scale,
        low: Number(d.l) / scale, close: Number(d.c) / scale,
        volume: Number(d.v) || 0,
      })).filter((c) => Number.isFinite(c.close));
    } catch { return []; }
  }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }

  async setLeverage(_marketId, _leverage) { return true; }

  async placeLimitOrder(o) {
    const marketId = Number(o.marketId);
    const priceScale = this._priceScales.get(marketId) || 1;
    const sizeScale = this._sizeScales.get(marketId) || 1;
    // Perpl 官方 mt=22 OrderRequest 定义：
    //   t: 1=OpenLong, 2=OpenShort, 3=CloseLong, 4=CloseShort, 5=Cancel
    //   p: 价格 (scaled)   s: 数量 (scaled)
    //   fl: 0=GTC        lv: 杠杆 hundredths (3x=300)
    //   lb: last execution block (head + ttl)，超过就作废
    const t = o.reduceOnly
      ? (o.side === 'buy' ? 4 : 3)   // reduceOnly: buy = close short, sell = close long
      : (o.side === 'buy' ? 1 : 2);  // open leg
    const lv = Math.round(Number(o.leverage || this._defaultLeverage || 3) * 100);
    // lb: 保守取 head + ttl。head=0（还没收到 heartbeat）时用 0 让服务端拒
    // 一次，我们能看到明确的 rejection 而不是永远等
    const lb = this._headBlock > 0 ? this._headBlock + this._orderTtlBlocks : 0;
    const payload = {
      mkt: marketId, t,
      p: Math.round(Number(o.price) * priceScale),
      s: Math.round(Number(o.sizeBase) * sizeScale),
      fl: 0, lv, lb,
    };
    const { orderId } = await this._sendOrderRequest(payload);
    if (!orderId || orderId === 'undefined' || orderId === '') throw new Error('Perpl 下单返回无 orderId');
    this.orders.set(orderId, {
      orderId, marketId, side: o.side,
      price: Number(o.price), sizeBase: Number(o.sizeBase),
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      reduceOnly: !!o.reduceOnly,
    });
    return { orderId };
  }

  async cancelOrder(marketId, orderId) {
    const marketIdN = Number(marketId);
    try {
      // t=5 Cancel，用 oid 传要撤的订单
      await this._sendOrderRequest({ mkt: marketIdN, t: 5, oid: Number(orderId), s: 0, fl: 0, lv: 0, lb: 0 }, 4000);
    } catch (e) {
      if (!/not\s?found|already/i.test(e.message)) throw e;
    }
    this.orders.delete(String(orderId));
    return true;
  }

  async cancelAll(marketId) {
    const marketIdN = Number(marketId);
    // Perpl 没有单条 cancel-all；逐单撤
    for (const o of [...this.orders.values()].filter((x) => x.marketId === marketIdN)) {
      await this.cancelOrder(marketIdN, o.orderId).catch(() => {});
    }
    // 保底：本地清空该市场跟踪（防止有 orphan）
    for (const [id, o] of this.orders) {
      if (o.marketId === marketIdN) this.orders.delete(id);
    }
    return true;
  }

  getOpenOrders(marketId) {
    return [...this.orders.values()].filter((o) => o.marketId === Number(marketId));
  }

  async fetchOpenOrders(marketId) {
    // Perpl 用 REST 查历史订单，open 状态过滤
    try {
      const j = await this._req('GET', '/v1/trading/order-history?state=open&limit=100');
      const arr = j.orders || j.data || (Array.isArray(j) ? j : []);
      const mIdN = Number(marketId);
      return arr
        .filter((o) => Number(o.marketId || o.market_id) === mIdN)
        .map((o) => {
          const scale = this._priceScales.get(mIdN) || 1;
          return {
            orderId: String(o.orderId || o.id),
            price: Number(o.price) / scale,
            side: (o.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy',
          };
        });
    } catch { return []; }
  }

  adoptOrder({ orderId, marketId, levelIndex, side, price, sizeBase }) {
    this.orders.set(String(orderId), {
      orderId: String(orderId), marketId: Number(marketId),
      levelIndex, side, price: Number(price), sizeBase: Number(sizeBase),
      reduceOnly: false,
    });
  }

  getPosition(marketId) {
    const p = this.positions.get(Number(marketId));
    if (!p || p.sizeBase === 0) return null;
    return p;
  }

  async closePosition(marketId) {
    const marketIdN = Number(marketId);
    const p = this.getPosition(marketIdN);
    if (!p || !p.sizeBase) return null;
    const sizeScale = this._sizeScales.get(marketIdN) || 1;
    // Perpl 官方：t=3 CloseLong (卖) / t=4 CloseShort (买)；市价单 p=0；lb=head+ttl
    const t = p.sizeBase > 0 ? 3 : 4;
    const lb = this._headBlock > 0 ? this._headBlock + this._orderTtlBlocks : 0;
    return await this._sendOrderRequest({
      mkt: marketIdN, t,
      p: 0,
      s: Math.round(Math.abs(p.sizeBase) * sizeScale),
      fl: 0, lv: 100, lb,
    }, 8000);
  }

  async reconcileOpenOrders() {
    try {
      const j = await this._req('GET', '/v1/trading/order-history?state=open&limit=100');
      const arr = j.orders || j.data || (Array.isArray(j) ? j : []);
      const stillOpen = new Set(arr.map((o) => String(o.orderId || o.id)));
      for (const id of [...this.orders.keys()]) if (!stillOpen.has(id)) this.orders.delete(id);
    } catch { /* skip */ }
    return true;
  }

  start() { this._startPolling(); }
  stop() {
    // bump 世代号：让老 socket 的 close handler 不再自动重连
    this._wsGen++;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this._wsReady = false;
    this._wsAuthed = false;
  }

  // ── REST 轮询：价格 / 持仓 / 余额 / fill 兜底 ────────────────────────────
  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._poll().catch(() => {}), POLL_MS);
    this._pollTimer.unref?.();
  }

  async _pollPrices() {
    // 每家用最新一根 60s 蜡烛做当前价（context 里通常没有价格字段）
    const now = Date.now();
    for (const [id] of this.markets) {
      const j = await this._pubGet(`/v1/market-data/${id}/candles/60/${now - 300000}-${now}`, 4000);
      const last = (j?.d || []).at(-1);
      if (!last) continue;
      const scale = this._priceScales.get(id) || 1;
      const price = Number(last.c) / scale;
      if (Number.isFinite(price) && price > 0) {
        this.prices.set(id, price);
        const m = this.markets.get(id);
        if (m) m.lastPrice = price;
        this.emit('price', { marketId: id, price });
      }
    }
  }

  async _poll() {
    this.lastOkAt = Date.now();

    // 1) 价格
    await this._pollPrices();

    // 2) 账户历史 → 推 balance / 持仓（perpl 用 account-history 查最新 snapshot）
    try {
      const j = await this._req('GET', '/v1/trading/account-history?limit=1');
      const snap = j?.data?.[0] || j?.[0] || j;
      if (snap) {
        const bal = Number(snap.balance ?? snap.usdcBalance ?? snap.collateral);
        if (Number.isFinite(bal)) this.balance = bal;
      }
    } catch { /* transient */ }

    // 3) fill 兜底：WS 应该已经推过，这里作为二次保险，检查本地跟踪的
    //    单是否还在 open 里；不在就查详情看是否 filled
    if (this.orders.size > 0) {
      try {
        const j = await this._req('GET', '/v1/trading/order-history?state=open&limit=200');
        const arr = j.orders || j.data || (Array.isArray(j) ? j : []);
        const stillOpen = new Set(arr.map((o) => String(o.orderId || o.id)));
        for (const id of [...this.orders.keys()]) {
          if (!stillOpen.has(id)) {
            // WS 通常会先推 fill，这里静默清理即可
            this.orders.delete(id);
          }
        }
      } catch { /* skip */ }
    }
  }
}

// 从 Perpl WS 消息里提取账户余额
// mt=19 WalletSnapshot: { addr, as: [ Account{ b: "210470000", lb: ... } ] }
// mt=20 WalletUpdate / mt=21 AccountUpdate: 单个 Account 或增量
//
// Amount 字段是 **微美分**（1 USDC = 1_000_000）——文档里 Micros = int64
// "Value in 10^-6 fractions"。除以 1e6 得到真实 USD。
const PERPL_AMOUNT_SCALE = 1_000_000;
function _extractPerplBalance(self, msg) {
  const accounts = Array.isArray(msg.as) ? msg.as : (msg.a ? [msg.a] : []);
  const candidates = accounts.length ? accounts : (msg.b !== undefined ? [msg] : []);
  for (const acc of candidates) {
    const raw = Number(acc?.b);
    if (!Number.isFinite(raw) || raw < 0) continue;
    const bal = raw / PERPL_AMOUNT_SCALE;
    const prev = Number(self.balance) || 0;
    self.balance = bal;
    if (Math.abs(prev - bal) > 0.001) {
      console.log(`[Perpl] balance 更新：$${prev.toFixed(2)} → $${bal.toFixed(2)}（raw=${raw}）`);
    }
  }
}
