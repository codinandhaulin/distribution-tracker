# Distribution Tracker

A single-page web app for tracking upcoming brokerage dividend distributions. Built with Node.js + Express; no build step, no framework.

## Running the app

```bash
npm run dev   # auto-restarts on file changes (preferred while developing)
npm start     # production
npm test      # run unit tests (node:test, no install needed)
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

- `server.js` — Express server, SQLite storage, JWT auth, server-side Polygon queue
- `public/index.html` — HTML shell only (no inline CSS or JS)
- `public/app.css` — all styles (~380 lines)
- `public/app.js` — all client JS (~500 lines, vanilla, no bundler)
- Portfolio + cache stored in `data/app.db` (SQLite via `node:sqlite`)
- No `localStorage` usage for app data (fully server-side)

## File layout

```
server.js          Express + SQLite + auth + Polygon queue
public/
  index.html       HTML shell, links app.css + app.js
  app.css          All styles (extracted from old monolithic HTML)
  app.js           All frontend JS (extracted from old monolithic HTML)
test/
  logic.test.js    Unit tests for pure-logic functions (node:test, no npm install)
data/
  app.db           SQLite DB (WAL mode): users, portfolios, ticker_cache
  *.json.migrated  Renamed JSON files after one-time migration to SQLite
```

## Dependencies

- `express` — HTTP server
- `bcryptjs` — password hashing (pure JS, no native compilation)
- `jsonwebtoken` — JWT session tokens
- `node:sqlite` — built-in SQLite (Node 24+, no npm package needed)

## Auth

- `USERS=martin:password,bob:other` in `.env` → users seeded into SQLite on startup (bcrypt-hashed)
- JWT sessions: `dt_tok` cookie, 7-day TTL, signed with `JWT_SECRET`
- If `USERS` is empty, auth is disabled and a single "default" user is used (good for local dev)
- `JWT_SECRET` in `.env` — if missing, a random secret is generated each restart (sessions reset)

## SQLite schema

```sql
users         (username PK, password_hash)
portfolios    (username PK, tickers TEXT)   -- JSON array of {symbol, costBasis, shares}
ticker_cache  (symbol PK, data TEXT, ts INTEGER)  -- 12h TTL
```

## Polygon endpoints used

| Data | Endpoint |
|------|----------|
| Price (prev close) | `GET /v2/aggs/ticker/{symbol}/prev` |
| Dividend history | `GET /v3/reference/dividends?ticker={symbol}&limit=24&order=desc` |
| Company name | `GET /v3/reference/tickers/{symbol}` |

Dividend and ticker-ref calls use `.catch(() => null)` — price will still show even if those fail.

## Rate limiting (important)

Polygon's free "Basic" plan is **5 API calls per minute**. Each ticker fetch makes 3 Polygon calls in parallel, so:

- **Server-side Polygon queue** (`polyEnqueue` / `drainPolyQueue` in `server.js`) serialises all Polygon calls across every connected browser — 30-second spacing between uncached fetches
- Cache hits (SQLite, 12h TTL) bypass the queue and return immediately
- The server retries a single 429 after a 65-second wait before propagating the error
- Initial import of a large portfolio (38 tickers) takes ~19 minutes on first cold load; all subsequent loads are instant from cache
- **Refresh All** button only re-fetches tickers whose cache entry is stale (>12h old) — safe to click anytime
- Client-side `batchFetch()` is sequential (no explicit delay) — server response time is the natural pacing
- Page-load uses `Promise.all` (parallel requests) — cache hits all return instantly; queue handles any cold tickers

## Key decisions

- **Polygon over FMP**: FMP's free tier no longer covers basic quote or dividend endpoints (403/402).
- **Prev-close not real-time**: Polygon's real-time snapshot endpoint requires a paid plan. Prev-close is fine for a distribution tracker.
- **node:sqlite over better-sqlite3**: Node 24's built-in sqlite module has the same synchronous API, zero native compilation needed. better-sqlite3 v9 requires C++20 which the macOS CommandLineTools Clang doesn't support by default.
- **JWT over in-memory sessions**: Stateless — sessions survive container restarts as long as JWT_SECRET is stable. Cookie name: `dt_tok`.
- **bcryptjs over bcrypt**: Pure JS, no native module compilation, slightly slower but imperceptible for login.
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

### 12-Month Payout Forecast chart
- Vertical bar chart card between the summary strip and the table/calendar
- Computes projected pay dates for each ticker for the next 12 months using `occurrencesInMonth()` + pay-date offset
- Bars scaled against range (max − 80%×min floor) so month-to-month differences are visible
- Current month highlighted; next-year months styled blue with rotated year label on first bar
- Annual total shown in chart header
- Hover tooltip shows per-ticker breakdown for that month, sorted by amount descending
- `computeMonthlyProjections()` attributes amounts to the **pay-date month** (not ex-date month)

### Calendar view
- 8-column CSS grid (7 days + week total column)
- Per-cell chip ordering: pay-date chips first (desc by amount), then ex-date chips
- Pay chips are slightly larger font (12px) than ex-date chips (10px)
- Chip colors: red = declared ex-date, purple = estimated ex-date, green = confirmed pay date, grey/italic = estimated pay date
- Weekly subtotals and monthly total shown
- Pay chips show inline delta vs prior distribution: `▲6.2%` (green) or `▼3.1%` (red) when a prior exists; tooltip shows per-share dollar detail ("Prev: $0.48/sh → $0.51/sh (+6.2%)")
- Today's date number rendered as blue filled circle
- Same-ticker pay events on same date merged (`addEv()` sums amounts and perShare)
- Daily payout total shown top-right of each cell in green mono

### Add / Import card
- Collapsible — auto-collapsed on load when portfolio exists, auto-expanded when empty
- Manual add: ticker + cost basis + shares
- CSV import: auto-detects Fidelity format (`Average Cost Basis` = per-share, `Cost Basis Total` = total)
- Default CSV mode = **merge** (update existing tickers, add new ones, leave others untouched); "Replace all" checkbox for full replace
- Duplicate tickers across CSV rows (e.g. margin + cash accounts) are merged: shares summed, cost basis weighted-averaged
- Mutual funds without exchange listings (e.g. FNILX) are not found by Polygon and will show an error — remove them manually

## Tests

```bash
npm test   # runs test/logic.test.js via node:test (built-in, no extra install)
```

69 tests across 6 suites covering the highest-risk pure-logic functions:

| Suite | What it covers |
|-------|---------------|
| `occurrencesInMonth` | Monthly/weekly/quarterly/annual funds; anchor-in-future rewind; zero-hit months |
| `projectFutureDates` | Date spacing, pay-offset, `isEstimated` propagation, null frequency/ex-date |
| `parseCSVRow` | Quoted commas, dollar amounts with commas, whitespace trimming, empty fields |
| `parseNum` | `$1,234.56` → `1234.56`, dashes → null, empty/null input |
| `mergePositions` | Weighted-average cost basis across duplicate ticker rows (Fidelity margin+cash lots) |
| CSV header detection | Fidelity column-name regexes for symbol, per-share cost, total cost, skip rows |

**Important:** the test file inlines copies of the functions from `public/app.js` (browser globals can't be imported). When you change a logic function in `app.js`, update the matching copy in `test/logic.test.js` too.

## Known limitations

- Polygon free tier (5 req/min) makes bulk initial import slow (~30s per uncached ticker)
- Some tickers (mutual funds, Fidelity-exclusive funds) will always fail Polygon lookup
- Pay dates for future events are estimated using the historical ex→pay offset from the most recent dividend record

## Working notes (for Claude — read on every new session)

**Owner:** Martin Bradley (mbradley@codematters.com). Personal finance tool for his own portfolio.

**Portfolio profile:** High-yield covered-call ETFs (MSTY, CONY, TSLY, AIPI, QQQI, BLOX, SPYI, TSPY, etc.), some BDCs (PBDC, CSWC), and a few growth positions (VOO, VUG, PYPL, RTX). Holds positions across both Margin and Cash accounts at Fidelity — CSV exports contain duplicate ticker rows that must be merged (shares summed, cost basis weighted-averaged).

**Plans:** Design/planning documents are saved in `plans/` in the repo root. Save each plan there (in addition to the Claude plan file) so decisions are captured in git history.

**How Martin likes to work:**
- Keep solutions simple — this is a personal tool, not a production codebase. Prefer editing existing functions over adding new abstraction layers. Three similar lines beats a premature helper.
- Update CLAUDE.md **and README.md** continuously after every meaningful change, not just at end of session.
- If Martin says "respond with TEXT ONLY and not call any tools" — obey literally, no tool calls for that response. He uses this during sensitive operations (e.g. mid-import when 429 errors are flying).
- When proposing UI changes, give 2–3 concrete options with a clear recommendation before building. Martin will say "yes" or redirect.

**Fidelity CSV format (already handled in code):**
- Column `Average Cost Basis` = per-share cost (not total)
- Column `Cost Basis Total` = total cost (divide by quantity for per-share)
- `SPAXX**` (money market sweep) has no quantity/cost and is auto-skipped
- `Pending activity` rows are filtered by the `pending` keyword check
- Duplicate rows per ticker (margin + cash lots) are merged in `handleCSVFile()`

**GitHub:** https://github.com/codinandhaulin/distribution-tracker
