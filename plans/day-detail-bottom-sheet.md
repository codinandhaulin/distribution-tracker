# Plan: Day detail bottom sheet for mobile calendar

## Context
On mobile, calendar cells are ~53px wide — chips are 8px font and unreadable. Tapping a chip requires pixel-perfect accuracy. The fix: make each day cell tappable to open a "day detail" sheet showing all events for that day in a readable list, with each ticker tappable to drill into its symbol modal.

On mobile: bottom sheet slides up from the bottom (native-feeling).
On desktop: standard centered modal (same pattern as existing modals).

## Changes

### `public/app.js`
- Added `let calEvents = {}` at module scope
- In `renderCalendar()`: assign `calEvents = events` before building HTML; add `onclick="openDayModal('${ds}')"` to each `.cal-cell`
- Added `event.stopPropagation()` to both chip onclick handlers in `makeChips()` so chips still open symbol modal without bubbling to the day modal
- Added `openDayModal(dateStr)` and `closeDayModal()` functions (after `closeSymbolModal`)
- Updated Escape key handler to also call `closeDayModal()`

### `public/index.html`
- Added `#day-modal` overlay element before `<script src="app.js">`

### `public/app.css`
- Added `.day-modal-total`, `.day-modal-row`, `.day-modal-type`, `.day-modal-amt`, `.day-modal-est` styles
- Inside `@media (max-width: 640px)`: added bottom-sheet override for `#day-modal` (aligns to bottom, full width, rounded top corners, 75vh max height)

## Status: Implemented
