# Gotchas from past exchange additions

Each entry: **[Round N]** what went wrong, why, and how to prevent it next time.

## Sign vs URL query serialization mismatch

**[Round 127→128→129 chain, Bitunix]**. Bitunix wants two different string formats for the same params:
- URL: `?marginCoin=USDT` (standard URL query)
- Sign input: `marginCoinUSDT` (no `=`, no `&`, sorted)

Round 127 used URL format for both → sign wrong → `[10007] Signature Error`.
Round 128 flipped to sign format for both → URL missing `=` → server couldn't parse `marginCoin` → still `10007`.
Round 129 finally split them into two functions and it worked.

**Prevention**: Before writing `_sign`, `grep -n "sortParams\|signInput" <sdk>/Demo/**/*.{js,py,go,java}` and read the SDK's implementation verbatim. If the SDK has two distinct functions (one for URL, one for sign), so should you. If it uses `axios({params: ...})` for the URL, that's a hint the URL goes through standard URL-encoding while sign is bespoke.

## response `code` is not always `0`

**[Never explicitly broke, but almost did]**. Bitget's success code is the string `"00000"`, not the number `0`. Bitunix is number `0`. StandX is `0`. `if (j?.code !== 0)` succeeds for Bitget even on success.

**Prevention**: Always mirror the SDK's `handleResponse` exactly. If SDK does `if (data.code !== 0)`, use `if (Number(j?.code) !== 0)`. If SDK does `if (data.code !== "00000")`, use `if (j?.code !== "00000")`.

## `orderId` shape mismatch → cancel假死

**[Round 126, StandX]**. `fetchOpenOrders` returned StandX's numeric exchange id (e.g. `12345678`), but `cancelOrder` tried `{cl_ord_id: "12345678"}` first. StandX returned "not found" (no such cl_ord_id), our regex matched "not found" as "already cancelled", we removed it locally but the order still lived on the exchange. Reconcile re-adopted it every 60s → loop.

**Prevention** in the adapter:
- Have `fetchOpenOrders` document which field it's returning as `orderId`.
- If `cancelOrder` has to try multiple field names, prioritize by ID shape (numeric → try `order_id` first; alpha → try `cl_ord_id` first).
- Don't treat "not found" as success on the FIRST attempt — only on the last.

## marketId string vs number

**[Round 45, StandX]**. StandX API is symbol-keyed ("BTC-USD"). Adapter naively used strings. Bot.js does `if (o.marketId === Number(this.config.marketId))` comparisons everywhere → strings never matched → orders silently ignored.

**Prevention**: `marketId` in `this.markets` MUST be a JS number (autoincrement local IDs). Use `this.symbolToId = new Map()` for reverse lookup when handling WS events or REST responses.

## `code=0` accepted ≠ actually done (async APIs)

**[Round 122, StandX]**. StandX `/api/cancel_orders` returns `code=0` immediately, but the actual cancellation is processed async on their side — up to seconds later. Bot's `cancelAll` fetched open orders immediately after and saw them still there, threw "cancel failed" and 40+ minutes of Autopilot skipping ensued.

**Prevention**: For any cancel/close endpoint, check the SDK doc for "asynchronous" language. If async, don't throw on residual — log and let the reconcile timer handle drift.

## Adding a 2-letter prefix that collides

**[Never broke because I check, but Round 87 had a related bug]**. Prefixes are shared across many namespaces: adapter dir, env var prefix, config key, UI element IDs, CSS var names. `bg` is already used both as the exchange prefix AND the CSS `background` shorthand. Duplicate prefix would collide.

**Prevention**: Before choosing `<prefix>`, run `grep -rn "'<prefix>'" src/ public/index.html` — if that returns anything, pick another. Never pick a common CSS keyword (`fg`, `md`, `sm`, `lg`, `bg`).

## Forgetting the `<prefix>-pet-card` div

**[Round 130a, Bitunix]**. `petRenderCard(k)` does `document.getElementById(k+"-pet-card")`; if missing, silent return. Round 127 wrote a minimal Bitunix tab that omitted the div → pet just never appeared, no console error. User had to notice.

**Prevention**: Every new tab panel starts with the pet-card div. It's in `wiring-checklist.md` step 6e as a must.

## Health signal drift

**[Round 20, Perpl]**. If the poll loop doesn't refresh `this.lastOkAt`, Autopilot's `stale = ex.lastOkAt ? (now - ex.lastOkAt > 120_000) : false` triggers → `skip 交易所数据 XXs 未更新` → autopilot never selects this exchange.

**Prevention**: Set `this.lastOkAt = Date.now()` at the end of every successful ticker/balance poll — not just on `init()`.

## Fill events without orderId lookup

**[Round 90 rollout for Bitget]**. Two ways to detect fills:
1. WS push: fill event has orderId, look up `this.orders.get(oid)` to get levelIndex.
2. REST diff: poll open orders, whatever's missing from local → fired.

If the exchange doesn't do WS fill push AND the adapter's poll loop doesn't do the diff, `emit('fill')` never fires and the bot thinks nothing filled → position accumulates on exchange but bot's local state is stale → auto-recover gets confused.

**Prevention**: Every adapter must have one of the two mechanisms, and it must set `clientOrderId` on the emitted fill so `bot.js` can match to the right rung.

## `_activeMarketId` gating that starves fill detection

**[Round 90, Bitget]**. Bitget's `_pollTick` gated its REST-diff fill detection on `if (this._activeMarketId)`. But `bot.js` never called `setActiveMarket()` for CEX-style single-market bots — the flag stayed null forever → fills silently ignored → 成交记录 tab blank.

**Prevention**: Gate the fill diff on `this.orders.size > 0`, not on the `_activeMarketId` hint.

## Trend analysis needs candles the exchange might not have

**[Round 49, StandX; Round 56 Ondo]**. Autopilot's `analyzeTrend` needs ≥50 candles. If `getCandles` returns fewer (because the exchange's kline endpoint is broken or requires a `countback` param), analyze returns null → Autopilot skips selecting → user sees "trend 分析中..." forever.

**Prevention**: Test `getCandles(marketId, 3600, 100)` in the adapter smoke test (Step 4). If it returns fewer than 50, try adding `countback` or lengthening the time range. Bitunix limit is 200 max — if you ask for more, some exchanges return 0.

## Race in `refreshTrend` (UI)

**[Round 62]**. If the user switches markets fast, the old fetch resolves after the new one and overwrites the chart. Not an adapter bug per se but worth knowing: the UI's `refreshTrend` uses an `_pendingRefreshId` counter — new fetches bump the counter and stale fetches abort. If the new tab you write has its own market picker, follow the same pattern.

## Response schema wrapper variance

**[Round 51, StandX]**. Different endpoints (or the same endpoint on different days) may wrap the payload as:
- `{data: [...]}`
- `{orders: [...]}`
- `{result: [...]}`
- `[...]` (bare array)

Round 51 pattern: unwrap defensively, and log the raw shape on first response so a future breakage is diagnosable:

```js
const raw = Array.isArray(j) ? j
  : (Array.isArray(j?.result) ? j.result
  : (Array.isArray(j?.orders) ? j.orders
  : (Array.isArray(j?.data) ? j.data : [])));
if (!this._openOrdersLogged) {
  this._openOrdersLogged = true;
  console.log(`[<Exchange>] fetchOpenOrders 首次响应 shape=<...>, sample=${JSON.stringify(raw[0]).slice(0,240)}`);
}
```
