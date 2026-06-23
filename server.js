import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf-8')
    .split('\n')
    .forEach(line => {
      const m = line.match(/^([^#\s=][^=]*)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim();
      }
    });
} catch { /* .env is optional */ }

// ── Auth ────────────────────────────────────────────────────────────
// Parse USERS env var: "alice:pass1,bob:pass2"
const USERS = Object.fromEntries(
  (process.env.USERS || '').split(',')
    .map(u => u.trim()).filter(Boolean)
    .map(u => { const i = u.indexOf(':'); return i > 0 ? [u.slice(0, i), u.slice(i + 1)] : null; })
    .filter(Boolean)
);
const AUTH_ENABLED = Object.keys(USERS).length > 0;

const sessions = new Map();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL });
  return token;
}

function getSession(req) {
  const m = (req.headers.cookie || '').match(/\bdt_sess=([a-f0-9]{64})\b/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expires < Date.now()) { sessions.delete(m[1]); return null; }
  return s;
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) { req.username = 'default'; return next(); }
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  req.username = s.username;
  next();
}

// ── Portfolio storage ────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

async function readPortfolio(username) {
  try {
    const raw = await readFile(path.join(DATA_DIR, `portfolio-${username}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return []; }
}

async function writePortfolio(username, tickers) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, `portfolio-${username}.json`), JSON.stringify(tickers));
}

// ── Polygon ──────────────────────────────────────────────────────────
const POLY_BASE = 'https://api.polygon.io';

async function polyGet(endpoint) {
  const key = process.env.POLYGON_KEY;
  if (!key) {
    const err = new Error('POLYGON_KEY not configured');
    err.noKey = true;
    throw err;
  }
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${POLY_BASE}${endpoint}${sep}apiKey=${key}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'DistributionTracker/1.0' }
  });
  if (!res.ok) throw new Error(`Polygon ${res.status}: ${res.statusText}`);
  return res.json();
}

async function polyGetRetry(endpoint) {
  try {
    return await polyGet(endpoint);
  } catch (err) {
    if (err.message.includes('429')) {
      console.log(`  Rate-limited by Polygon — waiting 65 s before retry…`);
      await new Promise(r => setTimeout(r, 65000));
      return await polyGet(endpoint);
    }
    throw err;
  }
}

function estimateNextExDate(lastDate, frequency) {
  const days = { 52: 7, 12: 30, 4: 91, 2: 182, 1: 365 }[frequency] || Math.round(365 / frequency);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let next = new Date(lastDate + 'T12:00:00Z');
  while (next <= today) next = new Date(next.getTime() + days * 86400000);
  return next.toISOString().split('T')[0];
}

// ── Server-side cache (persisted to disk) ───────────────────────────
const sCache = new Map();
const SCACHE_TTL = 12 * 60 * 60 * 1000; // 12h — matches what localStorage used to do
const CACHE_FILE = () => path.join(DATA_DIR, 'ticker-cache.json');

async function loadCache() {
  try {
    const raw = await readFile(CACHE_FILE(), 'utf8');
    for (const [sym, entry] of Object.entries(JSON.parse(raw)))
      sCache.set(sym, entry);
    console.log(`  ✓  Loaded ${sCache.size} cached ticker(s) from disk`);
  } catch { /* no cache file yet — starts empty */ }
}

let _cacheWriteTimer = null;
function scheduleCacheWrite() {
  clearTimeout(_cacheWriteTimer);
  _cacheWriteTimer = setTimeout(async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(CACHE_FILE(), JSON.stringify(Object.fromEntries(sCache)));
    } catch (e) { console.error('Cache write failed:', e.message); }
  }, 2000); // debounce: coalesce writes during a bulk fetch
}

function scGet(sym)       { const e = sCache.get(sym); return e && Date.now()-e.ts < SCACHE_TTL ? e.data : null; }
function scSet(sym, data) { sCache.set(sym, { data, ts: Date.now() }); scheduleCacheWrite(); }

// ── Express app ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth endpoints
app.get('/api/me', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ username: 'default', authEnabled: false });
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: s.username, authEnabled: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!AUTH_ENABLED) return res.json({ username: 'default' });
  if (!username || !USERS[username] || USERS[username] !== password)
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = createSession(username);
  res.setHeader('Set-Cookie', `dt_sess=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL/1000)}`);
  res.json({ username });
});

app.post('/api/logout', (req, res) => {
  const m = (req.headers.cookie || '').match(/\bdt_sess=([a-f0-9]{64})\b/);
  if (m) sessions.delete(m[1]);
  res.setHeader('Set-Cookie', 'dt_sess=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// Portfolio endpoints
app.get('/api/portfolio', requireAuth, async (req, res) => {
  res.json(await readPortfolio(req.username));
});

app.post('/api/portfolio', requireAuth, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  await writePortfolio(req.username, req.body);
  res.json({ ok: true });
});

app.get('/api/config', (_, res) => {
  res.json({ hasKey: !!process.env.POLYGON_KEY });
});

app.get('/api/ticker/:symbol', requireAuth, async (req, res) => {
  const symbol = req.params.symbol.toUpperCase().trim();
  const forceRefresh = req.query.force === '1';

  if (!forceRefresh) {
    const cached = scGet(symbol);
    if (cached) return res.json({ ...cached, _fromCache: true });
  }

  try {
    const [prevClose, divResp, tickerRef] = await Promise.all([
      polyGetRetry(`/v2/aggs/ticker/${symbol}/prev`),
      polyGetRetry(`/v3/reference/dividends?ticker=${symbol}&limit=24&order=desc`).catch(() => null),
      polyGetRetry(`/v3/reference/tickers/${symbol}`).catch(() => null)
    ]);

    const price = prevClose?.results?.[0]?.c;
    if (!price) {
      return res.status(404).json({ error: `"${symbol}" not found or has no price data.` });
    }

    const name    = tickerRef?.results?.name || symbol;
    const allDivs = (divResp?.results || []).filter(d => d.cash_amount > 0);
    const today   = new Date().toISOString().split('T')[0];

    const futureDivs   = allDivs.filter(d => d.ex_dividend_date > today);
    const pastDivs     = allDivs.filter(d => d.ex_dividend_date <= today);
    const nextDeclared = futureDivs.length > 0 ? futureDivs[futureDivs.length - 1] : null;

    const frequency       = allDivs[0]?.frequency ?? null;
    const recentDiv       = nextDeclared || pastDivs[0] || null;
    const distributionAmt = recentDiv?.cash_amount ?? 0;

    let exDividendDate = nextDeclared?.ex_dividend_date ?? null;
    let dividendDate   = nextDeclared?.pay_date ?? null;
    let isEstimated    = false;

    if (!exDividendDate && pastDivs.length > 0) {
      exDividendDate = estimateNextExDate(pastDivs[0].ex_dividend_date, frequency);
      isEstimated    = true;

      const lastEx  = pastDivs[0].ex_dividend_date;
      const lastPay = pastDivs[0].pay_date;
      if (lastEx && lastPay) {
        const offsetDays = Math.round(
          (new Date(lastPay + 'T12:00:00Z') - new Date(lastEx + 'T12:00:00Z')) / 86400000
        );
        const est = new Date(exDividendDate + 'T12:00:00Z');
        est.setDate(est.getDate() + offsetDays);
        dividendDate = est.toISOString().split('T')[0];
      }
    }

    const annualDividendRate = (distributionAmt && frequency) ? distributionAmt * frequency : 0;

    const responseData = {
      symbol, name, currentPrice: price, annualDividendRate,
      exDividendDate, dividendDate, distributionAmount: distributionAmt,
      frequency, isEstimated, currency: 'USD',
      history: allDivs.map(d => ({ date: d.ex_dividend_date, amount: d.cash_amount, payDate: d.pay_date || null }))
    };

    scSet(symbol, responseData);
    res.json({ ...responseData, _fromCache: false });

  } catch (err) {
    if (err.noKey) return res.status(503).json({ error: 'API key not configured', noKey: true });
    console.error(`[${symbol}] Error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch data.' });
  }
});

await loadCache();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Distribution Tracker → http://localhost:${PORT}`);
  if (!process.env.POLYGON_KEY)
    console.log(`\n  ⚠  No POLYGON_KEY set. Add it to .env to enable live data.\n     Free key: https://polygon.io/\n`);
  else
    console.log(`  ✓  POLYGON_KEY configured`);

  if (AUTH_ENABLED)
    console.log(`  ✓  Auth enabled — ${Object.keys(USERS).length} user(s): ${Object.keys(USERS).join(', ')}\n`);
  else
    console.log(`  ⚠  No USERS configured — auth disabled (single-user mode)\n`);
});
