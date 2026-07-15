// OndoExchange (LIVE) —— Ondo Perps 实盘适配器
//
// 当前状态：占位实现。骨架已就位，但下单/持仓/账户等写接口尚未接通
// （需要有效 API Key 做端到端联调）。init() 时会直接抛错，告诉用户
// 走 paper 模式或等联调完成。
//
// TODO（有 API Key 后要接的东西）：
//   • HMAC-SHA256 请求签名（headers: ONDO-KEY-ID / ONDO-TIMESTAMP / ONDO-SIGN）
//   • REST: /v1/perps/orders (create/get/cancel/batch-cancel) / /v1/perps/positions
//           /v1/margin-account/get-balance / /v1/markets / /v1/perps/history
//   • WebSocket wss://api.ondoperps.xyz/ws
//           - 公有: markPricesPerps / topOfBookPerps / depthBookPerps
//           - 私有: perps-orders / perps-fills / perps-positions / perps-balance
//   • 心跳: {op:"ping", id:uuid} 每 1s
//   • Order fields 全部支持: side/market/price/size/type/timeInForce/postOnly/reduceOnly/clientOrderId
//
// 文档: https://docs.ondoperps.xyz/api-reference/integration_guide
import { EventEmitter } from 'node:events';

export class OndoExchange extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.mode = 'live';
    this.apiKeyId = opts.apiKeyId;
    this.apiSecret = opts.apiSecret;
    this.apiUrl = (opts.apiUrl || 'https://api.ondoperps.xyz').replace(/\/$/, '');
    this.wsUrl = opts.wsUrl || this.apiUrl.replace(/^http/, 'ws') + '/ws';
    this.builderCode = opts.builderCode || null;
    this.dataSource = null;
    this.network = this.apiUrl.includes('sandbox') ? 'testnet' : 'mainnet';
  }

  async init() {
    throw new Error(
      'Ondo Perps 实盘尚未完成端到端联调，暂不可用。\n' +
      '  临时办法：把 ON_MODE 改回 paper 先跑模拟；\n' +
      '  正在开发中：等下一版发布再切 live。'
    );
  }

  // 下面的方法保留签名让 GridBot 契约不破，但不应被调用（init() 已挡住）。
  async reconnect() { return this.init(); }
  async getMarkets() { return []; }
  async getCandles() { return []; }
  async getPrice() { return null; }
  async setLeverage() { return true; }
  async placeLimitOrder() { throw new Error('Ondo LIVE 未启用'); }
  async cancelOrder() { throw new Error('Ondo LIVE 未启用'); }
  async cancelAll() { throw new Error('Ondo LIVE 未启用'); }
  getOpenOrders() { return []; }
  async fetchOpenOrders() { return []; }
  adoptOrder() { /* noop */ }
  getPosition() { return null; }
  async closePosition() { throw new Error('Ondo LIVE 未启用'); }
  start() { /* noop */ }
  stop() { /* noop */ }
}
