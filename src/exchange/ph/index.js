// Phoenix factory
// Round 209 完整实现：paper + LIVE（Solana wallet 签名 + instruction submit）
// phoenix.js 依赖 @solana/web3.js + bs58，用 lazy import 让 paper 模式无需这两个包
// 也能正常工作（未 npm install 时不会 crash）。
import { PhoenixPaper } from './paper.js';

export async function createExchange(cfg) {
  if (cfg.mode === 'live') {
    if (!cfg.walletPrivateKey) {
      throw new Error(
        'Phoenix LIVE 需要 Solana wallet：设置 PH_WALLET_PRIVATE_KEY (base58 编码 64-byte secret) ' +
        '+ 可选 PH_SOLANA_RPC_URL（默认 mainnet-beta）。Wallet 里要有 USDC 保证金。'
      );
    }
    const { PhoenixExchange } = await import('./phoenix.js');
    return new PhoenixExchange({
      walletPrivateKey: cfg.walletPrivateKey,
      solanaRpcUrl: cfg.solanaRpcUrl,
    });
  }
  return new PhoenixPaper({ startBalance: cfg.startBalance });
}
