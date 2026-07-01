# Plan: Mobile weekly total as full-width bar row

## Context

On mobile the `.cal-week-total` column is hidden to fit the 7-day grid. The user wants to see weekly payout totals on mobile. The week-total cell is already an independent grid item inserted after every 7 day cells — we can use `grid-column: 1 / -1` to span it across all 7 columns, turning it into a compact receipt-style subtotal bar between week rows. Zero JavaScript changes needed.

## Change — `public/app.css` only

Inside the existing `@media (max-width: 640px)` block, replace:

```css
.cal-week-total,
.cal-dow-week {
  display: none;
}
```

with:

```css
/* Hide the header "Week" column — no longer needed */
.cal-dow-week {
  display: none;
}

/* Show week totals as a full-width bar spanning all 7 day columns */
.cal-week-total {
  grid-column: 1 / -1;
  min-width: 0;
  padding: 3px 10px;
  border-left: none;
  border-top: 1px solid rgba(63, 185, 80, 0.25);
  background: rgba(63, 185, 80, 0.06);
  font-size: 11px;
  justify-content: flex-end;
}
```

The `grid-column: 1 / -1` causes the cell to auto-flow onto its own row and span all 7 columns. The green tinted background and subtle top border make it read as a subtotal without being visually heavy.

## Files changed

- `public/app.css` — inside the `@media (max-width: 640px)` block

## Status: Implemented
