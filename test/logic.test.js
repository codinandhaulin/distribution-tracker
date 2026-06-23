/**
 * Tests for pure logic functions extracted from public/app.js.
 *
 * Run:  npm test
 *
 * These functions have no DOM dependency and are the highest-risk areas:
 *   - occurrencesInMonth  — drives the calendar AND the 12-month forecast chart
 *   - projectFutureDates  — drives the ticker detail modal
 *   - parseCSVRow / parseNum — drives CSV import
 *   - mergePositions      — weighted-average cost basis on duplicate ticker rows
 *
 * When you change a function in app.js, update the copy here too.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
// Functions under test — kept in sync with public/app.js
// ─────────────────────────────────────────────────────────────────────────────

function occurrencesInMonth(anchorDateStr, intervalDays, year, month) {
  const anchor     = new Date(anchorDateStr + 'T12:00:00Z');
  const monthStart = new Date(Date.UTC(year, month, 1, 12));
  const monthEnd   = new Date(Date.UTC(year, month + 1, 0, 12));
  let d = new Date(anchor);
  while (d >= monthStart) d = new Date(d.getTime() - intervalDays * 86400000);
  const results = [];
  d = new Date(d.getTime() + intervalDays * 86400000);
  while (d <= monthEnd) {
    if (d >= monthStart) results.push(d.toISOString().split('T')[0]);
    d = new Date(d.getTime() + intervalDays * 86400000);
  }
  return results;
}

function projectFutureDates(d, count = 4) {
  if (!d.exDividendDate || !d.frequency) return [];
  const intervalDays = Math.round(365 / d.frequency);
  const payOffset = (d.dividendDate && d.exDividendDate)
    ? Math.round((new Date(d.dividendDate + 'T12:00:00Z') - new Date(d.exDividendDate + 'T12:00:00Z')) / 86400000)
    : null;
  const results = [];
  let next = new Date(d.exDividendDate + 'T12:00:00Z');
  for (let i = 0; i < count; i++) {
    const exDate = next.toISOString().split('T')[0];
    const payDate = payOffset != null
      ? new Date(next.getTime() + payOffset * 86400000).toISOString().split('T')[0]
      : null;
    results.push({ exDate, payDate, amount: d.distributionAmount, est: i === 0 ? d.isEstimated : true });
    next = new Date(next.getTime() + intervalDays * 86400000);
  }
  return results;
}

function parseCSVRow(line) {
  const out = []; let field = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { out.push(field.trim()); field = ''; }
    else field += ch;
  }
  out.push(field.trim());
  return out.map(f => f.replace(/^"|"$/g, '').trim());
}

function parseNum(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[$,\s%+]/g, ''));
  return isNaN(n) ? null : n;
}

// Extracted from handleCSVFile — the part that can run without DOM
function mergePositions(positions) {
  const bySymbol = new Map();
  for (const p of positions) {
    if (bySymbol.has(p.symbol)) {
      const ex = bySymbol.get(p.symbol);
      const tot = (ex.shares || 0) + (p.shares || 0);
      ex.costBasis = tot > 0
        ? ((ex.costBasis * (ex.shares || 0)) + (p.costBasis * (p.shares || 0))) / tot
        : ex.costBasis;
      ex.shares = tot || null;
    } else {
      bySymbol.set(p.symbol, { ...p });
    }
  }
  return [...bySymbol.values()];
}

// Header-detection regex (same as in handleCSVFile)
const reHeader = /^(symbol|ticker)$/i;
const reCostPS = /^average cost basis$|\/share|per share|avg(erage)?\s+cost(?!\s+(basis\s+)?total)/i;
const reCostTot = /cost basis total|total cost basis|total cost|^cost basis$/i;
const reSkip = /^(--|cash|pending|total|account)/i;

// ─────────────────────────────────────────────────────────────────────────────
// occurrencesInMonth
// ─────────────────────────────────────────────────────────────────────────────

describe('occurrencesInMonth', () => {

  test('monthly fund — anchor in same month returns that date', () => {
    // MSTY ex-date Jun 3 2026, checking June 2026
    const hits = occurrencesInMonth('2026-06-03', 30, 2026, 5); // month=5 = June
    assert.deepEqual(hits, ['2026-06-03']);
  });

  test('monthly fund — anchor in prior month projects forward one interval', () => {
    // Anchor Jun 3, checking July 2026 (30 days → Jul 3)
    const hits = occurrencesInMonth('2026-06-03', 30, 2026, 6);
    assert.deepEqual(hits, ['2026-07-03']);
  });

  test('monthly fund — anchor in future month rewinds correctly', () => {
    // Anchor Aug 1, 30-day interval, checking June 2026
    // Rewind: Aug1 → Jul2 → Jun2; Jun2 is in June → hit
    const hits = occurrencesInMonth('2026-08-01', 30, 2026, 5);
    assert.deepEqual(hits, ['2026-06-02']);
  });

  test('weekly fund — returns 5 hits when month starts on anchor weekday', () => {
    // Anchor Jun 2 2026 (Tuesday), 7-day interval, June 2026
    // Hits: Jun 2, 9, 16, 23, 30
    const hits = occurrencesInMonth('2026-06-02', 7, 2026, 5);
    assert.deepEqual(hits, ['2026-06-02', '2026-06-09', '2026-06-16', '2026-06-23', '2026-06-30']);
  });

  test('weekly fund — returns 4 hits when anchor weekday falls on 2nd', () => {
    // Anchor Jun 4 2026 (Thursday), 7-day interval, June 2026
    // Hits: Jun 4, 11, 18, 25
    const hits = occurrencesInMonth('2026-06-04', 7, 2026, 5);
    assert.deepEqual(hits, ['2026-06-04', '2026-06-11', '2026-06-18', '2026-06-25']);
  });

  test('quarterly fund — exactly one hit in the right month', () => {
    // Anchor Mar 15, 91-day interval → Jun 14 → in June
    const hits = occurrencesInMonth('2026-03-15', 91, 2026, 5);
    assert.deepEqual(hits, ['2026-06-14']);
  });

  test('quarterly fund — zero hits in non-distribution month', () => {
    // Anchor Mar 15, 91-day interval → Jun 14, Sep 13: July has nothing
    const hits = occurrencesInMonth('2026-03-15', 91, 2026, 6); // month=6 = July
    assert.deepEqual(hits, []);
  });

  test('annual fund — one hit in its anniversary month', () => {
    const hits = occurrencesInMonth('2026-06-15', 365, 2026, 5);
    assert.deepEqual(hits, ['2026-06-15']);
  });

  test('annual fund — zero hits in non-anniversary month', () => {
    const hits = occurrencesInMonth('2026-06-15', 365, 2026, 0); // January
    assert.deepEqual(hits, []);
  });

  test('returns all dates in correct ISO format', () => {
    const hits = occurrencesInMonth('2026-01-05', 7, 2026, 0); // January
    for (const h of hits) {
      assert.match(h, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// projectFutureDates
// ─────────────────────────────────────────────────────────────────────────────

describe('projectFutureDates', () => {

  const monthlyTicker = {
    exDividendDate: '2026-07-01',
    dividendDate:   '2026-07-08',  // 7 days after ex
    distributionAmount: 1.50,
    frequency: 12,
    isEstimated: false,
  };

  test('returns requested count of entries', () => {
    const res = projectFutureDates(monthlyTicker, 4);
    assert.equal(res.length, 4);
  });

  test('first entry starts at exDividendDate', () => {
    const res = projectFutureDates(monthlyTicker, 4);
    assert.equal(res[0].exDate, '2026-07-01');
  });

  test('subsequent entries spaced by 365/frequency days', () => {
    const res = projectFutureDates(monthlyTicker, 3);
    // intervalDays = Math.round(365/12) = 30
    assert.equal(res[1].exDate, '2026-07-31'); // Jul 1 + 30
    assert.equal(res[2].exDate, '2026-08-30'); // Jul 31 + 30
  });

  test('pay date offset preserved across all entries', () => {
    const res = projectFutureDates(monthlyTicker, 3);
    assert.equal(res[0].payDate, '2026-07-08'); // ex + 7
    assert.equal(res[1].payDate, '2026-08-07'); // Jul 31 + 7
    assert.equal(res[2].payDate, '2026-09-06'); // Aug 30 + 7
  });

  test('distribution amount carried through from ticker', () => {
    const res = projectFutureDates(monthlyTicker, 2);
    assert.equal(res[0].amount, 1.50);
    assert.equal(res[1].amount, 1.50);
  });

  test('first entry inherits isEstimated=false when confirmed', () => {
    const res = projectFutureDates(monthlyTicker, 3);
    assert.equal(res[0].est, false);
    assert.equal(res[1].est, true);
    assert.equal(res[2].est, true);
  });

  test('first entry inherits isEstimated=true when estimated', () => {
    const estimated = { ...monthlyTicker, isEstimated: true };
    const res = projectFutureDates(estimated, 2);
    assert.equal(res[0].est, true);
    assert.equal(res[1].est, true);
  });

  test('no dividendDate → payDate is null', () => {
    const noPay = { ...monthlyTicker, dividendDate: null };
    const res = projectFutureDates(noPay, 2);
    assert.equal(res[0].payDate, null);
    assert.equal(res[1].payDate, null);
  });

  test('missing frequency → returns empty array', () => {
    const noFreq = { ...monthlyTicker, frequency: null };
    assert.deepEqual(projectFutureDates(noFreq), []);
  });

  test('missing exDividendDate → returns empty array', () => {
    const noEx = { ...monthlyTicker, exDividendDate: null };
    assert.deepEqual(projectFutureDates(noEx), []);
  });

  test('count=0 returns empty array', () => {
    assert.deepEqual(projectFutureDates(monthlyTicker, 0), []);
  });

  test('weekly fund (frequency=52) spaces entries ~7 days apart', () => {
    const weekly = { ...monthlyTicker, frequency: 52 };
    const res = projectFutureDates(weekly, 2);
    // Math.round(365/52) = 7
    const diff = Math.round(
      (new Date(res[1].exDate) - new Date(res[0].exDate)) / 86400000
    );
    assert.equal(diff, 7);
  });

  test('quarterly fund (frequency=4) spaces entries ~91 days apart', () => {
    const quarterly = { ...monthlyTicker, frequency: 4 };
    const res = projectFutureDates(quarterly, 2);
    const diff = Math.round(
      (new Date(res[1].exDate) - new Date(res[0].exDate)) / 86400000
    );
    assert.equal(diff, 91);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// parseCSVRow
// ─────────────────────────────────────────────────────────────────────────────

describe('parseCSVRow', () => {

  test('simple unquoted fields', () => {
    assert.deepEqual(parseCSVRow('MSTY,100,20.50'), ['MSTY', '100', '20.50']);
  });

  test('quoted field containing a comma', () => {
    assert.deepEqual(parseCSVRow('"Smith, John",100'), ['Smith, John', '100']);
  });

  test('dollar amount with comma inside quotes', () => {
    assert.deepEqual(parseCSVRow('"$1,234.56",50'), ['$1,234.56', '50']);
  });

  test('trims whitespace from unquoted fields', () => {
    assert.deepEqual(parseCSVRow('  MSTY , 100 , 20.50 '), ['MSTY', '100', '20.50']);
  });

  test('empty field in middle', () => {
    assert.deepEqual(parseCSVRow('a,,c'), ['a', '', 'c']);
  });

  test('trailing comma produces empty last field', () => {
    const result = parseCSVRow('a,b,');
    assert.equal(result[2], '');
  });

  test('fully quoted fields', () => {
    assert.deepEqual(parseCSVRow('"MSTY","100","20.50"'), ['MSTY', '100', '20.50']);
  });

  test('strips surrounding quotes from quoted fields', () => {
    const result = parseCSVRow('"MSTY"');
    assert.equal(result[0], 'MSTY');
  });

  test('single field no comma', () => {
    assert.deepEqual(parseCSVRow('MSTY'), ['MSTY']);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// parseNum
// ─────────────────────────────────────────────────────────────────────────────

describe('parseNum', () => {

  test('plain number string', () => assert.equal(parseNum('100'), 100));
  test('dollar sign stripped', () => assert.equal(parseNum('$20.50'), 20.50));
  test('comma stripped', () => assert.equal(parseNum('1,234.56'), 1234.56));
  test('dollar + comma', () => assert.equal(parseNum('$1,234.56'), 1234.56));
  test('leading/trailing whitespace stripped', () => assert.equal(parseNum('  42.5  '), 42.5));
  test('percent sign stripped', () => assert.equal(parseNum('15%'), 15));
  test('leading plus stripped', () => assert.equal(parseNum('+100'), 100));
  test('negative value preserved', () => assert.equal(parseNum('-5.25'), -5.25));
  test('null input returns null', () => assert.equal(parseNum(null), null));
  test('empty string returns null', () => assert.equal(parseNum(''), null));
  test('non-numeric string returns null', () => assert.equal(parseNum('--'), null));
  test('dash returns null', () => assert.equal(parseNum('-'), null));
  test('numeric zero', () => assert.equal(parseNum('0'), 0));
  test('very small decimal', () => assert.equal(parseNum('0.0001'), 0.0001));

});

// ─────────────────────────────────────────────────────────────────────────────
// mergePositions — CSV duplicate-ticker handling
// ─────────────────────────────────────────────────────────────────────────────

describe('mergePositions', () => {

  test('single position passes through unchanged', () => {
    const result = mergePositions([{ symbol: 'MSTY', costBasis: 20, shares: 100 }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].costBasis, 20);
    assert.equal(result[0].shares, 100);
  });

  test('two distinct tickers both preserved', () => {
    const result = mergePositions([
      { symbol: 'MSTY', costBasis: 20, shares: 100 },
      { symbol: 'CONY', costBasis: 15, shares: 50 },
    ]);
    assert.equal(result.length, 2);
  });

  test('duplicate ticker — shares summed', () => {
    const result = mergePositions([
      { symbol: 'MSTY', costBasis: 20, shares: 100 },
      { symbol: 'MSTY', costBasis: 26, shares: 50 },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].shares, 150);
  });

  test('duplicate ticker — cost basis is weighted average', () => {
    // (100 × $20) + (50 × $26) / 150 = $3300 / 150 = $22
    const result = mergePositions([
      { symbol: 'MSTY', costBasis: 20, shares: 100 },
      { symbol: 'MSTY', costBasis: 26, shares: 50 },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].costBasis, 22);
  });

  test('three lots — weighted average across all', () => {
    // (100 × $20) + (50 × $26) + (50 × $30) / 200 = (2000+1300+1500)/200 = 4800/200 = $24
    const result = mergePositions([
      { symbol: 'MSTY', costBasis: 20, shares: 100 },
      { symbol: 'MSTY', costBasis: 26, shares: 50 },
      { symbol: 'MSTY', costBasis: 30, shares: 50 },
    ]);
    assert.equal(result[0].shares, 200);
    assert.equal(result[0].costBasis, 24);
  });

  test('equal lots — cost basis is simple average', () => {
    // (100 × $20) + (100 × $30) / 200 = $25
    const result = mergePositions([
      { symbol: 'CONY', costBasis: 20, shares: 100 },
      { symbol: 'CONY', costBasis: 30, shares: 100 },
    ]);
    assert.equal(result[0].costBasis, 25);
  });

  test('mixed tickers — only duplicates merged', () => {
    const result = mergePositions([
      { symbol: 'MSTY', costBasis: 20, shares: 100 },
      { symbol: 'CONY', costBasis: 15, shares: 50 },
      { symbol: 'MSTY', costBasis: 26, shares: 50 },
    ]);
    assert.equal(result.length, 2);
    const msty = result.find(r => r.symbol === 'MSTY');
    const cony = result.find(r => r.symbol === 'CONY');
    assert.equal(msty.shares, 150);
    assert.equal(cony.shares, 50);
  });

  test('null shares treated as zero in weighted average', () => {
    // null shares (e.g. no quantity column) — shares sum to null, cost basis falls back
    const result = mergePositions([
      { symbol: 'MSTY', costBasis: 20, shares: null },
      { symbol: 'MSTY', costBasis: 30, shares: null },
    ]);
    assert.equal(result.length, 1);
    // (0 + 0) = 0, not > 0 → falls back to ex.costBasis (first lot)
    assert.equal(result[0].costBasis, 20);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// CSV column-header detection regexes
// ─────────────────────────────────────────────────────────────────────────────

describe('CSV header detection', () => {

  test('detects "Symbol" header (Fidelity)', () => assert.ok(reHeader.test('Symbol')));
  test('detects "symbol" lowercase', () => assert.ok(reHeader.test('symbol')));
  test('detects "Ticker" header', () => assert.ok(reHeader.test('Ticker')));
  test('does not match unrelated column', () => assert.ok(!reHeader.test('Description')));

  test('detects Fidelity per-share cost column', () => {
    assert.ok(reCostPS.test('Average Cost Basis'));
  });
  test('does not match total cost column as per-share', () => {
    assert.ok(!reCostPS.test('Cost Basis Total'));
  });
  test('detects "/share" variant', () => assert.ok(reCostPS.test('Cost/Share')));
  test('detects "per share" variant', () => assert.ok(reCostPS.test('Price Per Share')));

  test('detects Fidelity total cost column', () => {
    assert.ok(reCostTot.test('Cost Basis Total'));
  });
  test('detects "Total Cost Basis"', () => assert.ok(reCostTot.test('Total Cost Basis')));

  test('skip rows: "--" prefix', () => assert.ok(reSkip.test('--')));
  test('skip rows: "Pending activity"', () => assert.ok(reSkip.test('Pending activity')));
  test('skip rows: "Cash" row', () => assert.ok(reSkip.test('Cash')));
  test('skip rows: "Total" row', () => assert.ok(reSkip.test('Total Account Value')));
  test('does not skip normal ticker', () => assert.ok(!reSkip.test('MSTY')));

});
