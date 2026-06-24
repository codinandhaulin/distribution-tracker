# Plan: Prominent loading status in header

## Context
During Polygon API calls — especially when the server queue spaces requests 30 seconds apart — the only feedback was a small "Loading X of Y…" text in the `#last-updated` span and per-row spinners in the table. During a cold load of a large portfolio this meant sitting silently for 30s at a time with no clear indication of what was happening.

## Changes

### `public/app.css`
Added `.status-loading` class to make the status text amber and bold while fetching:
```css
#last-updated { transition: color .2s; }
#last-updated.status-loading { color: #e3b341; font-weight: 600; }
```

### `public/app.js`
- Added `_statusTimer` variable and `setStatus(text, loading)` helper
- Updated `fetchTicker(symbol, force, progress)` to start a per-second countdown timer: `⟳ Fetching MSTY (3/38) · next in ~28s` (counts down from 30 — the Polygon queue interval)
- Updated `batchFetch` to pass progress label `(i+1/total)` to `fetchTicker` and call `setStatus('Updated HH:MM')` on completion
- Replaced three direct `document.getElementById('last-updated').textContent` writes with `setStatus()` calls

## Status: Implemented
