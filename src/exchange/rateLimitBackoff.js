// Round 276: 通用限流 / 认证失败指数退避模块。
//
// 背景：Phoenix（src/exchange/ph/phoenix.js）之前为了应对 auth 接口的 429 IP 限流，
// 单独写了一套指数退避（60s→120s→…封顶 30min，成功一次 reset）。Extended 只是遇 429
// 直接 throw 不重试，Ondo 是遇 429 给 60s 固定节流。三家各写各的、行为不一致。
// 这里把 Phoenix 那套（已经过多轮生产验证稳定）抽成通用模块，方便所有交易所适配器
// 复用同一套退避逻辑，而不是每家各自发明一遍。
//
// 用法示例：
//   import { RateLimitBackoff, isRateLimitOrAuthError } from '../rateLimitBackoff.js';
//   this._authBackoff = new RateLimitBackoff({ baseMs: 60_000, capMs: 1_800_000, label: 'Phoenix auth' });
//   ...
//   if (this._authBackoff.isActive()) throw new Error(this._authBackoff.describe());
//   try { await doRequest(); this._authBackoff.reset(); }
//   catch (e) { if (isRateLimitOrAuthError(e.message)) this._authBackoff.bump(); throw e; }

export class RateLimitBackoff {
    constructor({ baseMs = 60_000, capMs = 1_800_000, label = '' } = {}) {
          this.baseMs = baseMs;
          this.capMs = capMs;
          this.label = label;
          this._ms = 0;
          this._until = 0;
        }

    // 是否仍在退避窗口内
    isActive() {
          return !!this._until && Date.now() < this._until;
        }

    remainingSec() {
          return this._until ? Math.max(0, Math.round((this._until - Date.now()) / 1000)) : 0;
        }

    // 触发一次退避：首次 baseMs，之后每次翻倍，封顶 capMs
    bump() {
          const cur = this._ms || 0;
          const next = cur > 0 ? Math.min(cur * 2, this.capMs) : this.baseMs;
          this._ms = next;
          this._until = Date.now() + next;
          return next;
        }

    // 成功一次后清零退避计数
    reset() {
          this._ms = 0;
          this._until = 0;
        }

    describe() {
          return `${this.label ? this.label + ' ' : ''}backoff 中（还有 ${this.remainingSec()}s）`;
        }

    status() {
          return {
                  backoffMs: this._ms || 0,
                  backoffUntil: this._until || 0,
                  backoffRemainingSec: this.remainingSec(),
                };
        }
  }

// 判断错误信息是否属于"限流/认证失败"类别，值得触发退避
// （避免对所有错误都无脑退避，只在真的被 429/401/403/rate-limit 拒绝时才退避）
export function isRateLimitOrAuthError(msg) {
    return /429|rate.?limit|too many requests|unauthorized|401|403/i.test(String(msg || ''));
  }
