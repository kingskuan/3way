// LighterExchange (LIVE) — zkLighter L2 上的 zk perp DEX（Elliot Labs）
// · USDC 结算 · 主流币 BTC/ETH/SOL/HYPE/... · 零售零手续费 · L2 API key 签名
//
// 写端签名策略（Round 277 起）：
//   Lighter 的签名器是 Go 编译的 lighter-signer-*.so，用 Poseidon+BN254
//   zk-friendly 方案。纯 JS 无等价实现。本轮通过 tools/lighter-signer.py
//   常驻子进程 + JSON RPC over stdin/stdout 桥接官方 Python SDK：
//     · 有 LT_API_KEY_PRIVATE_KEY  → init() 里 spawn Python worker，写端可用
//     · 无 privateKey / 子进程挂    → 静默回落到 read-only（同 Round 276 行为）
//   Docker 镜像 (Round 277 更新的 Dockerfile) 已内置 python3 + lighter-sdk。
//
// 读端（无签名器也可用）：markets / candles / prices / positions / balance
// 全走公开 REST，不需要 auth token。
//
// 文档：https://mainnet.zklighter.elliot.ai （API 基址）
//       https://github.com/elliottech/lighter-python
//       https://github.com/elliottech/lighter-go （签名器 Go 源，二进制内嵌 python SDK）
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { LighterSignerBridge } from './signer-bridge.js';

const POLL_MS = 3000;
const BASE_URL = 'https://mainnet.zklighter.elliot.ai';

// Lighter 主流合约优先接入（避免小币把 poll 打爆）。这里列 Lighter 主战场
// 的常见 market symbol，遇到 orderBooks 返回后按此白名单过滤。
const PREFERRED_SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'HYPE', 'DOGE',
  'AVAX', 'BNB', 'XRP', 'ADA', 'LINK',
  'ARB', 'OP', 'APT', 'SUI', 'INJ',
  'NEAR', 'TIA', 'ATOM', 'DOT', 'LTC',
  'WLD', 'ORDI', 'PEPE', 'WIF', 'BONK',
]);

// 签名器不可用时抛的错（缺 privateKey / Python worker 挂 / 熔断给放弃了）
const SIGNER_MISSING_ERR = (reason = 'not_ready') =>
  new Error(
    `Lighter 签名器不可用 (${reason})：需 LT_API_KEY_PRIVATE_KEY + LT_ACCOUNT_INDEX，`
    + '且 Python worker (tools/lighter-signer.py) 起来后 check_client 无错。'
    + '本次操作已 skip，读端（价格/持仓/余额）仍可用。'
  );

// tools/lighter-signer.py 的绝对路径（跟 lighter.js 一样在同一个 repo，向上 3 级到 project root）
const _hereDir = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = pathResolve(_hereDir, '..', '..', '..', 'tools', 'lighter-signer.py');

export class LighterExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.privateKey = opts.privateKey || '';   // 40 hex chars（Lighter API key priv，不是 EVM/ed25519）
    this.accountIndex = Number(opts.accountIndex);
    this.apiKeyIndex = Number(opts.apiKeyIndex ?? 0);
    this.apiUrl = opts.apiUrl || BASE_URL;
    // Round 279: chainId + network 从 config 传入 · 支持 mainnet / rh-mainnet / testnet / rh-testnet
    this.chainId = Number.isFinite(Number(opts.chainId)) ? Number(opts.chainId) : null;
    this.dataSource = 'connecting';
    this.network = opts.network || 'mainnet';

    this.markets = new Map();       // marketId(number) -> Market
    this.symbolToId = new Map();    // "BTC" -> marketId
    this.mktIdxToLocal = new Map(); // Lighter market_id (exchange side) -> local marketId
    this.prices = new Map();
    this.orders = new Map();        // orderId -> { orderId, marketId, side, price, sizeBase, ... }
    this.positions = new Map();
    this.balance = 0;
    this.equity = 0;
    this.unrealizedPnl = 0;
    this.realizedPnl = null;
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.stats = null;

    this._pollTimer = null;
    this._activeMarketId = null;
    this._balanceCounter = 0;
    this._signerAvailable = false;    // true 表示 Python bridge init OK
    this._signerBridge = null;        // LighterSignerBridge | null
    this._writeStubWarned = false;    // 每种写操作首次抛错时 log 一次即可
    // client_order_index 是 int64，用来匹配 cancel 时的 order_index。
    // 用 (毫秒时间戳 << 20) + counter 保证进程内单调、进程间大概率不冲突。
    this._cloiCounter = 0;
    this._cloiBase = Number(BigInt(Date.now()) << 20n);
  }

  _nextClientOrderIndex() {
    // 保证不超过 Number.MAX_SAFE_INTEGER (2^53-1)：ms << 20 ≈ 2^60，太大 → 只取低 52 位
    this._cloiCounter = (this._cloiCounter + 1) & 0xffff;
    const raw = (this._cloiBase + this._cloiCounter) % Number.MAX_SAFE_INTEGER;
    return raw;
  }

  // 本地 marketId → Lighter 的 remote market_id
  _remoteMarketIndex(localMid) {
    for (const [rm, lm] of this.mktIdxToLocal) if (lm === Number(localMid)) return rm;
    return null;
  }

  // ── 请求辅助 ────────────────────────────────────────────────────────────
  async _pubGet(path, timeoutMs = 8000) {
    try {
      const res = await fetch(`${this.apiUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        this.lastError = `Lighter GET ${path} → HTTP ${res.status}`;
        return null;
      }
      const j = await res.json();
      // Lighter 统一响应 { code, message, ... }：code === 200 为成功，其余错
      if (j?.code != null && Number(j.code) !== 200) {
        this.lastError = `Lighter GET ${path} → code=${j.code} msg=${(j.message || '').slice(0,120)}`;
        return null;
      }
      return j;
    } catch (e) {
      this.lastError = `Lighter GET ${path} → ${e.name || 'err'}: ${(e.message || '').slice(0,120)}`;
      return null;
    }
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  async init() {
    // Lighter 的市场需从 /api/v1/orderBooks 拉（返回所有 order-book 元数据）
    const list = await this._fetchMarkets();
    if (!list.length) {
      // Round 278b: 保留 _pubGet 的具体错（HTTP 码 / 异常名）· 之前 throw generic
      // 「拉不到市场列表」覆盖了 lastError · 用户看不到根因
      throw new Error(`Lighter: 拉不到市场列表 · ${this.lastError || '无 _pubGet lastError（未调用？）'}`);
    }
    this._setMarkets(list);
    for (const [id, m] of this.markets) this.prices.set(id, m.lastPrice);

    // 拉一次账户余额 + 持仓（GET /api/v1/account?by=index&value=X 无需鉴权）
    if (!Number.isFinite(this.accountIndex) || this.accountIndex < 0) {
      throw new Error(
        'Lighter LIVE 需要 LT_ACCOUNT_INDEX（正整数，你在 zklighter.elliot.ai 上的账户 index）'
      );
    }
    if (!this.privateKey) {
      // 允许无 privateKey 起 read-only（能看真价/真仓，只是写端抛错）
      console.warn('[Lighter] 未提供 LT_API_KEY_PRIVATE_KEY，进入 read-only LIVE 模式（写端不可用）');
    }
    try {
      await this._refreshAccount();
      console.log(`[Lighter] 初始账户 balance=${this.balance} USDC positions=${this.positions.size}`);
    } catch (e) {
      throw new Error(
        `Lighter 账户拉取失败：${e.message}\n`
        + `  检查 LT_ACCOUNT_INDEX=${this.accountIndex} 是不是有效账户；\n`
        + `  且 API 基址 ${this.apiUrl} 可达。`
      );
    }

    // 有 privateKey 就尝试把 Python 签名器 bridge 起来。失败降级到 read-only，
    // 不 hard-fail — user 可以先看到日志再调 env。
    if (this.privateKey) {
      try {
        this._signerBridge = new LighterSignerBridge({
          pythonPath: process.env.LT_PYTHON || 'python3',
          workerPath: WORKER_PATH,
          initParams: {
            api_url: this.apiUrl,
            api_key_private_key: this.privateKey,
            account_index: this.accountIndex,
            api_key_index: this.apiKeyIndex,
            // Round 279: 传 chain_id 让 SignerClient 用对应网络的 L2 signing domain。
            // 原生 L2 = 304 · Robinhood Chain = 466324 · 缺就让 SDK 自动推。
            chain_id: this.chainId ?? undefined,
          },
        });
        this._signerBridge.on('crash', (err) => {
          console.warn('[Lighter] signer bridge crash:', err.message);
          this.emit('error', err);
        });
        await this._signerBridge.start();
        this._signerAvailable = true;
        console.log('[Lighter] Python signer bridge OK · 写端可用');
      } catch (e) {
        this._signerAvailable = false;
        console.warn('[Lighter] Python signer bridge 起不来，退回 read-only:', e.message);
      }
    }

    this.dataSource = 'real';
    this._startPolling();
    return true;
  }

  async reconnect() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    return this.init();
  }

  async _fetchMarkets() {
    // /api/v1/orderBooks：返 [{market_id, symbol, min_base_amount, size_decimals,
    //   price_decimals, supported_size_decimals, supported_price_decimals, ...}]
    const j = await this._pubGet('/api/v1/orderBooks');
    const arr = j?.order_books || j?.orderBooks || (Array.isArray(j) ? j : []);
    if (!arr.length) return [];

    // 拉 exchangeStats 或 orderBookDetails 拿实时价格（后者更详细）
    // Round 278c: exchangeStats 每条只有 { symbol, last_trade_price, ... } · 无 market_id ·
    // 之前用 Number(s.market_id) 全塞 NaN key · 后续按 remoteMid 查全 miss · price=0 →
    // 235 市场全被 filter 掉 · adapter 报「拉不到市场列表」。改按 symbol 建 priceBySymbol map。
    const stats = await this._pubGet('/api/v1/exchangeStats');
    const statsList = stats?.order_book_stats || stats?.orderBookStats || [];
    const priceBySymbol = new Map();
    for (const s of statsList) {
      const sym = String(s.symbol || '').toUpperCase();
      const p = Number(s.last_trade_price || s.mark_price || s.index_price || 0);
      if (sym && p > 0) priceBySymbol.set(sym, p);
    }

    const out = [];
    let nextId = 1;
    this.symbolToId.clear();
    this.mktIdxToLocal.clear();

    for (const b of arr) {
      const symbol = String(b.symbol || '').toUpperCase();
      if (!symbol) continue;
      if (!PREFERRED_SYMBOLS.has(symbol)) continue;

      const remoteMid = Number(b.market_id ?? b.marketId);
      if (!Number.isFinite(remoteMid)) continue;

      const priceDec = Number(b.supported_price_decimals ?? b.price_decimals ?? 2);
      const sizeDec  = Number(b.supported_size_decimals  ?? b.size_decimals  ?? 4);
      const stepPrice = Math.pow(10, -priceDec);
      const stepSize  = Math.pow(10, -sizeDec);
      const minSize   = Number(b.min_base_amount) > 0
        ? Number(b.min_base_amount) / Math.pow(10, Number(b.size_decimals ?? sizeDec))
        : stepSize;

      const price = priceBySymbol.get(symbol) || 0;
      if (!(price > 0)) continue;   // 没有活跃价的市场先跳过

      const marketId = nextId++;
      out.push({
        marketId,
        displayName: `${symbol}-USDC`,
        symbol,
        lastPrice: price,
        stepSize,
        stepPrice,
        minOrderSize: minSize,
        maxLeverage: 20,             // Lighter 默认最高杠杆，实际按账户 tier 有差异
        // 写端签名要把 price/size 缩成整数（乘 10^decimals）。存原始 decimals 避
        // 免用 -log10(stepPrice) 反算时踩浮点误差。
        _priceDec: priceDec,
        _sizeDec: sizeDec,
        _remoteMarketIndex: remoteMid,
      });
      this.symbolToId.set(symbol, marketId);
      this.symbolToId.set(`${symbol}-USDC`, marketId);
      this.mktIdxToLocal.set(remoteMid, marketId);
    }
    return out;
  }

  _setMarkets(list) {
    this.markets.clear();
    for (const m of list) this.markets.set(m.marketId, m);
  }

  async _refreshAccount() {
    if (!Number.isFinite(this.accountIndex)) return;
    // /api/v1/account?by=index&value=<n>：无鉴权，返 DetailedAccounts。
    const j = await this._pubGet(`/api/v1/account?by=index&value=${this.accountIndex}`);
    const acct = Array.isArray(j?.accounts) ? j.accounts[0] : (j?.account || j);
    if (!acct) throw new Error(`account_index=${this.accountIndex} 无数据`);

    // available_balance / collateral 都是字符串（USDC 6 位小数），照原样解析
    const bal = Number(acct.available_balance);
    const coll = Number(acct.collateral);
    if (Number.isFinite(coll) && coll > 0) {
      this.equity = coll;
      this.balance = Number.isFinite(bal) ? bal : coll;
    } else if (Number.isFinite(bal) && bal > 0) {
      this.balance = bal;
      this.equity = bal;
    }

    // 持仓
    this.positions.clear();
    let unreal = 0;
    for (const p of (acct.positions || [])) {
      const remoteMid = Number(p.market_id);
      const localMid = this.mktIdxToLocal.get(remoteMid);
      if (!localMid) continue;
      const size = Number(p.position);   // 已是 "对象数量" 字符串
      if (!(size > 0)) continue;
      // Lighter sign: 1 = long / -1 = short (guess based on doc pattern — 见 gotchas)
      const signedSize = Number(p.sign) < 0 ? -size : size;
      const uPnl = Number(p.unrealized_pnl || 0);
      unreal += uPnl;
      this.positions.set(localMid, {
        marketId: localMid,
        sizeBase: signedSize,
        entryPrice: Number(p.avg_entry_price || 0),
        unrealizedPnl: uPnl,
      });
    }
    this.unrealizedPnl = unreal;
    this.lastOkAt = Date.now();
  }

  // ── GridBot 接口（读端）────────────────────────────────────────────────
  async getMarkets() { return [...this.markets.values()]; }

  async getPrice(marketId) { return this.prices.get(Number(marketId)); }

  async getCandles(marketId, intervalSec = 3600, n = 200) {
    const mkt = this.markets.get(Number(marketId));
    if (!mkt) return [];
    // Lighter 用 remoteMid 拉 candles，local -> remote 反查
    let remoteMid = null;
    for (const [rm, lm] of this.mktIdxToLocal) { if (lm === mkt.marketId) { remoteMid = rm; break; } }
    if (remoteMid == null) return [];
    // resolution: 1m/5m/15m/1h/4h/1d
    const reso = intervalSec < 3600 ? `${intervalSec / 60}m`
               : intervalSec === 3600 ? '1h'
               : intervalSec === 14400 ? '4h'
               : intervalSec === 86400 ? '1d'
               : '1h';
    const end = Math.floor(Date.now() / 1000);
    const start = end - intervalSec * Math.max(50, Math.min(500, n));
    const path = `/api/v1/candles?market_id=${remoteMid}&resolution=${reso}`
               + `&start_timestamp=${start}&end_timestamp=${end}&count_back=${Math.min(500, Math.max(50, n))}`;
    const j = await this._pubGet(path);
    const list = j?.candles || j?.candlesticks || (Array.isArray(j) ? j : []);
    return list.map((c) => ({
      time: Number(c.timestamp || c.time || 0),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume0 || c.volume || 0),
    })).filter((c) => Number.isFinite(c.close));
  }

  async getStats() {
    // Lighter 目前没暴露"账户历史成交量"公开端点，返 null 由 bot 侧本地累积 fallback
    return this.stats;
  }

  // ── GridBot 接口（写端 — Round 277 起走 Python signer bridge）────────
  async setLeverage(marketId, leverage) {
    // Lighter 有 SignUpdateLeverage 接口（cross/isolated + fraction），但对 grid
    // 策略而言"每单不带 leverage 也能起单"，很多其它 DEX（Perpl/Extended/StandX/
    // Bitget）也是账户级不改。为了不给 bot 起单前加一步可能失败的 tx，这里先返
    // true，实际杠杆按账户 tier 默认走。future round 若真需要按 market 改，再补
    // sign_update_leverage 到 worker。
    if (!this._writeStubWarned) {
      this._writeStubWarned = true;
      console.log(`[Lighter] setLeverage(${marketId}, ${leverage}) — 走账户级默认杠杆，不发 tx`);
    }
    return true;
  }

  async placeLimitOrder(o) {
    if (!this._signerAvailable || !this._signerBridge) {
      const err = SIGNER_MISSING_ERR('signer_not_ready');
      this.emit('error', err);
      throw err;
    }
    const mkt = this.markets.get(Number(o.marketId));
    if (!mkt) throw new Error(`Lighter: 未知 market ${o.marketId}`);
    const remoteMid = mkt._remoteMarketIndex ?? this._remoteMarketIndex(mkt.marketId);
    if (remoteMid == null) throw new Error(`Lighter: ${mkt.symbol} 未映射到 remote market_index`);

    const priceDec = Number(mkt._priceDec);
    const sizeDec = Number(mkt._sizeDec);
    if (!Number.isFinite(priceDec) || !Number.isFinite(sizeDec)) {
      throw new Error(`Lighter: market ${mkt.symbol} 缺 price/size decimals（应在 init 时填）`);
    }

    const price = Math.round(Number(o.price) * Math.pow(10, priceDec));
    const baseAmount = Math.round(Number(o.sizeBase) * Math.pow(10, sizeDec));
    if (!(price > 0) || !(baseAmount > 0)) {
      throw new Error(`Lighter: 非法 price/size (raw price=${o.price} size=${o.sizeBase} → int ${price}/${baseAmount})`);
    }

    const clientOrderIndex = this._nextClientOrderIndex();
    const isAsk = String(o.side).toLowerCase() === 'sell';

    // SDK 常量：ORDER_TYPE_LIMIT=0 · ORDER_TIME_IN_FORCE_GOOD_TILL_TIME=1 (POST_ONLY=2)
    // 默认 GTT 而非 POST_ONLY 是为了跟 Decibel 一致（避免 replenish 时 POST_ONLY 违规 reject）
    const timeInForce = (o.postOnly ?? false) ? 2 : 1;

    const resp = await this._signerBridge.signCreateOrder({
      market_index: remoteMid,
      client_order_index: clientOrderIndex,
      base_amount: baseAmount,
      price,
      is_ask: isAsk,
      order_type: 0,
      time_in_force: timeInForce,
      reduce_only: !!o.reduceOnly,
      trigger_price: 0,
      order_expiry: -1,   // DEFAULT_28_DAY
    });
    if (!resp || resp.err) throw new Error(`Lighter 下单失败：${resp?.err || 'unknown'}`);
    if (resp.code != null && Number(resp.code) !== 200) {
      throw new Error(`Lighter 下单被拒 code=${resp.code} msg=${resp.message || ''}`);
    }

    // 本地跟踪：用 client_order_index 作 orderId（cancel 时需要传的就是这个）
    const orderId = String(clientOrderIndex);
    this.orders.set(orderId, {
      orderId,
      marketId: mkt.marketId,
      levelIndex: o.levelIndex,
      side: o.side,
      price: Number(o.price),
      sizeBase: Number(o.sizeBase),
      reduceOnly: !!o.reduceOnly,
      clientOrderIndex,
      txHash: resp.tx_hash || null,
    });
    return { orderId };
  }

  async cancelOrder(marketId, orderId) {
    // 先本地清理，让 bot 状态马上收敛（真链上撤单失败也不重复跟踪）
    this.orders.delete(String(orderId));
    if (!this._signerAvailable || !this._signerBridge) throw SIGNER_MISSING_ERR('signer_not_ready');
    const mkt = this.markets.get(Number(marketId));
    if (!mkt) return;
    const remoteMid = mkt._remoteMarketIndex ?? this._remoteMarketIndex(mkt.marketId);
    if (remoteMid == null) return;
    const orderIndex = Number(orderId);
    if (!Number.isFinite(orderIndex)) throw new Error(`Lighter cancel: orderId 不是数字 (${orderId})`);
    const resp = await this._signerBridge.signCancelOrder({
      market_index: remoteMid,
      order_index: orderIndex,
    });
    if (resp?.err) throw new Error(`Lighter 撤单失败：${resp.err}`);
    if (resp?.code != null && Number(resp.code) !== 200) {
      throw new Error(`Lighter 撤单被拒 code=${resp.code} msg=${resp.message || ''}`);
    }
  }

  async cancelAll(marketId) {
    const marketIdN = Number(marketId);
    for (const [id, o] of this.orders) {
      if (o.marketId === marketIdN) this.orders.delete(id);
    }
    if (!this._signerAvailable || !this._signerBridge) throw SIGNER_MISSING_ERR('signer_not_ready');
    const mkt = this.markets.get(marketIdN);
    if (!mkt) return;
    const remoteMid = mkt._remoteMarketIndex ?? this._remoteMarketIndex(marketIdN);
    if (remoteMid == null) return;
    const resp = await this._signerBridge.signCancelAll({
      time_in_force: 0,       // CANCEL_ALL_TIF_IMMEDIATE
      timestamp_ms: 0,
      cancel_all_market_index: remoteMid,
    });
    if (resp?.err) throw new Error(`Lighter cancelAll 失败：${resp.err}`);
  }

  async closePosition(marketId) {
    const pos = this.positions.get(Number(marketId));
    if (!pos || pos.sizeBase === 0) return { closed: true };
    if (!this._signerAvailable || !this._signerBridge) {
      return { closed: false, error: SIGNER_MISSING_ERR('signer_not_ready').message };
    }
    const mkt = this.markets.get(Number(marketId));
    if (!mkt) return { closed: false, error: `未知 market ${marketId}` };
    const remoteMid = mkt._remoteMarketIndex ?? this._remoteMarketIndex(mkt.marketId);
    if (remoteMid == null) return { closed: false, error: '未映射 remote market_index' };

    const priceDec = Number(mkt._priceDec);
    const sizeDec = Number(mkt._sizeDec);
    const size = Math.abs(Number(pos.sizeBase));
    const baseAmount = Math.round(size * Math.pow(10, sizeDec));
    if (!(baseAmount > 0)) return { closed: true };
    const isAsk = pos.sizeBase > 0;           // long 平仓 → sell
    // Market IOC + 5% slippage 保护（限价市价单：给个宽泛的最坏可接受价）
    const refPx = Number(this.prices.get(Number(marketId)) || mkt.lastPrice);
    const slippedPx = isAsk ? refPx * 0.95 : refPx * 1.05;
    const price = Math.round(slippedPx * Math.pow(10, priceDec));
    const clientOrderIndex = this._nextClientOrderIndex();
    try {
      const resp = await this._signerBridge.signCreateOrder({
        market_index: remoteMid,
        client_order_index: clientOrderIndex,
        base_amount: baseAmount,
        price,
        is_ask: isAsk,
        order_type: 1,         // ORDER_TYPE_MARKET
        time_in_force: 0,      // IOC
        reduce_only: true,
        trigger_price: 0,
        order_expiry: 0,       // DEFAULT_IOC_EXPIRY
      });
      if (resp?.err) return { closed: false, error: resp.err };
      if (resp?.code != null && Number(resp.code) !== 200) {
        return { closed: false, error: `code=${resp.code} msg=${resp.message || ''}` };
      }
      return { closed: true, txHash: resp?.tx_hash };
    } catch (e) {
      return { closed: false, error: e.message };
    }
  }

  async fetchOpenOrders(_marketId) {
    // /api/v1/accountActiveOrders 需 Authorization header（Go 签名器生成 auth token）
    // 无签名器时只能返本地跟踪（写端也在 stub 阶段所以恒为空）
    return [];
  }

  getOpenOrders(marketId) {
    return [...this.orders.values()].filter((o) => o.marketId === Number(marketId));
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
    return { sizeBase: p.sizeBase, entryPrice: p.entryPrice, unrealizedPnl: p.unrealizedPnl };
  }

  async fetchPositions() {
    // 已由 _refreshAccount 定时刷新 positions map，直接返
    return [...this.positions.values()];
  }

  async reconcileOpenOrders() { return true; }

  setActiveMarket(marketId) {
    this._activeMarketId = Number(marketId) || null;
  }

  // ── 轮询 ────────────────────────────────────────────────────────────────
  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._pollTick().catch(() => {}), POLL_MS);
    this._pollTimer.unref?.();
  }

  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._signerBridge) {
      try { this._signerBridge.stop(); } catch {}
      this._signerBridge = null;
      this._signerAvailable = false;
    }
  }

  start() {
    this._startPolling();
  }

  async _pollTick() {
    // 1. 全市场 tickers 一次拿完（/api/v1/exchangeStats 一次请求）
    try {
      const j = await this._pubGet('/api/v1/exchangeStats');
      const list = j?.order_book_stats || j?.orderBookStats || [];
      for (const s of list) {
        const remoteMid = Number(s.market_id);
        const localMid = this.mktIdxToLocal.get(remoteMid);
        if (!localMid) continue;
        const p = Number(s.last_trade_price || s.mark_price || s.index_price || 0);
        if (p > 0) {
          this.prices.set(localMid, p);
          const m = this.markets.get(localMid);
          if (m) m.lastPrice = p;
          this.emit('price', { marketId: localMid, price: p });
        }
      }
      this.lastOkAt = Date.now();
    } catch { /* 不阻塞后续 */ }

    // 2. 每 5 轮 (15s) 拉一次账户（balance + positions），跟 bg 同频
    this._balanceCounter++;
    if (this._balanceCounter >= 5) {
      this._balanceCounter = 0;
      try { await this._refreshAccount(); } catch { /* 静默 */ }
    }
  }
}
