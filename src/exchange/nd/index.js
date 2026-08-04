// Nado factory：live 需要 walletPrivateKey；缺则退 paper。
import { NadoPaper } from './paper.js';
import { NadoExchange } from './nado.js';

export function createExchange(cfg = {}) {
  const mode = cfg.mode || 'paper';
  if (mode === 'live' && cfg.walletPrivateKey) {
    try {
      return new NadoExchange({
        walletPrivateKey: cfg.walletPrivateKey,
        chainEnv: cfg.chainEnv || 'inkMainnet',
      });
    } catch (e) {
      console.warn(`[Nado] LIVE 初始化失败，回退 paper：${e.message}`);
      return new NadoPaper();
    }
  }
  return new NadoPaper();
}
