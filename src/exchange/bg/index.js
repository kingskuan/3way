// Bitget factory
// Round 82 Phase 1: paper only
// Round 83 Phase 2: LIVE 接入（HMAC-SHA256 auth + 3s REST 轮询）
import { BitgetPaper } from './paper.js';
import { BitgetExchange } from './bitget.js';

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.apiKey || !cfg.secretKey || !cfg.passphrase) {
      throw new Error(
        'Bitget LIVE 模式需要 3 段凭证：BG_API_KEY / BG_SECRET_KEY / BG_PASSPHRASE。' +
        'bitget.com → API Management → Create API 时会一次给全（passphrase 是你自己设的口令）。'
      );
    }
    return new BitgetExchange({
      apiKey: cfg.apiKey,
      apiSecret: cfg.secretKey,
      passphrase: cfg.passphrase,
    });
  }
  return new BitgetPaper({ startBalance: cfg.startBalance });
}
