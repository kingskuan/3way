// Bitunix factory
// Round 127：LIVE 直上（Bitunix Futures REST + Double-SHA256 auth）
import { BitunixPaper } from './paper.js';
import { BitunixExchange } from './bitunix.js';

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.apiKey || !cfg.apiSecret) {
      throw new Error(
        'Bitunix LIVE 模式需要 2 段凭证：BU_API_KEY / BU_API_SECRET。' +
        'bitunix.com → API Management → Create API 创建。'
      );
    }
    return new BitunixExchange({
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
    });
  }
  return new BitunixPaper({ startBalance: cfg.startBalance });
}
