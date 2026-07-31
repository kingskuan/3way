// Phoenix LIVE adapter (Round 209 skeleton)
//
// Phoenix (perp-api.phoenix.trade) 是 Solana 链上永续 DEX，架构跟其他 8 家 REST/HMAC
// 完全不同：
//   1. Auth = 钱包签名 → JWT bearer token（Privy 或 wallet signature）
//   2. 下单 = POST 拿回 base64 编码的 Solana instruction
//   3. 客户端要用 wallet keypair sign 那个 instruction 再 submit 到 Solana RPC
//   4. Order 在链上确认后 API 才认账
//
// **本文件是骨架** —— init() 会尝试 auth，成功就 UI 显示 LIVE；下单/撤单方法目前
// throw 明确错误提示"需 Solana signing 实现"。Round 210 会加：
//   - @solana/web3.js dep
//   - PH_WALLET_PRIVATE_KEY (base58) 解析
//   - PH_SOLANA_RPC_URL 连接
//   - Instruction 签名 + submit
//   - Fill 事件从链上确认拉
//
// 当前无 wallet 时 paper 兜底工作，UI 里 PH 卡显示 PAPER。
import { EventEmitter } from 'events';

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
    this._walletPrivateKey = walletPrivateKey || null;
    this._solanaRpcUrl = solanaRpcUrl || 'https://api.mainnet-beta.solana.com';
    this._authToken = null;
    this._authorityPubkey = null;
    this._pollTimer = null;
  }

  async _req(method, path, body = null, needAuth = false) {
    const headers = { 'Accept': 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (needAuth) {
      if (!this._authToken) throw new Error('Phoenix 未认证：钱包签名认证未完成');
      headers['Authorization'] = `Bearer ${this._authToken}`;
    }
    const opts = { method, headers, signal: AbortSignal.timeout(10000) };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const msg = j?.error || j?.message || text.slice(0, 160) || `HTTP ${res.status}`;
      throw new Error(`Phoenix ${method} ${path} → ${msg}`);
    }
    return j;
  }

  async init() {
    // 公开 endpoint：拉市场列表（不需 auth）
    try {
      const markets = await this._req('GET', '/v1/view/exchange/markets');
      if (Array.isArray(markets)) {
        let idx = 1;
        for (const m of markets) {
          if (!m.symbol) continue;
          this.markets.set(idx, {
            marketId: idx,
            displayName: m.symbol,
            symbol: m.symbol.replace('-PERP', ''),
            lastPrice: Number(m.markPrice || m.price || 0),
            minOrderSize: Number(m.minBaseLot || 0.001),
            stepSize: Number(m.baseLotSize || 0.001),
            stepPrice: Number(m.priceTickSize || 0.001),
            maxLeverage: Number(m.maxLeverage || 20),
          });
          this.prices.set(idx, Number(m.markPrice || m.price || 0));
          idx++;
        }
      }
    } catch (e) {
      this.lastError = `拉市场失败：${e.message}`;
      throw new Error(`Phoenix init 拉市场失败：${e.message}`);
    }

    // Wallet 签名认证（Round 210 会实现完整流程）
    if (!this._walletPrivateKey) {
      this.dataSource = 'real-readonly';   // 能读市场，但不能交易
      this.lastOkAt = Date.now();
      throw new Error(
        'Phoenix LIVE 需要 Solana wallet：设置 PH_WALLET_PRIVATE_KEY (base58) + ' +
        'PH_SOLANA_RPC_URL。Round 210 会完整实现 wallet 签名 + Solana instruction submit。' +
        '目前建议用 paper mode。'
      );
    }

    // TODO Round 210:
    //   1. bs58 解析 privateKey → Keypair
    //   2. GET /v1/auth/nonce 拿 nonce
    //   3. Keypair sign nonce message
    //   4. POST /v1/auth/login/wallet with signature → 拿 bearer token
    //   5. 存 this._authToken 和 this._authorityPubkey
    throw new Error('Phoenix LIVE wallet 签名认证未实现（Round 210 待做）');
  }

  async getMarkets() {
    return [...this.markets.values()];
  }

  async getPrice(marketId) {
    return this.prices.get(Number(marketId)) ?? null;
  }

  async getCandles(marketId, sec, n) {
    // Phoenix API doc 里有 candle endpoint 但未探明 path。Round 210 补。
    // 暂时返合成 K 线兜底 autopilot 选币逻辑不炸
    const price = this.prices.get(Number(marketId)) ?? 100;
    const now = Math.floor(Date.now() / 1000);
    const step = sec || 3600;
    const out = [];
    let last = price;
    for (let i = n - 1; i >= 0; i--) {
      const t = now - i * step;
      const drift = (Math.random() - 0.5) * 0.006;
      const close = last * (1 + drift);
      out.push({ time: t, open: last, high: Math.max(last, close), low: Math.min(last, close), close, volume: 0 });
      last = close;
    }
    return out;
  }

  async setLeverage(_marketId, _leverage) {
    // Phoenix isolated margin — leverage 每单指定，无 account-level setLeverage
    return true;
  }

  async placeLimitOrder(_o) {
    throw new Error('Phoenix LIVE placeLimitOrder 未实现 —— 需 Solana wallet 签名 instruction。Round 210 待做。');
  }

  async cancelOrder(_marketId, _orderId) {
    throw new Error('Phoenix LIVE cancelOrder 未实现 —— 需 Solana wallet 签名。Round 210 待做。');
  }

  async cancelAll(_marketId) {
    throw new Error('Phoenix LIVE cancelAll 未实现。Round 210 待做。');
  }

  async fetchOpenOrders(_marketId) {
    if (!this._authorityPubkey) return [];
    try {
      const orders = await this._req('GET', `/v1/traders/${this._authorityPubkey}/orders_v2`, null, true);
      return Array.isArray(orders) ? orders : [];
    } catch (e) {
      this.lastError = e.message;
      return [];
    }
  }

  async fetchPositions() {
    if (!this._authorityPubkey) return [];
    try {
      const state = await this._req('GET', `/v1/trader/state/${this._authorityPubkey}`, null, true);
      return state?.positions || [];
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

  async closePosition(_marketId) {
    throw new Error('Phoenix LIVE closePosition 未实现。Round 210 待做。');
  }

  async reconcileOpenOrders() { return true; }

  start() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      try {
        const markets = await this._req('GET', '/v1/view/exchange/markets');
        if (Array.isArray(markets)) {
          for (const [id, m] of this.markets) {
            const remote = markets.find((r) => r.symbol === m.displayName);
            if (remote) {
              const p = Number(remote.markPrice || remote.price || 0);
              if (p > 0) {
                this.prices.set(id, p);
                m.lastPrice = p;
                this.emit('price', { marketId: id, price: p });
              }
            }
          }
          this.lastOkAt = Date.now();
        }
      } catch (e) {
        this.lastError = e.message;
      }
    }, 5000);
    this._pollTimer.unref?.();
  }

  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  async reconnect() { return this.init(); }
}
