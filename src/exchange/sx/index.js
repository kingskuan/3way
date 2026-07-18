import { StandXPaper } from './paper.js';
import { StandXExchange } from './standx.js';

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.privateKey) {
      // 没配 private key 就 fallback 到 paper（用户看到 SX: PAPER，不会崩）
      console.warn('[StandX] SX_PRIVATE_KEY 未设置，回退到 paper 模式');
      return new StandXPaper({ startBalance: cfg.startBalance || 10000 });
    }
    return new StandXExchange({ chain: cfg.chain || 'bsc', privateKey: cfg.privateKey });
  }
  return new StandXPaper({ startBalance: cfg.startBalance || 10000 });
}
