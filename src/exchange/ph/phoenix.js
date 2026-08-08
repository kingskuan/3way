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
import { Connection, Keypair, Transaction, TransactionInstruction, PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';

const BASE_URL = 'https://perp-api.phoenix.trade';

export class PhoenixExchange extends EventEmitter {
  constructor({ walletPrivateKey, solanaRpcUrl }) {
    super();
    this.mode = 'live';
    this.dataSource = 'connecting';
    this.lastOkAt = 0;
    this.lastError = null;
    // Round 231: 逆向找到 orders_v2 真参数 (pdaIndex/orderStatus camelCase) 后 fetchOpenOrders
    // 能真的返数组了。撤销 Round 228 的 unreliable 声明，bot 恢复正常 reconcile 通路。
    // Round 252: 回到 unreliable —— Round 232 endpoint 改成了 order-history（历史交易
    // 日志，含 cancelled/filled）而不是真的 open orders API。当 41 open 单被后续
    // recent 100 events (cancel/fill) 挤出窗口时，filter status='active' 返 0 → 哨兵
    // 报「链上41单/交易所0」假告警（QC 截图: Phoenix 网页 41 orders + 1 position 全
    // 在，QnV 本地 41 tracked = 完全同步，但告警刷屏）。跟 Perpl 一样声明 unreliable
    // 让 Round 228 的 safeChainOO=trackedOrders 兜底接管，chain==tracked 不报 drift。
    this.hasReliableOrderListing = false;
    this.balance = 0;
    this.realizedPnl = 0;
    this.orders = new Map();
    this.positions = new Map();
    this.prices = new Map();
    this.markets = new Map();
    this._marketSymbolToId = new Map();
    // Round 275v：bot 网格价格集 —— cancelAll 只撤价在这个集合里的链上单，
    // 用户手动挂在别的价的单不动。key=marketId, value=Set<price rounded to stepPrice>。
    this._botGridLevels = new Map();
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

    // Round 221: 关掉 WebSocket subscription client。@solana/web3.js 默认会连一个
    // ws endpoint 做实时 subscription（block/account/slot），Solana public RPC
    // (api.mainnet-beta.solana.com) 429 后 ws 无 catch 抛未处理 rejection kill 进程。
    // 用 wsEndpoint: 'wss://invalid' 让 ws 失败但不影响 HTTP RPC 调用。
    // 用户配 PH_SOLANA_RPC_URL 时相信他给的是能扛住的 RPC（Helius/QuickNode 等）。
    const rpcUrl = solanaRpcUrl || 'https://api.mainnet-beta.solana.com';
    this._solanaConn = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: 'wss://api.mainnet-beta.solana.com',   // 走公网 ws，但 429 时靠全局 handler 兜
      confirmTransactionInitialTimeout: 60_000,
      disableRetryOnRateLimit: false,
    });
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
    // Round 235: auth 429 backoff —— token 过期后每 poll (10s) 都触发 re-auth，
    // 每次都被 Phoenix API 429 rate-limit → 死循环刷屏 lastError。cache 上次失败时间，
    // backoff 内不重试 nonce，避免 self-inflict rate limit。
    // Round 241: 固定 60s 挡不住持续 IP rate limit（QC 部署 20+ min 每 60-90s 就再 429，
    // 26 条噪音）。改成指数退避：60→120→240→480→960→1800s（cap 30min），成功后 reset。
    if (this._authBackoffUntil && Date.now() < this._authBackoffUntil) {
      throw new Error(`Phoenix auth backoff 中（还有 ${Math.round((this._authBackoffUntil - Date.now())/1000)}s）`);
    }
    // Round 241: mutex 防并发 —— _pollFills / fetchOpenOrders / _refreshBalance 同时
    // 到期时会 race 打双份 auth 请求，log 里同秒 duplicate 429 就是这个。用 Promise
    // lock 让 concurrent caller share 一次 auth 结果。
    if (this._authInflight) {
      return this._authInflight;
    }
    this._authInflight = this._doAuth().finally(() => { this._authInflight = null; });
    return this._authInflight;
  }

  _bumpAuthBackoff(kind) {
    // Round 241: 指数退避。首次 60s，成功一次前每次翻倍到 cap 30min。
    const cur = this._authBackoffMs || 0;
    const next = cur > 0 ? Math.min(cur * 2, 1800_000) : 60_000;
    this._authBackoffMs = next;
    this._authBackoffUntil = Date.now() + next;
    // Round 242: auth 挂了 → 降级 real-readonly，让 autopilot skip 起单，
    // 避免 80 次 place-order 全被 backoff 拒 → 挂上 0/80 → 熔断循环。
    this.dataSource = 'real-readonly';
    this.lastError = `auth ${kind} 429 → backoff ${Math.round(next/1000)}s`;
    try { console.log(`[Phoenix] auth ${kind} 429 → backoff ${Math.round(next/1000)}s (指数退避防 IP rate limit) · dataSource=real-readonly`); } catch {}
  }

  async _doAuth() {
    // 1. 拿 nonce（字段是 wallet_pubkey，不是 pubkey；Round 213 直接打 API 探到）
    const nonceRes = await fetch(`${BASE_URL}/v1/auth/nonce?wallet_pubkey=${this._authorityPubkey}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!nonceRes.ok) {
      const t = await nonceRes.text();
      // 429 → 指数退避；其他错继续 throw 不 backoff
      if (nonceRes.status === 429) this._bumpAuthBackoff('nonce');
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
      if (loginRes.status === 429) this._bumpAuthBackoff('login');
      throw new Error(`Phoenix login 失败：HTTP ${loginRes.status} · ${t.slice(0, 200)}`);
    }
    const loginData = await loginRes.json();
    // Phoenix 实际返 { token_type, access_token, refresh_token, expires_in, pop_key }
    // Round 216: 探到真字段是 access_token (下划线)，之前找 token/accessToken/bearerToken
    // 全空 → 抛"响应无 token" → dataSource=real-readonly。加真字段名。
    this._authToken = loginData?.access_token || loginData?.accessToken || loginData?.token || loginData?.bearerToken;
    // expires_in 是秒（900 = 15 min），刷新前 60s 视为过期
    const expiresInSec = Number(loginData?.expires_in) || 3600;
    this._authTokenExpiresAt = Date.now() + expiresInSec * 1000;
    if (!this._authToken) throw new Error(`Phoenix login 响应无 access_token：${JSON.stringify(loginData).slice(0, 200)}`);
    // Round 241: 成功一次 → reset 指数退避计数
    this._authBackoffMs = 0;
    this._authBackoffUntil = 0;
    // Round 242: auth 恢复 → dataSource 从 real-readonly 升回 real，autopilot 恢复起单
    if (this.dataSource === 'real-readonly') {
      this.dataSource = 'real';
      this.lastError = '';
      try { console.log('[Phoenix] auth 恢复成功 · dataSource=real → autopilot 可重新起单'); } catch {}
    }
  }

  async init() {
    // 拉市场（不需 auth）
    try {
      const markets = await this._req('GET', '/v1/view/exchange/markets');
      // Round 253: 从源头过滤 Phoenix stock markets —— Round 220 只在 autopilot
      // 挑候选时过滤，但 rotate/用户手动切/persisted config 都能绕过 → 用户看
      // 到 QnV Phoenix 显示 NVDA 运行 0/32 挂上就是这样。
      // 股票 market 的 tickSize 缩放跟 API 返 K 线不一致（Round 220：API 返 $835 UI 显 $201），
      // 网格铺出去 tick 对不上全被拒。彻底不注册 = 任何路径都选不到。
      const PH_STOCK_SYMBOLS = /^(NVDA|MU|TSM|AMZN|AAPL|GOOGL|META|CRCL|COIN|ASML|CRWV|MSTR|GOLD|WTIOIL|COST|BABA|WMT|LLY|HOOD|NFLX|UBER|MELI|PLTR|IBIT|SPX|SPY|QQQ)$/i;
      if (Array.isArray(markets)) {
        // Round 275s: 按 symbol 字母序排序再分配 idx，让 marketId 跨 restart 稳定。
        // 之前按 API 返回顺序分配 → API 顺序变（新加/删除市场）→ 同一 symbol 的 idx 变
        // → bot.config.marketId 存的老 idx 找不到位置 → getPosition 返 null → UI 空仓（QC 场景：
        // 用户在 phoenix.trade 手动开 BTC short，QnV 位置卡永远 None 就是这个 root cause）。
        // 排序后 BTC 永远在同一位置（相对 crypto 集合），加/删只影响后来者，减少 marketId 漂移。
        const sortedMkts = [...markets].sort((a, b) =>
          String(a.symbol || '').localeCompare(String(b.symbol || '')));
        let idx = 1;
        let stockFiltered = 0;
        for (const m of sortedMkts) {
          if (!m.symbol) continue;
          if (m.marketStatus !== 'active') continue;
          if (PH_STOCK_SYMBOLS.test(String(m.symbol))) { stockFiltered++; continue; }
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
        if (stockFiltered > 0) {
          try { console.log(`[Phoenix] init 过滤 ${stockFiltered} 个 stock market（Round 253：tick 缩放异常，不注册防误选）`); } catch {}
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

    // Round 214c: init 立刻启 poll timer —— server.js 只调 init 不调 start
    // （对比 Ondo：init() 里就 this._startPolling()）。没这句 _pollPrices 永不跑
    // → 62 市场全 lastPrice=0，Autopilot 无法给 Phoenix 挑币。
    this.start();

    return true;
  }

  async _refreshBalance() {
    try {
      // Round 218: 探到真实 Phoenix trader state 结构：
      //   { authority, traderPdaIndex, slot, slotIndex,
      //     snapshot: {
      //       version, capabilities, subaccounts: [
      //         { subaccountIndex, sequence, collateral: "295020000", cooldownStatus }
      //       ]
      //     }
      //   }
      // collateral 是 string, USDC micro units (6 decimals) → /1e6 得 USD
      // Round 269: 先试 no-Bearer 拉 trader state —— Round 262 diagnostic 已证明这个
      //   endpoint no-Bearer 也返 200。auth 挂 backoff 时（Phoenix IP rate limit 常态）
      //   还能保持 positions/balance 缓存新鲜。否则 fetchPositions 走 needAuth=true 拉不到，
      //   本地 positions Map 保留最后一次的老数据 → Round 254 stray-check 用 stale 缓存
      //   误判「有 stray 位置」→ autopilot 每 tick 静默 skip Phoenix → 死循环。
      //   401/403 fallback Bearer；其他错误直接 throw 让 outer catch 记 lastError。
      let state;
      try {
        state = await this._req('GET', `/v1/trader/state/${this._authorityPubkey}`, null, false);
      } catch (e) {
        if (!/401|403|unauthorized/i.test(e.message)) throw e;
        state = await this._req('GET', `/v1/trader/state/${this._authorityPubkey}`, null, true);
      }
      const subs = state?.snapshot?.subaccounts;
      if (Array.isArray(subs) && subs.length > 0) {
        // 汇总所有 subaccount 的 collateral（一般只有 index=0，但保险起见 sum）
        let totalMicro = 0;
        for (const sub of subs) {
          totalMicro += Number(sub.collateral || 0);
        }
        this.balance = totalMicro / 1e6;
      }
      // Round 234: positions 藏在 snapshot.subaccounts[*].positions（不是 state.positions）
      // Field 实测：{ symbol, basePositionLots: '-6561' (string int, 有符号), entryPriceUsd: '72.97' }
      // sizeBase = basePositionLots × 10^-baseLotsDecimals (来自 market metadata)
      // 之前代码读 state.positions 恒为 undefined → this.positions 一直空 → bot 认为 position=None
      // → Autopilot 认为空仓可开新 grid → Phoenix 拒单 "cannot increase exposure"（因已有 short）
      // → 无限失败循环（用户 Telegram 收到"下单失败 508 次"根因）
      this.positions.clear();
      const subs2 = state?.snapshot?.subaccounts;
      if (Array.isArray(subs2)) {
        for (const sub of subs2) {
          const posArr = Array.isArray(sub?.positions) ? sub.positions : [];
          for (const p of posArr) {
            const symbol = p.symbol;
            const mid = this._marketSymbolToId.get(symbol);
            if (mid == null) continue;
            const m = this.markets.get(mid);
            const lotsInt = Number(p.basePositionLots || 0);
            if (!Number.isFinite(lotsInt) || lotsInt === 0) continue;
            const sizeBase = lotsInt * (m?.stepSize || 1);
            this.positions.set(mid, {
              marketId: mid,
              sizeBase,   // 有符号: 负=short 正=long
              entryPrice: Number(p.entryPriceUsd || p.entryPrice || 0),
              unrealizedPnl: 0,   // Phoenix 不直接返 uPnL，前端算：(current - entry) × sizeBase
              leverage: Number(p.leverage || 10),
            });
          }
        }
        if (this.positions.size > 0 && !this._positionsLogged) {
          this._positionsLogged = true;
          try {
            const dump = [...this.positions.entries()].map(([id, p]) => {
              const m = this.markets.get(id);
              return `${m?.displayName ?? id}: ${p.sizeBase.toFixed(3)} @ $${p.entryPrice.toFixed(2)}`;
            }).join(', ');
            console.log(`[Phoenix] positions 首次同步：${dump}`);
          } catch {}
        }
      }
    } catch (e) {
      this.lastError = `拉 trader state 失败：${e.message}`;
    }
  }

  async _signAndSubmitInstructions(instructionsData) {
    // Round 233: 80 单 seed 让 Helius RPC 内部 confirmTransaction 轮询 429 洪水
    // （3:15:21 log 20+ 条 "Server responded with 429 ... Retrying after Xms"）。
    // 序列化所有 tx submission + 500ms 间隔，让 RPC 匀速吃单不 burst。
    const chain = this._solanaSubmitChain || Promise.resolve();
    let releaseNext;
    const gate = new Promise((r) => { releaseNext = r; });
    this._solanaSubmitChain = chain.then(() => gate).catch(() => {});
    await chain.catch(() => {});
    const minGap = 500;
    const wait = Math.max(0, (this._lastSubmitAt || 0) + minGap - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await this._doSignAndSubmit(instructionsData);
    } finally {
      this._lastSubmitAt = Date.now();
      releaseNext();
    }
  }

  async _doSignAndSubmit(instructionsData) {
    // Round 219: Phoenix 实际返 [{ data: [byte...], keys: [{pubkey,isSigner,isWritable}], programId? }]
    // 不是 base64 VersionedTransaction。要 build TransactionInstruction + Transaction 手工签名。
    // place-limit-order 返 [{data,keys,programId}]
    // cancel-all-orders 返 {data,keys,programId} (直接单对象)
    // 也兼容 {instructions: [...]} 格式
    let arr;
    if (Array.isArray(instructionsData)) arr = instructionsData;
    else if (instructionsData?.instructions) arr = instructionsData.instructions;
    else if (instructionsData?.data && instructionsData?.keys) arr = [instructionsData];
    else arr = null;
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error('Phoenix 返回的 instruction 数组为空：' + JSON.stringify(instructionsData).slice(0, 200));
    }
    // 构造 legacy Transaction 一次性 submit 所有 instruction
    const tx = new Transaction();
    // Round 222c: Phoenix program 需要充足 compute budget + priority fee 避免
    // simulation "Program failed to complete"。默认 200k CU 对复杂 DeFi 不够。
    // 400k CU + 5000 microlamports priority = 前置 2 个 ComputeBudgetProgram
    // instruction，Phoenix 的 place-limit-order 应能完成 simulation。
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }));
    for (const inst of arr) {
      if (!inst.data || !Array.isArray(inst.keys)) {
        throw new Error(`Phoenix instruction 结构异常：${JSON.stringify(inst).slice(0, 200)}`);
      }
      // programId 一般在 keys 里第一个 isSigner=false isWritable=false 的 pubkey，或独立字段
      // Phoenix 返 keys 数组第 0/1 项常是 program 相关的 config，实际 programId 藏在 keys 末尾或 metadata
      // 保守：找第一个 isWritable=false 的 pubkey 作为 programId 兜底（真 programId 会在 pkg meta 中）
      const programIdStr = inst.programId || inst.program_id;
      if (!programIdStr) {
        throw new Error('Phoenix instruction 缺 programId');
      }
      tx.add(new TransactionInstruction({
        keys: inst.keys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: !!k.isSigner,
          isWritable: !!k.isWritable,
        })),
        programId: new PublicKey(programIdStr),
        data: Buffer.from(inst.data),
      }));
    }
    // 拉最新 blockhash + fee payer
    const { blockhash } = await this._solanaConn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = this._keypair.publicKey;
    tx.sign(this._keypair);
    // Submit + confirm
    const rawTx = tx.serialize();
    const sig = await this._solanaConn.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
    });
    // Round 233: confirmTransaction 内部每 500ms poll getSignatureStatuses；
    // Helius 被打爆时每 poll 都 429 → 无限 backoff 卡死 30s+。加 8s Promise.race
    // 兜底：过 8s 未 confirm 就当"已经发出"（trades-history poll 会 30-90s 内补记账），
    // 不阻塞下一单起单。sig 已经拿到、tx 也 broadcast 了，"没等到 confirm" != "失败"。
    try {
      await Promise.race([
        this._solanaConn.confirmTransaction(sig, 'confirmed'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('confirmTimeout8s')), 8000)),
      ]);
    } catch (e) {
      if (!/confirmTimeout/.test(e.message)) throw e;
      // silent: log 一条方便诊断
      try { console.log(`[Phoenix] confirmTransaction 8s 超时 sig=${sig.slice(0, 12)}… 继续（trades-history 会补记账）`); } catch {}
    }
    return [sig];
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

  /**
   * Round 275y：Phoenix lifetime volume 从 trades-history endpoint 分页汇总。
   *
   * QC 场景：用户 phoenix.trade Portfolio "Total Traded $106.23K"，QnV 只显示 $3.7K。
   * 原因 _pollFills fill event 走 Bearer + auth 挂 → 采样极稀 → stats.volume 严重低估。
   *
   * 修法：bot._syncExchangeStats 每 60s 调 getStats() 拉真实累计。这里分页遍历
   * trades-history (每页 200，最多 20 页 = 4000 fills)，dedup fillId，
   * sum |virtualQuoteLotsDelta| / 1e6 = USDC 名义值。
   *
   * 5min 缓存防 IP rate limit：page walk 每 5min 最多跑一次。缓存有效期间返老值。
   * bot._syncExchangeStats 里 Math.max 保护本地 fill event 累计，防漂移。
   */
  async getStats() {
    if (!this._authorityPubkey) return null;
    const now = Date.now();
    const cached = this._lifetimeVolCache;
    if (cached && (now - cached.at) < 5 * 60_000) {
      return { volume: cached.volume };
    }
    try {
      const seen = new Set();
      let vol = 0;
      let cursor = null;
      const MAX_PAGES = 20; // 4000 fills 顶
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ limit: '200' });
        if (cursor) params.set('cursor', cursor);
        let resp;
        try {
          resp = await this._req('GET', `/v1/trader/${this._authorityPubkey}/trades-history?${params}`, null, false);
        } catch (e) {
          if (!/401|403|unauthorized/i.test(e.message)) throw e;
          resp = await this._req('GET', `/v1/trader/${this._authorityPubkey}/trades-history?${params}`, null, true);
        }
        const arr = resp?.data;
        if (!Array.isArray(arr) || arr.length === 0) break;
        for (const f of arr) {
          const fid = String(f.fillId || `${f.slot}:${f.slotIndex}:${f.eventIndex}`);
          if (seen.has(fid)) continue;
          seen.add(fid);
          const q = Number(f.virtualQuoteLotsDelta);
          // Phoenix quote lots for USDC 是 6 位小数（micro USDC）→ /1e6 得 $
          if (Number.isFinite(q)) vol += Math.abs(q) / 1e6;
        }
        if (!resp?.hasMore || !resp?.nextCursor) break;
        cursor = resp.nextCursor;
      }
      this._lifetimeVolCache = { volume: vol, at: now };
      return { volume: vol };
    } catch (e) {
      this.lastError = `getStats: ${e.message}`;
      // 缓存有 → 返老值；否则 null 让上游保持本地累计
      return cached ? { volume: cached.volume } : null;
    }
  }

  async placeLimitOrder(o) {
    const marketId = Number(o.marketId);
    const m = this.markets.get(marketId);
    if (!m) throw new Error(`Phoenix 未知 marketId=${marketId}`);
    // Round 250 + 256: Round 250 之前 real-readonly 时静默跳过下单。但 Round 255/256
    // 后 /v1/ix/* 试跳过 Bearer 也许能通 —— 真正授权在 Solana 签名，Bearer 只是身份
    // 提示。所以 real-readonly 时还是尝试下单，让下面的 needAuth=false 走一遍看能不
    // 能通。若真的被拒 (401 fallback 也失败) 才 return skipped 让 bot 别 retry。
    const side = o.side === 'buy' ? 'Bid' : 'Ask';
    // priceInTicks = price / priceTickSize; numBaseLots = sizeBase / baseLotSize
    const priceInTicks = Math.round(Number(o.price) / m.stepPrice);
    const numBaseLots = Math.round(Number(o.sizeBase) / m.stepSize);
    if (priceInTicks <= 0 || numBaseLots <= 0) {
      throw new Error(`Phoenix 单量/价格 tick 计算异常 price=${o.price} size=${o.sizeBase}`);
    }
    // Round 219: 用 place-limit-order (cross-margin, 复用 subaccount 0 已 deposit 的 collateral)
    // 而不是 place-isolated-limit-order（后者每次要 transfer_amount 新建 isolated subaccount，
    // 每笔单一个 subaccount = 80 网格 80 个隔离账户，架构完全不适合网格）
    // 字段用全 camelCase：Round 219 探到 traderPdaIndex/priceInTicks/numBaseLots
    // Round 234：起单前防抱头 —— 已有 short/long 仓时不再加同向仓位。避免 Phoenix
    // "Unhealthy trader cannot increase exposure" 拒单后 bot 死循环重试 → 508/min alert flood。
    // return null 而不是 throw：bot.js 的 .catch 不触发 → 不 _placeFails++/不 alert/不 retry。
    // 静默跳过 = 网格半边先不铺，等 reduceOnly 平仓单先落地释放保证金。
    const existing = this.positions.get(marketId);
    if (existing && existing.sizeBase !== 0 && !o.reduceOnly) {
      const wantIncrease = (o.side === 'sell' && existing.sizeBase < 0)
                       || (o.side === 'buy' && existing.sizeBase > 0);
      if (wantIncrease) {
        // 首次跳过 log 一次做诊断，之后静默
        if (!this._skipLoggedFor) this._skipLoggedFor = new Set();
        const key = `${marketId}:${o.side}`;
        if (!this._skipLoggedFor.has(key)) {
          this._skipLoggedFor.add(key);
          try { console.log(`[Phoenix] 跳过 ${o.side} ${m.displayName}：已持 ${existing.sizeBase.toFixed(3)} 同向仓位（防 Unhealthy trader 拒单）`); } catch {}
        }
        return { orderId: null, skipped: true };
      }
    }
    const body = {
      authority: this._authorityPubkey,
      traderPdaIndex: 0,
      side,
      symbol: m.displayName,
      priceInTicks,
      numBaseLots,
    };
    // Round 256: 试跳过 Bearer auth，同 Round 255 cancel-order 一样思路 ——
    // /v1/ix/* 只是 build 未签名 Solana instructions，真正授权在 Solana 签名。
    // Phoenix auth API 一直 429 rate_limited 时唯一救命路径。若无 Bearer 401，
    // 再 fallback 到需 Bearer 路径；若 Bearer 也没（backoff 中）就返 skipped 让
    // bot 不 retry 不 alert（同 Round 250 的静默 skip）。
    let instructionsData;
    const isRateOrAuth = (msg) => /401|403|unauthorized|rate_limited|429|backoff/i.test(msg);
    try {
      instructionsData = await this._req('POST', '/v1/ix/place-limit-order', body, false);
    } catch (e) {
      // Round 264: 之前只 catch 401/403 走 Bearer fallback，其他 (rate_limited/429/500) 直接
      // throw 到 bot.js → 80 单 seed 全打 alert + retry。Phoenix 实际返 "rate_limited" 是
      // IP 级 rate limit（非 auth），Bearer fallback 帮不了。改成：401/403/rate 都试 Bearer；
      // 若 Bearer 也挂就静默 skip 让 bot 别 retry 别 alert。避免 80 单 seed 生成 80 条
      // "下单失败 rate_limited" 刷屏 + reconcile 重试雪崩。
      if (!isRateOrAuth(e.message)) throw e;
      try {
        instructionsData = await this._req('POST', '/v1/ix/place-limit-order', body, true);
      } catch (e2) {
        if (isRateOrAuth(e2.message)) {
          if (!this._authSkipLogged || Date.now() - this._authSkipLogged > 300_000) {
            this._authSkipLogged = Date.now();
            try { console.log(`[Phoenix] placeLimitOrder 跳过：IP rate limit / auth backoff 中 (${e2.message.slice(0, 100)})，等窗口过再补单`); } catch {}
          }
          return { orderId: null, skipped: true };
        }
        throw e2;
      }
    }
    const sigs = await this._signAndSubmitInstructions(instructionsData);
    // Round 259: Solana signature ≠ Phoenix orderSequenceNumber (fetchOpenOrders
    // 里的 orderId)。之前 return sig 作 orderId → bot.active 存 sig 但 reconcile
    // 拉 orderSequenceNumber → 永远 mismatch → chain N 单 vs bot 0 tracked。
    // 用户 QC 截图: Phoenix chain 41 单 + QnV 显示 0/32 = 就是这个。
    //
    // 修：返 orderId=null (deferred) —— bot 认为「place 已提交但 orderId 未知」，
    // 不添加 stale entry 到 active。Reconcile 拉 chain 时会用真的 orderSequenceNumber
    // adopt。levelIndex 判重靠下一次 reconcile 补上，Round 259 comment 提醒。
    // orders 内部 map 保留（用 sig 做临时 key）便于 debug，不影响 bot.active 判重。
    const sig = sigs[0] || ('ph-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    this.orders.set(sig, {
      orderId: sig, marketId, side: o.side,
      price: Number(o.price), sizeBase: Number(o.sizeBase),
      levelIndex: o.levelIndex, clientOrderId: o.clientOrderId,
      reduceOnly: !!o.reduceOnly,
      solanaSig: sig,   // 显式标注是 sig 不是真 orderId
    });
    return { orderId: null, deferred: true };
  }

  async cancelOrder(marketId, orderId) {
    // Round 219: Phoenix cancel-order 需要 orders 数组（可批量）+ traderPdaIndex
    const m = this.markets.get(Number(marketId));
    if (!m) return true;
    const body = {
      authority: this._authorityPubkey,
      traderPdaIndex: 0,
      symbol: m.displayName,
      orders: [String(orderId)],
    };
    try {
      // Round 255: 试跳过 Bearer auth —— /v1/ix/* 只是返未签名 Solana instructions，
      // 真正授权靠钱包签名。auth 挂时也能撤单。若 endpoint 强制 Bearer 会 401 → fallback。
      let instructionsData;
      try {
        instructionsData = await this._req('POST', '/v1/ix/cancel-order', body, false);
      } catch (e) {
        if (!/401|403|unauthorized/i.test(e.message)) throw e;
        instructionsData = await this._req('POST', '/v1/ix/cancel-order', body, true);
      }
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

  // Round 275v：让 bot 告诉 adapter 当前 grid 的价格集，cancelAll 用它 filter。
  // 保护用户在 phoenix.trade 手动挂的、价格不在 bot grid 里的单（QC 场景：
  // 用户 short BTC + 挂 9 保护单 → bot 起停 → 老 cancelAll blanket → 9 单一起没了）。
  // levels: number[] （bot.grid.levels）。marketId: 当前 bot 跑的市场。
  setActiveGridLevels(marketId, levels) {
    const mid = Number(marketId);
    if (!Array.isArray(levels)) { this._botGridLevels.delete(mid); return; }
    const m = this.markets.get(mid);
    const tick = m?.stepPrice || 0.01;
    const set = new Set();
    for (const p of levels) {
      const n = Number(p);
      if (!Number.isFinite(n)) continue;
      // round-to-tick 让链上 order price（也是 tick 对齐）能命中
      const snapped = Math.round(n / tick) * tick;
      set.add(snapped.toFixed(8));
    }
    this._botGridLevels.set(mid, set);
  }

  async cancelAll(marketId) {
    const m = this.markets.get(Number(marketId));
    if (!m) return true;
    const mid = Number(marketId);
    // Round 275v：撤销 Round 219+249 的 blanket /v1/ix/cancel-all-orders 路径。
    // 老路径无差别撤链上该 market 所有单 —— 用户手动挂的保护单会被一并清掉
    // （QC 场景实测：Railway 部署完 4 分钟内 bot 起停 3 次，每次 cancelAll blanket
    // → 用户 phoenix.trade 上手动挂的 9 单全清了 → 用户短仓裸持）。
    //
    // 新逻辑：
    //   1. 若 setActiveGridLevels 从没设过（老版 bot 或 grid 未 build），什么都不做，
    //      返 true。不敢误撤 → 用户手动去 phoenix.trade 清。
    //   2. 若有 grid 集合，fetchOpenOrders 拿链上真单 (含真 orderSequenceNumber + price)，
    //      只撤价格在 grid 集合里的。用户在其他价的单一律不动。
    const gridSet = this._botGridLevels.get(mid);
    if (!gridSet || gridSet.size === 0) {
      try { console.log(`[Phoenix] cancelAll(mid=${mid}) skip — 没有 bot grid 价格集（防误撤用户手动单）`); } catch {}
      return true;
    }
    const tick = m.stepPrice || 0.01;
    const priceKey = (p) => (Math.round(Number(p) / tick) * tick).toFixed(8);
    let real;
    try { real = await this.fetchOpenOrders(mid); }
    catch (e) { throw new Error(`cancelAll: 拉 open orders 失败 ${e.message}`); }
    if (!Array.isArray(real) || real.length === 0) return true;
    let botCount = 0, userCount = 0, cancelledAny = false, lastErr = null;
    for (const o of real) {
      if (gridSet.has(priceKey(o.price))) {
        botCount++;
        try {
          await this.cancelOrder(mid, o.orderId);
          cancelledAny = true;
        } catch (e) { lastErr = e; }
      } else {
        userCount++;
      }
    }
    try { console.log(`[Phoenix] cancelAll(mid=${mid}) 撤 ${botCount} 单 bot 网格价，跳过 ${userCount} 单用户价（保护手动挂单）`); } catch {}
    if (botCount > 0 && !cancelledAny && lastErr) throw lastErr;
    return true;
  }

  async fetchOpenOrders(_marketId) {
    // Round 232：Round 231 用 plural /v1/traders/{wallet}/orders_v2 被 API 拒 "Trader not found"
    // —— plural URL 的 pk 是 trader PDA，我们只有 wallet。改用 singular endpoint
    // /v1/trader/{wallet}/order-history 直接吃 wallet + unauth 就通。
    // 响应字段：{ orderSequenceNumber, marketSymbol, status ('open'|'cancelled'|'filled'|...),
    //             side ('bid'|'ask'), price, baseQty, remainingBaseQty, ... }
    // status 过滤客户端做（服务端 orderStatus 参数没生效）。
    if (!this._authorityPubkey) return null;
    // Round 246 → Round 269: 之前 auth 挂了（real-readonly）直接返 null。但 Round 262
    // diagnostic 证明 order-history 端点 no-Bearer 也返 200 —— 应该照样能拉到 chain 真实
    // orders 让 Round 254 stray-check + bot reconcile 用正确数据。撤销 Round 246 早退。
    const LIMIT = 100;
    try {
      let resp;
      try {
        resp = await this._req('GET', `/v1/trader/${this._authorityPubkey}/order-history?limit=${LIMIT}`, null, false);
      } catch (e) {
        if (!/401|403|unauthorized/i.test(e.message)) throw e;
        resp = await this._req('GET', `/v1/trader/${this._authorityPubkey}/order-history?limit=${LIMIT}`, null, true);
      }
      const arr = Array.isArray(resp) ? resp : (Array.isArray(resp?.data) ? resp.data : null);
      if (!arr) return null;
      // Round 239: Phoenix 真实 API 用 'active' 不是 'open'（Round 232 猜错了）。
      // 实测响应 status 有：active（等 fill），cancelled，filled。改成 whitelist 多个"open-like"状态。
      const OPEN_STATES = new Set(['open', 'active', 'new', 'placed', 'accepted']);
      const open = arr.filter((o) => OPEN_STATES.has(String(o.status || '').toLowerCase()));
      if (!this._ordersLogged) {
        this._ordersLogged = true;
        try { console.log(`[Phoenix] order-history 返 ${arr.length} 单，其中 open ${open.length} 单 (sample: ${JSON.stringify(arr[0] || {}).slice(0, 250)})`); } catch {}
      }
      // Round 246: 分页边界 heuristic —— arr 塞满 limit 但 open 大量减少 (< 3)，
      // 极大概率是老 open 单被挤出 100 窗口，不是真的被撤/成交。返 null 而不是 []
      // 让 Round 228 fallback 用 tracked 数量替代，避免哨兵 false drift alert。
      if (arr.length >= LIMIT && open.length < 3 && (this._lastOpenCount || 0) >= 10) {
        try { console.log(`[Phoenix] order-history hit limit=${LIMIT} 但 open=${open.length} << lastKnown=${this._lastOpenCount}，视为分页盲区返 null`); } catch {}
        return null;
      }
      this._lastOpenCount = open.length;
      return open.map((o) => ({
        orderId: String(o.orderSequenceNumber ?? o.orderId ?? o.id ?? ''),
        price: Number(o.price),
        side: (o.side === 'bid' || o.side === 'Bid' || o.side === 'buy') ? 'buy' : 'sell',
      })).filter((x) => x.orderId);
    } catch (e) {
      this.lastError = `fetchOpenOrders: ${e.message}`;
      return null;
    }
  }

  async fetchPositions() {
    // Round 234: positions 在 snapshot.subaccounts[*].positions 不是 state.positions（同 _refreshBalance 同 bug）
    // Round 269: 同 _refreshBalance —— no-Bearer 优先，401/403 fallback。
    if (!this._authorityPubkey) return [];
    try {
      let state;
      try {
        state = await this._req('GET', `/v1/trader/state/${this._authorityPubkey}`, null, false);
      } catch (e) {
        if (!/401|403|unauthorized/i.test(e.message)) throw e;
        state = await this._req('GET', `/v1/trader/state/${this._authorityPubkey}`, null, true);
      }
      const subs = state?.snapshot?.subaccounts;
      if (!Array.isArray(subs)) return [];
      const out = [];
      for (const sub of subs) {
        const posArr = Array.isArray(sub?.positions) ? sub.positions : [];
        for (const p of posArr) {
          const lots = Number(p.basePositionLots || 0);
          if (lots === 0) continue;
          out.push(p);
        }
      }
      return out;
    } catch (e) {
      this.lastError = e.message;
      return [];
    }
  }

  getOpenOrders(marketId) {
    const marketIdN = Number(marketId);
    const direct = [...this.orders.values()].filter((o) => o.marketId === marketIdN);
    if (direct.length > 0) return direct;
    // Round 275s: bot.config.marketId 可能是老 idx（Phoenix 重启后 idx 漂移）→ 直接
    // 匹配返 0 单。若请求的 mid 在当前 markets 里不存在 (=stale id)，把所有 orders 都
    // 视作是 bot 挂的（Phoenix grid 只跑单市场）。让 emergency-cleanup / UI 挂单数正确。
    if (!this.markets.has(marketIdN)) {
      return [...this.orders.values()];
    }
    return [];
  }

  getPosition(marketId) {
    const mid = Number(marketId);
    const direct = this.positions.get(mid);
    if (direct) return direct;
    // Round 275s: 老 config marketId 找不到 → 若 positions 只有 1 条且请求 mid 在
    // 当前 markets 不存在 (=stale id 漂移)，就是它。Phoenix grid 单市场，1 条位置即 bot 的。
    // 修 QC 场景：用户 phoenix.trade 开 BTC short，adapter 正确存 mid=8，
    // 但 bot.config.marketId=21 (老 idx) → 直接 get(21) 返 null → UI 显示空仓，实际链上有。
    if (this.positions.size === 1 && !this.markets.has(mid)) {
      return [...this.positions.values()][0];
    }
    return null;
  }

  // Round 275s: symbol-first 查询接口，让 bot.getState()/autopilot stray-check 能绕开
  // marketId 漂移问题。symbol 是全局稳定的（BTC 永远是 BTC）。
  getPositionBySymbol(symbol) {
    if (!symbol) return null;
    const mid = this._marketSymbolToId.get(String(symbol));
    if (mid != null) return this.positions.get(mid) || null;
    return null;
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

  /** Round 262: 诊断快照。UI「🔍 诊断 Phoenix 挂单」按钮调 /api/ph/debug 落到这里。
   *  之前 Phoenix 没实现 getDebugSnapshot → 按钮返 { info: '该适配器未实现…'} 用户点了没反应。
   *  Phoenix 的痛点特殊：auth 挂 backoff 时读也读不到，得让用户直接看到 auth 状态 +
   *  各 endpoint 的 raw 响应，才能判断 Round 260 no-Bearer 路径能不能跑。 */
  async getDebugSnapshot() {
    const now = Date.now();
    const out = {
      dataSource: this.dataSource,
      lastError: this.lastError,
      lastOkAt: this.lastOkAt ? new Date(this.lastOkAt).toISOString() : null,
      lastOkAgeSec: this.lastOkAt ? Math.round((now - this.lastOkAt) / 1000) : null,
      auth: {
        hasToken: !!this._authToken,
        tokenExpiresInSec: this._authTokenExpiresAt
          ? Math.round((this._authTokenExpiresAt - now) / 1000) : null,
        backoffMs: this._authBackoffMs || 0,
        backoffRemainingSec: this._authBackoffUntil
          ? Math.max(0, Math.round((this._authBackoffUntil - now) / 1000)) : 0,
        inflight: !!this._authInflight,
        wallet: this._authorityPubkey
          ? this._authorityPubkey.slice(0, 8) + '...' + this._authorityPubkey.slice(-6) : null,
      },
      localBalance: this.balance,
      localMarkets: this.markets.size,
      localOrders: this.orders.size,
      localOrdersSample: [...this.orders.values()].slice(0, 3),
      localPositions: this.positions.size,
      localPositionsSample: [...this.positions.values()].slice(0, 3),
    };
    if (!this._authorityPubkey) return out;

    // Probe：Bearer 需要 + no-Bearer 两条路径都试。看用户就知道 Round 260 能否 work：
    // no-Bearer 若都 200 → real-readonly 起单有戏；若都被拒 → IP 级 rate limit 硬挡。
    const wallet = this._authorityPubkey;
    const paths = [
      { path: `/v1/trader/${wallet}/order-history?limit=100`, label: 'order-history (open orders 来源)' },
      { path: `/v1/trader/state/${wallet}`, label: 'trader/state (positions + balance 来源)' },
      { path: `/v1/trader/${wallet}/trades-history?limit=5`, label: 'trades-history (fills 来源)' },
    ];
    out.probes = {};
    for (const { path, label } of paths) {
      const noAuthKey = `${path} · no-Bearer`;
      const authKey = `${path} · Bearer`;
      out.probes[noAuthKey] = await this._probeOne(path, false, label);
      out.probes[authKey] = await this._probeOne(path, true, label);
    }

    // 用 fetchOpenOrders 走真实解析逻辑（含 Round 246 real-readonly guard），
    // 看用户就知道 bot 侧读到的是啥
    try {
      const parsed = await this.fetchOpenOrders(0);
      out.fetchOpenOrdersResult = parsed === null
        ? 'null (real-readonly guard / API 挂 / 分页盲区)'
        : `${parsed.length} orders`;
    } catch (e) { out.fetchOpenOrdersError = e?.message || String(e); }

    return out;
  }

  async _probeOne(path, needAuth, label) {
    try {
      const j = await this._req('GET', path, null, needAuth);
      const body = JSON.stringify(j);
      const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : null);
      return {
        ok: true,
        label,
        preview: body.slice(0, 400),
        dataLen: arr ? arr.length : null,
        topKeys: (j && typeof j === 'object' && !Array.isArray(j)) ? Object.keys(j).slice(0, 12) : null,
      };
    } catch (e) {
      return { ok: false, label, error: String(e?.message || e).slice(0, 250) };
    }
  }

  // Round 232：Round 231 用 /v1/traders/{pk}/trades_v2 结果 API 返 "Trader not found"
  // — 因为 plural traders/{pk} 的 pk 是 trader PDA，不是 wallet。web app 用
  // /v1/trader/{wallet}/trades-history（singular）也 work 且直接用 wallet + unauth 就通。
  // 响应字段实测：
  //   { fillId, marketSymbol, price, baseLotsDelta (signed, base units),
  //     virtualQuoteLotsDelta (quote $), timestamp, fees, ... }
  // baseLotsDelta 负=卖出/开空，正=买入/平空。size = |baseLotsDelta|。
  async _pollFills() {
    if (!this._authorityPubkey) return;
    let resp;
    try {
      // Round 275y: 从 Bearer 改成 no-Bearer 优先。QC 场景实证：Phoenix 官网
      // Lifetime Traded $106K，QnV 只累计 $3.7K = 3.5%。原因 _pollFills 走 Bearer
      // 但 auth API 大多时候 IP 级 429 rate_limited → fills 采样极稀。Round 262
      // diagnostic 已证 no-Bearer /v1/trader/{wallet}/trades-history 返 200，跟
      // trader/state (Round 269) 同 pattern。limit 50→200 尽量多回填。
      // 401/403 fallback Bearer 保留兼容。
      try {
        resp = await this._req(
          'GET',
          `/v1/trader/${this._authorityPubkey}/trades-history?limit=200`,
          null,
          false,
        );
      } catch (e) {
        if (!/401|403|unauthorized/i.test(e.message)) throw e;
        resp = await this._req(
          'GET',
          `/v1/trader/${this._authorityPubkey}/trades-history?limit=200`,
          null,
          true,
        );
      }
    } catch (e) { this.lastError = `pollFills: ${e.message}`; return; }
    const arr = Array.isArray(resp) ? resp : (Array.isArray(resp?.data) ? resp.data : null);
    if (!arr) return;
    const isFirst = !this._knownFillIds;
    this._knownFillIds = this._knownFillIds || new Set();
    if (isFirst) {
      try { console.log(`[Phoenix] trades-history 首次 poll ${arr.length} 条历史 fill，seed dedup set 不 emit${arr.length > 0 ? ` (sample: ${JSON.stringify(arr[0]).slice(0, 400)})` : ''}`); } catch {}
    }
    let emitted = 0;
    for (const f of arr) {
      const fid = String(f.fillId ?? f.signature ?? `${f.slot}:${f.slotIndex}:${f.eventIndex}`);
      if (!fid || fid === 'undefined:undefined:undefined') continue;
      if (this._knownFillIds.has(fid)) continue;
      this._knownFillIds.add(fid);
      if (isFirst) continue;
      const symbol = f.marketSymbol;
      const marketId = this._marketSymbolToId.get(symbol);
      if (!marketId) continue;
      const price = Number(f.price);
      const baseDelta = Number(f.baseLotsDelta);
      const size = Math.abs(baseDelta);
      if (!(price > 0 && size > 0)) continue;
      const side = baseDelta > 0 ? 'buy' : 'sell';
      this.emit('fill', {
        marketId, side, price, sizeBase: size,
        orderId: String(f.orderSequenceNumber ?? fid),
        clientOrderId: '',
        levelIndex: undefined,
      });
      emitted++;
    }
    if (emitted > 0) {
      try { console.log(`[Phoenix] trades-history emit ${emitted} 新 fill`); } catch {}
    }
    if (this._knownFillIds.size > 500) {
      this._knownFillIds = new Set([...this._knownFillIds].slice(-250));
    }
  }

  start() {
    if (this._pollTimer) return;
    // 首次立刻拉一批 top 市场价格（BTC/ETH/SOL 优先）
    this._pollPrices().catch(() => {});
    this._pollTimer = setInterval(async () => {
      try {
        await this._pollPrices();
        this.lastOkAt = Date.now();
        // 每 30 次 poll (300s = 5min) 刷 balance/positions，每 9 次 poll 拉 fills（90s）
        if (!this._pollCount) this._pollCount = 0;
        this._pollCount++;
        // Round 275s: 撤除 && this._authToken 门禁 —— Round 269 后 _refreshBalance
        // 优先走 no-Bearer 路径（/v1/trader/state 端点 unauth 就通），不需要 token。
        // 老门禁让 auth backoff 中 balance/positions 永远不刷 → 用户手动开仓 QnV 看不到。
        //
        // Round 275x: 30s→300s (5min)。Round 275s 撤门禁后 30s 一次 no-Bearer
        // 拉 /v1/trader/state 打 IP 级 rate limit 429，positions Map 永远拉不
        // 到 → autopilot 275v 看不到位置 → 起单刷屏。5min 一次给 rate window 恢复时间。
        // trade off：手动开仓/平仓后 QnV 位置卡最多滞后 5min 才更新，可接受。
        if (this._pollCount % 30 === 0) {
          await this._refreshBalance();
        }
        // Round 233: fills poll 30s → 90s 缓解 Phoenix API rate_limited 429
        if (this._pollCount % 9 === 0) {
          await this._pollFills().catch((e) => { this.lastError = `pollFills: ${e.message}`; });
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
        // Round 222a: 前端 chart 期望 c.time 字段（ms）—— 其他 8 家都返 time。
        // Round 213 用 t 导致前端 Invalid Date 崩。同时 keep t 兼容 analyzeTrend。
        time: Number(b.time),
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
