# Distribution Tracker

A personal web app for tracking upcoming brokerage dividend distributions. Shows ex-dates, pay dates, and projected payouts in a calendar and table view.

Built with Node.js + Express, vanilla JS, and SQLite. No build step.

## Setup

**1. Prerequisites**

- Node.js 24+

**2. Install dependencies**

```bash
npm install
```

**3. Get a Polygon.io API key**

Sign up for free at [polygon.io](https://polygon.io/) — the Basic (free) plan is sufficient.

**4. Create `.env`**

```
POLYGON_KEY=your_key_here
JWT_SECRET=some_long_random_string
USERS=martin:yourpassword
```

If `USERS` is omitted, auth is disabled (single-user local mode).

## Running

```bash
npm run dev   # development — auto-restarts on file changes
npm start     # production
npm test      # run unit tests
```

Then open [http://localhost:3000](http://localhost:3000).

## Importing your portfolio

Click **Add / Import** and upload a CSV export from Fidelity. Duplicate ticker rows (margin + cash accounts) are automatically merged — shares summed, cost basis weighted-averaged.

## Notes

- First cold load is slow on Polygon's free tier (~30s per uncached ticker due to 5 req/min rate limit). All subsequent loads are instant from the 12-hour cache.
- Mutual funds without exchange listings (e.g. FNILX) will fail Polygon lookup — remove them manually.
