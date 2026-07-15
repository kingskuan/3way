import { PaperExchange } from './paper.js';
import { OndoExchange } from './ondo.js';

/** Factory: choose adapter by mode. */
export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.apiKeyId || !cfg.apiSecret) {
      throw new Error('LIVE 模式需要 ONDO_API_KEY_ID 和 ONDO_API_SECRET 环境变量（去 app.ondoperps.xyz → API Keys 创建）。');
    }
    return new OndoExchange({
      apiKeyId: cfg.apiKeyId,
      apiSecret: cfg.apiSecret,
      apiUrl: cfg.apiUrl,
      wsUrl: cfg.wsUrl,
      builderCode: cfg.builderCode,
    });
  }
  return new PaperExchange({ apiUrl: cfg.apiUrl, startBalance: cfg.startBalance });
}
