# Distribution Tracker

A single-page web app for tracking upcoming brokerage dividend distributions. Built with Node.js + Express; no build step, no framework.

## Running the app

```bash
npm run dev   # auto-restarts on file changes (preferred while developing)
npm start     # production
```

Then open http://localhost:3000.

## API key

Uses **Polygon.io** for price and dividend data. The free "Basic" plan is sufficient.

1. Get a free key at https://polygon.io/
2. Create `.env` in the project root (see `.env.example`):
   ```
   POLYGON_KEY=your_key_here
   ```

## Architecture

- `server.js` — Express server, proxies Polygon API calls, exposes `/api/ticker/:symbol` and `/api/config`
- `public/index.html` — entire frontend (vanilla JS, no bundler)
- Ticker list + cost basis persisted in `localStorage` under key `dt2_tickers`
- Fetched API data cached in `localStorage` under key `dt2_cache` (12-hour TTL)
- Server also keeps an in-memory cache (4-hour TTL) to reduce Polygon calls within a session

## Polygon endpoints used

| Data | Endpoint |
|------|----------|
| Price (prev close) | `GET /v2/aggs/ticker/{symbol}/prev` |
| Dividend history | `GET /v3/reference/dividends?ticker={symbol}&limit=24&order=desc` |
| Company name | `GET /v3/reference/tickers/{symbol}` |

Dividend and ticker-ref calls use `.catch(() => null)` — price will still show even if those fail.

## Rate limiting (important)

Polygon's free "Basic" plan is **5 API calls per minute**. Each ticker fetch makes 3 Polygon calls in parallel, so:

- `batchFetch()` in the client enforces a **30-second gap** between tickers that need a real API call
- Cache hits are served instantly with no delay
- The server retries a single 429 after a 65-second wait before propagating the error
- Initial import of a large portfolio (38 tickers) takes ~19 minutes on first load; all subsequent loads are instant from cache
- **Refresh All** button only re-fetches tickers whose cache entry is stale (>12h old)

## Key decisions

- **Polygon over FMP**: FMP's free tier no longer covers basic quote or dividend endpoints (403/402).
- **Prev-close not real-time**: Polygon's real-time snapshot endpoint requires a paid plan. Prev-close is fine for a distribution tracker.
- **No database**: tickers + cost basis live in `localStorage`. The server is stateless.
- **Frequency from API**: Polygon returns a `frequency` field directly (1/2/4/12). If no dividend records are returned, `frequency` is `null` — never defaulted to 4 (Quarterly) to avoid misleading badges.
- **Dual-source calendar**: actual Polygon history for past ex/pay dates; forward projection for future dates using `occurrencesInMonth()` based on frequency interval.
- **Estimated vs confirmed**: future projected pay dates get `est: true` flag and render as grey/italic chips; confirmed past pay dates render as solid green.
- **Alpaca considered, not adopted**: Alpaca's free tier lacks reliable dividend history for the ETF/CEF universe this app tracks.

## UI features

### Table view
- Sortable columns — click any header to sort asc/desc; active column highlighted with ▲/▼
- Default sort: upcoming ex-dates first (soonest → furthest → past/missing)
- Columns: Ticker, Company, Price, Cost/Sh, Shares, Ex-Date, Pay Date, Dist/Sh, Freq, Ann. Rate, Yield/Price, Yield/Cost, Est. Payout, Ann. Payout
- Ann. Payout = `shares × annualDividendRate` (highlighted column)

### Calendar view
- 8-column CSS grid (7 days + week total column)
- Per-cell chip ordering: pay-date chips first (desc by amount), then ex-date chips
- Pay chips are slightly larger font (12px) than ex-date chips (10px)
- Chip colors: red = declared ex-date, purple = estimated ex-date, green = confirmed pay date, grey/italic = estimated pay date
- Weekly subtotals and monthly total shown

### Add / Import card
- Collapsible — auto-collapsed on load when portfolio exists, auto-expanded when empty
- Manual add: symbol + cost basis + shares
- CSV import: auto-detects Fidelity format (`Average Cost Basis` = per-share, `Cost Basis Total` = total)
- Duplicate symbols across CSV rows (e.g. margin + cash accounts) are merged: shares summed, cost basis weighted-averaged
- Mutual funds without exchange listings (e.g. FNILX) are not found by Polygon and will show an error — remove them manually

## Known limitations

- Polygon free tier (5 req/min) makes bulk initial import slow (~30s per uncached ticker)
- Some tickers (mutual funds, Fidelity-exclusive funds) will always fail Polygon lookup
- Pay dates for future events are estimated using the historical ex→pay offset from the most recent dividend record
