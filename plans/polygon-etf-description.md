# Plan: ETF description from Polygon

## Context
Polygon's `/v3/reference/tickers/{symbol}` is already called in `fetchFromPolygon` (server.js) to get the company name. We investigated whether the same response contained a `description` field that could be shown in the ticker detail modal.

## Proposed Change
1. Extract `tickerRef?.results?.description` in `server.js` alongside `name`
2. Include `description` in the cached object returned from `fetchFromPolygon`
3. Render it as a muted paragraph in `openSymbolModal()` in `app.js`, between the stats strip and bar chart

## Status: Abandoned
Polygon's free Basic plan does not return a `description` field. Confirmed by adding a debug `console.log(Object.keys(tickerRef.results))` — the response only includes:
`ticker, name, market, locale, primary_exchange, type, active, currency_name, composite_figi, share_class_figi, ticker_root, list_date, share_class_shares_outstanding, round_lot`

Description is a paid-tier feature. All code changes were reverted.
