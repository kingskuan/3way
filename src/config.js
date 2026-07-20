// 五所整合配置加载器（Decibel / Extended / RISEx / Ondo / Perpl）
// 支持全局代理（GLOBAL_PROXY）+ 各交易所独立代理覆盖
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        const q = v.match(/^"([^"]*)"|^'([^']*)'/); // quoted: take the quoted content
        if (q) v = q[1] ?? q[2];
        else v = v.replace(/\s+#.*$/, '').trim();   // unquoted: strip inline comments
        process.env[m[1]] = v;
      }
    }
  }
}

export function getConfig() {
  loadEnv();

  // 全局代理：作为所有交易所的默认代理
  const globalProxy =
    process.env.GLOBAL_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    '';

  // ── Decibel ──────────────────────────────────────────────────────────────
  const deNet = (process.env.DE_NETWORK || 'mainnet').toLowerCase();
  const deDefaults =
    deNet === 'testnet'
      ? { api: 'https://api.testnet.aptoslabs.com/decibel' }
      : { api: 'https://api.mainnet.aptoslabs.com/decibel' };

  const de = {
    mode: (process.env.DE_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: deNet,
    apiKey: process.env.DECIBEL_API_KEY || '',
    privateKey: process.env.DECIBEL_PRIVATE_KEY || '',
    subaccount: process.env.DECIBEL_SUBACCOUNT || '',
    apiUrl: (process.env.DECIBEL_API_URL || deDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.DECIBEL_PROXY || globalProxy,
  };

  // ── Extended ──────────────────────────────────────────────────────────────
  const exNet = (process.env.EX_NETWORK || 'mainnet').toLowerCase();
  const exDefaults =
    exNet === 'testnet'
      ? { api: 'https://api.starknet.sepolia.extended.exchange' }
      : { api: 'https://api.starknet.extended.exchange' };

  const ex = {
    mode: (process.env.EX_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: exNet,
    apiKey: process.env.EXTENDED_API_KEY || '',
    vault: process.env.EXTENDED_VAULT || '',
    starkPrivateKey: process.env.EXTENDED_STARK_PRIVATE_KEY || '',
    starkPublicKey: process.env.EXTENDED_STARK_PUBLIC_KEY || '',
    feeRate: process.env.EXTENDED_MAX_FEE || '0.0005',
    apiUrl: (process.env.EXTENDED_API_URL || exDefaults.api).replace(/\/$/, ''),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.EXTENDED_PROXY || globalProxy,
  };

  // ── RISEx ─────────────────────────────────────────────────────────────────
  const rsNet = (process.env.RS_NETWORK || 'mainnet').toLowerCase();
  const rsDefaults =
    rsNet === 'testnet'
      ? { api: 'https://api.testnet.rise.trade', ws: 'wss://ws.testnet.rise.trade' }
      // 官方 mainnet 已从 risex.trade 迁到 rise.trade（旧域名 CONNECT tunnel 502）
      : { api: 'https://api.rise.trade', ws: 'wss://ws.rise.trade' };

  const rs = {
    mode: (process.env.RS_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: rsNet,
    account: process.env.ACCOUNT_ADDRESS || '',
    signerKey: process.env.SIGNER_PRIVATE_KEY || '',
    apiUrl: process.env.RISEX_API_URL || rsDefaults.api,
    wsUrl: process.env.RISEX_WS_URL || rsDefaults.ws,
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.RISEX_PROXY || globalProxy,
  };

  // ── Perpl (perpl.xyz on Monad L1) ─────────────────────────────────────────
  const plNet = (process.env.PL_NETWORK || 'mainnet').toLowerCase();
  const plDefaults = plNet === 'testnet'
    ? { api: 'https://testnet.perpl.xyz/api', ws: 'wss://testnet.perpl.xyz' }
    : { api: 'https://app.perpl.xyz/api',     ws: 'wss://app.perpl.xyz' };

  // 官方文档：chain_id 是**数字**（Monad mainnet=143 / testnet=10143）；
  // 私钥官方 env 名是 PERPL_API_KEY_SECRET（hex 64 字符可选 0x 前缀），
  // 兼容我旧版的 PERPL_PRIVATE_KEY。
  const pl = {
    mode: (process.env.PL_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: plNet,
    apiKey: process.env.PERPL_API_KEY || '',
    privateKey: process.env.PERPL_API_KEY_SECRET || process.env.PERPL_PRIVATE_KEY || '',
    apiUrl: (process.env.PERPL_API_URL || plDefaults.api).replace(/\/$/, ''),
    wsUrl: process.env.PERPL_WS_URL || plDefaults.ws,
    chainId: Number(process.env.PERPL_CHAIN_ID) || (plNet === 'testnet' ? 10143 : 143),
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.PERPL_PROXY || globalProxy,
  };

  // ── StandX Perps (perps.standx.com, BSC/Solana) ───────────────────────────
  const sx = {
    mode: (process.env.SX_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    chain: (process.env.SX_CHAIN || 'bsc').toLowerCase(),
    privateKey: process.env.SX_PRIVATE_KEY || '',   // BSC 钱包私钥（0x... hex）
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.SX_PROXY || globalProxy,
  };

  // ── Bitget Perps (bitget.com, USDT-M futures) ─────────────────────────────
  // Round 82 Phase 1：paper only。LIVE 需 api key + secret + passphrase（Bitget
  // 官方要求 3 段凭证），去 bitget.com → API Management → Create API 创建。
  const bg = {
    mode: (process.env.BG_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    apiKey: process.env.BG_API_KEY || '',
    secretKey: process.env.BG_SECRET_KEY || '',
    passphrase: process.env.BG_PASSPHRASE || '',
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.BG_PROXY || globalProxy,
  };

  // ── Ondo Perps ────────────────────────────────────────────────────────────
  const onNet = (process.env.ON_NETWORK || 'mainnet').toLowerCase();
  const onDefaults = onNet === 'testnet'
    ? { api: 'https://api.ondoperps-sandbox.xyz', ws: 'wss://api.ondoperps-sandbox.xyz/ws' }
    : { api: 'https://api.ondoperps.xyz',         ws: 'wss://api.ondoperps.xyz/ws' };

  const on = {
    mode: (process.env.ON_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
    network: onNet,
    apiKeyId: process.env.ONDO_API_KEY_ID || '',
    apiSecret: process.env.ONDO_API_SECRET || '',
    apiUrl: (process.env.ONDO_API_URL || onDefaults.api).replace(/\/$/, ''),
    wsUrl: process.env.ONDO_WS_URL || onDefaults.ws,
    builderCode: process.env.ONDO_BUILDER_CODE || '',
    startBalance: Number(process.env.PAPER_BALANCE || 10000),
    proxy: process.env.ONDO_PROXY || globalProxy,
  };

  // 本地默认绑 127.0.0.1；在 Railway / Docker 里必须绑 0.0.0.0 才能被平台的
  // 反向代理转到（PaaS 环境下自动切换，也可用 HOST=0.0.0.0 显式覆盖）。
  // 生产环境自动强制要求 DASHBOARD_PASSWORD（在 server.js 里执行）。
  const isCloud = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME || process.env.DOCKER_CONTAINER);
  const defaultHost = isCloud ? '0.0.0.0' : '127.0.0.1';

  return {
    port: Number(process.env.PORT || 8080),
    // SECURITY: bind to loopback by default so the dashboard (which can start/stop
    // LIVE trading and edit .env) is NOT exposed to the local network. Set
    // HOST=0.0.0.0 explicitly only if you understand the risk and add your own auth.
    host: process.env.HOST || defaultHost,
    // Directory for persisted state (.state.json). Railway volume: /data.
    stateDir: process.env.STATE_DIR || root,
    dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
    dashboardUser: process.env.DASHBOARD_USER || 'admin',
    isCloud,
    globalProxy,
    de,
    ex,
    rs,
    on,
    pl,
    sx,
    bg,
  };
}

export const ROOT = root;
