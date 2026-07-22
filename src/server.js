// 多 DEX 整合服务器
// 路由规则：
//   /api/de/*  → Decibel
//   /api/ex/*  → Extended
//   /api/rs/*  → RISEx
//   /api/on/*  → Ondo Perps
//   /api/pl/*  → perpl.xyz
//   /api/sx/*  → StandX
//   /api/bg/*  → Bitget（Round 82，paper only）
//   /api/bu/*  → Bitunix（Round 127，LIVE）
//   /api/overview → 全所总览（余额+盈亏）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from './config.js';
import { createExchange as createDeExchange } from './exchange/de/index.js';
import { createExchange as createExExchange } from './exchange/ex/index.js';
import { createExchange as createRsExchange } from './exchange/rs/index.js';
import { createExchange as createOnExchange } from './exchange/on/index.js';
import { createExchange as createPlExchange } from './exchange/pl/index.js';
import { createExchange as createSxExchange } from './exchange/sx/index.js';
import { createExchange as createBgExchange } from './exchange/bg/index.js';
import { createExchange as createBuExchange } from './exchange/bu/index.js';
import { GridBot } from './bot.js';
import { analyzeTrend } from './trend.js';
import { setupProxies, checkProxy } from './proxy.js';
import { loadSnapshot, saveSnapshot } from './persist.js';
import { createAiService } from './ai/service.js';
import { createAutopilot } from './ai/autopilot.js';
import { createPets } from './pets.js';

// ── 启动配置 ─────────────────────────────────────────────────────────────────
const cfg = getConfig();

// ── 云端部署强制口令保护 ──────────────────────────────────────────────────────
// 一旦监听 0.0.0.0（即 Railway/Docker/公网暴露），必须设置 DASHBOARD_PASSWORD，
// 否则任何人拿到 URL 就能启停实盘、改 .env、看你的资金。守门必须严。
if ((cfg.host === '0.0.0.0' || cfg.isCloud) && !cfg.dashboardPassword) {
  console.error('\n[启动失败] 检测到公网/容器部署（HOST=0.0.0.0），但未设置 DASHBOARD_PASSWORD。');
  console.error('  仪表盘可以启停实盘交易、改 AI/代理配置，绝不能裸奔上公网。');
  console.error('  解决办法：在 Railway 项目变量里加 DASHBOARD_PASSWORD=<一个强口令>');
  console.error('  （可选 DASHBOARD_USER，默认 admin），保存后重新部署。\n');
  process.exit(1);
}

// ── 实盘凭据预检查：缺什么直接列出来，不甩堆栈吓人 ─────────────────────────────
{
  const missing = [];
  if (cfg.de.mode === 'live') {
    if (!cfg.de.apiKey) missing.push(['Decibel ', 'DECIBEL_API_KEY', '在 geomi.dev 免费创建']);
    if (!cfg.de.privateKey) missing.push(['Decibel ', 'DECIBEL_PRIVATE_KEY', '在 app.decibel.trade/api 创建 API 钱包']);
  }
  if (cfg.ex.mode === 'live') {
    if (!cfg.ex.apiKey) missing.push(['Extended', 'EXTENDED_API_KEY', 'app.extended.exchange → API Management']);
    if (!cfg.ex.vault) missing.push(['Extended', 'EXTENDED_VAULT', '同上，创建 API Key 时一并显示']);
    if (!cfg.ex.starkPrivateKey) missing.push(['Extended', 'EXTENDED_STARK_PRIVATE_KEY', '同上，只显示一次务必保存']);
  }
  if (cfg.rs.mode === 'live') {
    if (!cfg.rs.account) missing.push(['RISEx   ', 'ACCOUNT_ADDRESS', 'RISEx 应用的账户 / API 设置']);
    if (!cfg.rs.signerKey) missing.push(['RISEx   ', 'SIGNER_PRIVATE_KEY', 'RISEx 应用的账户 / API 设置']);
  }
  if (cfg.on.mode === 'live') {
    if (!cfg.on.apiKeyId) missing.push(['Ondo    ', 'ONDO_API_KEY_ID', 'app.ondoperps.xyz → Profile → API Keys → Add New']);
    if (!cfg.on.apiSecret) missing.push(['Ondo    ', 'ONDO_API_SECRET', '同上（只显示一次，务必当场保存）']);
  }
  if (cfg.pl.mode === 'live') {
    if (!cfg.pl.apiKey) missing.push(['perpl   ', 'PERPL_API_KEY', 'app.perpl.xyz/apikeys → 创建 API Key']);
    if (!cfg.pl.privateKey) missing.push(['perpl   ', 'PERPL_PRIVATE_KEY', '同上（Ed25519 私钥，只显示一次）']);
  }
  if (cfg.bg.mode === 'live') {
    if (!cfg.bg.apiKey) missing.push(['Bitget  ', 'BG_API_KEY', 'bitget.com → API Management → Create API']);
    if (!cfg.bg.secretKey) missing.push(['Bitget  ', 'BG_SECRET_KEY', '同上（创建时一并显示）']);
    if (!cfg.bg.passphrase) missing.push(['Bitget  ', 'BG_PASSPHRASE', '同上（自己设的口令，创建时和 secret 一起给）']);
  }
  if (cfg.bu.mode === 'live') {
    if (!cfg.bu.apiKey) missing.push(['Bitunix ', 'BU_API_KEY', 'bitunix.com → API Management → Create API']);
    if (!cfg.bu.apiSecret) missing.push(['Bitunix ', 'BU_API_SECRET', '同上（创建时一并显示，只显示一次务必保存）']);
  }
  if (missing.length) {
    console.error('\n[启动失败] 有交易所被设为 live 实盘模式，但 .env 里还缺以下凭据：\n');
    for (const [ex, key, where] of missing) {
      console.error(`  ${ex}  缺 ${key}`);
      console.error(`            获取方式：${where}`);
    }
    console.error('\n解决办法（二选一）：');
    console.error('  1. 用记事本打开项目里的 .env，补齐上面列出的字段');
    console.error('     （详细获取教程见 README.md 第七节）');
    console.error('  2. 暂时不实盘：把 .env 里对应的 DE_MODE / EX_MODE / RS_MODE 改回 paper\n');
    process.exit(1);
  }
}

// ── 代理设置 ─────────────────────────────────────────────────────────────────
const proxyResult = await setupProxies(cfg);
if (proxyResult.used) {
  console.log('[代理] 已启用: ' + proxyResult.used);
  console.log('[代理检测] 正在验证代理可用性...');
  const chk = await checkProxy();
  if (chk.ok) {
    console.log('[代理检测] ✓ 代理正常，当前出口 IP: ' + chk.ip);
  } else {
    console.error('[代理检测] ✗ 代理无法联网：' + chk.error);
    const hasLive = ['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', 'bu'].some((k) => cfg[k].mode === 'live');
    if (hasLive) {
      console.error('  实盘模式已中止启动，以免在断网状态下运行造成挂单失控。');
      process.exit(1);
    } else {
      console.error('  模拟模式将继续运行，但可能拿不到真实行情。');
    }
  }
} else {
  console.log('[代理] 未配置（直连模式）');
}

// ── 创建所有 DEX 和机器人 ─────────────────────────────────────────────────────
const deExchange = createDeExchange(cfg.de);
const exExchange = createExExchange(cfg.ex);
const rsExchange = createRsExchange(cfg.rs);
const onExchange = createOnExchange(cfg.on);
const plExchange = createPlExchange(cfg.pl);
const sxExchange = createSxExchange(cfg.sx);
const bgExchange = createBgExchange(cfg.bg);
const buExchange = createBuExchange(cfg.bu);

const deBot = new GridBot(deExchange, { onChange: (s) => saveSnapshot('de', s) });
const exBot = new GridBot(exExchange, { onChange: (s) => saveSnapshot('ex', s) });
const rsBot = new GridBot(rsExchange, { onChange: (s) => saveSnapshot('rs', s) });
const onBot = new GridBot(onExchange, { onChange: (s) => saveSnapshot('on', s) });
const plBot = new GridBot(plExchange, { onChange: (s) => saveSnapshot('pl', s) });
const sxBot = new GridBot(sxExchange, { onChange: (s) => saveSnapshot('sx', s) });
const bgBot = new GridBot(bgExchange, { onChange: (s) => saveSnapshot('bg', s) });
const buBot = new GridBot(buExchange, { onChange: (s) => saveSnapshot('bu', s) });

// Restore cumulative stats / config from the previous run (display continuity).
// Trading does NOT auto-resume; stray-order cleanup happens after each exchange
// finishes init (see below).
deBot.restore(loadSnapshot('de'));
exBot.restore(loadSnapshot('ex'));
rsBot.restore(loadSnapshot('rs'));
onBot.restore(loadSnapshot('on'));
plBot.restore(loadSnapshot('pl'));
sxBot.restore(loadSnapshot('sx'));
bgBot.restore(loadSnapshot('bg'));
buBot.restore(loadSnapshot('bu'));

// Belt-and-suspenders: ensure every exchange always has an 'error' listener so a
// stray emit can never crash the process (the GridBot also attaches one).
for (const ex of [deExchange, exExchange, rsExchange, onExchange, plExchange, sxExchange, bgExchange, buExchange]) {
  ex.on('error', (e) => { try { console.error('[DEX 错误] ' + (e?.message || e)); } catch {} });
}

// ── AI 服务（哨兵/日报/分析/对话/出区间建议）────────────────────────────────
const aiService = createAiService({
  bots: { de: deBot, ex: exBot, rs: rsBot, on: onBot, pl: plBot, sx: sxBot, bg: bgBot, bu: buBot },
  exchanges: { de: deExchange, ex: exExchange, rs: rsExchange, on: onExchange, pl: plExchange, sx: sxExchange, bg: bgExchange, bu: buExchange },
});
aiService.start();

// ── AI Autopilot（无脑一键：AI 自动选币 + 起网格 + 熔断护栏 + Telegram 复盘）
const autopilot = createAutopilot({
  bots: { de: deBot, ex: exBot, rs: rsBot, on: onBot, pl: plBot, sx: sxBot, bg: bgBot, bu: buBot },
  exchanges: { de: deExchange, ex: exExchange, rs: rsExchange, on: onExchange, pl: plExchange, sx: sxExchange, bg: bgExchange, bu: buExchange },
});
autopilot.start();

// ── 宠物系统（每家 DEX 一只宠物，交易量累积成养料，6 阶进化）
const pets = createPets({ bots: { de: deBot, ex: exBot, rs: rsBot, on: onBot, pl: plBot, sx: sxBot, bg: bgBot, bu: buBot } });
pets.start();

// SSE 客户端集合（按 DEX 分组）
const deClients = new Set();
const exClients = new Set();
const rsClients = new Set();
const onClients = new Set();
const plClients = new Set();
const sxClients = new Set();
const bgClients = new Set();
const buClients = new Set();

// ── 工具函数 ──────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function send(res, code, obj) {
  const body = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve) => {
    let b = '', n = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > maxBytes) { done = true; try { req.destroy(); } catch { /* ignore */ } resolve({}); return; }
      b += c;
    });
    req.on('end', () => { if (done) return; done = true; try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// ── 交易所路由处理器工厂 ───────────────────────────────────────────────────────
function makeExchangeHandler(prefix, bot, exchange, exCfg, clients, name) {
  return async (req, res, subPath, url) => {
    if (subPath === '/markets') {
      return send(res, 200, {
        exchange: name,
        mode: exCfg.mode,
        dataSource: exchange.dataSource || (exCfg.mode === 'live' ? 'real' : 'synthetic'),
        network: exchange.network || exCfg.network,
        apiUrl: exchange.apiUrl || exCfg.apiUrl,
        markets: await exchange.getMarkets(),
      });
    }

    if (subPath === '/trend') {
      const marketId = Number(url.searchParams.get('marketId') || 1);
      const intervalSec = Number(url.searchParams.get('intervalSec') || 3600);
      let candles = [];
      try { candles = await exchange.getCandles(marketId, intervalSec, 200); } catch { /* tolerate */ }
      let price = null;
      try { price = await exchange.getPrice(marketId); } catch {}
      const analysis = (candles && candles.length >= 20)
        ? analyzeTrend(candles)
        : {
            trend: 'range', recommended: 'neutral', strength: 0, atrPct: null, price,
            detail: '暂时拿不到足够K线数据，已默认中性网格。可手动设置上下边界后启动；不影响下单。',
          };
      return send(res, 200, { analysis, candles: (candles || []).slice(-120) });
    }

    if (subPath === '/state') return send(res, 200, bot.getState());

    if (subPath === '/start' && req.method === 'POST') {
      try { return send(res, 200, await bot.start(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stop' && req.method === 'POST') {
      try { return send(res, 200, await bot.stop(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/adjust' && req.method === 'POST') {
      try { return send(res, 200, await bot.adjustRange(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/reset' && req.method === 'POST') {
      try { return send(res, 200, await bot.resetStats()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/cancel-orders' && req.method === 'POST') {
      try { return send(res, 200, await bot.cancelAllOrders()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    // 诊断接口：返回适配器的 raw REST 响应快照（供人工核对 API 字段名）。
    // 只有实现了 getDebugSnapshot 的适配器才有内容。
    if (subPath === '/debug' && req.method === 'GET') {
      try {
        if (typeof exchange.getDebugSnapshot !== 'function') {
          return send(res, 200, { info: '该适配器未实现 getDebugSnapshot' });
        }
        return send(res, 200, await exchange.getDebugSnapshot());
      } catch (e) { return send(res, 500, { error: e.message }); }
    }

    // Round 92-95: 强制同步 exchange 侧状态
    // Round 98：加 stepCounts 逐步 snapshot orders/positions size —— 定位到底是哪一步
    // 把 mt=23 adopt 的 orders 清掉的。之前 Round 97 加了 guard 但 orders 还是被清 →
    // 说明还有别的 code path 在删。
    if (subPath === '/sync' && req.method === 'POST') {
      const snapCounts = () => ({
        positions: exchange.positions?.size ?? 0,
        orders: exchange.orders?.size ?? 0,
      });
      const before = { ...snapCounts(), balance: exchange.balance ?? null };
      const errors = {};
      const stepCounts = { start: snapCounts() };
      // Round 107：bot 停了但本地还残留仓位/挂单 —— 用户 Perpl 网页手动平仓
      // 但 QnV 幽灵仓位 stuck 的场景。清本地 map 再 WS resnap，WS 会重推
      // mt=23 (orders 快照) + mt=26 (position 更新)，还在的会自动回来，
      // 已经关掉的就干净了。只在 bot 停 + 有本地残留时触发，正常运行不影响。
      let cleared = null;
      if (bot && !bot.running && (exchange.positions?.size > 0 || exchange.orders?.size > 0)) {
        cleared = { positions: exchange.positions?.size ?? 0, orders: exchange.orders?.size ?? 0 };
        try { exchange.positions?.clear?.(); exchange.orders?.clear?.(); } catch {}
      }
      let resnapInfo = null;
      if (typeof exchange.forceWsResnap === 'function') {
        try { resnapInfo = await exchange.forceWsResnap(); }
        catch (e) { errors.forceWsResnap = e?.message || String(e); }
        stepCounts.afterResnap = snapCounts();
      }
      if (typeof exchange.fetchPositions === 'function') {
        try { await exchange.fetchPositions(); }
        catch (e) { errors.fetchPositions = e?.message || String(e); }
        stepCounts.afterFetchPositions = snapCounts();
      }
      if (typeof exchange.reconcileOpenOrders === 'function') {
        try { await exchange.reconcileOpenOrders(); }
        catch (e) { errors.reconcileOpenOrders = e?.message || String(e); }
        stepCounts.afterReconcile = snapCounts();
      }
      const after = { ...snapCounts(), balance: exchange.balance ?? null };
      let debug = null;
      if (typeof exchange.getDebugSnapshot === 'function') {
        try { debug = await exchange.getDebugSnapshot(); }
        catch (e) { errors.debugSnapshot = e?.message || String(e); }
      }
      stepCounts.afterDebug = snapCounts();
      return send(res, 200, { before, after, errors, debug, resnapInfo, stepCounts, cleared });
    }

    // 紧急清链上残留：撤所有市场的挂单 + 平所有持仓。绕过 bot 状态，直接调
    // exchange 层。用于 bot 无 config / autopilot 崩溃后链上有残留的场景。
    //
    // 数据源三路 union（针对 Perpl REST 401 / 本地 map 漂移的场景）：
    //   1) exchange.fetchOpenOrders(mktId)  — Round 30 REST + WS 本地 fallback
    //   2) bot.active                       — bot 自己下过的单（oid 是从 mt=24 回响拿的）
    //   3) exchange.orders  (Perpl 私有)   — 适配器 map（WS mt=23 收养的 + placeLimitOrder 加的）
    // dedupe 后 cancel by oid（直接 mt=22 t=5，不经 fetchOpenOrders）。
    if (subPath === '/emergency-cleanup' && req.method === 'POST') {
      try {
        const b = await readBody(req).catch(() => ({}));

        // === Phase 1: 采集所有已知 oid（在 reconnect 之前） ===
        // Round 32 之前的 bug：先 reconnect + wait 3.5s，期间 bot reconcile 定时器
        // 触发 massVanish clear（bot.active.clear() 把 20 个 oid 都清掉），我们
        // 拿到空 map → 撤 0 单。改：先把 oid 都缓存下来，再 reconnect。
        const markets0 = await exchange.getMarkets().catch(() => []);
        const targets = b?.marketId != null
          ? [markets0.find((m) => Number(m.marketId) === Number(b.marketId))].filter(Boolean)
          : markets0;
        const oidsByMkt = new Map();
        for (const m of targets) {
          const mktId = Number(m.marketId);
          const oids = new Set();
          try {
            const ords = await exchange.fetchOpenOrders(mktId);
            for (const o of ords) if (o.orderId) oids.add(String(o.orderId));
          } catch { /* skip */ }
          if (bot?.config?.marketId === mktId && bot.active) {
            for (const oid of bot.active.keys()) if (oid) oids.add(String(oid));
          }
          if (exchange.orders && typeof exchange.orders.values === 'function') {
            for (const o of exchange.orders.values()) {
              if (Number(o.marketId) === mktId && o.orderId) oids.add(String(o.orderId));
            }
          }
          oidsByMkt.set(mktId, oids);
        }

        // === Phase 2: WS 重连让 mt=23 补充孤儿 oid ===
        if (typeof exchange.reconnect === 'function') {
          await exchange.reconnect().catch(() => {});
          await new Promise((r) => setTimeout(r, 3500));  // 等 mt=23 snapshot 到
        }
        // Reconnect 后再从适配器 orders map 补一遍（这次可能包含 mt=23 收养的孤儿）
        if (exchange.orders && typeof exchange.orders.values === 'function') {
          for (const o of exchange.orders.values()) {
            const mktId = Number(o.marketId);
            const s = oidsByMkt.get(mktId);
            if (s && o.orderId) s.add(String(o.orderId));
          }
        }

        // === Phase 3: 撤 & 平 ===
        // Round 55：以前 `r === undefined` 也算 cancel 成功——但适配器没实现
        // cancelOrder 就会返 undefined → 报"20 单已撤"实际 0 单动。
        // 现在严格：cancelOrder 必须明确返 true 或非 null 对象才算成功。
        // closePosition 空仓返 `{closed:true, size:0, empty:true}`（Round 55），
        // 用 .empty 区分"真平仓"vs"本来就空"。
        let totalCancelled = 0;
        let totalClosed = 0;
        let totalFailed = 0;   // Round 55：撤单失败的单数
        const perMarket = [];
        const failMessages = [];
        for (const m of targets) {
          const mktId = Number(m.marketId);
          const oids = oidsByMkt.get(mktId) || new Set();
          let cancelledHere = 0;
          let failedHere = 0;
          for (const oid of oids) {
            try {
              const r = await exchange.cancelOrder?.(mktId, oid);
              // 严格：true 或 truthy 对象才算撤成功；undefined/null 一律算失败
              if (r === true || (typeof r === 'object' && r !== null)) cancelledHere++;
              else failedHere++;
            } catch (e) {
              failedHere++;
              if (failMessages.length < 5) failMessages.push(`${m.displayName}: ${(e?.message || e).slice(0, 100)}`);
            }
          }
          // 再跑一次 cancelAll 兜底
          let cleanupErr = null;
          try { await exchange.cancelAll?.(mktId); }
          catch (e) { cleanupErr = e?.message || String(e); }
          totalCancelled += cancelledHere;
          totalFailed += failedHere;
          let closedHere = false;
          let wasEmpty = false;
          if (typeof exchange.closePosition === 'function') {
            try {
              const r = await exchange.closePosition(mktId);
              if (r && r.empty === true) wasEmpty = true;
              else if (r) { totalClosed++; closedHere = true; }
            } catch (e) {
              if (failMessages.length < 5) failMessages.push(`${m.displayName} closePosition: ${(e?.message || e).slice(0, 100)}`);
            }
          }
          if (cancelledHere > 0 || failedHere > 0 || closedHere) {
            perMarket.push({
              market: m.displayName,
              cancelled: cancelledHere,
              failed: failedHere,
              closed: closedHere,
              empty: wasEmpty,
              cleanupErr: cleanupErr || undefined,
            });
          }
        }
        return send(res, 200, { ok: true, totalCancelled, totalClosed, totalFailed, perMarket, failMessages });
      } catch (e) { return send(res, 500, { error: e.message }); }
    }

    if (subPath === '/start-recovery' && req.method === 'POST') {
      try { return send(res, 200, await bot.startRecovery(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    // 重新与交易所建立连接：重建客户端/解卡轮询/重启轮询循环。
    // 不撤单、不平仓、不动网格状态 —— 挂单照常被跟踪；重连成功后立刻对账一次。
    // 若该所启动时未连上导致续跑被跳过（快照仍为运行状态），重连成功后自动续跑接管挂单。
    if (subPath === '/reconnect' && req.method === 'POST') {
      try {
        if (typeof exchange.reconnect === 'function') await exchange.reconnect();
        else if (typeof exchange.init === 'function') await exchange.init();
        let resumed = false, resumeError = null;
        if (!bot.running) {
          const key = prefix.split('/').pop(); // '/api/ex' -> 'ex'
          const snap = loadSnapshot(key);
          if (snap?.running && snap?.config) {
            try {
              // marketId 是按连接会话编号的，可能已漂移：按市场名称重新解析
              const markets = await exchange.getMarkets();
              const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
              const m = markets.find((x) => norm(x.displayName) === norm(snap.config.displayName) || norm(x.name) === norm(snap.config.displayName));
              if (m) snap.config.marketId = m.marketId;
              await bot.resume(snap);
              resumed = true;
              console.log(`[恢复] ${key.toUpperCase()} 重连成功后已自动续跑，接管挂单并完成对账。`);
            } catch (e) {
              resumeError = e?.message || String(e); // 续跑失败不撤单：挂单保留，可重启程序再试
              console.error(`[恢复] ${key.toUpperCase()} 重连后续跑失败（${resumeError}），挂单保留未动。`);
            }
          }
        }
        if (bot.running) await bot.reconcileOpenOrders().catch(() => {});
        return send(res, 200, { ok: true, resumed, resumeError, state: bot.getState() });
      } catch (e) {
        return send(res, 500, { error: e?.message || String(e) });
      }
    }

    if (subPath === '/close-position' && req.method === 'POST') {
      try { const b = await readBody(req); return send(res, 200, await bot.closePositionNow(b && b.marketId)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(bot.getState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    send(res, 404, { error: 'not found: ' + subPath });
  };
}

const deHandler = makeExchangeHandler('/api/de', deBot, deExchange, cfg.de, deClients, 'Decibel');
const exHandler = makeExchangeHandler('/api/ex', exBot, exExchange, cfg.ex, exClients, 'Extended');
const rsHandler = makeExchangeHandler('/api/rs', rsBot, rsExchange, cfg.rs, rsClients, 'RISEx');
const onHandler = makeExchangeHandler('/api/on', onBot, onExchange, cfg.on, onClients, 'Ondo');
const plHandler = makeExchangeHandler('/api/pl', plBot, plExchange, cfg.pl, plClients, 'Perpl');
const sxHandler = makeExchangeHandler('/api/sx', sxBot, sxExchange, cfg.sx, sxClients, 'StandX');
const bgHandler = makeExchangeHandler('/api/bg', bgBot, bgExchange, cfg.bg, bgClients, 'Bitget');
const buHandler = makeExchangeHandler('/api/bu', buBot, buExchange, cfg.bu, buClients, 'Bitunix');

// ── HTTP Basic Auth 中间件（有 DASHBOARD_PASSWORD 才启用） ──────────────────
// 时间常量比较，避免旁路时间攻击。
function _timingEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function checkAuth(req) {
  if (!cfg.dashboardPassword) return true;
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return _timingEq(user, cfg.dashboardUser) && _timingEq(pass, cfg.dashboardPassword);
}

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
const server = http.createServer(async (request, res) => {
  const url = new URL(request.url, 'http://localhost');
  const p = url.pathname;

  // 平台健康检查（Railway/Render 用），不需要口令
  if (p === '/healthz' || p === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // 全站口令保护（仅当 DASHBOARD_PASSWORD 设置时生效）
  if (!checkAuth(request)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="grid-bot", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return res.end('401 Unauthorized — 需要仪表盘口令');
  }

  try {
    // ── 总览 API ──────────────────────────────────────────────────────────
    if (p === '/api/overview') {
      return send(res, 200, {
        de: pick(deBot.getState(), cfg.de.mode),
        ex: pick(exBot.getState(), cfg.ex.mode),
        rs: pick(rsBot.getState(), cfg.rs.mode),
        on: pick(onBot.getState(), cfg.on.mode),
        pl: pick(plBot.getState(), cfg.pl.mode),
        sx: pick(sxBot.getState(), cfg.sx.mode),
        bg: pick(bgBot.getState(), cfg.bg.mode),
        bu: pick(buBot.getState(), cfg.bu.mode),
      });
    }

    // ── 总览 SSE 流 ───────────────────────────────────────────────────────
    if (p === '/api/overview/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // send the current snapshot immediately (don't leave the client blank
      // until the next 1s broadcast tick)
      const initial = {
        de: pick(deBot.getState(), cfg.de.mode),
        ex: pick(exBot.getState(), cfg.ex.mode),
        rs: pick(rsBot.getState(), cfg.rs.mode),
        on: pick(onBot.getState(), cfg.on.mode),
        pl: pick(plBot.getState(), cfg.pl.mode),
        sx: pick(sxBot.getState(), cfg.sx.mode),
        bg: pick(bgBot.getState(), cfg.bg.mode),
        bu: pick(buBot.getState(), cfg.bu.mode),
      };
      res.write(`data: ${JSON.stringify(initial, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`);
      const overviewClients = server._overviewClients;
      overviewClients.add(res);
      request.on('close', () => overviewClients.delete(res));
      return;
    }

    // ── AI API ────────────────────────────────────────────────────────────
    if (p === '/api/ai/status') {
      return send(res, 200, aiService.status());
    }
    if (p === '/api/ai/test' && request.method === 'POST') {
      try { return send(res, 200, await aiService.test()); }
      catch (e) { return send(res, 200, { ok: false, error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/sentinel-run' && request.method === 'POST') {
      try {
        const r = await aiService.runSentinel();
        // Round 70：优先返 sentinelError（含 raw AI 响应片段）而不是 fallback
        // "巡检失败"泛化消息，方便定位 kimi 返非 JSON 之类的 root cause
        if (aiService.sentinelError) return send(res, 200, { error: aiService.sentinelError });
        return send(res, 200, r || { error: '巡检没返数据也没设错误——可能刚重启，AI 服务未初始化' });
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/market-run' && request.method === 'POST') {
      // Round 71：也异步化（Round 35 只做了 report）——kimi 慢，iOS 30s Load failed
      const startedAt = Date.now();
      aiService.runMarketAnalysis().catch(() => {});
      return send(res, 202, { ok: true, startedAt, msg: '市况分析中，约 15-40 秒后 AI 页会自动刷新' });
    }
    if (p === '/api/ai/report' && request.method === 'POST') {
      // 异步生成——AI 调用 + prompt 加持完常常 20-60s，手机浏览器 30s 就会 "Load
      // failed" 断开。改成立刻返 202 + jobId，客户端 poll /api/ai/status.report.t
      // 变化就能拿到结果。
      const startedAt = Date.now();
      aiService.makeReport().catch(() => {});
      return send(res, 202, { ok: true, startedAt, msg: '日报生成中，约 30-60 秒后自动出现' });
    }
    if (p === '/api/ai/analyze' && request.method === 'POST') {
      // Round 71：异步化。kimi 分析大 payload 会 30s+，iOS Safari Load failed。
      // 结果存 aiService._analysisByEx[key]，前端 poll /api/ai/analyze-status?key=xx
      try {
        const b = await readBody(request);
        const key = String(b.ex || 'de');
        const startedAt = Date.now();
        aiService.analyzeAsync(key, startedAt);
        return send(res, 202, { ok: true, startedAt, key, msg: '分析中，约 10-30 秒后自动出现' });
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/analyze-status' && request.method === 'GET') {
      const key = url.searchParams.get('key') || 'de';
      const r = aiService._analysisByEx?.[key];
      return send(res, 200, r || { pending: true });
    }
    // ── Autopilot API ─────────────────────────────────────────────────────
    if (p === '/api/autopilot/status') {
      return send(res, 200, autopilot.status());
    }
    if (p === '/api/autopilot/config' && request.method === 'POST') {
      try { return send(res, 200, autopilot.updateConfig(await readBody(request))); }
      catch (e) { return send(res, 400, { error: e?.message || String(e) }); }
    }
    if (p === '/api/autopilot/resume' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        if (!b?.key) return send(res, 400, { error: 'missing "key"' });
        return send(res, 200, autopilot.resumeExchange(String(b.key)));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/autopilot/resume-all' && request.method === 'POST') {
      try { return send(res, 200, autopilot.resumeAll()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    // Round 112：一键撤除全部 DEX 仓位 + 挂单 + 清熔断，让 Autopilot 从零重开
    // （用于风控风格换了、Round 109 mode 修复要生效等场景 —— 现有 bot 不停不重开）
    if (p === '/api/autopilot/reset-all-positions' && request.method === 'POST') {
      try {
        const bots = { de: deBot, ex: exBot, rs: rsBot, on: onBot, pl: plBot, sx: sxBot, bg: bgBot, bu: buBot };
        const exchanges = { de: deExchange, ex: exExchange, rs: rsExchange, on: onExchange, pl: plExchange, sx: sxExchange, bg: bgExchange, bu: buExchange };
        const results = {};
        await Promise.all(Object.entries(bots).map(async ([k, bot]) => {
          const ex = exchanges[k];
          if (bot?.running) {
            try {
              await bot.stop({ closePosition: true });
              results[k] = 'stopped+closed';
            } catch (e) { results[k] = 'err: ' + (e?.message || String(e)).slice(0, 100); }
          } else if (ex && typeof ex.cancelAll === 'function' && bot?.config?.marketId != null) {
            // Round 120：bot 已停但 chain 可能有孤儿 → 试撤（清 StandX 那 44 单场景）
            // 用 bot.config.marketId (bot 最后跑的市场，即使停了 config 还在)
            try {
              const r = await ex.cancelAll(bot.config.marketId);
              results[k] = 'was-stopped, orphan-cancel: ' + (typeof r === 'object' ? JSON.stringify(r).slice(0, 80) : String(r));
            } catch (e) { results[k] = 'was-stopped, orphan-cancel err: ' + (e?.message || String(e)).slice(0, 100); }
          } else {
            results[k] = 'not-running';
          }
        }));
        const apStatus = autopilot.resumeAll();
        return send(res, 200, { results, autopilot: apStatus });
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    // ── 宠物系统 API ─────────────────────────────────────────────────────
    if (p === '/api/pets') {
      return send(res, 200, pets.status());
    }

    if (p === '/api/ai/chat' && request.method === 'POST') {
      // Round 71：异步化。kimi 大 snapshot 30s+ iOS Safari Load failed。
      // 结果存 aiService._chatResult[jobId]，前端 poll /api/ai/chat-status
      try {
        const b = await readBody(request);
        if (!b.message) return send(res, 400, { error: '消息为空' });
        const jobId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        aiService.chatControlAsync(jobId, b.message, Array.isArray(b.history) ? b.history : []);
        return send(res, 202, { ok: true, jobId, msg: '对话中，约 10-30 秒...' });
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/chat-status' && request.method === 'GET') {
      const jobId = url.searchParams.get('jobId') || '';
      const r = aiService._chatResults?.[jobId];
      return send(res, 200, r || { pending: true });
    }

    // ── 代理配置 API ──────────────────────────────────────────────────────
    if (p === '/api/proxy-check') {
      const result = await checkProxy();
      return send(res, 200, result);
    }

    if (p === '/api/proxy-config') {
      return send(res, 200, {
        global: process.env.GLOBAL_PROXY || '',
        de: process.env.DECIBEL_PROXY || '',
        ex: process.env.EXTENDED_PROXY || '',
        rs: process.env.RISEX_PROXY || '',
        on: process.env.ONDO_PROXY || '',
        pl: process.env.PERPL_PROXY || '',
      });
    }

    if (p === '/api/env' && request.method === 'POST') {
      try {
        const { key, value } = await readBody(request);
        const PROXY_KEYS = ['GLOBAL_PROXY','DECIBEL_PROXY','EXTENDED_PROXY','RISEX_PROXY','ONDO_PROXY','PERPL_PROXY'];
        const AI_KEYS = ['AI_PROVIDER','AI_API_KEY','AI_BASE_URL','AI_MODEL','AI_MODEL_SMALL','AI_SENTINEL_MINUTES','AI_MARKET_MINUTES','AI_REPORT_HOUR','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','NOTIFY_WEBHOOK'];
        if (!PROXY_KEYS.includes(key) && !AI_KEYS.includes(key)) return send(res, 400, { error: '不允许修改该字段: ' + key });
        // SECURITY: the value is written verbatim into .env. Reject anything that
        // could break out of a single KEY=VALUE line (newlines / control chars)
        // — otherwise a crafted value could inject arbitrary env lines (e.g. flip
        // DE_MODE=live, set private keys). Per-key format validation below.
        const val = value == null ? '' : String(value).trim();
        if (val) {
          if (/\s/.test(val) || [...val].some((c) => c.charCodeAt(0) < 32) || val.length > 500) {
            return send(res, 400, { error: '值包含非法字符（空白/换行/控制字符）或过长。' });
          }
          if (PROXY_KEYS.includes(key)) {
            // host:port | host:port:user:pass | scheme://[user:pass@]host:port
            const ok = /^[\w.-]+:\d{1,5}(:[^:\s@]+:[^:\s@]+)?$/.test(val)
              || /^(https?|socks[45]?):\/\/([^:@/\s]+(:[^@/\s]+)?@)?[\w.-]+:\d{1,5}\/?$/i.test(val);
            if (!ok) return send(res, 400, { error: '代理地址格式无效。示例：http://127.0.0.1:7890 或 socks5://user:pass@host:1080' });
          } else if (key === 'AI_PROVIDER') {
            if (!/^(openai|anthropic|gemini)$/i.test(val)) return send(res, 400, { error: 'AI_PROVIDER 只能是 openai / anthropic / gemini（OpenAI 兼容协议的服务商选 openai）。' });
          } else if (key === 'AI_SENTINEL_MINUTES' || key === 'AI_MARKET_MINUTES') {
            if (!/^\d{1,4}$/.test(val)) return send(res, 400, { error: '间隔必须是数字（分钟，0=关闭）。' });
          } else if (key === 'AI_REPORT_HOUR') {
            if (!/^\d{1,2}$/.test(val) || Number(val) > 23) return send(res, 400, { error: '日报时间必须是 0-23 的整点小时。' });
          } else if (key === 'AI_BASE_URL' || key === 'NOTIFY_WEBHOOK') {
            if (!/^https?:\/\/\S+$/i.test(val)) return send(res, 400, { error: '必须是 http(s):// 开头的 URL。' });
          }
        }
        // 更新内存中的环境变量
        if (val) process.env[key] = val; else delete process.env[key];
        // 写入 .env 文件
        const envFile = path.join(ROOT, '.env');
        let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
        const regex = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
        const line = val ? `${key}=${val}` : `# ${key}=`;
        if (regex.test(content)) {
          content = content.replace(regex, line);
        } else {
          content = content.trimEnd() + '\n' + line + '\n';
        }
        fs.writeFileSync(envFile, content, 'utf8');
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    // ── 交易所子路由 ──────────────────────────────────────────────────────
    if (p.startsWith('/api/de/')) {
      return await deHandler(request, res, p.slice('/api/de'.length), url);
    }
    if (p.startsWith('/api/ex/')) {
      return await exHandler(request, res, p.slice('/api/ex'.length), url);
    }
    if (p.startsWith('/api/rs/')) {
      return await rsHandler(request, res, p.slice('/api/rs'.length), url);
    }
    if (p.startsWith('/api/on/')) {
      return await onHandler(request, res, p.slice('/api/on'.length), url);
    }
    if (p.startsWith('/api/pl/')) {
      return await plHandler(request, res, p.slice('/api/pl'.length), url);
    }
    if (p.startsWith('/api/sx/')) {
      return await sxHandler(request, res, p.slice('/api/sx'.length), url);
    }
    if (p.startsWith('/api/bg/')) {
      return await bgHandler(request, res, p.slice('/api/bg'.length), url);
    }
    if (p.startsWith('/api/bu/')) {
      return await buHandler(request, res, p.slice('/api/bu'.length), url);
    }

    // ── 静态文件 ──────────────────────────────────────────────────────────
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(ROOT, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full);
      // Round 87：cache 策略——HTML 每次强制 revalidate（否则用户升级后 iOS
      // Safari 一直看老 JS 缓存的 UI，报"undefined"/"无 Bitget 按钮"其实
      // 代码早修好了）。PNG/font/等 asset 可长期缓存。
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      if (ext === '.html' || full.endsWith('/index.html')) {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        headers['Pragma'] = 'no-cache';
        headers['Expires'] = '0';
      } else if (['.png', '.woff2', '.ico', '.svg'].includes(ext)) {
        headers['Cache-Control'] = 'public, max-age=86400';   // 1 天
      }
      res.writeHead(200, headers);
      return fs.createReadStream(full).pipe(res);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server._overviewClients = new Set();

// ── SSE 推送定时器 ────────────────────────────────────────────────────────────
setInterval(() => {
  const stringify = (obj) =>
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

  if (deClients.size > 0) {
    const data = `data: ${stringify(deBot.getState())}\n\n`;
    for (const r of deClients) { try { r.write(data); } catch { deClients.delete(r); } }
  }
  if (exClients.size > 0) {
    const data = `data: ${stringify(exBot.getState())}\n\n`;
    for (const r of exClients) { try { r.write(data); } catch { exClients.delete(r); } }
  }
  if (rsClients.size > 0) {
    const data = `data: ${stringify(rsBot.getState())}\n\n`;
    for (const r of rsClients) { try { r.write(data); } catch { rsClients.delete(r); } }
  }
  if (onClients.size > 0) {
    const data = `data: ${stringify(onBot.getState())}\n\n`;
    for (const r of onClients) { try { r.write(data); } catch { onClients.delete(r); } }
  }
  if (plClients.size > 0) {
    const data = `data: ${stringify(plBot.getState())}\n\n`;
    for (const r of plClients) { try { r.write(data); } catch { plClients.delete(r); } }
  }
  if (sxClients.size > 0) {
    const data = `data: ${stringify(sxBot.getState())}\n\n`;
    for (const r of sxClients) { try { r.write(data); } catch { sxClients.delete(r); } }
  }
  if (bgClients.size > 0) {
    const data = `data: ${stringify(bgBot.getState())}\n\n`;
    for (const r of bgClients) { try { r.write(data); } catch { bgClients.delete(r); } }
  }
  if (buClients.size > 0) {
    const data = `data: ${stringify(buBot.getState())}\n\n`;
    for (const r of buClients) { try { r.write(data); } catch { buClients.delete(r); } }
  }
  if (server._overviewClients.size > 0) {
    const deState = deBot.getState();
    const exState = exBot.getState();
    const rsState = rsBot.getState();
    const onState = onBot.getState();
    const plState = plBot.getState();
    const sxState = sxBot.getState();
    const bgState = bgBot.getState();
    const buState = buBot.getState();
    const overview = {
      de: pick(deState, cfg.de.mode),
      ex: pick(exState, cfg.ex.mode),
      rs: pick(rsState, cfg.rs.mode),
      on: pick(onState, cfg.on.mode),
      pl: pick(plState, cfg.pl.mode),
      sx: pick(sxState, cfg.sx.mode),
      bg: pick(bgState, cfg.bg.mode),
      bu: pick(buState, cfg.bu.mode),
    };
    const data = `data: ${stringify(overview)}\n\n`;
    for (const r of server._overviewClients) { try { r.write(data); } catch { server._overviewClients.delete(r); } }
  }
}, 1000);

function pick(s, mode) {
  return {
    running: s.running,
    mode,
    balance: s.balance,
    equity: s.equity,
    totalPnl: s.totalPnl,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: s.unrealizedPnl,
    returnPct: s.returnPct,
    volume: s.volume,
    completedRungs: s.stats?.completedRungs ?? 0,
    openOrders: s.openOrders ?? 0,
    exchangeOpenOrders: s.exchangeOpenOrders ?? null,
    outOfRange: s.outOfRange ?? false,
    health: s.health ?? null,
    lastPrice: s.lastPrice,
    config: s.config,
  };
}

// ── 错误处理 ──────────────────────────────────────────────────────────────────
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${cfg.port} 已被占用。`);
    console.error('请先关闭之前的程序窗口，或在 .env 里改 PORT=8081 用别的端口。\n');
  } else {
    console.error('[服务器错误] ' + (e?.message || e));
  }
  process.exit(1);
});

// ── 初始化各交易所 ────────────────────────────────────────────────────────────
async function initExchange(exchange, name, exCfg) {
  try {
    await exchange.init();
    console.log(`[${name}] ✓ 连接成功 [${exCfg.mode.toUpperCase()} 模式]`);
  } catch (e) {
    console.error(`\n[${name}] ✗ 初始化失败：${e?.message || e}`);
    console.error(`  目标接口: ${exCfg.apiUrl}   网络: ${exCfg.network}`);
    const cause = e?.cause || {};
    const code = cause.code || '';
    if (code === 'ENOTFOUND') {
      console.error('  ➤ 域名解析失败：检查网络，或配置代理。');
    } else if (code === 'ECONNREFUSED' && String(cause.address || '').includes('127.0.0.1')) {
      console.error('  ➤ 本机代理端口连不上，检查代理软件是否开启。');
    } else if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(cause.message || '')) {
      console.error('  ➤ 连接超时，接口被网络拦截，或代理未正确转发。');
    }
    console.error(`  该交易所将以离线模式运行（行情可能使用合成数据）。\n`);
    // 不退出，让其他交易所继续工作
  }
}

await Promise.all([
  initExchange(deExchange, 'Decibel', cfg.de),
  initExchange(exExchange, 'Extended', cfg.ex),
  initExchange(rsExchange, 'RISEx', cfg.rs),
  initExchange(onExchange, 'Ondo', cfg.on),
  initExchange(plExchange, 'Perpl', cfg.pl),
  initExchange(sxExchange, 'StandX', { mode: cfg.sx.mode, apiUrl: 'https://perps.standx.com', network: cfg.sx.chain || 'bsc' }),
  initExchange(bgExchange, 'Bitget', { mode: cfg.bg.mode, apiUrl: 'https://api.bitget.com' }),
  initExchange(buExchange, 'Bitunix', { mode: cfg.bu.mode, apiUrl: 'https://fapi.bitunix.com' }),
]);

// ── 崩溃恢复 / 续跑 ────────────────────────────────────────────────────────────
// If a bot was "running" when the process died, RESUME it: re-attach to the
// orders still resting on the exchange and keep managing the grid. If resume
// fails (e.g. exchange offline), fall back to cancelling stray orders so we
// never operate a half-known grid.
async function resumeIfWasRunning(bot, exchange, key) {
  const snap = loadSnapshot(key);
  if (!(snap?.running && snap?.config)) return;
  if (exchange.dataSource == null) {
    console.log(`[恢复] ${key.toUpperCase()} 交易所未连接，跳过续跑；保留挂单待下次连接。`);
    return;
  }
  try {
    console.log(`[恢复] 检测到 ${key.toUpperCase()} 上次为运行状态，正在接管续跑...`);
    await bot.resume(snap);
    console.log(`[恢复] ${key.toUpperCase()} 已续跑，接管挂单并完成对账。`);
  } catch (e) {
    console.error(`[恢复] ${key.toUpperCase()} 续跑失败（${e?.message || e}），改为撤销遗留挂单。`);
    await bot.recoverStrayOrders().catch(() => {});
  }
}
await Promise.all([
  resumeIfWasRunning(deBot, deExchange, 'de'),
  resumeIfWasRunning(exBot, exExchange, 'ex'),
  resumeIfWasRunning(rsBot, rsExchange, 'rs'),
  resumeIfWasRunning(onBot, onExchange, 'on'),
  resumeIfWasRunning(plBot, plExchange, 'pl'),
  resumeIfWasRunning(sxBot, sxExchange, 'sx'),
  resumeIfWasRunning(bgBot, bgExchange, 'bg'),
  resumeIfWasRunning(buBot, buExchange, 'bu'),
]);
// Autopilot 迁移补丁：resume 完之后再认领在跑的托管 bot（构造函数里做为时过早，
// 那时 bot.running 都还是 false）
autopilot.adoptRunningBots();

// Round 137：强制 boot 时对所有 bot 拉一次 exchange volume，释放历史污染。
// Round 136 的异常检测（stats.volume > 100 × exchange.volume 则用 exchange）
// 依赖 _syncExchangeStats 跑起来。但它只在 _startReconcileTimer 里绑（需要 bot
// running）。Bitunix 从没 run 过 → 4.7B 一直卡。这里 boot 时强制跑一次，
// 让 Round 136 anomaly check 有机会执行。
await Promise.all([
  ['de', deBot], ['ex', exBot], ['rs', rsBot], ['on', onBot],
  ['pl', plBot], ['sx', sxBot], ['bg', bgBot], ['bu', buBot],
].map(async ([k, bot]) => {
  if (typeof bot?.ex?.getStats !== 'function') return;
  try {
    await bot._syncExchangeStats();
    const v = bot.stats?.volume;
    if (Number.isFinite(v)) console.log(`[启动 volume sync] ${k.toUpperCase()} stats.volume=${v}`);
  } catch { /* transient, don't block startup */ }
}));

// After init, surface any LEFTOVER position so the dashboard can prompt the user
// (recovery ladder / re-grid / market close). Decibel & Extended RE-NUMBER their
// marketIds every run, so the persisted numeric id may point at the wrong market
// — re-resolve it by the market NAME, then start watching it so the position is
// polled into getState.
const _norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function detectOrphanPosition(bot, ex) {
  if (!bot.config?.displayName || ex.dataSource == null || typeof ex.getMarkets !== 'function') return;
  try {
    const markets = await ex.getMarkets();
    const want = _norm(bot.config.displayName);
    const m = markets.find((x) => _norm(x.displayName) === want || _norm(x.name) === want || _norm(x.symbol) === want);
    if (m) {
      bot.config.marketId = m.marketId;            // fix stale/ephemeral id -> current
      await ex.getPrice(m.marketId).catch(() => {}); // seed watch -> position gets polled
    }
  } catch { /* ignore */ }
}
await Promise.all([
  detectOrphanPosition(deBot, deExchange),
  detectOrphanPosition(exBot, exExchange),
  detectOrphanPosition(rsBot, rsExchange),
  detectOrphanPosition(onBot, onExchange),
  detectOrphanPosition(plBot, plExchange),
]);

server.listen(cfg.port, cfg.host, () => {
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  QnV · 五所整合网格机器人 已启动`);
  console.log(`  仪表盘: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
  if (cfg.host === '0.0.0.0') {
    console.log('  ⚠ 监听所有网卡(0.0.0.0)，局域网/公网可访问。');
    if (cfg.dashboardPassword) console.log(`  🔒 已启用口令保护（用户名 ${cfg.dashboardUser}）`);
  }
  console.log(`${'═'.repeat(52)}`);
  console.log(`  Decibel  [${cfg.de.mode.toUpperCase()}]  ${cfg.de.network}`);
  console.log(`  Extended [${cfg.ex.mode.toUpperCase()}]  ${cfg.ex.network}`);
  console.log(`  RISEx    [${cfg.rs.mode.toUpperCase()}]  ${cfg.rs.network}`);
  console.log(`  Ondo     [${cfg.on.mode.toUpperCase()}]  ${cfg.on.network}`);
  console.log(`  Perpl    [${cfg.pl.mode.toUpperCase()}]  ${cfg.pl.network}`);
  console.log(`${'─'.repeat(52)}`);
  if ([cfg.de, cfg.ex, cfg.rs, cfg.on, cfg.pl].some((c) => c.mode === 'paper')) {
    console.log('  ⚠ 部分交易所为模拟模式，不涉及真实资金。');
    console.log('    在 .env 中设置 DE_MODE/EX_MODE/RS_MODE/ON_MODE/PL_MODE=live 切换实盘。');
  }
  console.log('');
});
