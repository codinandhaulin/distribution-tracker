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

function estimateNextExDate(lastDate, frequency) {
  const days = { 52: 7, 12: 30, 4: 91, 2: 182, 1: 365 }[frequency] || Math.round(365 / frequency);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let next = new Date(lastDate + 'T12:00:00Z');
  while (next <= today) next = new Date(next.getTime() + days * 86400000);
  return next.toISOString().split('T')[0];
}

// ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_, res) => {
  res.json({ hasKey: !!process.env.POLYGON_KEY });
});

app.get('/api/ticker/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase().trim();
  try {
    const [prevClose, divResp, tickerRef] = await Promise.all([
      polyGet(`/v2/aggs/ticker/${symbol}/prev`),
      polyGet(`/v3/reference/dividends?ticker=${symbol}&limit=24&order=desc`).catch(() => null),
      polyGet(`/v3/reference/tickers/${symbol}`).catch(() => null)
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
    // futureDivs are newest-first so the last element is the soonest upcoming
    const nextDeclared = futureDivs.length > 0 ? futureDivs[futureDivs.length - 1] : null;

    // Polygon provides frequency directly: 1=annual, 2=semi, 4=quarterly, 12=monthly
    const frequency      = allDivs[0]?.frequency || 4;
    const recentDiv      = nextDeclared || pastDivs[0] || null;
    const distributionAmt = recentDiv?.cash_amount ?? 0;

    let exDividendDate = nextDeclared?.ex_dividend_date ?? null;
    let dividendDate   = nextDeclared?.pay_date ?? null;
    let isEstimated    = false;

    if (!exDividendDate && pastDivs.length > 0) {
      exDividendDate = estimateNextExDate(pastDivs[0].ex_dividend_date, frequency);
      isEstimated    = true;

      // Estimate pay date using the same ex→pay offset as the most recent historical dividend
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

    const annualDividendRate = distributionAmt ? distributionAmt * frequency : 0;

    res.json({
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
    });

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
