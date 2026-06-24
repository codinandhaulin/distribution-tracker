# Plan: Mobile-friendly layout (calendar-first)

## Context
The app is used heavily on mobile but had only one narrow media query (600px) that barely helped. The 8-column calendar grid (~49px/column on a 390px phone), overflowing header, and excessive padding made it nearly unusable on a phone. Priority was the calendar view, which Martin uses most.

## Key findings
- Calendar grid: `repeat(7, 1fr) auto` — 8 columns including week-total. ~49px/col on 390px phone.
- Header: 5 elements in a row (brand, status, view toggle, refresh, user chip) — overflows at ~390px
- Only existing media query: `@media (max-width: 600px)` with 4 trivial rules
- `1fr` columns have implicit min-size from content — needed `minmax(0, 1fr)` to hard-cap column width

## Changes

### `public/index.html`
- Wrapped "Refresh All" button text in `<span class="btn-label">Refresh All</span>` so it can be hidden on mobile via CSS while keeping the SVG icon

### `public/app.css`
Replaced the thin `@media (max-width: 600px)` block with a comprehensive `@media (max-width: 640px)` block covering:
- **Header**: reduce padding to 10px, hide brand title text (`.brand h1`), hide "Refresh All" label (`.btn-label`), allow flex-wrap
- **Main**: reduce padding from `20px 24px` to `10px 10px`
- **Summary strip**: tighter gaps and padding
- **Bar chart**: hidden (`#chart-card { display: none }`) — too narrow to be useful
- **Calendar**: hide week-total column, switch to `repeat(7, minmax(0, 1fr))`, shrink cells (52px min-height) and chips (8px font)
- **Ticker detail modal**: `overflow-x: auto` on modal body, reduce hist-table padding from 18px to 8px
- **Add/Import card**: column layout on mobile

## Status: Implemented
Notable fix: used `minmax(0, 1fr)` instead of `1fr` to prevent chip content from expanding grid columns beyond available width (was clipping Saturday on iPhone 14 Pro Max).
