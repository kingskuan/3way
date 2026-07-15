import { PaperExchange } from './paper.js';
import { PerplExchange } from './perpl.js';

/** Factory: choose adapter by mode. */
export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.apiKey || !cfg.privateKey) {
      throw new Error('LIVE 模式需要 PERPL_API_KEY 和 PERPL_PRIVATE_KEY 环境变量（去 app.perpl.xyz/apikeys 创建）。');
    }
    return new PerplExchange({
      apiKey: cfg.apiKey,
      privateKey: cfg.privateKey,
      apiUrl: cfg.apiUrl,
      wsUrl: cfg.wsUrl,
      chainId: cfg.chainId,
    });
  }
  return new PaperExchange({ apiUrl: cfg.apiUrl, startBalance: cfg.startBalance });
}
