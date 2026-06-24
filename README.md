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
npm run lint  # lint the project
```

Then open [http://localhost:3000](http://localhost:3000).

## Importing your portfolio

Click **Add / Import** and upload a CSV export from Fidelity. Duplicate ticker rows (margin + cash accounts) are automatically merged — shares summed, cost basis weighted-averaged.

## Deploying with Docker

A `Dockerfile` and `docker-compose.yml` are included.

**1. Make sure `.env` exists** in the project root with your keys (same as local setup above). Docker Compose reads it automatically.

**2. Build and start**

```bash
docker compose up -d
```

The app will be available at [http://localhost:3000](http://localhost:3000).

**3. Stopping / restarting**

```bash
docker compose down       # stop and remove container
docker compose restart    # restart without rebuilding
```

**4. Rebuilding after code changes**

```bash
docker compose up -d --build
```

**Data persistence**

The SQLite database is stored in `./data/app.db` on the host (mounted into the container), so your portfolio and cache survive container restarts and rebuilds.

**Notes on JWT_SECRET**

Set a stable `JWT_SECRET` in `.env`. If it's missing, a random one is generated each startup and all sessions are invalidated on restart.

## Publishing and pulling a pre-built image

To run on another machine without building from source, publish the image to a registry first.

**Docker Hub** (1 free private repo):
```bash
docker build -t yourusername/distribution-tracker .
docker push yourusername/distribution-tracker
```

**GitHub Container Registry** (free, tied to your GitHub account):

Create a GitHub PAT at **Settings → Developer settings → Personal access tokens → Tokens (classic)** with scopes: `write:packages`, `read:packages`, `delete:packages`.

```bash
echo YOUR_GITHUB_PAT | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
docker build -t ghcr.io/codinandhaulin/distribution-tracker .
docker push ghcr.io/codinandhaulin/distribution-tracker
```

**On the destination machine:**

1. Create `.env` with your keys (see Setup above — the image does not contain secrets)
2. Copy `docker-compose.yml` to the same folder
3. Pull and start:

```bash
docker compose pull
docker compose up -d
```

---

## Notes

- First cold load is slow on Polygon's free tier (~30s per uncached ticker due to 5 req/min rate limit). All subsequent loads are instant from the 12-hour cache.
- Mutual funds without exchange listings (e.g. FNILX) will fail Polygon lookup — remove them manually.
