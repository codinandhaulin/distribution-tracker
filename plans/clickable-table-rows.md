# Plan: Clickable Table Rows → Symbol Modal

Clicking anywhere on a table row (except the action buttons) opens the existing `openSymbolModal(symbol)` — the same modal triggered by ticker chips in the calendar view.

---

## Approach

Event delegation on `#tbody` — one listener attached once at init, survives re-renders. Action buttons stop propagation on their parent `.actions` div.

---

## Changes

### `public/app.js`

**1. Add `onclick="event.stopPropagation()"` to the `.actions` div in `actionBtns()`**

```js
// before
return `<div class="actions">
// after
return `<div class="actions" onclick="event.stopPropagation()">
```

**2. Add `data-symbol="${symbol}"` to every `<tr>` in `renderRow()`**

All four row states (loading, error, no-data, full-data):
```js
// before
return `<tr>
// after
return `<tr data-symbol="${symbol}">
```

**3. Add delegated listener in `startApp()`, alongside the existing `#thead-row` listener**

```js
document.getElementById('tbody').addEventListener('click', e => {
  if (e.target.closest('.actions')) return;
  const row = e.target.closest('tr[data-symbol]');
  if (!row) return;
  openSymbolModal(row.dataset.symbol);
});
```

### `public/app.css`

**4. Add pointer cursor for clickable rows**

```css
tbody tr[data-symbol] { cursor: pointer; }
```

Add after the existing `tbody tr:last-child td` rule. The existing hover background highlight already applies — no extra color needed.

---

## Notes

- `openSymbolModal` already handles the no-data case gracefully ("No data loaded yet"), so loading/error rows are safe to click.
- The `.actions` `stopPropagation` + `closest('.actions')` guard in the listener are belt-and-suspenders.
- Badge `onclick` attributes on lines ~504/549 of `renderRow` may optionally be removed (row click handles it now) but leaving them is harmless.
- No HTML or server changes needed.
