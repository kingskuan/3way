# Wiring checklist

For each file below, run `grep -n "'bu'\|bu:" <file>` after editing to spot any place you missed. This checklist reflects the actual Round 127 diff (Bitunix, 8th exchange). Substitute `bu` → your new 2-letter `<prefix>`, `Bitunix` → your `<Exchange>` display name.

## 1. `src/config.js`

Add new section after the last existing one:

```js
// ── <Exchange> Perps ─────────────────────────────
const <prefix> = {
  mode: (process.env.<PREFIX>_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper',
  apiKey: process.env.<PREFIX>_API_KEY || '',
  apiSecret: process.env.<PREFIX>_API_SECRET || '',
  // ...any other creds this exchange needs (passphrase, chain, vault, etc.)
  startBalance: Number(process.env.PAPER_BALANCE || 10000),
  proxy: process.env.<PREFIX>_PROXY || globalProxy,
};
```

And export it at the bottom:
```js
return {
  ...,
  de, ex, rs, on, pl, sx, bg,
  <prefix>,   // ← add
};
```

## 2. `src/server.js` — 12+ edit points

Search for `bgExchange` (Bitget) and mirror every occurrence for `<prefix>Exchange`. The exact edits (from Round 127 diff):

| Where | What |
|---|---|
| Top imports | `import { createExchange as create<Prefix>Exchange } from './exchange/<prefix>/index.js';` |
| Cred check block | Add `if (cfg.<prefix>.mode === 'live') { ... missing.push(...) }` |
| Live-check array | Add `<prefix>` to `['de','ex','rs','on','pl','sx','bg']` in the `hasLive` line |
| Exchange creation | `const <prefix>Exchange = create<Prefix>Exchange(cfg.<prefix>);` |
| Bot creation | `const <prefix>Bot = new GridBot(<prefix>Exchange, { onChange: (s) => saveSnapshot('<prefix>', s) });` |
| Bot restore | `<prefix>Bot.restore(loadSnapshot('<prefix>'));` |
| Error listeners loop | Add `<prefix>Exchange` to `for (const ex of [...])` |
| aiService injection | Add `<prefix>: <prefix>Bot` and `<prefix>: <prefix>Exchange` to bots/exchanges objects |
| autopilot injection | Same as above |
| pets injection | Add `<prefix>: <prefix>Bot` |
| SSE clients set | `const <prefix>Clients = new Set();` |
| Handler | `const <prefix>Handler = makeExchangeHandler('/api/<prefix>', <prefix>Bot, <prefix>Exchange, cfg.<prefix>, <prefix>Clients, '<Exchange>');` |
| Overview API | Add `<prefix>: pick(<prefix>Bot.getState(), cfg.<prefix>.mode),` |
| Overview SSE initial | Same |
| reset-all-positions endpoint | Add to `bots`/`exchanges` maps inside handler |
| Route dispatch | `if (p.startsWith('/api/<prefix>/')) return await <prefix>Handler(...)` |
| SSE broadcast (setInterval) | Add `if (<prefix>Clients.size > 0) { const data = ...; for (const r of <prefix>Clients) ... }` and add to overview aggregation block |
| initExchange call | `initExchange(<prefix>Exchange, '<Exchange>', { mode: cfg.<prefix>.mode, apiUrl: 'https://...' }),` |
| resumeIfWasRunning call | `resumeIfWasRunning(<prefix>Bot, <prefix>Exchange, '<prefix>'),` |

**Sanity check after editing**: `grep -c "'<prefix>'\|<prefix>Bot\|<prefix>Exchange" src/server.js` — you should get ~20+ matches. If under 15, you missed something.

## 3. `src/ai/autopilot.js` — 2 spots

```js
const EXNAMES = { de:'Decibel', ex:'Extended', rs:'RISEx', on:'Ondo', pl:'Perpl', sx:'StandX', bg:'Bitget', <prefix>:'<Exchange>' };
const KEYS = ['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', '<prefix>'];
```

## 4. `src/ai/service.js` — 5 spots

Use `grep -n "'de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg'" src/ai/service.js` to find every iteration, then append `'<prefix>'`. There are exactly 5 (was 5 in Round 127 — count may drift as service.js evolves). Plus the `EXNAMES` map at the top.

## 5. `src/pets.js` — 2 spots

```js
const KEYS = ['de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', '<prefix>'];

// Add new species entry:
export const PET_SPECIES = {
  ...,
  <prefix>: {
    name: '<中文神兽名>', theme: '<8-12 字副标题>',
    stageNames: ['<Lv1>', '<Lv2>', '<Lv3>', '<Lv4>', '<Lv5>', '<Lv6>', '<Lv7>'],
    fallback: ['🥚', '🐺', '🦊', '🐆', '⚡', '👑', '💫'],   // emoji per stage
    color: '#8b5cf6',
  },
};
```

## 6. `public/index.html` — 15+ spots

Do in this order. The file is huge; use `sed` where safe.

### 6a. CSS variables (near line 30)

```css
--<prefix>-color: #<hex>;   /* 找一个跟其他 7 家色区别足够的 */
--<prefix>-bg: #<hex>18;    /* same color + '18' alpha suffix */
```

### 6b. Header badges (search for `hdr-bg-dot`)

Duplicate the bg row for `<prefix>`:
```html
<div style="display:flex;align-items:center;gap:6px;padding:3px 4px">
  <span class="hdot idle" id="hdr-<prefix>-dot"></span>
  <span id="hdr-<prefix>" class="badge badge-paper" style="flex:1;text-align:left;padding:2px 6px">
    <PREFIX>: PAPER
  </span>
</div>
```

### 6c. Tab button (search for `switchTab('bg')`)

```html
<button class="tab-btn" onclick="switchTab('<prefix>')"><span style="color:var(--<prefix>-color)">●</span> <Exchange></button>
```

### 6d. Overview card (search for `<!-- Bitget`)

Duplicate the whole `<div class="ov-card bg">...</div>` block, replace every `bg` → `<prefix>` and every `Bitget` → `<Exchange>`.

### 6e. Tab panel (search for `<div id="tab-bg"`)

Duplicate the whole panel, or write a minimal one like Round 127 did. **REMEMBER** the pet-card:
```html
<div class="panel <prefix> pet-card" id="<prefix>-pet-card" style="margin-bottom:14px;padding:14px 16px"></div>
```
Round 130a bug: forgetting this = no pet renders.

### 6f. JavaScript constants (search for the exact strings below)

Do these with `sed -i "s/'de','ex','rs','on','pl','sx','bg'/'de','ex','rs','on','pl','sx','bg','<prefix>'/g; s/'de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg'/'de', 'ex', 'rs', 'on', 'pl', 'sx', 'bg', '<prefix>'/g" public/index.html`.

After the sed, `grep -c "'<prefix>'" public/index.html` should return ~13. If any keys array was already using this pattern, the sed may double-inject — check with `grep "'<prefix>','<prefix>'\|'<prefix>', '<prefix>'"` and fix any doubles.

Then also manually:
- `AI_EXNAME` map — add `<prefix>:'<Exchange>'`
- `NUM_SELECTORS` array — for each `#ov-*-pnl`, `#ov-*-bal`, `#ov-*-eq`, `#ov-*-price`, `#ov-*-rpnl`, `#ov-*-upnl`, `#ov-*-vol`, `#ov-*-rungs`, `#*-st-price`, `#*-st-bal`, `#*-st-eq` — add the `<prefix>` variant. That's 11 additions.
- `TAB_ORDER` const — add `'<prefix>'` between `'bg'` and `'autopilot'`
- `SWIPE_ORDER` const — add `'<prefix>'` at the end
- `PET_COLORS` map — add `<prefix>:'var(--<prefix>-color,#<hex>)'`
- `updateHdrSummary()` local `keys` array — add `'<prefix>'`

## 7. Environment variables (Railway)

At the end, tell the user exactly what env vars to add:
```
<PREFIX>_MODE=live
<PREFIX>_API_KEY=<from <exchange>.com API Management>
<PREFIX>_API_SECRET=<same page>
```

## Sanity-check queries

Before committing, run these:

```bash
node --check src/exchange/<prefix>/<exchange>.js
node --check src/exchange/<prefix>/paper.js
node --check src/exchange/<prefix>/index.js
node --check src/config.js
node --check src/server.js
node --check src/ai/autopilot.js
node --check src/ai/service.js
node --check src/pets.js
npm test
```

If tests break, you almost certainly broke an existing exchange's wiring (usually a comma or missing entry in a map). Bisect by reverting your changes to one file at a time.
