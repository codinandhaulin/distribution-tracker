import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf-8")
    .split("\n")
    .forEach((line) => {
      const m = line.match(/^([^#\s=][^=]*)=(.*)$/);
      if (m && !process.env[m[1].trim()])
        process.env[m[1].trim()] = m[2].trim();
    });
} catch {
  // Ignore missing .env file.
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Database ──────────────────────────────────────────────────────────
const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS portfolios (
    username TEXT PRIMARY KEY,
    tickers  TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS ticker_cache (
    symbol TEXT PRIMARY KEY,
    data   TEXT NOT NULL,
    ts     INTEGER NOT NULL
  );
`);

// ── Prepared statements ───────────────────────────────────────────────
const stmt = {
  userGet: db.prepare("SELECT password_hash FROM users WHERE username=?"),
  userExists: db.prepare("SELECT 1 FROM users WHERE username=?"),
  userInsert: db.prepare(
    "INSERT OR IGNORE INTO users (username,password_hash) VALUES (?,?)",
  ),
  userCount: db.prepare("SELECT COUNT(*) AS n FROM users"),
  portfolioGet: db.prepare("SELECT tickers FROM portfolios WHERE username=?"),
  portfolioUpsert: db.prepare(
    "INSERT OR REPLACE INTO portfolios (username,tickers) VALUES (?,?)",
  ),
  cacheGet: db.prepare("SELECT data,ts FROM ticker_cache WHERE symbol=?"),
  cacheUpsert: db.prepare(
    "INSERT OR REPLACE INTO ticker_cache (symbol,data,ts) VALUES (?,?,?)",
  ),
};

// ── Auth setup ────────────────────────────────────────────────────────
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (() => {
    console.warn(
      "  ⚠  JWT_SECRET not set — sessions will reset on restart. Add JWT_SECRET to .env",
    );
    return crypto.randomBytes(32).toString("hex");
  })();

async function seedUsers() {
  const raw = (process.env.USERS || "").trim();
  if (!raw) return;
  for (const entry of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = entry.indexOf(":");
    if (i < 0) continue;
    const username = entry.slice(0, i),
      password = entry.slice(i + 1);
    if (stmt.userExists.get(username)) continue;
    const hash = await bcrypt.hash(password, 10);
    stmt.userInsert.run(username, hash);
    console.log(`  ✓  Created user: ${username}`);
  }
}

let AUTH_ENABLED = false; // set after seedUsers()

function getAuthUser(req) {
  const m = (req.headers.cookie || "").match(/\bdt_tok=([^;]+)/);
  if (!m) return null;
  try {
    return jwt.verify(decodeURIComponent(m[1]), JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) {
    req.username = "default";
    return next();
  }
  const payload = getAuthUser(req);
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  req.username = payload.username;
  next();
}

// ── Portfolio ─────────────────────────────────────────────────────────
function readPortfolio(username) {
  const row = stmt.portfolioGet.get(username);
  try {
    return row ? JSON.parse(row.tickers) : [];
  } catch {
    return [];
  }
}

function writePortfolio(username, tickers) {
  stmt.portfolioUpsert.run(username, JSON.stringify(tickers));
}

// ── Ticker cache ──────────────────────────────────────────────────────
// Two freshness rules instead of a flat TTL:
//  • price: prev-close only changes once per trading day — fresh until the
//    most recent market close (~16:30 ET on weekdays)
//  • dividends: history is immutable; new declarations only matter once the
//    next expected ex-date passes — fresh until then (7-day fallback when
//    no ex-date is known)
// When only the price is stale, fetchTickerSmart refetches just prev-close
// (1 Polygon call instead of 3) and merges it into the cached blob.
const DIV_FALLBACK_TTL = 7 * 24 * 60 * 60 * 1000;

function cacheRow(symbol) {
  const row = stmt.cacheGet.get(symbol);
  if (!row) return null;
  try {
    return { data: JSON.parse(row.data), ts: row.ts };
  } catch {
    return null;
  }
}

function lastMarketCloseMs(now = Date.now()) {
  // Read ET wall-clock via the toLocaleString round-trip, find the most
  // recent weekday 16:30 ET, then shift the wall-clock delta back onto the
  // real timestamp.
  // ponytail: ignores market holidays — worst case one redundant 1-call refresh
  const et = new Date(
    new Date(now).toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const close = new Date(et);
  close.setHours(16, 30, 0, 0); // 16:00 close + 30 min for data to settle
  if (et < close) close.setDate(close.getDate() - 1);
  while (close.getDay() === 0 || close.getDay() === 6)
    close.setDate(close.getDate() - 1);
  return now - (et - close);
}

function priceFresh(ts, now = Date.now()) {
  return ts >= lastMarketCloseMs(now);
}

function divsFresh(data, ts, now = Date.now()) {
  if (data.exDividendDate) {
    const today = new Date(now).toISOString().split("T")[0];
    return today <= data.exDividendDate;
  }
  return now - (data.divTs ?? ts) < DIV_FALLBACK_TTL;
}

function cacheFresh(row, now = Date.now()) {
  return !!row && priceFresh(row.ts, now) && divsFresh(row.data, row.ts, now);
}

function scSet(symbol, data) {
  stmt.cacheUpsert.run(symbol, JSON.stringify(data), Date.now());
}

// ── Polygon ───────────────────────────────────────────────────────────
const POLY_BASE = "https://api.polygon.io";
// Yahoo 429s are usually IP-level penalties lasting minutes-to-hours, not
// transient rate blips. One attempt per call, and the cooldown doubles on
// every consecutive 429 (60s → 30min cap) so we stop refreshing the penalty.
const YAHOO_COOLDOWN_MS = 60000;
const YAHOO_COOLDOWN_MAX_MS = 30 * 60000;
let yahooLast429 = 0;
let yahooCooldownMs = YAHOO_COOLDOWN_MS;

// Token-bucket to throttle actual Polygon HTTP calls. We track tokens
// (one token == one Polygon HTTP request). Tokens refill at a steady
// pace to enforce `POLY_MAX_PER_MIN` across the process.
const POLY_MAX_PER_MIN = Number(process.env.POLY_MAX_PER_MIN) || 5;
const POLY_TOKEN_REFILL_MS = Math.floor(60000 / POLY_MAX_PER_MIN) || 12000;
// Start with 1 token, not a full bucket: a full bucket plus first-minute
// refills lets a cold import fire ~2× the per-minute quota and trip a 429. 
let polyTokens = 1;
let polyRefillTimer = null;

function startPolyRefill() {
  if (polyRefillTimer) return;
  polyRefillTimer = setInterval(() => {
    polyTokens = Math.min(polyTokens + 1, POLY_MAX_PER_MIN);
  }, POLY_TOKEN_REFILL_MS);
}

function stopPolyRefill() {
  if (!polyRefillTimer) return;
  clearInterval(polyRefillTimer);
  polyRefillTimer = null;
}

async function acquirePolygonToken() {
  startPolyRefill();
  if (polyTokens > 0) {
    polyTokens -= 1;
    return;
  }
  // Poll until a token becomes available. The interval is small so we
  // wake quickly once refill adds a token.
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (polyTokens > 0) {
        polyTokens -= 1;
        clearInterval(iv);
        resolve();
      }
    }, Math.max(250, Math.floor(POLY_TOKEN_REFILL_MS / 4)));
  });
}

// Ensure refill timer is cleaned up on process exit
process.on("exit", stopPolyRefill);
process.on("SIGINT", () => {
  stopPolyRefill();
  process.exit();
});

async function polyGet(endpoint) {
  await acquirePolygonToken();
  const key = process.env.POLYGON_KEY;
  if (!key) {
    const e = new Error("POLYGON_KEY not configured");
    e.noKey = true;
    throw e;
  }
  const sep = endpoint.includes("?") ? "&" : "?";
  const res = await fetch(`${POLY_BASE}${endpoint}${sep}apiKey=${key}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "DistributionTracker/2.0",
    },
  });
  if (!res.ok) throw new Error(`Polygon ${res.status}: ${res.statusText}`);
  return res.json();
}

async function polyGetRetry(endpoint) {
  try {
    return await polyGet(endpoint);
  } catch (err) {
    if (!err.message.includes("429")) throw err;
    console.log("  Rate-limited — waiting 65 s…");
    await new Promise((r) => setTimeout(r, 65000));
    return polyGet(endpoint);
  }
}


async function yahooGetRetry(url, headers) {
  const sinceLast429 = Date.now() - yahooLast429;
  if (yahooLast429 > 0 && sinceLast429 < yahooCooldownMs) {
    const wait = Math.ceil((yahooCooldownMs - sinceLast429) / 1000);
    console.log(`  [yahoo] cooldown active — skipping fallback for ${wait}s`);
    throw new Error("Yahoo 429: Too Many Requests");
  }

  const res = await fetch(url, { headers });
  if (res.ok) {
    yahooLast429 = 0;
    yahooCooldownMs = YAHOO_COOLDOWN_MS;
    return res;
  }
  if (res.status === 429) {
    yahooCooldownMs = yahooLast429
      ? Math.min(yahooCooldownMs * 2, YAHOO_COOLDOWN_MAX_MS)
      : YAHOO_COOLDOWN_MS;
    yahooLast429 = Date.now();
    console.log(`  [yahoo] 429 — cooling down ${Math.round(yahooCooldownMs / 1000)}s`);
  }
  throw new Error(`Yahoo ${res.status}: ${res.statusText}`);
}

function inferFrequencyFromHistory(divs) {
  if (!divs?.length || divs.length < 2) return null;
  const dates = divs
    .map((d) => new Date(d.ex_dividend_date + "T12:00:00Z"))
    .filter((d) => !isNaN(d))
    .sort((a, b) => b - a);
  if (dates.length < 2) return null;

  const intervals = [];
  for (let i = 0; i < dates.length - 1; i++) {
    intervals.push((dates[i] - dates[i + 1]) / 86400000);
  }
  const avg = intervals.reduce((sum, v) => sum + v, 0) / intervals.length;
  if (avg <= 14) return 52;
  if (avg <= 60) return 12;
  if (avg <= 120) return 4;
  if (avg <= 220) return 2;
  return 1;
}

function estimateNextExDate(lastDate, frequency) {
  if (!lastDate || !frequency) return null;
  const days =
    { 52: 7, 12: 30, 4: 91, 2: 182, 1: 365 }[frequency] ||
    Math.round(365 / frequency);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let next = new Date(lastDate + "T12:00:00Z");
  while (next <= today) next = new Date(next.getTime() + days * 86400000);
  return next.toISOString().split("T")[0];
}

function shapeTickerData(
  symbol,
  prevClose,
  divResp,
  tickerRef,
  source = "polygon",
  today = new Date().toISOString().split("T")[0],
) {
  const price = prevClose?.results?.[0]?.c;
  if (!price) {
    const e = new Error(`Ticker "${symbol}" not found or has no price data.`);
    e.notFound = true;
    throw e;
  }

  const name = tickerRef?.results?.name || symbol;
  const allDivs = (divResp?.results || []).filter((d) => d.cash_amount > 0);
  const future = allDivs.filter((d) => d.ex_dividend_date > today);
  const past = allDivs.filter((d) => d.ex_dividend_date <= today);
  const next = future.length ? future[future.length - 1] : null;

  const rawFrequency = allDivs[0]?.frequency ?? null;
  const frequency = rawFrequency > 0 ? rawFrequency : inferFrequencyFromHistory(allDivs) ?? null;
  const recentDiv = next || past[0] || null;
  const distAmt = recentDiv?.cash_amount ?? 0;

  let exDividendDate = next?.ex_dividend_date ?? null;
  let dividendDate = next?.pay_date ?? null;
  let isEstimated = false;

  if (!exDividendDate && past.length > 0) {
    exDividendDate = estimateNextExDate(past[0].ex_dividend_date, frequency);
    isEstimated = true;
    const lastEx = past[0].ex_dividend_date,
      lastPay = past[0].pay_date;
    if (exDividendDate && lastEx && lastPay) {
      const off = Math.round(
        (new Date(lastPay + "T12:00:00Z") - new Date(lastEx + "T12:00:00Z")) /
          86400000,
      );
      const est = new Date(exDividendDate + "T12:00:00Z");
      est.setDate(est.getDate() + off);
      dividendDate = est.toISOString().split("T")[0];
    }
  }

  return {
    symbol,
    name,
    source,
    currentPrice: price,
    annualDividendRate: distAmt && frequency ? distAmt * frequency : 0,
    exDividendDate,
    dividendDate,
    distributionAmount: distAmt,
    frequency,
    isEstimated,
    currency: "USD",
    history: allDivs.map((d) => ({
      date: d.ex_dividend_date,
      amount: d.cash_amount,
      payDate: d.pay_date || null,
    })),
  };
}

async function fetchYahooDividendEvents(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=2y&interval=1d&events=div`;
  const res = await yahooGetRetry(url, {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status}: ${res.statusText}`);
  const json = await res.json();
  const events = json.chart?.result?.[0]?.events?.dividends;
  if (!events) return [];
  return Object.values(events)
    .map((e) => ({
      ex_dividend_date: new Date(e.date * 1000).toISOString().split("T")[0],
      cash_amount: e.amount,
      pay_date: null,
    }))
    .sort((a, b) => b.ex_dividend_date.localeCompare(a.ex_dividend_date));
}

// dividendhistory.org models upcoming ex/pay dates on the fund's actual
// published calendar (same-month-last-year pattern), so it knows dates that
// Polygon/Yahoo won't have until the fund files them. The payout page embeds
// a JSON blob; upcoming rows are flagged type "u". Only consulted when our
// own next ex-date is an estimate, so traffic is a few requests a day.
async function fetchDHUpcoming(symbol) {
  const res = await fetch(
    `https://dividendhistory.org/payout/${encodeURIComponent(symbol)}/`,
    {
      headers: {
        Accept: "text/html",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!res.ok) throw new Error(`dividendhistory ${res.status}`);
  const html = await res.text();
  const m = html.match(/data-dividend-chart-json>([^<]+)</);
  if (!m) return null;
  const rows = JSON.parse(m[1]).dividends || [];
  // rows are newest-first; type "u" is dividendhistory.org's own "upcoming/
  // estimated" flag. Don't also require ex_div > today: once that date slips
  // into the past (site hasn't refreshed yet, or its guess was a few days
  // early), discarding it just falls back to the cruder same-file
  // estimateNextExDate(), which skips a whole cycle ahead instead of staying
  // close to the real date.
  return rows.filter((r) => r.type === "u").pop() || null;
}

async function fetchFromPolygon(symbol) {
  const [prevClose, divResp, tickerRef] = await Promise.all([
    polyGetRetry(`/v2/aggs/ticker/${symbol}/prev`),
    polyGetRetry(
      `/v3/reference/dividends?ticker=${symbol}&limit=24&order=desc`,
    ).catch(() => null),
    polyGetRetry(`/v3/reference/tickers/${symbol}`).catch(() => null),
  ]);

  let data = shapeTickerData(symbol, prevClose, divResp, tickerRef);
  const historyThreshold =
    data.frequency === 12 ? 8 : data.frequency === 4 ? 4 : data.frequency === 2 ? 3 : 5;
  const shouldTryAlternative =
    data.history.length === 0 || data.history.length < historyThreshold;

  if (shouldTryAlternative && data.source === "polygon") {
    try {
      const yahooDivs = await fetchYahooDividendEvents(symbol);
      if (yahooDivs.length) {
        console.log(`  [yahoo] fallback used for ${symbol} (${yahooDivs.length} dividends)`);
        data = shapeTickerData(
          symbol,
          prevClose,
          { results: yahooDivs },
          tickerRef,
          "yahoo",
        );
      }
    } catch (err) {
      console.log(`  [yahoo] fallback failed for ${symbol}: ${err.message}`);
    }
  }

  if (data.isEstimated) {
    // No confirmed future dividend from Polygon/Yahoo — see if
    // dividendhistory.org knows the fund's published calendar.
    try {
      const up = await fetchDHUpcoming(symbol);
      if (up?.ex_div && up?.payday) {
        console.log(
          `  [dividendhistory] upcoming for ${symbol}: ex ${up.ex_div} pay ${up.payday}`,
        );
        data.exDividendDate = up.ex_div;
        data.dividendDate = up.payday;
        if (up.payout > 0) {
          data.distributionAmount = up.payout;
          if (data.frequency)
            data.annualDividendRate = up.payout * data.frequency;
        }
      }
    } catch (err) {
      console.log(`  [dividendhistory] failed for ${symbol}: ${err.message}`);
    }
  }

  return data;
}

async function fetchTickerSmart(symbol, force) {
  const row = cacheRow(symbol);
  if (!force && row && divsFresh(row.data, row.ts)) {
    // Dividend data still valid — only the price is stale (1 call vs 3).
    polyCurrentCalls = 1;
    const prevClose = await polyGetRetry(`/v2/aggs/ticker/${symbol}/prev`);
    const price = prevClose?.results?.[0]?.c;
    if (price) {
      const data = { ...row.data, currentPrice: price };
      scSet(symbol, data);
      return data;
    }
    // empty prev-close → fall through to a full refetch
  }
  polyCurrentCalls = POLY_CALLS_PER_FETCH;
  const data = await fetchFromPolygon(symbol);
  data.divTs = Date.now();
  scSet(symbol, data);
  return data;
}

// ── Server-side Polygon queue ─────────────────────────────────────────
// Serialises all Polygon calls across every connected client so the
// Polygon free-tier limit is respected regardless of how many browsers
// are open simultaneously. We aim to cap total Polygon API hits to
// `POLY_MAX_PER_MIN` per minute. Each uncached fetch makes an estimated
// `POLY_EST_CALLS_PER_FETCH` Polygon requests (prev, dividends, ticker ref),
// so compute the minimum interval between dequeues to stay within quota.
const POLY_CALLS_PER_FETCH = 3; // prev close + dividends + ticker ref
let polyLastAt = 0,
  polyRunning = false,
  polyCurrent = null,
  polyCurrentCalls = POLY_CALLS_PER_FETCH; // 1 when only the price is refetched
const polyQueue = []; // {symbol, force, resolve, reject}

// Coalesce concurrent requests for the same symbol. Without this, the
// page-load Promise.all (fires all tickers in parallel) and a sequential
// batchFetch (Refresh All / Hard Refresh) that overlaps it each enqueue
// their own copy of every symbol — the second wave's requests sit queued
// behind the first, so a tab's own "(i/N)" progress can appear stuck long
// after the server has moved on to different tickers from the other wave.
const polyInFlight = new Map(); // symbol -> Promise

function polyEnqueue(symbol, force) {
  if (!force) {
    const row = cacheRow(symbol);
    if (cacheFresh(row)) return Promise.resolve(row.data);
    const inflight = polyInFlight.get(symbol);
    if (inflight) return inflight;
  }
  const p = new Promise((resolve, reject) => {
    polyQueue.push({ symbol, force, resolve, reject });
    drainPolyQueue();
  });
  if (!force) {
    polyInFlight.set(symbol, p);
    p.finally(() => {
      if (polyInFlight.get(symbol) === p) polyInFlight.delete(symbol);
    });
  }
  return p;
}

async function drainPolyQueue() {
  if (polyRunning) return;
  polyRunning = true;
  try {
    while (polyQueue.length > 0) {
      const item = polyQueue[0];
      // Re-check cache — a previous dequeue may have fetched this symbol
      if (!item.force) {
        const row = cacheRow(item.symbol);
        if (cacheFresh(row)) {
          polyQueue.shift();
          item.resolve(row.data);
          continue;
        }
      }
      // No fixed dequeue interval here; the token-bucket in `polyGet`
      // enforces the true Polygon request rate. Add a small backoff when
      // the queue is long to avoid a tight busy loop.
      if (polyLastAt > 0 && polyQueue.length > 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const { symbol, force, resolve, reject } = polyQueue.shift();
      polyCurrent = symbol;
      try {
        polyLastAt = Date.now();
        console.log(`  [polygon] fetching ${symbol}`);
        resolve(await fetchTickerSmart(symbol, force));
      } catch (err) {
        reject(err);
      } finally {
        polyCurrent = null;
      }
    }
  } finally {
    polyRunning = false;
  }
}

// ── Express ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/me", (req, res) => {
  if (!AUTH_ENABLED)
    return res.json({ username: "default", authEnabled: false });
  const payload = getAuthUser(req);
  if (!payload) return res.status(401).json({ error: "Not logged in" });
  res.json({ username: payload.username, authEnabled: true });
});

app.post("/api/login", async (req, res) => {
  if (!AUTH_ENABLED) return res.json({ username: "default" });
  const { username, password } = req.body || {};
  const user = stmt.userGet.get(username);
  if (!user || !(await bcrypt.compare(password || "", user.password_hash)))
    return res.status(401).json({ error: "Invalid username or password" });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  res.setHeader(
    "Set-Cookie",
    `dt_tok=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${7 * 24 * 3600}`,
  );
  res.json({ username });
});

app.post("/api/logout", (_, res) => {
  res.setHeader("Set-Cookie", "dt_tok=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/portfolio", requireAuth, (req, res) => {
  res.json(readPortfolio(req.username));
});

app.post("/api/portfolio", requireAuth, (req, res) => {
  if (!Array.isArray(req.body))
    return res.status(400).json({ error: "Expected array" });
  writePortfolio(req.username, req.body);
  res.json({ ok: true });
});

app.get("/api/config", (_, res) => {
  res.json({ hasKey: !!process.env.POLYGON_KEY });
});

app.get("/api/version", (_, res) => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
  );
  res.json({ version: pkg.version });
});

app.get("/api/queue", (_, res) => {
  // Countdown to the next *ticker* fetch. While a fetch is active its calls
  // grab each token as it refills, so the bucket never accumulates — anchor
  // to when the current ticker started instead: it consumes `polyCurrentCalls`
  // tokens (1 for a price-only refresh, 3 for a full fetch), so the next one
  // starts ~that many refills later.
  const nextInMs = polyCurrent
    ? Math.max(0, polyLastAt + polyCurrentCalls * POLY_TOKEN_REFILL_MS - Date.now())
    : 0;
  res.json({
    pending: polyQueue.length,
    current: polyCurrent,
    total: (polyCurrent ? 1 : 0) + polyQueue.length,
    availableTokens: polyTokens,
    nextInMs,
  });
});

app.get("/api/ticker/:symbol", requireAuth, async (req, res) => {
  const symbol = req.params.symbol.toUpperCase().trim();
  const force = req.query.force === "1";
  try {
    res.json(await polyEnqueue(symbol, force));
  } catch (err) {
    if (err.noKey)
      return res
        .status(503)
        .json({ error: "API key not configured", noKey: true });
    if (err.notFound) return res.status(404).json({ error: err.message });
    console.error(`[${symbol}]`, err.message);
    res.status(500).json({ error: err.message || "Failed to fetch data." });
  }
});

// ── Startup ───────────────────────────────────────────────────────────
await seedUsers();
const userCount = stmt.userCount.get().n;
AUTH_ENABLED = userCount > 0;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Distribution Tracker → http://localhost:${PORT}`);
  if (!process.env.POLYGON_KEY)
    console.log("  ⚠  No POLYGON_KEY — add to .env to enable live data");
  else console.log("  ✓  POLYGON_KEY configured");
  if (AUTH_ENABLED) console.log(`  ✓  Auth enabled (${userCount} user(s))`);
  else
    console.log("  ⚠  No users configured — auth disabled (single-user mode)");
  console.log();
});
