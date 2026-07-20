// Bitget factory
// Phase 1 (Round 82)：只有 paper mode。LIVE 走 bitget.js 待 Phase 2 接入。
import { BitgetPaper } from './paper.js';

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    // Phase 1 保护：如果用户开了 LIVE 但 bitget.js 还没实现，直接 throw 而不是
    // 静默走 paper——避免用户以为在跑实盘却其实是合成。
    throw new Error(
      'Bitget LIVE 模式尚未实现（Round 82 只完成 paper 骨架）。' +
      '把 .env 里 BG_MODE 改回 paper，或等 Round 83 接入 LIVE。'
    );
  }
  return new BitgetPaper({ startBalance: cfg.startBalance });
}
