// PerplExchange (LIVE) —— perpl.xyz 实盘适配器（Monad L1）
//
// 当前状态：占位实现。骨架已就位，但下单/持仓/账户等写接口尚未接通。
// perpl 的下单/撤单走 **WebSocket 交易通道**（不是 REST），且需要 Ed25519
// 请求签名 + 6 段 canonical string (CHAIN_ID/METHOD/PATH/TIMESTAMP/NONCE/BODY_HASH)。
// 需要 API Key 联调完成后才能启用。
//
// TODO（有 API Key 后要接的东西）：
//   • Ed25519 签名（复用 Decibel 的 @noble/ed25519 依赖）
//   • WebSocket wss://app.perpl.xyz/ws/v1/trading（下单/撤单/账户流）
//   • WebSocket wss://app.perpl.xyz/ws/v1/market-data（订单簿/成交/mark price）
//   • REST 只用于历史查询：/v1/trading/fills, /order-history, /account-history
//   • 请求头 X-API-Key / X-API-Timestamp / X-API-Nonce / X-API-Signature
//   • Body hash: SHA256(request body)，GET 请求 body 为空串
//
// 文档: https://github.com/PerplFoundation/api-docs
import { EventEmitter } from 'node:events';

export class PerplExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.apiKey = opts.apiKey;
    this.privateKey = opts.privateKey;
    this.apiUrl = (opts.apiUrl || 'https://app.perpl.xyz/api').replace(/\/$/, '');
    this.wsUrl = opts.wsUrl || this.apiUrl.replace(/^http/, 'ws').replace(/\/api$/, '');
    this.chainId = opts.chainId || 'monad-mainnet-1';
    this.dataSource = null;
    this.network = this.apiUrl.includes('testnet') ? 'testnet' : 'mainnet';
  }

  async init() {
    throw new Error(
      'perpl.xyz 实盘尚未完成端到端联调，暂不可用。\n' +
      '  临时办法：把 PL_MODE 改回 paper 先跑模拟；\n' +
      '  正在开发中：需要 WebSocket 交易通道 + Ed25519 签名，等下一版发布再切 live。'
    );
  }

  async reconnect() { return this.init(); }
  async getMarkets() { return []; }
  async getCandles() { return []; }
  async getPrice() { return null; }
  async setLeverage() { return true; }
  async placeLimitOrder() { throw new Error('perpl LIVE 未启用'); }
  async cancelOrder() { throw new Error('perpl LIVE 未启用'); }
  async cancelAll() { throw new Error('perpl LIVE 未启用'); }
  getOpenOrders() { return []; }
  async fetchOpenOrders() { return []; }
  adoptOrder() { /* noop */ }
  getPosition() { return null; }
  async closePosition() { throw new Error('perpl LIVE 未启用'); }
  start() { /* noop */ }
  stop() { /* noop */ }
}
