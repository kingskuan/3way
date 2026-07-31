// Phoenix factory
// Round 209 Phase 1: paper only + LIVE skeleton (需 Solana wallet)
// Round 210 计划: 完整 LIVE (wallet 签名 + Solana instruction submit)
import { PhoenixPaper } from './paper.js';
import { PhoenixExchange } from './phoenix.js';

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.walletPrivateKey) {
      throw new Error(
        'Phoenix LIVE 需要 Solana wallet：设置 PH_WALLET_PRIVATE_KEY (base58 编码) ' +
        '+ PH_SOLANA_RPC_URL。Round 210 完整实现。目前建议 PH_MODE=paper。'
      );
    }
    return new PhoenixExchange({
      walletPrivateKey: cfg.walletPrivateKey,
      solanaRpcUrl: cfg.solanaRpcUrl,
    });
  }
  return new PhoenixPaper({ startBalance: cfg.startBalance });
}
