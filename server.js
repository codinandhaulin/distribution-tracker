import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

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

// Retry polyGet once on 429, waiting 65 seconds for the rate-limit window to reset.
async function polyGetRetry(endpoint) {
  try {
    return await polyGet(endpoint);
  } catch (err) {
    if (err.message.includes('429')) {
      console.log(`  Rate-limited by Polygon — waiting 65 s before retry…`);
      await new Promise(r => setTimeout(r, 65000));
      return await polyGet(endpoint); // throws if still 429
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

// ── Server-side cache (survives within a process session) ───────────
const sCache = new Map(); // symbol -> { data, ts }
const SCACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

function scGet(sym)       { const e = sCache.get(sym); return e && Date.now()-e.ts < SCACHE_TTL ? e.data : null; }
function scSet(sym, data) { sCache.set(sym, { data, ts: Date.now() }); }

// ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_, res) => {
  res.json({ hasKey: !!process.env.POLYGON_KEY });
});

app.get('/api/ticker/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase().trim();
  const forceRefresh = req.query.force === '1';

  if (!forceRefresh) {
    const cached = scGet(symbol);
    if (cached) return res.json(cached);
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

    const name = tickerRef?.results?.name || symbol;

    // Polygon returns dividends newest-first; keep cash dividends only
    const allDivs = (divResp?.results || []).filter(d => d.cash_amount > 0);
    const today   = new Date().toISOString().split('T')[0];

    const futureDivs   = allDivs.filter(d => d.ex_dividend_date > today);
    const pastDivs     = allDivs.filter(d => d.ex_dividend_date <= today);
    const nextDeclared = futureDivs.length > 0 ? futureDivs[futureDivs.length - 1] : null;

    // Polygon provides frequency directly: 1=annual, 2=semi, 4=quarterly, 12=monthly
    // Only set frequency when we actually have dividend records — don't default to 4 (Quarterly) when there's no data
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
      symbol,
      name,
      currentPrice: price,
      annualDividendRate,
      exDividendDate,
      dividendDate,
      distributionAmount: distributionAmt,
      frequency,
      isEstimated,
      currency: 'USD',
      history: allDivs.map(d => ({ date: d.ex_dividend_date, amount: d.cash_amount, payDate: d.pay_date || null }))
    };

    scSet(symbol, responseData);
    res.json(responseData);

  } catch (err) {
    if (err.noKey) {
      return res.status(503).json({ error: 'API key not configured', noKey: true });
    }
    console.error(`[${symbol}] Error:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch data.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const hasKey = !!process.env.POLYGON_KEY;
  console.log(`\n  Distribution Tracker → http://localhost:${PORT}`);
  if (!hasKey) {
    console.log(`\n  ⚠  No POLYGON_KEY set. Add it to .env to enable live data.`);
    console.log(`     Free key: https://polygon.io/\n`);
  } else {
    console.log(`  ✓  POLYGON_KEY configured\n`);
  }
});
