# Exchange adapter interface

Every adapter is an `EventEmitter` subclass. Grid bot (`src/bot.js`) drives it via these methods and listens for these events. Keep field names and event names identical to what's here — bot.js and autopilot.js hard-code them.

## Constructor state (initialize in `constructor()`)

```js
this.mode = 'live';               // or 'paper' for paper.js
this.dataSource = 'connecting';   // becomes 'real' after init(), 'synthetic' for paper
this.network = 'mainnet';         // or 'testnet' if you support it

this.markets = new Map();         // marketId(number) → Market
this.symbolToId = new Map();      // "BTCUSDT" → 1 (for reverse lookup in fill/position handlers)
this.prices = new Map();          // marketId → lastPrice
this.orders = new Map();          // orderId(string) → { orderId, marketId, side, price, sizeBase, ... }
this.positions = new Map();       // marketId → { sizeBase, entryPrice, unrealizedPnl, leverage, positionId? }
this.balance = 0;
this.realizedPnl = 0;
this.lastOkAt = Date.now();       // timestamp of last successful API call — Autopilot's health check
this.lastError = null;
this.stats = null;                // { volume: <cumulative USDC> } — Round 75 pattern
```

## Market shape (what `getMarkets()` returns)

```js
{
  marketId: 1,           // number — autoincrement local ID, NOT the exchange's string symbol
  displayName: 'BTCUSDT', // user-facing string; also used as key in symbolToId
  symbol: 'BTC',          // optional short form
  lastPrice: 72000,
  stepSize: 0.001,        // qty tick — order sizeBase must snap to this
  stepPrice: 0.1,         // price tick — order price must snap to this
  minOrderSize: 0.001,
  maxLeverage: 125,
}
```

**Gotcha**: `marketId` must be a number. Round 45 hit StandX using string marketIds ("BTC-USD"), which broke `Number(marketId) === marketId` comparisons in bot.js. If the exchange's API is symbol-keyed, auto-assign incrementing numeric IDs and use `symbolToId` for lookup.

## Required methods

Every one of these is called by `bot.js` or `autopilot.js`. Missing any = silent breakage.

```js
async init()                                // Connect. Throw with clear msg on auth fail.
async reconnect()                           // Kill polling, re-run init(). UI calls this via /api/<prefix>/reconnect.
async getMarkets()                          // Return [...this.markets.values()]
async getPrice(marketId)                    // Return this.prices.get(Number(marketId))
async getCandles(marketId, intervalSec, n)  // Return [{time, open, high, low, close, volume}, ...]
async getStats()                            // Return { volume } — cumulative fill volume. Used for pet feed + UI.
async setLeverage(marketId, lev)            // Return true on success; silence "no change" errors.
async placeLimitOrder(o)                    // o = { marketId, side:'buy'|'sell', price, sizeBase, reduceOnly?, clientOrderId?, levelIndex? }
                                            // Return { orderId }. Also this.orders.set(orderId, ...).
async cancelOrder(marketId, orderId)        // Return true. Also this.orders.delete(orderId).
async cancelAll(marketId)                   // Cancel every resting order for this market.
async fetchOpenOrders(marketId)             // Return [{orderId, price, side}] from the exchange (not local map).
adoptOrder({orderId, marketId, levelIndex, side, price, sizeBase})  // Bot's reconcile calls this to adopt orphans.
getOpenOrders(marketId)                     // Sync — return [...this.orders.values()].filter(o => o.marketId === Number(marketId))
async fetchPositions()                      // Return [{marketId, sizeBase, entryPrice, unrealizedPnl, leverage, positionId?}]
getPosition(marketId)                       // Sync — return this.positions.get(Number(marketId)) or null
async closePosition(marketId)               // Return {closed: bool, empty?: bool, count?: number, size?: number, error?: string}
async reconcileOpenOrders()                 // Usually a no-op (return true) — bot's own reconcile timer handles it.
setActiveMarket(marketId)                   // Autopilot calls to hint "only care about this market"
start()                                     // Start polling if not already. paper.js starts a random-walk timer.
stop()                                      // Kill all timers.
```

## Events to emit

```js
this.emit('price', { marketId, price })
this.emit('fill', {
  orderId, marketId, levelIndex, side, price, sizeBase,
  fillPrice, fillSize, clientOrderId,
})
this.emit('error', new Error(msg))
```

Bot.js attaches listeners for all three at construction time. **Round 42 gotcha**: always have an `error` listener from init — an unhandled `emit('error')` crashes Node.

## Fill detection pattern

Two common flavors:

- **WebSocket push** (Perpl, RISEx): the exchange sends fill events, adapter routes them to `emit('fill')` after mapping to a local `orderId`. Uses the WS `oid` / `orderId` field to look up `this.orders`.
- **REST polling diff** (Bitget, Bitunix, StandX): every N seconds fetch open orders, compare to `this.orders`; anything in local map but missing from exchange = filled. Round 90 fixed this for Bitget — copy that pattern.

## Response code convention (varies per exchange)

Always read the SDK's `handleResponse` before assuming. Past values:

| Exchange | Success code | Type |
|---|---|---|
| Bitget | `"00000"` | string |
| Bitunix | `0` | number |
| Ondo | `code` omitted, use HTTP status | — |
| StandX | `code === 0` | number |

Never `if (j.code !== 0)` — do `if (Number(j.code) !== 0)` or match the SDK's exact check.

## Health signal

`this.lastOkAt = Date.now()` after every successful API call. Autopilot's "stale" check (Round 20) skips a tick if `now - lastOkAt > 120_000`. If you forget to update `lastOkAt` in the poll loop, Autopilot silently stops scheduling this exchange.
