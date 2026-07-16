// 五所整合服务器
// 路由规则：
//   /api/de/*  → Decibel
//   /api/ex/*  → Extended
//   /api/rs/*  → RISEx
//   /api/on/*  → Ondo Perps
//   /api/pl/*  → perpl.xyz
//   /api/overview → 五所总览（余额+盈亏）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from './config.js';
import { createExchange as createDeExchange } from './exchange/de/index.js';
import { createExchange as createExExchange } from './exchange/ex/index.js';
import { createExchange as createRsExchange } from './exchange/rs/index.js';
import { createExchange as createOnExchange } from './exchange/on/index.js';
import { createExchange as createPlExchange } from './exchange/pl/index.js';
import { GridBot } from './bot.js';
import { analyzeTrend } from './trend.js';
import { setupProxies, checkProxy } from './proxy.js';
import { loadSnapshot, saveSnapshot } from './persist.js';
import { createAiService } from './ai/service.js';
import { createAutopilot } from './ai/autopilot.js';

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
    const hasLive = ['de', 'ex', 'rs', 'on', 'pl'].some((k) => cfg[k].mode === 'live');
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

// ── 创建三个交易所和机器人 ────────────────────────────────────────────────────
const deExchange = createDeExchange(cfg.de);
const exExchange = createExExchange(cfg.ex);
const rsExchange = createRsExchange(cfg.rs);
const onExchange = createOnExchange(cfg.on);
const plExchange = createPlExchange(cfg.pl);

const deBot = new GridBot(deExchange, { onChange: (s) => saveSnapshot('de', s) });
const exBot = new GridBot(exExchange, { onChange: (s) => saveSnapshot('ex', s) });
const rsBot = new GridBot(rsExchange, { onChange: (s) => saveSnapshot('rs', s) });
const onBot = new GridBot(onExchange, { onChange: (s) => saveSnapshot('on', s) });
const plBot = new GridBot(plExchange, { onChange: (s) => saveSnapshot('pl', s) });

// Restore cumulative stats / config from the previous run (display continuity).
// Trading does NOT auto-resume; stray-order cleanup happens after each exchange
// finishes init (see below).
deBot.restore(loadSnapshot('de'));
exBot.restore(loadSnapshot('ex'));
rsBot.restore(loadSnapshot('rs'));
onBot.restore(loadSnapshot('on'));
plBot.restore(loadSnapshot('pl'));

// Belt-and-suspenders: ensure every exchange always has an 'error' listener so a
// stray emit can never crash the process (the GridBot also attaches one).
for (const ex of [deExchange, exExchange, rsExchange, onExchange, plExchange]) {
  ex.on('error', (e) => { try { console.error('[交易所错误] ' + (e?.message || e)); } catch {} });
}

// ── AI 服务（哨兵/日报/分析/对话/出区间建议）────────────────────────────────
const aiService = createAiService({
  bots: { de: deBot, ex: exBot, rs: rsBot, on: onBot, pl: plBot },
  exchanges: { de: deExchange, ex: exExchange, rs: rsExchange, on: onExchange, pl: plExchange },
});
aiService.start();

// ── AI Autopilot（无脑一键：AI 自动选币 + 起网格 + 熔断护栏 + Telegram 复盘）
const autopilot = createAutopilot({
  bots: { de: deBot, ex: exBot, rs: rsBot, on: onBot, pl: plBot },
  exchanges: { de: deExchange, ex: exExchange, rs: rsExchange, on: onExchange, pl: plExchange },
});
autopilot.start();

// SSE 客户端集合（按交易所分组）
const deClients = new Set();
const exClients = new Set();
const rsClients = new Set();
const onClients = new Set();
const plClients = new Set();

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
        return send(res, 200, r || { error: aiService.sentinelError || '巡检失败' });
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/market-run' && request.method === 'POST') {
      try { return send(res, 200, await aiService.runMarketAnalysis()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/report' && request.method === 'POST') {
      try { return send(res, 200, await aiService.makeReport()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/analyze' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        return send(res, 200, await aiService.analyze(String(b.ex || 'de')));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
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

    if (p === '/api/ai/chat' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        if (!b.message) return send(res, 400, { error: '消息为空' });
        return send(res, 200, await aiService.chatControl(b.message, Array.isArray(b.history) ? b.history : []));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
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

    // ── 静态文件 ──────────────────────────────────────────────────────────
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(ROOT, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
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
  if (server._overviewClients.size > 0) {
    const deState = deBot.getState();
    const exState = exBot.getState();
    const rsState = rsBot.getState();
    const onState = onBot.getState();
    const plState = plBot.getState();
    const overview = {
      de: pick(deState, cfg.de.mode),
      ex: pick(exState, cfg.ex.mode),
      rs: pick(rsState, cfg.rs.mode),
      on: pick(onState, cfg.on.mode),
      pl: pick(plState, cfg.pl.mode),
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
]);

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
