// Lighter 工厂：paper 走 LighterPaper，live 走 LighterExchange（读端可用，写端待 Go 签名器 FFI）。
// Round 首发：user 用 LT_API_KEY_PRIVATE_KEY + LT_ACCOUNT_INDEX (+ 可选 LT_API_KEY_INDEX) 启用 LIVE。
// 写端会在 Round N+1 引入 ffi-napi 加载 Go 签名器 .so 后打通。
import { LighterPaper } from './paper.js';
import { LighterExchange } from './lighter.js';

export function createExchange(cfg) {
  if (cfg.mode === 'live') {
    // 只要给了 accountIndex 就能进 LIVE（read-only 也可用来显示真数据）；
    // privateKey 存在则将来 Go 签名器接入后自动升级为可写。缺 accountIndex 直接报错。
    if (!Number.isFinite(Number(cfg.accountIndex)) || Number(cfg.accountIndex) < 0) {
      throw new Error(
        'Lighter LIVE 模式需要 LT_ACCOUNT_INDEX（正整数，你在 zklighter.elliot.ai 上的账户 index，'
        + '打开钱包连接 Lighter 页面看 Account Info 里的 Index 值）'
      );
    }
    return new LighterExchange({
      privateKey: cfg.privateKey,
      accountIndex: Number(cfg.accountIndex),
      apiKeyIndex: Number(cfg.apiKeyIndex ?? 0),
      apiUrl: cfg.apiUrl,
      chainId: cfg.chainId,       // Round 279: 传网络 chain_id 给 SignerClient
      network: cfg.network,
    });
  }
  return new LighterPaper({ startBalance: cfg.startBalance });
}
