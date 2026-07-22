---
name: add-exchange
description: Add a new perpetual futures DEX or CEX (e.g. Bitget, Bitunix, StandX, Perpl, Ondo) as an eighth/ninth/etc adapter into the QnV multi-exchange grid trading bot. Trigger whenever the user says something like "add <exchange name>", "接入 <exchange>", "加个新的交易所", "根据这个 API doc 弄一个 DEX/CEX", or pastes a link to an exchange's API docs / official SDK. This skill knows the full 9-file wiring pattern (adapter, config, server, autopilot, service, pets, UI) that every past addition (Round 41 StandX, Round 82-83 Bitget, Round 127-129 Bitunix) had to touch, and it knows the 4 classic bugs each round hit (wrong 2-letter prefix collision, keys-array misses, sign-vs-URL serialization confusion, forgotten pet-card DOM node). Use this skill proactively even when the user only casually mentions adding an exchange — the wiring is easy to get wrong and takes 8+ files.
---

# Adding a new perpetual futures exchange to QnV

## Why this skill exists

Every past exchange addition (StandX, Bitget, Bitunix) hit the same 2-3 preventable bugs mid-way through Round N and needed a Round N+1 or N+2 to patch. The root cause was always **missing a wiring point** in one of ~9 files, or **guessing an API detail** that the SDK could have confirmed in seconds. This skill captures the exact checklist and the exact gotchas so a new exchange gets added correctly on the first commit.

## What "adding an exchange" means

The user wants to bring a new perpetual futures venue online in QnV so the Autopilot can trade it alongside the existing 7 (Decibel / Extended / RISEx / Ondo / Perpl / StandX / Bitget). "Bringing it online" means:

- Adapter class that implements the `Exchange` interface (init, getMarkets, getCandles, placeLimitOrder, cancelOrder, cancelAll, fetchOpenOrders, fetchPositions, closePosition, setLeverage, getPrice, getStats, adoptOrder, reconcileOpenOrders, start, stop, reconnect, setActiveMarket, emit 'price'/'fill'/'error' events).
- Paper mock so it still boots even without API creds.
- Full wiring so it appears in overview, autopilot, service (哨兵/日报), pet system, and the UI (header badge, tab button, overview card, control tab).
- LIVE mode driven by env vars added by the user in Railway.

## Step 0 — Interview the user before writing anything

Before touching code, get answers to these. Skip the ones already answered in the conversation history — don't ask them again.

1. **What's the exchange's official API documentation URL?** (usually the GitHub open-api repo like `BitunixOfficial/open-api`, or the docs site like `openapidoc.bitunix.com`). Ask for both if only one is given.
2. **What 2-letter prefix should this exchange use?** Existing taken prefixes: `de` (Decibel), `ex` (Extended), `rs` (RISEx), `on` (Ondo), `pl` (Perpl), `sx` (StandX), `bg` (Bitget), `bu` (Bitunix). **Do NOT reuse.** Suggest one from the exchange name and confirm.
3. **Paper MVP first, or straight to LIVE?** Recommend straight-to-LIVE (Round 127 did this) unless the user says they don't have creds yet.
4. **If LIVE, does the user have API creds ready and will they add them to Railway env themselves?** If not, do paper.
5. **Chinese pet name for the exchange?** Optional (Bitunix is 穷奇). If skipped, use a generic emoji fallback.

## Step 1 — Read the SDK before writing the adapter

**Never write the adapter from the docs page alone.** Round 127 → 128 → 129 chain proves this: I burned 3 rounds because I guessed the signature algorithm and the queryParams serialization from a doc page that said "sorted by key". The SDK code was unambiguous. Read `references/adapter-template.md` for the shape of a solid adapter — do this in parallel while cloning the SDK.

Clone the SDK repo (usually `<Exchange>Official/open-api` on GitHub):
```bash
git clone --depth 1 https://github.com/<Owner>/open-api.git /tmp/claude-*/scratchpad/<name>-sdk
```

Then read (in this order):
- **Signing / auth file** first — for Bitunix it was `Demo/Node/openApiHttpSign.js`. Look for the exact string-to-sign and the exact param serialization. If a Node SDK exists, prefer it (identical language reduces guessing).
- **Path constants file** — for Bitunix it was `Demo/Java/src/main/java/com/bitunix/openapi/constants/FuturesPath.java`. This lists every real endpoint path, so you don't have to guess them.
- **Response models** — Java response classes are the cleanest source of field names (e.g. `TradingPair.java` gave the exact fields `basePrecision`, `quotePrecision`, `minTradeVolume`, `maxLeverage`, `symbolStatus`).
- **The main private/public client** — one file usually shows every endpoint's body/param shape.

If there's no SDK at all, then and only then fall back to the docs page — but be prepared for a Round N+1 signature-fix commit.

## Step 2 — Write the adapter (3 files)

The adapter directory is `src/exchange/<prefix>/`. Create three files:

```
src/exchange/<prefix>/
├── <exchange>.js  ← LIVE adapter (~500 lines, biggest file)
├── paper.js       ← Synthetic paper mode (~120 lines)
└── index.js       ← Factory: picks LIVE vs paper based on cfg.mode
```

Use `src/exchange/bg/` (Bitget) as the closest template for a CEX-style REST+HMAC exchange, or `src/exchange/pl/` (Perpl) for a DEX with WebSocket-heavy protocol. Copy that whole directory, rename everything, and swap the signing + endpoints.

`references/adapter-template.md` has the interface every adapter must implement. Read it once.

**Critical gotchas from past additions** — see `references/gotchas.md` for the full list, but the top three:

1. **Sign string ≠ URL query string.** Almost every CEX has one format for the URL (`?key=value&key2=value2`) and a different format for the signature input (Bitunix uses `keyvaluekey2value2`, no separators; Bitget uses `timestamp+method+path+body`). Round 127 → 128 → 129 chain happened because I used one string for both. Keep them separate functions from day one:
   ```js
   _urlQueryString(params) { /* standard ?key=value& */ }
   _signParamsString(params) { /* whatever the SDK does */ }
   ```
2. **orderId shape.** Every exchange returns orderIds in a different form (numeric string vs cl_ord_id vs UUID). Whatever `fetchOpenOrders` returns is what `cancelOrder` receives, and cancel APIs are picky about which field name that ID maps to. See `references/gotchas.md` "orderId matching" section.
3. **Response code convention.** Bitget uses `code: "00000"` (string), Bitunix uses `code: 0` (number). Never `code === "0"` or `code === 0` blindly — check the SDK's `handleResponse`.

## Step 3 — Wire it into all the systems

There are **~9 files** to touch outside the adapter. Missing any one silently breaks a feature. Follow `references/wiring-checklist.md` — it's a copy-paste-able checklist. The high-level list:

1. `src/config.js` — add `<prefix>` config section reading env vars
2. `src/server.js` — 12+ edit points (imports, createExchange, GridBot, restore, error listeners, aiService, autopilot, pets, SSE clients set, handler, cred check, overview API, overview SSE initial, reset-all-positions endpoint, SSE broadcast, init call, resume call)
3. `src/ai/autopilot.js` — 2 places: `EXNAMES` and `KEYS`
4. `src/ai/service.js` — 5 places: 4 iteration arrays + `EXNAMES`
5. `src/pets.js` — 2 places: `KEYS` and `PET_SPECIES` (new species entry)
6. `public/index.html` — 15+ places (do all in one pass):
   - CSS: `--<prefix>-color` + `--<prefix>-bg`
   - Header: badge + dot in `hdr-details-wrap`
   - Tab button: `switchTab('<prefix>')`
   - Overview card: full `ov-<prefix>-*` block
   - Tab panel: `<div id="tab-<prefix>">` — **DO NOT write a minimal / 精简 version.** Duplicate the whole `<div id="tab-bg">` (~120 lines), replace `bg` → `<prefix>` / `Bitget` → `<Exchange>` / `--bg-color` → `--<prefix>-color`. Round 127→131 chain (Bitunix) burned 4 days because a精简 tab omitted the DOM `makeExchangeCtrl(prefix, chartId)` needs → `loadMarkets` never ran → `hdr-<prefix>` badge stuck on PAPER even though backend was fully LIVE. Include the pet-card `<div id="<prefix>-pet-card">` at top (Round 130a).
   - `const <prefix>Ctrl = makeExchangeCtrl('<prefix>', '<prefix>-chart');` — right after the `bgCtrl` line. This is what actually updates the header badge.
   - `AP_EX` map add `<prefix>:'<Exchange>'` — otherwise Autopilot's per-DEX picker skips your new exchange.
   - AI 分析 button row — hard-coded, not iterated. Add `<button onclick="aiAnalyze('<prefix>', this)">分析 <Exchange></button>`.
   - JS constants: `AI_EXNAME` map, `NUM_SELECTORS` array, `TAB_ORDER`, `SWIPE_ORDER`, `PET_COLORS` map, all `['de','ex',...,'<prefix>']` keys arrays (there are ~13 of them — do `grep -n "'de','ex','rs','on','pl','sx','bg'" public/index.html` to find them all, then `sed` in bulk)

`references/wiring-checklist.md` has the exact search/replace patterns.

## Step 4 — Test

Run before committing:

```bash
node --check src/exchange/<prefix>/<exchange>.js
node --check src/exchange/<prefix>/paper.js
node --check src/exchange/<prefix>/index.js
node --check src/config.js
node --check src/server.js
node --check src/ai/autopilot.js
node --check src/ai/service.js
node --check src/pets.js
npm test   # should still be 16/16 (or whatever passing count was)
```

Paper mode smoke test:
```bash
node -e "
import('./src/config.js').then(async ({getConfig}) => {
  const cfg = getConfig();
  const {createExchange} = await import('./src/exchange/<prefix>/index.js');
  const ex = createExchange(cfg.<prefix>);
  await ex.init();
  const mkts = await ex.getMarkets();
  console.log('markets:', mkts.slice(0,3).map(m => ({id: m.marketId, name: m.displayName, price: m.lastPrice})));
  ex.stop();
});
"
```

## Step 5 — Commit + PR + monitor

Follow the project's existing convention:
- Commit title: `Round <N>：加 <Exchange> LIVE（第 <M> 家 · <auth type>）`
- Include a `# 概述`, `# <Exchange> 特色` (what's weird about this API), `# 新增文件`, `# Wire 到系统`, `# 用户操作` (env vars to add in Railway), `# 测试` sections in the commit body
- Push `-u origin claude/multi-platform-automation-railway-uha8i8`
- Open a **draft** PR via `mcp__github__create_pull_request` — the user will convert to ready when they've reviewed
- Subscribe via `mcp__github__subscribe_pr_activity`
- Schedule a `ScheduleWakeup` fallback ~1h out (webhook doesn't cover merge)

## Step 6 — Anticipate the next round

**Assume you got the signing wrong.** After the user deploys to Railway, they will very likely come back with something like `[10007] Signature Error` or `HTTP 401` or "还是没连上". The fix is nearly always in `_signParamsString` or in a header field name. Have the SDK repo clone still ready in scratchpad. Don't re-clone.

## References

- `references/adapter-template.md` — Interface every adapter implements, method signatures, event names
- `references/wiring-checklist.md` — Copy-paste checklist for all 9 files
- `references/gotchas.md` — Every bug Round 127→130 hit, with the fix pattern

Skim these at Step 1. Follow them precisely at Step 2 and Step 3. That way you get the exchange live on the first PR instead of the third.
