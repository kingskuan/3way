// GridBot: orchestrates an arithmetic grid on one market. Places the initial
// ladder of limit orders, and on every fill places the opposite order one rung
// away (buy->sell up, sell->buy down), capturing `spacing * size` per round.
// Risk controls: leverage cap, margin pre-check, fee/spacing check, out-of-range
// alerts (optional auto-stop), periodic open-order reconciliation, crash-safe
// persistence with resume-on-restart, live range adjustment, and a health probe.
import { buildGrid, seedOrders, replacementFor, isReduceOnly } from './grid.js';

const RECONCILE_MS = 30000;   // periodic open-order reconciliation cadence
const PRUNE_GRACE_MS = 20000; // don't prune a tracked order younger than this

export class GridBot {
  constructor(exchange, opts = {}) {
    this.ex = exchange;
    this.running = false;
    this.config = null;
    this.grid = null;
    this.active = new Map();        // orderId -> {levelIndex, side, price, opening, placedAt}
    this.fills = [];                // recent fills (capped)
    this.alerts = [];               // recent alerts (capped)
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.startBalance = null;
    this.lastPrice = null;
    this.outOfRange = false;
    this.risk = null;
    this._stopping = false;         // re-entrancy guard for auto-stop
    this._coidSeq = 0;              // monotonic client-order-id counter
    this._placeFails = 0;          // cumulative order-placement failures
    this._lastFailAt = 0;
    this._exchangeOpenOrders = null; // last reconciled real open-order count
    this._pendingLevels = new Set(); // levels with a placement in flight (dedup guard)
    this._recoveryOccupied = new Set(); // recovery: real exchange-occupied levels (from reconcile)
    this._reconTimer = null;
    this.recovery = false;          // standalone reduce-only recovery mode
    this._onChange = typeof opts.onChange === 'function' ? opts.onChange : null; // persistence hook
    this._onFill = (f) => this._handleFill(f);
    this._onPrice = (p) => this._handlePrice(p);
    // CRITICAL: an EventEmitter that emits 'error' with no listener crashes the
    // whole Node process. Adapters emit 'error' on cancelled/rejected orders, so
    // we MUST always have a listener attached for the bot's whole lifetime.
    this._onError = (e) => this._handleExError(e);
    this.ex.on('error', this._onError);
    this._cancelTimes = [];          // timestamps of recent order cancellations
    this._refillPausedUntil = 0;     // back-off window: pause new placements until this time
    this._lastErrAlertAt = 0;
    this._lastErrLogAt = 0;
    this._retryQueue = [];           // failed CLOSING-leg placements awaiting retry (never opening legs)
    this._noPosStreak = 0;           // consecutive empty-position observations (recovery finish guard)
    this._pnlBase = null;            // realizedPnl baseline; resetStats uses an offset because some
                                     // adapters (RISEx) re-fetch realizedPnl from the exchange every poll
  }

  /**
   * Handle an 'error' emitted by the exchange adapter. Never throws (that would
   * crash the process). Records a throttled alert, and — if orders are being
   * cancelled rapidly (the tell-tale of collateral exhaustion or manual
   * intervention) — pauses auto-refill so we stop hammering the exchange and
   * burning gas on orders that just get rejected.
   */
  _handleExError(e) {
    const msg = (e && e.message) ? e.message : String(e);
    const now = Date.now();
    if (now - this._lastErrLogAt > 3000) { this._lastErrLogAt = now; try { console.error('[交易所事件] ' + msg); } catch {} }
    if (now - this._lastErrAlertAt > 5000) { this._lastErrAlertAt = now; this._alert('交易所事件: ' + msg); }

    if (/取消|cancel|collateral|保证金|reject/i.test(msg)) {
      this._cancelTimes.push(now);
      this._cancelTimes = this._cancelTimes.filter((t) => now - t < 60000); // last 60s
      if (this._cancelTimes.length >= 5 && now >= this._refillPausedUntil) {
        this._refillPausedUntil = now + 60000;
        this._alert('⚠️ 检测到 60 秒内多笔订单被取消（疑似保证金不足或手动撤单），已暂停自动补单 60 秒，避免反复被拒、浪费手续费。请检查保证金/减小持仓。');
      }
    }
  }

  /** Notify the persistence layer (if any) that durable state changed. */
  _changed() { try { this._onChange?.(this.snapshot()); } catch { /* never let persistence break trading */ } }

  /** Durable snapshot for crash recovery / resume. Includes resting orders. */
  snapshot() {
    return {
      running: this.running, config: this.config, stats: this.stats,
      recovery: this.recovery, pnlBase: this._pnlBase,
      startBalance: this.startBalance, outOfRange: this.outOfRange, lastPrice: this.lastPrice,
      active: [...this.active.entries()],
    };
  }

  /**
   * Restore display/accounting state after a process restart WITHOUT resuming
   * trading (running stays false). Used when we only want continuity of stats.
   */
  restore(snap) {
    if (!snap || !snap.config) return;
    this.config = snap.config;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    try {
      this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
      this._recomputeRisk();
    } catch { /* config may be incomplete */ }
  }

  /**
   * Resume a grid that was running when the process died: re-attach to the
   * orders still resting on the exchange (rebuilding both our tracking and the
   * adapter's), restart listeners, then reconcile against the real book.
   */
  async resume(snap) {
    if (!snap || !snap.config) throw new Error('无可恢复的运行中网格快照');
    if (this.running) throw new Error('已在运行，无法重复恢复');
    // Standalone recovery ladder has no grid (gridCount=null): resume it via its
    // own path — the old code fell into buildGrid, threw, and the fallback then
    // CANCELLED the whole ladder while the position stayed open.
    if (snap.recovery || snap.config.mode === 'recovery') return this._resumeRecovery(snap);
    if (!Array.isArray(snap.active)) throw new Error('无可恢复的运行中网格快照');
    this.config = snap.config;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this.outOfRange = !!snap.outOfRange;
    this.lastPrice = snap.lastPrice ?? null;
    this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
    this._recomputeRisk();

    // Rebuild our active map AND the adapter's order tracking so fills on these
    // pre-existing orders are detected.
    this.active.clear();
    for (const [id, info] of snap.active) {
      const oid = String(id);
      this.active.set(oid, { ...info, placedAt: info.placedAt ?? Date.now() });
      if (typeof this.ex.adoptOrder === 'function') {
        try {
          this.ex.adoptOrder({
            orderId: oid, marketId: this.config.marketId, levelIndex: info.levelIndex,
            side: info.side, price: info.price, sizeBase: info.sizeBase ?? this.config.sizeBase,
          });
        } catch { /* best effort */ }
      }
    }

    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this.running = true;
    this._startReconcileTimer();
    this._alert(`已恢复运行中的 ${this.config.displayName} ${labelMode(this.config.mode)}：接管 ${this.active.size} 个挂单，正在与交易所对账…`);
    this.reconcileOpenOrders().catch(() => {}); // immediate reconcile
    this._changed();
    return this.getState();
  }

  /** Resume a standalone reduce-only recovery ladder after a process restart. */
  async _resumeRecovery(snap) {
    this.config = snap.config;
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0, ...(snap.stats || {}) };
    this.startBalance = snap.startBalance ?? null;
    this._pnlBase = snap.pnlBase ?? null;
    this.grid = null; this.risk = null;
    this.recovery = true; this.outOfRange = false;
    this.lastPrice = snap.lastPrice ?? null;
    this._noPosStreak = 0; this._retryQueue = [];
    this.active.clear();
    for (const [id, info] of (Array.isArray(snap.active) ? snap.active : [])) {
      const oid = String(id);
      this.active.set(oid, { ...info, placedAt: info.placedAt ?? Date.now() });
      try {
        this.ex.adoptOrder?.({
          orderId: oid, marketId: this.config.marketId, levelIndex: info.levelIndex,
          side: info.side, price: info.price, sizeBase: info.sizeBase ?? this.config.sizeBase,
        });
      } catch { /* best effort */ }
    }
    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();
    this.running = true;
    // seed the adapter's price watch + refresh lastPrice
    const px = await this.ex.getPrice(this.config.marketId).catch(() => null);
    if (px > 0) this.lastPrice = px;
    this._recoveryOccupied = new Set();
    this._alert(`已恢复 ${this.config.displayName} 的「只减仓回收阶梯」：接管 ${this.active.size} 个挂单，正在与交易所对账…`);
    await this.reconcileOpenOrders().catch(() => {});
    this._startReconcileTimer();
    this._changed();
    return this.getState();
  }

  /**
   * Fallback recovery: cancel any resting orders from a previous run (used when
   * resume is not desired or fails).
   */
  async recoverStrayOrders() {
    if (!this.config) return;
    await this.ex.cancelAll(this.config.marketId).catch(() => {});
    this._alert('⚠️ 检测到上次运行未正常结束：已撤销该市场遗留挂单。请确认仓位后重新启动网格。');
    this._changed();
  }

  /** @param cfg {marketId, mode, lower, upper, gridCount, sizeBase, leverage, outOfRangeAction} */
  async start(cfg) {
    if (this.running || this._starting) throw new Error('机器人已在运行或正在启动，请勿重复点击。');
    this._starting = true;
    try { return await this._start(cfg); }
    finally { this._starting = false; }
  }

  async _start(cfg) {
    const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
    if (!market) throw new Error('找不到该市场 marketId=' + cfg.marketId);

    // Round 71：切换 marketId 时先清老市场的挂单 + 平老仓位。
    // 之前 bot.start(newMarket) 只对 newMarket cancelAll（0 单），老市场
    // 的挂单和仓位全留下。StandX 用户切 BTC→ETH→SOL 三次留 60 单 + 2 仓
    // 就是这。Ondo 不出问题因为一直只跑 BTC-USD.P，没换过市场。
    if (this.config && Number(this.config.marketId) !== Number(market.marketId)) {
      const oldName = this.config.displayName || `marketId=${this.config.marketId}`;
      try { await this.ex.cancelAll(this.config.marketId); } catch { /* best effort */ }
      if (typeof this.ex.closePosition === 'function') {
        try { await this.ex.closePosition(this.config.marketId); } catch { /* best effort */ }
      }
      // Round 146 Bug 3：切市场清 fills。以前不清 → autopilot Round 121 stop-idle
      // 停 A → 起 B 后，fills[0].t 仍是 A 市场的老时间戳 → autopilot 下一 tick 立刻
      // 判"30 分钟无成交"再 rotate → 每 15 分钟轮一次，B 根本没机会跑。
      this.fills = [];
      this._alert(`切换市场：先清老市场 ${oldName} 挂单+平仓，再起 ${market.displayName}`);
    }

    const leverage = Math.min(Number(cfg.leverage || 3), market.maxLeverage || 50);
    const sizeBase = Math.max(Number(cfg.sizeBase), market.minOrderSize || 0);
    this.config = {
      marketId: market.marketId, displayName: market.displayName,
      mode: cfg.mode || 'neutral',
      lower: Number(cfg.lower), upper: Number(cfg.upper),
      gridCount: Number(cfg.gridCount), sizeBase, leverage,
      // 区间外止损策略：'close'=冲破区间平仓（撤单+平仓+停止）；'recover'=只减仓回收阶梯
      outOfRangeAction: cfg.outOfRangeAction === 'recover' ? 'recover' : 'close',
      stepSize: market.stepSize, stepPrice: market.stepPrice,
    };
    this.grid = buildGrid({ lower: this.config.lower, upper: this.config.upper, gridCount: this.config.gridCount });
    // 把每档价格 snap 到市场的 stepPrice（价格 tick）——Ondo 的 API 硬性要求
    // 价格是 tick 的整数倍，不然 "invalid - doesn't snap to min price increment"。
    // 用 tick 的小数位数 toFixed 消除浮点残尾（关键：Math.round(1978.83/0.1)*0.1
    // 会产出 1978.8000000000002，Ondo 拒）。
    if (market.stepPrice > 0) {
      const tick = market.stepPrice;
      const dp = Math.max(0, Math.min(10, -Math.floor(Math.log10(tick))));
      this.grid.levels = this.grid.levels.map((lv) => Number((Math.round(lv / tick) * tick).toFixed(dp)));
    }
    this._recomputeRisk();
    this._refillPausedUntil = 0; this._cancelTimes = []; // fresh start clears any back-off
    this._retryQueue = []; this._noPosStreak = 0;
    this._reseedCount = 0; this._lastReseedAt = 0; this._vanishStreak = 0;
    this.recovery = false;

    // record the starting equity up front (margin pre-check, returnPct, recovery)
    if (this.startBalance == null) {
      this.startBalance =
        typeof this.ex.equity === 'number' ? this.ex.equity
        : typeof this.ex.balance === 'number' ? this.ex.balance
        : null;
    }

    // ---- margin pre-check ----
    const requiredMargin = this.risk.requiredMargin;
    const available = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : null;
    if (available != null) {
      if (requiredMargin > available) {
        throw new Error(`保证金不足：该网格约需 ${round2(requiredMargin)} USDC（名义敞口 ${this.risk.notional}，${leverage}x），当前可用 ${round2(available)} USDC。请降低每格数量/网格数，或提高杠杆/充值后再启动。`);
      }
      if (requiredMargin > available * 0.8) {
        this._alert(`⚠️ 保证金占用偏高：约 ${round2(requiredMargin)} / 可用 ${round2(available)} USDC（>80%），价格波动时有强平风险。`);
      }
    }

    // ---- fee vs spacing sanity check ----
    const feeRate = Number(this.ex.feeRate) || 0.0005;
    const roundTripFeePct = feeRate * 2 * 100;
    if (this.risk.spacingPct <= roundTripFeePct) {
      this._alert(`⚠️ 网格间距 ${this.risk.spacingPct}% 不足以覆盖往返手续费（约 ${round2(roundTripFeePct)}%），每完成一格可能亏损。建议拉大间距或减少网格数。`);
    }

    const levOk = await this.ex.setLeverage(market.marketId, leverage).catch(() => false);
    if (levOk === false) this._alert(`⚠️ 杠杆设置 ${leverage}x 未生效，将沿用交易所端该市场的当前杠杆，请在交易所网页端核实后再继续。`);
    await this.ex.cancelAll(market.marketId).catch(() => {});

    this.lastPrice = await this.ex.getPrice(market.marketId);
    if (!Number.isFinite(this.lastPrice) || this.lastPrice <= 0) {
      throw new Error('未能获取有效的最新价（行情中断），已取消启动以免错挂网格单。请稍后重试。');
    }
    if (this.lastPrice < this.config.lower * 0.5 || this.lastPrice > this.config.upper * 2) {
      throw new Error(`最新价 ${this.lastPrice} 与网格区间 [${this.config.lower}, ${this.config.upper}] 偏离过大，已取消启动。请刷新行情后重设区间。`);
    }
    this.outOfRange = this.lastPrice < this.config.lower || this.lastPrice > this.config.upper;

    this.ex.on('fill', this._onFill);
    this.ex.on('price', this._onPrice);
    if (typeof this.ex.start === 'function') this.ex.start();

    // ---- seed the ladder (every seed order is an OPENING leg) ----
    const seeds = seedOrders({ levels: this.grid.levels, price: this.lastPrice, mode: this.config.mode, spacing: this.grid.spacing });
    for (const s of seeds) await this._place({ ...s, opening: true });

    if (this.startBalance == null && typeof this.ex.balance === 'number') this.startBalance = this.ex.balance;
    this.running = true;
    this._startReconcileTimer();
    this._alert(`已启动 ${this.config.displayName} ${labelMode(this.config.mode)}，${this.grid.count} 格，间距 ${this.grid.spacing}（${this.risk.spacingPct}%），杠杆 ${leverage}x，挂出 ${this.active.size} 单。`);
    this._changed();
    return this.getState();
  }

  async stop({ closePosition = true } = {}) {
    this._stopReconcileTimer();
    if (!this.running) {
      if (this.config) {
        // Round 60: cancelAll 若成功（不 throw）说明链上已清干净（Round 51 加过
        // finalCheck）。重置 _exchangeOpenOrders=0 让 sentinel 别再报"停止但
        // 仍剩 N 单"陈旧信息。cancelAll throw 则保持旧值（真有残留）。
        let cancelOk = false;
        try { await this.ex.cancelAll(this.config.marketId); cancelOk = true; }
        catch { cancelOk = false; }
        if (cancelOk) this._exchangeOpenOrders = 0;
        if (closePosition && typeof this.ex.closePosition === 'function') {
          await this._closeWithConfirm(this.config.marketId);
        }
        this._alert('已尝试撤销该市场的所有挂单并平仓。');
      }
      this.active.clear();
      this._retryQueue = [];
      this._changed();
      return this.getState();
    }
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    // Round 60: 同上——cancelAll 成功即清空 _exchangeOpenOrders
    let cancelOk2 = false;
    try { await this.ex.cancelAll(this.config.marketId); cancelOk2 = true; }
    catch { cancelOk2 = false; }
    if (cancelOk2) this._exchangeOpenOrders = 0;
    this.active.clear();
    let closeRequested = false;
    if (closePosition && typeof this.ex.closePosition === 'function') {
      await this._closeWithConfirm(this.config.marketId);
      closeRequested = true;
    }
    this.running = false;
    this.recovery = false;
    this._retryQueue = [];
    this._alert(closeRequested
      ? '机器人已停止：挂单已撤销，已发送平仓指令（请在交易所确认仓位已平）。'
      : '机器人已停止，挂单已撤销（未平仓）。');
    this._changed();
    return this.getState();
  }

  /**
   * One-click: cancel ALL resting orders for this market WITHOUT touching the
   * open POSITION. Also stops the grid (running=false) and detaches handlers so
   * no later automated action (fill replacements / auto-stop) can affect the
   * position afterwards. To resume trading, start the grid again.
   */
  async cancelAllOrders() {
    if (!this.config) throw new Error('尚未配置市场，没有可撤的挂单。');
    this._stopReconcileTimer();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    // Round 52：不再 .catch 静默；让 cancelAll 的 error propagate 到 UI
    // 用户之前看不到"6 轮后链上仍剩 48 单"这种关键消息，以为撤单成功了。
    let cancelErr = null;
    try {
      await this.ex.cancelAll(this.config.marketId);
      // Round 60: 成功 = 链上真的清干净了 → 同步 _exchangeOpenOrders=0
      this._exchangeOpenOrders = 0;
    } catch (e) {
      cancelErr = e;
      this._alert('撤单失败: ' + (e?.message || e));
    }
    this.active.clear();
    this.running = false;
    this._refillPausedUntil = 0; this._cancelTimes = []; this._retryQueue = [];
    this._changed();
    if (cancelErr) throw cancelErr;   // 关键：让 server /cancel-orders 返 400 + error 消息给 UI
    this._alert('已一键撤销该市场全部挂单（持仓保留、未平仓）。网格已停止，如需继续请重新启动。');
    return this.getState();
  }

  /**
   * Adjust the grid's price range WITHOUT stopping. Margin is re-checked against
   * the new range; if it passes, current orders are cancelled and the ladder is
   * re-seeded around the live price. The open POSITION is left untouched.
   */
  async adjustRange({ lower, upper }) {
    if (!this.running || !this.config) throw new Error('网格未在运行，无法调整区间。');
    const lo = Number(lower), hi = Number(upper);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) throw new Error('上边界必须大于下边界。');
    const price = this.lastPrice;
    if (Number.isFinite(price) && (price < lo * 0.5 || price > hi * 2)) {
      throw new Error(`新区间 [${lo}, ${hi}] 与当前价 ${round2(price)} 偏离过大，已取消调整。`);
    }
    const newGrid = buildGrid({ lower: lo, upper: hi, gridCount: this.config.gridCount });
    const mid = (lo + hi) / 2;
    const notional = newGrid.count * this.config.sizeBase * mid;
    const requiredMargin = notional / this.config.leverage;
    const available = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : null;
    if (available != null && requiredMargin > available) {
      throw new Error(`保证金不足以支持新区间：约需 ${round2(requiredMargin)} USDC，当前可用 ${round2(available)} USDC。请缩小区间/减少格数后再试。`);
    }

    await this.ex.cancelAll(this.config.marketId).catch(() => {});
    this.active.clear();
    this._refillPausedUntil = 0; this._cancelTimes = []; // user re-set the range: clear back-off
    this.config = { ...this.config, lower: lo, upper: hi };
    this.grid = newGrid;
    this._recomputeRisk();
    this.outOfRange = Number.isFinite(price) ? (price < lo || price > hi) : false;
    if (!this.outOfRange && Number.isFinite(price) && price > 0) {
      const seeds = seedOrders({ levels: newGrid.levels, price, mode: this.config.mode, spacing: newGrid.spacing });
      for (const s of seeds) await this._place({ ...s, opening: true });
    }
    this._alert(`已调整区间为 [${lo}, ${hi}]，${newGrid.count} 格，间距 ${newGrid.spacing}（${this.risk.spacingPct}%），重新挂出 ${this.active.size} 单（持仓保留）。`);
    this._changed();
    return this.getState();
  }

  /** Zero cumulative stats and re-baseline PnL to the current equity. */
  resetStats() {
    this.stats = { buys: 0, sells: 0, completedRungs: 0, gridProfit: 0, volume: 0 };
    this.fills = [];
    this._placeFails = 0;
    this._lastFailAt = 0;
    this._refillPausedUntil = 0; this._cancelTimes = [];
    this.startBalance = typeof this.ex.equity === 'number' ? this.ex.equity
      : typeof this.ex.balance === 'number' ? this.ex.balance : this.startBalance;
    // Offset-based reset: adapters like RISEx refresh realizedPnl from the
    // exchange every poll, so writing 0 into it never sticks — record a
    // baseline instead and subtract it in getState.
    this._pnlBase = typeof this.ex.realizedPnl === 'number' ? this.ex.realizedPnl : null;
    this._alert('已重置统计：已实现盈亏、收益率、成交量、完成格数清零，并以当前权益为新基准。');
    this._changed();
    return this.getState();
  }

  _recomputeRisk() {
    if (!this.grid || !this.config) return;
    const mid = (this.config.lower + this.config.upper) / 2;
    const notional = this.grid.count * this.config.sizeBase * mid;
    this.risk = {
      leverage: this.config.leverage,
      notional: round2(notional),
      requiredMargin: round2(notional / this.config.leverage),
      perRungProfit: round2(this.grid.spacing * this.config.sizeBase),
      spacingPct: round2((this.grid.spacing / mid) * 100),
    };
  }

  async _place(o) {
    const opening = o.opening !== false;
    const reduceOnly = o.reduceOnly ?? isReduceOnly(o.side, this.config.mode);
    // Back-off: while paused (after a burst of cancellations / collateral
    // rejections) do not place new OPENING orders. CLOSING / reduce-only /
    // recovery legs need no extra margin and are never blocked — dropping a
    // take-profit leg would strand its inventory without an exit order.
    if (opening && !o.recovery && this._refillPausedUntil && Date.now() < this._refillPausedUntil) return;
    // INVARIANT: at most ONE resting order per grid level. If this level is
    // already covered (or a placement for it is in flight), skip. Stacking a
    // second order on an occupied level is exactly what made the open-order
    // count creep up over time (replacement-one-rung-away colliding with the
    // order already resting there).
    const lvl = o.levelIndex;
    if (this._pendingLevels.has(lvl)) return;
    for (const a of this.active.values()) if (a.levelIndex === lvl) return;
    this._pendingLevels.add(lvl);
    const seq = (++this._coidSeq) % 1_000_000;
    const clientOrderId = Number(`${Date.now() % 1_000_000_0}${String(seq).padStart(6, '0')}`);
    const sizeBase = Number(o.sizeBase) > 0 ? Number(o.sizeBase) : this.config.sizeBase; // per-order override (partial fills)
    try {
      const r = await this.ex.placeLimitOrder({
        marketId: this.config.marketId, side: o.side, price: o.price,
        sizeBase, reduceOnly,
        levelIndex: o.levelIndex, clientOrderId,
        // Round 106：Perpl 没 setLeverage account-level 概念，杠杆必须每单带；不带
        // 就 fallback 到 exchange 层的 _defaultLeverage=3 → user 设 15x 但仓位
        // 一直开 3x。其他 DEX（Extended/Bitget/StandX）忽略这个字段无副作用。
        leverage: this.config.leverage,
      }).catch((e) => {
        this._placeFails++; this._lastFailAt = Date.now();
        this._alert('下单失败: ' + e.message);
        this._queueRetry({ ...o, opening, reduceOnly, sizeBase }); // closing legs get retried
        return null;
      });
      if (r?.orderId) this.active.set(String(r.orderId), { levelIndex: lvl, side: o.side, price: o.price, sizeBase, opening, recovery: !!o.recovery, placedAt: Date.now() });
    } finally {
      this._pendingLevels.delete(lvl);
    }
  }

  /**
   * Queue a failed placement for retry.
   * - CLOSING / reduce-only legs get 5 tries (can never ADD inventory; retrying
   *   always safe; silently dropping one strands its take-profit forever).
   * - Round 145: OPENING legs (replacement buys after neutral sell fills, etc.)
   *   get 3 tries. Before Round 145 they were dropped silently → over 30 min
   *   of sideways trading, opening-leg replacements accumulated to a gap
   *   centered on the price (user QC Bitunix screenshot: 5 empty grids in
   *   middle). Runaway rejects are still bounded by `_refillPausedUntil`
   *   (60s pause after 5+ cancel/reject bursts in 60s), so bounded retry
   *   here can't spin API rate-limit.
   */
  _queueRetry(o) {
    const isOpening = o.opening !== false && !o.reduceOnly && !o.recovery;
    const cap = isOpening ? 3 : 5;
    const tries = (o._tries || 0) + 1;
    if (tries > cap) {
      const label = isOpening ? '补挂开仓单' : '补挂平仓单';
      this._alert(`❌ ${label}（level ${o.levelIndex} @ ${o.price}）连续 ${tries - 1} 次失败，已放弃。请到交易所核实并手动挂单。`);
      return;
    }
    this._retryQueue.push({ ...o, _tries: tries, _nextAt: Date.now() + 5000 * tries }); // linear back-off
  }

  /** Retry due closing-leg placements (driven by price ticks + reconcile timer). */
  _drainRetryQueue() {
    if (!this.running || !this._retryQueue.length) return;
    const now = Date.now();
    const due = [];
    this._retryQueue = this._retryQueue.filter((o) => (o._nextAt <= now ? (due.push(o), false) : true));
    for (const o of due) this._place(o); // _place re-queues on failure with tries+1
  }

  _handleFill(f) {
    // Round 107：诊断 rungs=0 但 volume>0 —— Ondo/StandX/Bitget UI 显示大量成交
    // 量但 completedRungs=0，怀疑 fill event 的 marketId 跟 config.marketId 类型
    // 或值对不上（Number vs String, "BTC-USD" vs "BTC-USD.P"），静默 return 掉了。
    // 头 3 次不 match log 一次帮定位。
    if (!this.running) return;
    if (f.marketId !== this.config.marketId) {
      if (!this._fillMismatchLogged) this._fillMismatchLogged = 0;
      if (this._fillMismatchLogged < 3) {
        this._fillMismatchLogged++;
        try { console.log(`[bot] fill 事件 marketId 对不上 → 丢弃。fill.marketId=${JSON.stringify(f.marketId)} (${typeof f.marketId}) vs config.marketId=${JSON.stringify(this.config.marketId)} (${typeof this.config.marketId})`); } catch {}
      }
      return;
    }
    const id = String(f.orderId);
    const act = this.active.get(id);
    this.active.delete(id);
    const levelIndex = act?.levelIndex ?? f.levelIndex;
    const fillPrice = Number.isFinite(f.price) ? f.price : (act?.price ?? 0);
    const fillSize = Number.isFinite(f.sizeBase) ? f.sizeBase : this.config.sizeBase;

    if (f.side === 'buy') this.stats.buys++; else this.stats.sells++;
    this.stats.volume = round2(this.stats.volume + fillPrice * fillSize);
    this.fills.unshift({ t: Date.now(), side: f.side, price: fillPrice, size: fillSize, level: levelIndex });
    if (this.fills.length > 50) this.fills.pop();

    const isRecovery = !!(act && act.recovery);
    const closing = isRecovery ? true
      : (act ? act.opening === false
             : ((this.config.mode === 'short') ? f.side === 'buy' : f.side === 'sell'));
    if (closing) {
      this.stats.completedRungs++;
      // Incremental accumulation with the ACTUAL fill size: adjustRange no longer
      // rewrites history (the old code recomputed rungs × CURRENT spacing), and
      // partial fills are credited with what really executed.
      const sp = this.grid?.spacing ?? this.config.spacing ?? 0;
      this.stats.gridProfit = round2(this.stats.gridProfit + sp * fillSize);
    }

    // Recovery-ladder fills are pure reduce-only EXITS of stranded inventory —
    // never re-quote a replacement for them.
    if (!isRecovery && this.grid) {
      const repl = replacementFor({ side: f.side, levelIndex }, this.grid.levels, this.config.mode);
      if (repl && !this.outOfRange && this.running) {
        repl.opening = closing; // replacement is the opposite leg
        if (fillSize > 0) repl.sizeBase = fillSize; // partial fill: mirror the actually-filled qty
        this._place(repl);
      }
    }
    this._changed();
  }

  _handlePrice(p) {
    if (p.marketId !== this.config.marketId) return;
    this.lastPrice = p.price;
    this._drainRetryQueue();
    if (this.recovery) { this._manageRecoveryStandalone(); return; }
    const out = p.price < this.config.lower || p.price > this.config.upper;
    const action = this.config.outOfRangeAction || 'close';
    if (out && !this.outOfRange) {
      this.outOfRange = true;
      const where = p.price < this.config.lower ? '跌破下边界' : '突破上边界';
      if (action === 'recover') {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），启用「只减仓回收阶梯」：暂停补单，挂出 reduce-only 单等回调分批减仓（只减不加、不自动止损，请自行控制风险）。`);
        this._placeRecoveryLadder();
      } else {
        this._alert(`⚠️ 价格${where}（${round2(p.price)}），触发「冲破区间平仓」：撤单 + 平仓 + 停止。`);
        if (!this._stopping) {
          this._stopping = true;
          this.stop({ closePosition: true }).finally(() => { this._stopping = false; });
        }
      }
    } else if (out && this.outOfRange && action === 'recover') {
      this._placeRecoveryLadder(); // extend the ladder as price makes new extremes (dedup keeps it idempotent)
    } else if (!out && this.outOfRange) {
      this.outOfRange = false;
      this._cancelRecoveryLadder();
      this._alert(`价格回到区间内（${round2(p.price)}），撤销回收阶梯，恢复正常网格运行。`);
    }
  }

  /**
   * 只减仓回收阶梯：价格冲出区间后，在「现价 ↔ 被冲破的边界」之间挂一批 reduce-only
   * 单。价格每回调一档就分批了结被套住的库存。reduce-only 保证「只减不加」（永远不会
   * 把套牢的仓位越加越大）；本策略不自动止损 —— 趋势继续单边延续会一直扛着。
   */
  _placeRecoveryLadder() {
    if (!this.running || !this.outOfRange || !this.grid) return;
    if ((this.config.outOfRangeAction || 'close') !== 'recover') return;
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !pos.sizeBase) return; // 没有可减的持仓
    const sp = this.grid.spacing, lvl0 = this.grid.levels[0];
    const L = this.config.lower, U = this.config.upper;
    const long = pos.sizeBase > 0;
    const existing = new Set([...this.active.values()].filter((o) => o.recovery).map((o) => o.levelIndex));
    const maxRungs = this.grid.count;
    let placed = 0;
    const room = () => existing.size + placed < maxRungs;
    if (long && price < L) {
      // 跌破下边界、手里是多头：在「现价 ↔ 下边界」之间挂 reduce-only 卖单
      for (let lv = L - sp; lv > price && room(); lv -= sp) {
        const idx = Math.round((lv - lvl0) / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'sell', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    } else if (!long && price > U) {
      // 突破上边界、手里是空头：在「上边界 ↔ 现价」之间挂 reduce-only 买单
      for (let lv = U + sp; lv < price && room(); lv += sp) {
        const idx = Math.round((lv - lvl0) / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'buy', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    }
    if (placed) {
      this._alert(`回收阶梯：新挂 ${placed} 个 reduce-only ${long ? '卖' : '买'}单，等回调分批减仓。`);
      this._changed();
    }
  }

  /** Cancel all recovery-ladder orders (when price returns into range). */
  async _cancelRecoveryLadder() {
    const ids = [...this.active].filter(([, o]) => o.recovery).map(([id]) => id);
    if (!ids.length) return;
    for (const id of ids) {
      await this.ex.cancelOrder?.(this.config.marketId, id)?.catch?.(() => {});
      this.active.delete(id);
    }
    this._alert(`已撤销 ${ids.length} 个回收阶梯挂单。`);
    this._changed();
  }

  // ============ 未托管持仓处置（开机扫描后手动选择）============

  /**
   * 只减仓回收阶梯（独立模式）：对一笔已存在的持仓，挂 reduce-only 单在反弹时分批
   * 减仓；只减不加、不需要新保证金、不自动止损。不需要完整网格。
   */
  async startRecovery(cfg) {
    if (this.running || this._starting) throw new Error('已在运行，请先停止再操作。');
    this._starting = true;
    try {
      const market = (await this.ex.getMarkets()).find((m) => m.marketId === Number(cfg.marketId));
      if (!market) throw new Error('找不到该市场 marketId=' + cfg.marketId);
      const pos = this.ex.getPosition?.(market.marketId);
      if (!pos || !pos.sizeBase) throw new Error('该市场当前没有持仓，无需回收。');
      const price = await this.ex.getPrice(market.marketId);
      if (!Number.isFinite(price) || price <= 0) throw new Error('未能获取有效最新价，请稍后重试。');
      // 阶梯间距：入参 -> 上次网格间距 -> 现价的 0.15%
      let spacing = Number(cfg.spacing) || this.config?.spacing || this.grid?.spacing;
      if (!(spacing > 0)) spacing = Math.max(market.stepPrice || 0.1, price * 0.0015);
      // 每档减仓量：入参 -> 上次每格量 -> 持仓量/20
      let sizeBase = Number(cfg.sizeBase) || this.config?.sizeBase || (Math.abs(pos.sizeBase) / 20);
      sizeBase = Math.max(sizeBase, market.minOrderSize || 0);
      this.config = {
        marketId: market.marketId, displayName: market.displayName, mode: 'recovery',
        sizeBase, spacing, stepSize: market.stepSize, stepPrice: market.stepPrice,
        lower: null, upper: null, gridCount: null, leverage: pos.leverage ?? null,
        outOfRangeAction: 'recover',
        aboveEntryOnly: !!cfg.aboveEntryOnly, // 只在成本价上方(多)/下方(空)、即不亏的价位才挂减仓单
      };
      this.grid = null; this.risk = null;
      this.recovery = true; this.outOfRange = false; this.lastPrice = price;
      this._noPosStreak = 0; this._retryQueue = [];
      this.active.clear();
      if (this.startBalance == null) {
        this.startBalance = typeof this.ex.equity === 'number' ? this.ex.equity
          : typeof this.ex.balance === 'number' ? this.ex.balance : null;
      }
      this.ex.on('fill', this._onFill);
      this.ex.on('price', this._onPrice);
      if (typeof this.ex.start === 'function') this.ex.start();
      this.running = true;
      const dir = pos.sizeBase > 0 ? '多' : '空';
      const modeTxt = this.config.aboveEntryOnly ? '仅在成本价以上(不亏)分批减仓' : '任何反弹都分批减仓';
      this._alert(`已对 ${market.displayName} 的${dir}头 ${Math.abs(round6(pos.sizeBase))} 启用「只减仓回收阶梯」：${modeTxt}（只减不加、不自动止损，请自行控制风险）。`);
      // Seed against any orders ALREADY resting on the exchange (e.g. left over from
      // a prior recovery session) so we adopt/dedup them instead of stacking a whole
      // new ladder on top — the cause of the runaway open-order count.
      this._recoveryOccupied = new Set();
      await this.reconcileOpenOrders().catch(() => {});
      this._manageRecoveryStandalone();
      this._startReconcileTimer(); // keep deduping/pruning the ladder while it runs
      this._changed();
      return this.getState();
    } finally { this._starting = false; }
  }

  /** 市价平仓：撤销该市场全部挂单并立即市价平掉持仓。 */
  async closePositionNow(marketId) {
    const mId = Number(marketId ?? this.config?.marketId);
    if (!Number.isFinite(mId)) throw new Error('未指定市场，无法平仓。');
    this._stopReconcileTimer();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    await this.ex.cancelAll(mId).catch(() => {});
    this.active.clear();
    this._retryQueue = [];
    let closed = false;
    if (typeof this.ex.closePosition === 'function') {
      await this._closeWithConfirm(mId);
      closed = true;
    }
    this.running = false; this.recovery = false;
    this._alert(closed ? '已发送市价平仓指令并撤销该市场挂单（请在交易所确认已平）。' : '已撤销挂单（该交易所不支持自动平仓）。');
    this._changed();
    return this.getState();
  }

  /**
   * Send a market close and CONFIRM the position is actually gone (polls the
   * adapter's position cache). Retries up to 3 times — an IOC close capped at a
   * worst-case price (±5%) can miss entirely when the market moves fast; each
   * retry re-prices from the latest mark. The old code fired once and hoped.
   */
  async _closeWithConfirm(marketId) {
    const mId = Number(marketId);
    if (typeof this.ex.closePosition !== 'function') return false;
    if (!this.ex.getPosition?.(mId)) { await this.ex.closePosition(mId).catch(() => {}); return true; }
    // Round 135：直接 async fetchPositions() 拿真相，不用 sync getPosition() 缓存。
    // 之前用缓存：SX poll ~15s 一次，8s 窗口内可能根本没轮到 refresh → 缓存
    // 是 stale → 3 次都读 stale 数据 → 假报"仓位仍在"。用户 21:35 SX 平仓
    // 其实成功了，QnV 报 "❌ 已尝试 3 次平仓但仓位仍未平掉" 是假警。
    const confirmClosed = async () => {
      if (typeof this.ex.fetchPositions !== 'function') {
        // 适配器没实现 fetchPositions，退化用 sync 缓存
        const pos = this.ex.getPosition?.(mId);
        return !pos || !pos.sizeBase;
      }
      try {
        const list = await this.ex.fetchPositions();
        // 同步刷新 exchange 的 positions Map，让 getPosition() 也拿到真相
        if (this.ex.positions && typeof this.ex.positions.set === 'function') {
          this.ex.positions.delete(mId);
          for (const p of list) {
            if (p.marketId != null) this.ex.positions.set(Number(p.marketId), p);
          }
        }
        const p = list.find((x) => Number(x.marketId) === mId);
        return !p || !p.sizeBase;
      } catch { return false; }
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await this.ex.closePosition(mId); }
      catch (e) { this._alert('平仓指令发送失败: ' + (e?.message || e)); }
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        await sleep(1500);   // 每 1.5s 拉一次，别把交易所 rate limit 打爆
        if (await confirmClosed()) { this._alert('✅ 已确认仓位已平。'); return true; }
      }
      if (attempt < 3) this._alert(`⚠️ 平仓后仓位仍在（第 ${attempt} 次），按最新价重试市价平仓…`);
    }
    this._alert('❌ 已尝试 3 次平仓但仓位仍未平掉，请立即到交易所手动处理！');
    return false;
  }

  /** 独立回收阶梯：始终在现价的"下一档步进"处维持一排 reduce-only 退出单。 */
  _manageRecoveryStandalone() {
    if (!this.running || !this.recovery || !this.config) return;
    const price = this.lastPrice;
    if (!Number.isFinite(price) || price <= 0) return;
    const pos = this.ex.getPosition?.(this.config.marketId);
    if (!pos || !pos.sizeBase) {
      // Require several CONSECUTIVE empty observations before declaring the
      // recovery finished — a single transient empty response from the position
      // endpoint (network blip) must not tear down the whole ladder.
      if (++this._noPosStreak >= 5) this._finishRecovery();
      return;
    }
    this._noPosStreak = 0;
    const sp = this.config.spacing;
    if (!(sp > 0)) return;
    const long = pos.sizeBase > 0;
    // "只在入场价以上(不亏)减仓"：多头只在 >= 成本价挂卖，空头只在 <= 成本价挂买。
    const aboveEntry = !!this.config.aboveEntryOnly;
    const entry = Number(pos.entryPrice) || 0;
    // Rungs needed = enough to fully exit the CURRENT position (not a fixed 30).
    // As fills shrink the position, `need` shrinks too, so the ladder never
    // over-provisions. Hard ceiling guards against a pathological position/step.
    const HARD_MAX = 80;
    const perRung = this.config.sizeBase || (Math.abs(pos.sizeBase) / 20);
    const need = Math.min(HARD_MAX, Math.max(1, Math.ceil(Math.abs(pos.sizeBase) / perRung)));
    // Occupied = our tracked recovery levels UNION the exchange's real resting
    // levels (from reconcile). Using the real set means a spurious "order gone"
    // can't trick us into stacking a second order on a level that is still live.
    const existing = new Set([...this.active.values()].filter((o) => o.recovery).map((o) => o.levelIndex));
    for (const idx of this._recoveryOccupied) existing.add(idx);
    let placed = 0;
    if (long) {
      let lv = Math.ceil(price / sp) * sp; if (lv <= price) lv += sp;
      if (aboveEntry && entry > 0) { const eLv = Math.ceil(entry / sp) * sp; if (lv < eLv) lv = eLv; } // 不在成本价下方卖
      for (let k = 0; k < HARD_MAX && existing.size + placed < need; k++, lv += sp) {
        const idx = Math.round(lv / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'sell', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    } else {
      let lv = Math.floor(price / sp) * sp; if (lv >= price) lv -= sp;
      if (aboveEntry && entry > 0) { const eLv = Math.floor(entry / sp) * sp; if (lv > eLv) lv = eLv; } // 不在成本价上方买
      for (let k = 0; k < HARD_MAX && existing.size + placed < need; k++, lv -= sp) {
        const idx = Math.round(lv / sp);
        if (existing.has(idx)) continue;
        this._place({ levelIndex: idx, side: 'buy', price: lv, reduceOnly: true, recovery: true, opening: false });
        placed++;
      }
    }
    if (placed) this._changed();
  }

  /** 持仓已减完 -> 结束回收。 */
  _finishRecovery() {
    if (!this.recovery) return;
    this.recovery = false;
    this._stopReconcileTimer();
    this._recoveryOccupied = new Set();
    this.ex.off('fill', this._onFill);
    this.ex.off('price', this._onPrice);
    this.ex.cancelAll?.(this.config.marketId)?.catch?.(() => {});
    this.active.clear();
    this.running = false;
    this._alert('回收完成：持仓已全部减完，回收阶梯已停止。');
    this._changed();
  }

  /**
   * Reconcile our tracking against the exchange's REAL open orders:
   *  - prune tracked orders no longer on the book (missed fills/cancels),
   *  - refill grid levels that have no resting order on the exchange.
   * "Occupied" levels are derived from the real order prices, so this is robust
   * even when our in-memory tracking has drifted.
   */
  async reconcileOpenOrders() {
    if (!this.running || !this.config) return;
    if (typeof this.ex.fetchOpenOrders !== 'function') return;
    // Keep the adapter's price watch warm so a long-running market is never
    // pruned as "idle" (adapters drop unwatched markets after 10 min).
    this.ex.getPrice?.(this.config.marketId)?.catch?.(() => {});
    this._drainRetryQueue();
    const recovery = !!this.recovery;
    // Recovery has no grid: derive levels straight from price via config.spacing.
    const sp = recovery ? this.config.spacing : this.grid?.spacing;
    const lvl0 = recovery ? 0 : this.grid?.levels?.[0];
    if (!(sp > 0) || lvl0 == null) return;
    const nLevels = recovery ? Infinity : this.grid.levels.length;
    // Grid-mode recovery ladder (outOfRangeAction='recover') rests OUTSIDE the
    // grid: negative idx below the range, >= nLevels above. Widen the accepted
    // window so dedup/trim covers the ladder too (it used to be skipped, letting
    // duplicate ladder orders stack unchecked).
    const ladderPad = (!recovery && this.config.outOfRangeAction === 'recover') ? (this.grid?.count ?? 0) : 0;
    const idxLo = 0 - ladderPad, idxHi = nLevels === Infinity ? Infinity : nLevels + ladderPad;
    let real;
    try { real = await this.ex.fetchOpenOrders(this.config.marketId); } catch { return; }
    if (!Array.isArray(real)) return;
    this._exchangeOpenOrders = real.length;
    const realIds = new Set(real.map((o) => String(o.orderId)));
    const now = Date.now();

    // GUARD against transient bad snapshots: Extended's open-order endpoint has
    // been observed returning "0 orders" while dozens are really resting. An
    // all-vanished snapshot while we track many is overwhelmingly an API glitch
    // (real fills arrive via fill events anyway) — trusting it once wiped 78
    // tracked orders and orphaned them on the exchange. Skip pruning entirely on
    // such a snapshot, and in general require an order to be missing from TWO
    // consecutive reconciles before pruning it.
    // Round 34：某些适配器（Perpl）REST 端不可靠枚举链上单——real=[] 不一定
    // 是"exchange 真的 0 单"，可能只是 REST 401 我方看不见。这类适配器上不做
    // massVanish 的清+reseed 逻辑，纯靠 WS 事件（mt=24 fill/cancel）维持一致性。
    const unreliableListing = this.ex?.hasReliableOrderListing === false;
    const massVanish = !unreliableListing && real.length === 0 && this.active.size >= 3;
    if (massVanish) {
      this._vanishStreak = (this._vanishStreak || 0) + 1;
      if (now - (this._lastVanishAlertAt || 0) > 60000) {
        this._lastVanishAlertAt = now;
        this._alert(`⚠️ 挂单对账：交易所返回 0 单但本地跟踪 ${this.active.size} 单，疑似接口异常快照（连续 ${this._vanishStreak} 次），本轮不清理。`);
      }
      // 10 次连续 massVanish（默认 reconcile 30s → 5 分钟）没变 → 认为
      // 挂单真的没了（被 exchange 撤/成交/过期），信任外部：清本地，让下面
      // self-heal 逻辑接管重铺。
      //
      // 保护：如果最近 15 min 内刚 reseed 过（本地重铺了），不清 active。
      // 否则会形成"reseed 20 → 5 min后又 vanish → clear+reseed 20"的死循环，
      // 用户见过链上累积到 155 单。既然刚 reseed 过又 vanish，多半是接口
      // 侧 fetchOpenOrders 返 [] 而不是订单真被撤，别再自动清了。
      const recentReseed = this._lastReseedAt && (now - this._lastReseedAt < 15 * 60_000);
      if (this._vanishStreak >= 10 && !recentReseed) {
        this._alert(`⚠️ 挂单对账：交易所端 0 单持续 ${this._vanishStreak} 次（>5 分钟），信任外部，清本地 ${this.active.size} 单跟踪，准备重铺。`);
        this.active.clear();
        this._vanishStreak = 0;
      } else if (this._vanishStreak >= 10 && recentReseed) {
        // 抑制重复告警
        if (now - (this._lastVanishSuppressAlertAt || 0) > 5 * 60_000) {
          this._lastVanishSuppressAlertAt = now;
          this._alert(`⚠️ 挂单持续 vanish 但最近刚重铺过——多半是 fetchOpenOrders 接口异常，不再自动清本地。请人工排查（打开 /api/${this.ex?._exKey || '?'}/debug）。`);
        }
      }
    } else {
      this._vanishStreak = 0;
    }
    let pruned = 0;
    if (!massVanish) {
      for (const [oid, info] of [...this.active]) {
        if (realIds.has(oid)) { info.goneRecon = 0; continue; }
        if (now - (info.placedAt || 0) <= PRUNE_GRACE_MS) continue;
        info.goneRecon = (info.goneRecon || 0) + 1;
        if (info.goneRecon >= 2) { this.active.delete(oid); pruned++; }
      }
    }

    // Map real orders to levels. Cancel any DUPLICATE resting order on a level so
    // we converge to one-order-per-level (the root cause of count creep). ADOPT
    // any untracked survivor into tracking — in recovery mode that's a leftover
    // ladder; in grid mode it's an order we lost track of (e.g. a bad "0 orders"
    // snapshot once wiped tracking while the orders stayed live on the exchange).
    // Adoption restores accounting AND fill handling for those orphans.
    const occupied = new Set();
    let trimmed = 0, adopted = 0;
    for (const o of real) {
      const px = Number(o.price);
      if (!Number.isFinite(px) || !(sp > 0)) continue;
      const idx = Math.round((px - lvl0) / sp);
      if (!(idx >= idxLo && idx < idxHi)) continue;
      if (!occupied.has(idx)) {
        occupied.add(idx);
        if (!this.active.has(String(o.orderId))
            && ![...this.active.values()].some((a) => a.levelIndex === idx)) { // level truly unclaimed
          const side = o.side === 'buy' ? 'buy' : 'sell';
          // opening/closing heuristic (mirrors _handleFill's fallback): in short
          // mode buys close, otherwise sells close.
          const closing = recovery ? true : ((this.config.mode === 'short') ? side === 'buy' : side === 'sell');
          try { this.ex.adoptOrder?.({ orderId: o.orderId, marketId: this.config.marketId, levelIndex: idx, side, price: px, sizeBase: this.config.sizeBase }); } catch { /* ignore */ }
          this.active.set(String(o.orderId), { levelIndex: idx, side, price: px, opening: !closing, recovery, placedAt: now });
          adopted++;
        }
        continue;
      }
      // Round 125：async cancel API (StandX 等) 冷却窗口。同一 orderId 60 秒
      // 内不重复发 cancel，避免 reconcile 每 30 秒把同批 duplicate 反复 signing
      // → StandX 侧 rate-limit / 吞消息 → 100 单永远撤不干净循环。
      const cancelKey = String(o.orderId);
      if (!this._cancelAttempts) this._cancelAttempts = new Map();
      const lastAttempt = this._cancelAttempts.get(cancelKey);
      if (lastAttempt && (now - lastAttempt) < 60_000) continue;   // 冷却中，跳过
      this._cancelAttempts.set(cancelKey, now);
      try { await this.ex.cancelOrder(this.config.marketId, o.orderId); this.active.delete(String(o.orderId)); trimmed++; }
      catch { /* leave it; next cycle retries after cooldown */ }
    }
    // 清 5 分钟以上的老 cancel 记录，防内存增长
    if (this._cancelAttempts && this._cancelAttempts.size > 200) {
      for (const [k, t] of this._cancelAttempts) {
        if (now - t > 5 * 60_000) this._cancelAttempts.delete(k);
      }
    }
    if (recovery) this._recoveryOccupied = occupied;

    // IMPORTANT: reconciliation no longer re-seeds opening orders. Re-seeding via
    // seedOrders re-opened a SAME-SIDE order on a level that a fill had just
    // (correctly) vacated — its take-profit order lives one rung away — which made
    // the grid open positions endlessly in one direction (runaway inventory).
    // The grid is now maintained ONLY by the normal fill -> opposite-leg
    // replacement chain. Reconcile just keeps tracking accurate (prune) and
    // enforces one-order-per-level (trim). It never opens new positions.
    if (pruned || trimmed || adopted) {
      this._alert(`挂单对账：交易所实际 ${real.length} 单；清理失效 ${pruned}，撤除重复 ${trimmed}${adopted ? `，接管 ${adopted}` : ''}。`);
      this._changed();
    }

    // Self-heal 补铺：普通网格模式下，如果 exchange 那端 0 单、本地也 0 单、
    // 有正常的 grid + 价格在区间内、不在 recovery / out-of-range / 补单退避 中，
    // 说明 start() 挂单挂丢了（例如 Perpl WS 响应字段名对不上、进程重启时
    // resume 拿到的 snapshot.active 是空的等）→ 重新 seedOrders 一次。
    // 打的日志: adapter 侧的 diagnostic + bot 侧 alert，方便 debug。
    // Round 34：适配器不可靠枚举时，跳过 self-heal reseed。real=0 可能只是
    // 我方看不见，链上其实还挂着单——reseed 会往链上再压一批变孤儿。
    if (!recovery && !this.outOfRange && this.running && !unreliableListing
        && this.grid && real.length === 0 && this.active.size === 0
        && (!this._refillPausedUntil || now >= this._refillPausedUntil)
        && Number.isFinite(this.lastPrice) && this.lastPrice > 0
        && (now - (this._lastReseedAt || 0) > 60_000)) {
      // Reseed 次数上限：如果已 reseed >= 3 次 bot 却仍然 real=0，几乎肯定是
      // 接口异常（fetchOpenOrders 字段名或 endpoint 有问题）不是订单真丢了。
      // 再 reseed 只会往链上继续压钱。停手，让人工排查。
      this._reseedCount = (this._reseedCount || 0);
      if (this._reseedCount >= 3) {
        if (now - (this._lastReseedCapAlertAt || 0) > 10 * 60_000) {
          this._lastReseedCapAlertAt = now;
          this._alert(`⚠️ 已 reseed ${this._reseedCount} 次仍然本地/交易所都 0 单——接口疑似异常，停止自动重铺（避免链上累积孤儿单）。请人工排查 /api/${this.ex?._exKey || '?'}/debug 后手动重启网格。`);
        }
        return;
      }
      this._lastReseedAt = now;
      this._reseedCount++;
      try {
        // 重铺前先 re-snap 每档到市场**当前** stepPrice。之前 resume 出来的
        // 老 bot 里 config.stepPrice 可能是升级前保存的旧值（比如 0.01），跟
        // 市场真实 tick 0.1 不一致。永远优先信市场，config 记回来复用。
        let tick = 0;
        try {
          const mkt = (await this.ex.getMarkets()).find((m) => m.marketId === this.config.marketId);
          if (mkt?.stepPrice > 0) {
            tick = mkt.stepPrice;
            this.config.stepPrice = tick;
          }
        } catch { /* best effort */ }
        if (!(tick > 0)) tick = this.config?.stepPrice || 0;
        if (tick > 0) {
          // 用 tick 的小数位数做 toFixed，消除 `Math.round(lv/tick)*tick` 的浮点
          // 残尾（1978.83 → 1978.8300000000002 → API 判 not snap）
          const dp = Math.max(0, Math.min(10, -Math.floor(Math.log10(tick))));
          this.grid.levels = this.grid.levels.map((lv) => Number((Math.round(lv / tick) * tick).toFixed(dp)));
        }
        const { seedOrders } = await import('./grid.js');
        const seeds = seedOrders({ levels: this.grid.levels, price: this.lastPrice, mode: this.config.mode, spacing: this.grid.spacing });
        this._alert(`⚠️ 网格状态异常：running=true 但交易所 0 单、本地 0 单，尝试重新铺 ${seeds.length} 单…`);
        for (const s of seeds) await this._place({ ...s, opening: true });
        this._alert(`重铺完成：现有 ${this.active.size} / ${seeds.length} 单挂上。`);
        this._changed();
      } catch (e) {
        this._alert(`重铺失败：${e?.message || e}`);
      }
    }
  }

  _startReconcileTimer() {
    if (this._reconTimer) return;
    this._reconTimer = setInterval(() => { this.reconcileOpenOrders().catch(() => {}); }, RECONCILE_MS);
    this._reconTimer.unref?.();
    // Round 75：定期同步 exchange 侧真实 volume（Ondo /v1/portfolio/summary,
    // StandX /api/query_* 试探）。fill event 不可靠的 exchange 就靠这个。
    if (!this._volumeSyncTimer && typeof this.ex.getStats === 'function') {
      this._volumeSyncTimer = setInterval(() => this._syncExchangeStats().catch(() => {}), 60_000);
      this._volumeSyncTimer.unref?.();
      // 启动时立刻拉一次，别等 60s
      this._syncExchangeStats().catch(() => {});
    }
  }
  _stopReconcileTimer() {
    if (this._reconTimer) { clearInterval(this._reconTimer); this._reconTimer = null; }
    if (this._volumeSyncTimer) { clearInterval(this._volumeSyncTimer); this._volumeSyncTimer = null; }
  }

  /**
   * Round 75：拉 exchange 侧真实 volume 覆盖 stats.volume。
   * 用 max(local, exchange) 保护本地已累计的（尤其 Extended/RISEx fill 正常的
   * 所），避免 exchange API 短期漂移把本地准确数字覆盖成偏小值。
   *
   * Round 136：加异常检测 —— 之前 Bitunix.getStats 错返全站 quoteVol (~47.2 亿)，
   * 通过 Math.max 永远卡在 4.7B 不下来。修 getStats 后新值会正常但 max 保护
   * 让老污染数据永远不释放。规则：exchange 值 < local × 0.01（即差 100 倍以上）
   * 且 exchange 值合理（<账户余额 × 10000）→ 认为 local 是历史污染，用 exchange
   * 值覆盖。正常波动（漂移）不会触发。
   */
  async _syncExchangeStats() {
    try {
      const s = await this.ex.getStats();
      if (s && Number.isFinite(s.volume) && s.volume >= 0) {
        const before = this.stats.volume || 0;
        const bal = Number(this.ex.balance) || 0;
        const sane = s.volume < Math.max(bal * 10000, 1e7);   // 合理上限
        const polluted = before > s.volume * 100 && s.volume >= 0;
        let next;
        if (sane && polluted) {
          next = round2(s.volume);   // 信 exchange，释放历史污染
        } else {
          next = Math.max(before, round2(s.volume));   // 原逻辑
        }
        this.stats.volume = next;
        if (this.stats.volume !== before) this._changed();
      }
    } catch { /* transient */ }
  }

  _alert(message) {
    this.alerts.unshift({ t: Date.now(), message });
    if (this.alerts.length > 30) this.alerts.pop();
  }

  /** Per-exchange health classification surfaced to the dashboard. */
  _health() {
    const ex = this.ex;
    const okAge = (typeof ex.lastOkAt === 'number' && ex.lastOkAt > 0) ? Date.now() - ex.lastOkAt : null;
    const priceStale = !!(ex._pxStale && this.config && typeof ex._pxStale.has === 'function' && ex._pxStale.has(this.config.marketId));
    const recentFail = this._lastFailAt && (Date.now() - this._lastFailAt < 60000);
    const paused = this._refillPausedUntil && Date.now() < this._refillPausedUntil;
    let status = 'ok', reason = '正常运行';
    if (!this.running && !this.config) { status = 'idle'; reason = '未运行'; }
    else if (paused) { status = 'error'; reason = `订单频繁被取消（疑似保证金不足），已暂停补单 ${Math.ceil((this._refillPausedUntil - Date.now())/1000)}s`; }
    else if (ex.dataSource === 'synthetic') { status = 'warn'; reason = '合成行情（未连真实交易所）'; }
    else if (okAge != null && okAge > 30000) { status = 'error'; reason = `交易所数据 ${Math.round(okAge / 1000)}s 未更新`; }
    else if (priceStale) { status = 'warn'; reason = '行情滞后（已用持仓推算价兜底）'; }
    else if (recentFail) { status = 'warn'; reason = `近1分钟下单失败 ${this._placeFails} 次`; }
    return {
      status, reason,
      dataSource: ex.dataSource ?? null,
      lastOkAgeMs: okAge,
      priceStale,
      placeFails: this._placeFails,
      exchangeOpenOrders: this._exchangeOpenOrders,
    };
  }

  getState() {
    const pos = this.running || this.config ? this.ex.getPosition?.(this.config?.marketId) : null;
    const openByLevel = {};
    for (const o of this.active.values()) openByLevel[o.levelIndex] = o.side;

    const unrealized = pos ? round2(pos.unrealizedPnl) : 0;
    const balance = typeof this.ex.balance === 'number' ? round2(this.ex.balance) : null;
    const equityRaw = typeof this.ex.equity === 'number' ? this.ex.equity
      : (balance != null ? balance + unrealized : null);
    const equity = equityRaw != null ? round2(equityRaw) : null;

    let realized;
    // Round 149：优先用 stats.gridProfit（fills-based · 跟外部转账/存款无关）。
    //
    // 之前用 (equity - startBalance) - unrealized 会把外部转账误报成盈亏——
    // 用户 Bitget 转 $319 去 Bitunix → equity 从 700→381 → 公式误报"已实现
    // 亏损 -318"，实际网格几乎没亏，只是钱换了个仓。
    //
    // gridProfit 从每次 rung completion 累积（spacing × sizeBase），只跟 bot
    // 实际吃到的网格利润有关。是理论值，不含 exchange 手续费/资金费用，比
    // exchange 的真实 realized 通常略高，但**不受转账污染**。
    //
    // 若 adapter 从 exchange API 拿到真 realizedPnl（RISEx 是这样做的），走
    // 二号分支；startBalance-based 保底给没有 stats 但有 startBalance 的场景
    // （目前不会走到，留兜底）。
    if (this.stats && Number.isFinite(this.stats.gridProfit)) {
      realized = round2(this.stats.gridProfit);
    } else if (typeof this.ex.realizedPnl === 'number') {
      realized = round2(this.ex.realizedPnl - (this._pnlBase ?? 0));
    } else if (equityRaw != null && this.startBalance != null) {
      realized = round2((equityRaw - this.startBalance) - unrealized);
    } else {
      realized = 0;
    }
    const totalPnl = round2(realized + unrealized);
    const returnPct = (this.startBalance && this.startBalance > 0)
      ? round2((totalPnl / this.startBalance) * 100)
      : ((equity && equity > 0) ? round2((totalPnl / equity) * 100) : null);
    return {
      mode: this.ex.mode,
      recovery: this.recovery,
      running: this.running,
      config: this.config,
      grid: this.grid,
      lastPrice: this.lastPrice != null ? round2(this.lastPrice) : null,
      outOfRange: this.outOfRange,
      risk: this.risk,
      stats: this.stats,
      openOrders: this.active.size,
      exchangeOpenOrders: this._exchangeOpenOrders,
      openByLevel,
      health: this._health(),
      // Round 107：leverage 兜底 —— 交易所有的没返 leverage 字段（Ondo/Bitget 位置解析后是 null），
      // UI 就显示"nullx"。这时用 bot.config.leverage 兜底（这是用户设的杠杆，跟 place 时用的一致）。
      position: pos ? { sizeBase: round6(pos.sizeBase), entryPrice: round2(pos.entryPrice), unrealizedPnl: round2(pos.unrealizedPnl), leverage: pos.leverage ?? this.config?.leverage ?? null } : null,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
      totalPnl,
      returnPct,
      equity,
      balance,
      volume: Math.max(0, round2((this.stats.volume || 0) - (this.stats.volumeBaseline || 0))),
      theoreticalProfit: round2(this.stats.gridProfit),
      startBalance: this.startBalance != null ? round2(this.startBalance) : null,
      fills: this.fills.slice(0, 20),
      alerts: this.alerts.slice(0, 12),
    };
  }
}

function labelMode(m) { return m === 'long' ? '做多网格' : m === 'short' ? '做空网格' : '中性网格'; }

function round2(x) { return Math.round(x * 100) / 100; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
