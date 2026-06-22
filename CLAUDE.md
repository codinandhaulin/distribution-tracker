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
- State is persisted in `localStorage` under the key `dt2_tickers`

## Polygon endpoints used

| Data | Endpoint |
|------|----------|
| Price (prev close) | `GET /v2/aggs/ticker/{symbol}/prev` |
| Dividend history | `GET /v3/reference/dividends?ticker={symbol}&limit=24&order=desc` |
| Company name | `GET /v3/reference/tickers/{symbol}` |

The dividend and ticker-ref calls use `.catch(() => null)` so a plan restriction on those endpoints doesn't break the whole request — price will still show.

## Key decisions

- **Polygon over FMP**: FMP's free tier no longer covers basic quote or dividend endpoints (403/402). Polygon's free tier covers aggregates and reference data.
- **Prev-close not real-time**: Polygon's real-time snapshot endpoint requires a paid plan. Prev-close is fine for a distribution tracker.
- **No database**: tickers + cost basis live in the browser's `localStorage`. The server is stateless.
- **Frequency from API**: Polygon returns a `frequency` field directly (1/2/4/12), so there's no need to infer it from date intervals.
