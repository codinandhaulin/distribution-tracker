# Plan: Portfolio Value Summary Row (Option B)

Second row below the existing summary strip showing Market Value, Total Cost, and Unrealized Gain/Loss. No new API calls — all data is already in memory.

---

## What we're computing

| Stat | Formula |
|------|---------|
| Market Value | Σ `shares × currentPrice` (tickers with both loaded) |
| Total Cost | Σ `shares × costBasis` (tickers with shares) |
| Unrealized Gain/Loss | Market Value − Total Cost, as `$X.XX (+Y.Y%)` |

Gain is green; loss is red; `—` when insufficient data.

---

## Touch points

### `public/index.html`

Wrap the existing 6 `.stat` divs in a new `<div class="summary-row summary-row--top">`. Add a second child `<div class="summary-row summary-row--portfolio">` with three stat cells:

```html
<div class="summary-strip hidden" id="summary-strip">

  <div class="summary-row summary-row--top">
    <!-- existing 6 .stat cells unchanged, same IDs -->
    <div class="stat"><div class="stat-label">Tickers</div><div class="stat-value" id="s-count">—</div></div>
    <div class="stat"><div class="stat-label">Ex-Dates ≤ 7 Days</div><div class="stat-value amber" id="s-urgent">—</div></div>
    <div class="stat"><div class="stat-label">Payout Due ≤ 30 Days</div><div class="stat-value" id="s-payout">—</div></div>
    <div class="stat"><div class="stat-label">Avg Yield on Cost</div><div class="stat-value green" id="s-yoc">—</div></div>
    <div class="stat"><div class="stat-label">Avg Yield on Price</div><div class="stat-value" id="s-yop">—</div></div>
    <div class="stat"><div class="stat-label">Est. Annual Total</div><div class="stat-value green" id="s-annual">—</div></div>
  </div>

  <div class="summary-row summary-row--portfolio">
    <div class="stat"><div class="stat-label">Market Value</div><div class="stat-value" id="s-mktval">—</div></div>
    <div class="stat"><div class="stat-label">Total Cost</div><div class="stat-value" id="s-cost">—</div></div>
    <div class="stat"><div class="stat-label">Unrealized Gain / Loss</div><div class="stat-value" id="s-gain">—</div></div>
  </div>

</div>
```

New IDs: `s-mktval`, `s-cost`, `s-gain`.

---

### `public/app.css`

**Change `.summary-strip`** from a single flat grid to a column-flex container:

```css
/* Before */
.summary-strip {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 1px; background: var(--border); border: 1px solid var(--border);
  border-radius: 10px; overflow: hidden;
}

/* After */
.summary-strip {
  display: flex; flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px; overflow: hidden;
}
```

**Add `.summary-row` rules** (each row gets the original grid behaviour):

```css
.summary-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 1px;
  background: var(--border);
}
.summary-row--portfolio {
  border-top: 1px solid var(--border);
}
```

**Add `.loss` color class** (after the existing `.stat-value.amber` rule):

```css
.stat-value.loss { color: var(--red); }
```

Gain reuses the existing `.green` class.

---

### `public/app.js` — `renderSummary()`

Add a portfolio value loop after the existing loops, then write three new elements at the end:

```js
// ── Row 2: Portfolio value ──
let mktVal = 0, hasMktVal = false;
let totalCost = 0, hasCost = false;

for (const { symbol, costBasis, shares } of S.tickers) {
  const d = S.data[symbol];
  if (shares != null && d?.currentPrice) { mktVal += shares * d.currentPrice; hasMktVal = true; }
  if (shares != null && costBasis)       { totalCost += shares * costBasis;    hasCost = true; }
}

document.getElementById('s-mktval').textContent = hasMktVal ? fmt$(mktVal) : '—';
document.getElementById('s-cost').textContent   = hasCost   ? fmt$(totalCost) : '—';

const gainEl = document.getElementById('s-gain');
if (hasMktVal && hasCost) {
  const gain = mktVal - totalCost;
  const gainPct = totalCost > 0 ? (gain / totalCost) * 100 : null;
  const sign = gain >= 0 ? '+' : '';
  gainEl.textContent = fmt$(gain) + (gainPct != null ? ` (${sign}${gainPct.toFixed(2)}%)` : '');
  gainEl.className = 'stat-value ' + (gain >= 0 ? 'green' : 'loss');
} else {
  gainEl.textContent = '—';
  gainEl.className = 'stat-value';
}
```

**Notes:**
- Gain/Loss className is replaced wholesale on each render (no stale-class risk).
- `gain >= 0` is green; `gain < 0` is red; `$0.00 (+0.00%)` is green (not a loss).
- Both `hasMktVal` and `hasCost` must be true for Gain/Loss to render; otherwise `—`.

---

## Implementation order

1. HTML — safe to add before CSS/JS wires it up
2. CSS — restores correct layout
3. JS — connects data

No server changes, no new API calls, no test changes.
