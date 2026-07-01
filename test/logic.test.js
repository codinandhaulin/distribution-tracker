/**
 * Tests for pure logic functions extracted from public/app.js and server.js.
 *
 * Run:  npm test
 *
 * Covers:
 *   - occurrencesInMonth  — drives the calendar AND the 12-month forecast chart
 *   - projectionParams    — shared interval/offset helper used by all three projection sites
 *   - projectFutureDates  — drives the ticker detail modal
 *   - parseCSVRow / parseNum — drives CSV import
 *   - mergePositions      — weighted-average cost basis on duplicate ticker rows
 *   - estimateNextExDate  — server-side next ex-date estimator
 *   - shapeTickerData     — server-side Polygon response → app data object
 *
 * When you change a function in app.js or server.js, update the copy here too.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — kept in sync with public/app.js
// ─────────────────────────────────────────────────────────────────────────────

const parseISO = (s) => new Date(s + "T12:00:00Z");
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const diffDays = (a, b) => Math.round((a - b) / 86400000);

// ─────────────────────────────────────────────────────────────────────────────
// Functions under test — kept in sync with public/app.js
// ─────────────────────────────────────────────────────────────────────────────

function occurrencesInMonth(anchorDateStr, intervalDays, year, month) {
  const anchor = new Date(anchorDateStr + "T12:00:00Z");
  const monthStart = new Date(Date.UTC(year, month, 1, 12));
  const monthEnd = new Date(Date.UTC(year, month + 1, 0, 12));
  let d = new Date(anchor);
  while (d >= monthStart) d = new Date(d.getTime() - intervalDays * 86400000);
  const results = [];
  d = new Date(d.getTime() + intervalDays * 86400000);
  while (d <= monthEnd) {
    if (d >= monthStart) results.push(d.toISOString().split("T")[0]);
    d = new Date(d.getTime() + intervalDays * 86400000);
  }
  return results;
}

function projectionParams(d) {
  const intervalDays = d.frequency ? Math.round(365 / d.frequency) : 91;
  const payOffset =
    d.dividendDate && d.exDividendDate
      ? diffDays(parseISO(d.dividendDate), parseISO(d.exDividendDate))
      : 14;
  return { intervalDays, payOffset };
}

function projectFutureDates(d, count = 4) {
  if (!d.exDividendDate || !d.frequency) return [];
  const { intervalDays, payOffset } = projectionParams(d);
  const results = [];
  let next = parseISO(d.exDividendDate);
  for (let i = 0; i < count; i++) {
    const exDate = next.toISOString().split("T")[0];
    const payDate = addDays(next, payOffset).toISOString().split("T")[0];
    results.push({
      exDate,
      payDate,
      amount: d.distributionAmount,
      est: i === 0 ? d.isEstimated : true,
    });
    next = addDays(next, intervalDays);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-side functions — kept in sync with server.js
// ─────────────────────────────────────────────────────────────────────────────

function estimateNextExDate(lastDate, frequency) {
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

  const frequency = allDivs[0]?.frequency ?? null;
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
    if (lastEx && lastPay) {
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

function parseCSVRow(line) {
  const out = [];
  let field = "",
    inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) {
      out.push(field.trim());
      field = "";
    } else field += ch;
  }
  out.push(field.trim());
  return out.map((f) => f.replace(/^"|"$/g, "").trim());
}

function parseNum(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[$,\s%+]/g, ""));
  return isNaN(n) ? null : n;
}

// Extracted from handleCSVFile — the part that can run without DOM
function mergePositions(positions) {
  const bySymbol = new Map();
  for (const p of positions) {
    if (bySymbol.has(p.symbol)) {
      const ex = bySymbol.get(p.symbol);
      const tot = (ex.shares || 0) + (p.shares || 0);
      ex.costBasis =
        tot > 0
          ? (ex.costBasis * (ex.shares || 0) + p.costBasis * (p.shares || 0)) /
            tot
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
const reCostPS =
  /^average cost basis$|\/share|per share|avg(erage)?\s+cost(?!\s+(basis\s+)?total)/i;
const reCostTot = /cost basis total|total cost basis|total cost|^cost basis$/i;
const reSkip = /^(--|cash|pending|total|account)/i;

// ─────────────────────────────────────────────────────────────────────────────
// occurrencesInMonth
// ─────────────────────────────────────────────────────────────────────────────

describe("occurrencesInMonth", () => {
  test("monthly fund — anchor in same month returns that date", () => {
    // MSTY ex-date Jun 3 2026, checking June 2026
    const hits = occurrencesInMonth("2026-06-03", 30, 2026, 5); // month=5 = June
    assert.deepEqual(hits, ["2026-06-03"]);
  });

  test("monthly fund — anchor in prior month projects forward one interval", () => {
    // Anchor Jun 3, checking July 2026 (30 days → Jul 3)
    const hits = occurrencesInMonth("2026-06-03", 30, 2026, 6);
    assert.deepEqual(hits, ["2026-07-03"]);
  });

  test("monthly fund — anchor in future month rewinds correctly", () => {
    // Anchor Aug 1, 30-day interval, checking June 2026
    // Rewind: Aug1 → Jul2 → Jun2; Jun2 is in June → hit
    const hits = occurrencesInMonth("2026-08-01", 30, 2026, 5);
    assert.deepEqual(hits, ["2026-06-02"]);
  });

  test("weekly fund — returns 5 hits when month starts on anchor weekday", () => {
    // Anchor Jun 2 2026 (Tuesday), 7-day interval, June 2026
    // Hits: Jun 2, 9, 16, 23, 30
    const hits = occurrencesInMonth("2026-06-02", 7, 2026, 5);
    assert.deepEqual(hits, [
      "2026-06-02",
      "2026-06-09",
      "2026-06-16",
      "2026-06-23",
      "2026-06-30",
    ]);
  });

  test("weekly fund — returns 4 hits when anchor weekday falls on 2nd", () => {
    // Anchor Jun 4 2026 (Thursday), 7-day interval, June 2026
    // Hits: Jun 4, 11, 18, 25
    const hits = occurrencesInMonth("2026-06-04", 7, 2026, 5);
    assert.deepEqual(hits, [
      "2026-06-04",
      "2026-06-11",
      "2026-06-18",
      "2026-06-25",
    ]);
  });

  test("quarterly fund — exactly one hit in the right month", () => {
    // Anchor Mar 15, 91-day interval → Jun 14 → in June
    const hits = occurrencesInMonth("2026-03-15", 91, 2026, 5);
    assert.deepEqual(hits, ["2026-06-14"]);
  });

  test("quarterly fund — zero hits in non-distribution month", () => {
    // Anchor Mar 15, 91-day interval → Jun 14, Sep 13: July has nothing
    const hits = occurrencesInMonth("2026-03-15", 91, 2026, 6); // month=6 = July
    assert.deepEqual(hits, []);
  });

  test("annual fund — one hit in its anniversary month", () => {
    const hits = occurrencesInMonth("2026-06-15", 365, 2026, 5);
    assert.deepEqual(hits, ["2026-06-15"]);
  });

  test("annual fund — zero hits in non-anniversary month", () => {
    const hits = occurrencesInMonth("2026-06-15", 365, 2026, 0); // January
    assert.deepEqual(hits, []);
  });

  test("returns all dates in correct ISO format", () => {
    const hits = occurrencesInMonth("2026-01-05", 7, 2026, 0); // January
    for (const h of hits) {
      assert.match(h, /^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// projectFutureDates
// ─────────────────────────────────────────────────────────────────────────────

describe("projectFutureDates", () => {
  const monthlyTicker = {
    exDividendDate: "2026-07-01",
    dividendDate: "2026-07-08", // 7 days after ex
    distributionAmount: 1.5,
    frequency: 12,
    isEstimated: false,
  };

  test("returns requested count of entries", () => {
    const res = projectFutureDates(monthlyTicker, 4);
    assert.equal(res.length, 4);
  });

  test("first entry starts at exDividendDate", () => {
    const res = projectFutureDates(monthlyTicker, 4);
    assert.equal(res[0].exDate, "2026-07-01");
  });

  test("subsequent entries spaced by 365/frequency days", () => {
    const res = projectFutureDates(monthlyTicker, 3);
    // intervalDays = Math.round(365/12) = 30
    assert.equal(res[1].exDate, "2026-07-31"); // Jul 1 + 30
    assert.equal(res[2].exDate, "2026-08-30"); // Jul 31 + 30
  });

  test("pay date offset preserved across all entries", () => {
    const res = projectFutureDates(monthlyTicker, 3);
    assert.equal(res[0].payDate, "2026-07-08"); // ex + 7
    assert.equal(res[1].payDate, "2026-08-07"); // Jul 31 + 7
    assert.equal(res[2].payDate, "2026-09-06"); // Aug 30 + 7
  });

  test("distribution amount carried through from ticker", () => {
    const res = projectFutureDates(monthlyTicker, 2);
    assert.equal(res[0].amount, 1.5);
    assert.equal(res[1].amount, 1.5);
  });

  test("first entry inherits isEstimated=false when confirmed", () => {
    const res = projectFutureDates(monthlyTicker, 3);
    assert.equal(res[0].est, false);
    assert.equal(res[1].est, true);
    assert.equal(res[2].est, true);
  });

  test("first entry inherits isEstimated=true when estimated", () => {
    const estimated = { ...monthlyTicker, isEstimated: true };
    const res = projectFutureDates(estimated, 2);
    assert.equal(res[0].est, true);
    assert.equal(res[1].est, true);
  });

  test("no dividendDate → payDate falls back to ex-date + 14 days", () => {
    const noPay = { ...monthlyTicker, dividendDate: null };
    const res = projectFutureDates(noPay, 2);
    assert.equal(res[0].payDate, "2026-07-15"); // 2026-07-01 + 14
    assert.equal(res[1].payDate, "2026-08-14"); // 2026-07-31 + 14
  });

  test("missing frequency → returns empty array", () => {
    const noFreq = { ...monthlyTicker, frequency: null };
    assert.deepEqual(projectFutureDates(noFreq), []);
  });

  test("missing exDividendDate → returns empty array", () => {
    const noEx = { ...monthlyTicker, exDividendDate: null };
    assert.deepEqual(projectFutureDates(noEx), []);
  });

  test("count=0 returns empty array", () => {
    assert.deepEqual(projectFutureDates(monthlyTicker, 0), []);
  });

  test("weekly fund (frequency=52) spaces entries ~7 days apart", () => {
    const weekly = { ...monthlyTicker, frequency: 52 };
    const res = projectFutureDates(weekly, 2);
    // Math.round(365/52) = 7
    const diff = Math.round(
      (new Date(res[1].exDate) - new Date(res[0].exDate)) / 86400000,
    );
    assert.equal(diff, 7);
  });

  test("quarterly fund (frequency=4) spaces entries ~91 days apart", () => {
    const quarterly = { ...monthlyTicker, frequency: 4 };
    const res = projectFutureDates(quarterly, 2);
    const diff = Math.round(
      (new Date(res[1].exDate) - new Date(res[0].exDate)) / 86400000,
    );
    assert.equal(diff, 91);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseCSVRow
// ─────────────────────────────────────────────────────────────────────────────

describe("parseCSVRow", () => {
  test("simple unquoted fields", () => {
    assert.deepEqual(parseCSVRow("MSTY,100,20.50"), ["MSTY", "100", "20.50"]);
  });

  test("quoted field containing a comma", () => {
    assert.deepEqual(parseCSVRow('"Smith, John",100'), ["Smith, John", "100"]);
  });

  test("dollar amount with comma inside quotes", () => {
    assert.deepEqual(parseCSVRow('"$1,234.56",50'), ["$1,234.56", "50"]);
  });

  test("trims whitespace from unquoted fields", () => {
    assert.deepEqual(parseCSVRow("  MSTY , 100 , 20.50 "), [
      "MSTY",
      "100",
      "20.50",
    ]);
  });

  test("empty field in middle", () => {
    assert.deepEqual(parseCSVRow("a,,c"), ["a", "", "c"]);
  });

  test("trailing comma produces empty last field", () => {
    const result = parseCSVRow("a,b,");
    assert.equal(result[2], "");
  });

  test("fully quoted fields", () => {
    assert.deepEqual(parseCSVRow('"MSTY","100","20.50"'), [
      "MSTY",
      "100",
      "20.50",
    ]);
  });

  test("strips surrounding quotes from quoted fields", () => {
    const result = parseCSVRow('"MSTY"');
    assert.equal(result[0], "MSTY");
  });

  test("single field no comma", () => {
    assert.deepEqual(parseCSVRow("MSTY"), ["MSTY"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseNum
// ─────────────────────────────────────────────────────────────────────────────

describe("parseNum", () => {
  test("plain number string", () => assert.equal(parseNum("100"), 100));
  test("dollar sign stripped", () => assert.equal(parseNum("$20.50"), 20.5));
  test("comma stripped", () => assert.equal(parseNum("1,234.56"), 1234.56));
  test("dollar + comma", () => assert.equal(parseNum("$1,234.56"), 1234.56));
  test("leading/trailing whitespace stripped", () =>
    assert.equal(parseNum("  42.5  "), 42.5));
  test("percent sign stripped", () => assert.equal(parseNum("15%"), 15));
  test("leading plus stripped", () => assert.equal(parseNum("+100"), 100));
  test("negative value preserved", () =>
    assert.equal(parseNum("-5.25"), -5.25));
  test("null input returns null", () => assert.equal(parseNum(null), null));
  test("empty string returns null", () => assert.equal(parseNum(""), null));
  test("non-numeric string returns null", () =>
    assert.equal(parseNum("--"), null));
  test("dash returns null", () => assert.equal(parseNum("-"), null));
  test("numeric zero", () => assert.equal(parseNum("0"), 0));
  test("very small decimal", () => assert.equal(parseNum("0.0001"), 0.0001));
});

// ─────────────────────────────────────────────────────────────────────────────
// mergePositions — CSV duplicate-ticker handling
// ─────────────────────────────────────────────────────────────────────────────

describe("mergePositions", () => {
  test("single position passes through unchanged", () => {
    const result = mergePositions([
      { symbol: "MSTY", costBasis: 20, shares: 100 },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].costBasis, 20);
    assert.equal(result[0].shares, 100);
  });

  test("two distinct tickers both preserved", () => {
    const result = mergePositions([
      { symbol: "MSTY", costBasis: 20, shares: 100 },
      { symbol: "CONY", costBasis: 15, shares: 50 },
    ]);
    assert.equal(result.length, 2);
  });

  test("duplicate ticker — shares summed", () => {
    const result = mergePositions([
      { symbol: "MSTY", costBasis: 20, shares: 100 },
      { symbol: "MSTY", costBasis: 26, shares: 50 },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].shares, 150);
  });

  test("duplicate ticker — cost basis is weighted average", () => {
    // (100 × $20) + (50 × $26) / 150 = $3300 / 150 = $22
    const result = mergePositions([
      { symbol: "MSTY", costBasis: 20, shares: 100 },
      { symbol: "MSTY", costBasis: 26, shares: 50 },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].costBasis, 22);
  });

  test("three lots — weighted average across all", () => {
    // (100 × $20) + (50 × $26) + (50 × $30) / 200 = (2000+1300+1500)/200 = 4800/200 = $24
    const result = mergePositions([
      { symbol: "MSTY", costBasis: 20, shares: 100 },
      { symbol: "MSTY", costBasis: 26, shares: 50 },
      { symbol: "MSTY", costBasis: 30, shares: 50 },
    ]);
    assert.equal(result[0].shares, 200);
    assert.equal(result[0].costBasis, 24);
  });

  test("equal lots — cost basis is simple average", () => {
    // (100 × $20) + (100 × $30) / 200 = $25
    const result = mergePositions([
      { symbol: "CONY", costBasis: 20, shares: 100 },
      { symbol: "CONY", costBasis: 30, shares: 100 },
    ]);
    assert.equal(result[0].costBasis, 25);
  });

  test("mixed tickers — only duplicates merged", () => {
    const result = mergePositions([
      { symbol: "MSTY", costBasis: 20, shares: 100 },
      { symbol: "CONY", costBasis: 15, shares: 50 },
      { symbol: "MSTY", costBasis: 26, shares: 50 },
    ]);
    assert.equal(result.length, 2);
    const msty = result.find((r) => r.symbol === "MSTY");
    const cony = result.find((r) => r.symbol === "CONY");
    assert.equal(msty.shares, 150);
    assert.equal(cony.shares, 50);
  });

  test("null shares treated as zero in weighted average", () => {
    // null shares (e.g. no quantity column) — shares sum to null, cost basis falls back
    const result = mergePositions([
      { symbol: "MSTY", costBasis: 20, shares: null },
      { symbol: "MSTY", costBasis: 30, shares: null },
    ]);
    assert.equal(result.length, 1);
    // (0 + 0) = 0, not > 0 → falls back to ex.costBasis (first lot)
    assert.equal(result[0].costBasis, 20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV column-header detection regexes
// ─────────────────────────────────────────────────────────────────────────────

describe("CSV header detection", () => {
  test('detects "Symbol" header (Fidelity)', () =>
    assert.ok(reHeader.test("Symbol")));
  test('detects "symbol" lowercase', () => assert.ok(reHeader.test("symbol")));
  test('detects "Ticker" header', () => assert.ok(reHeader.test("Ticker")));
  test("does not match unrelated column", () =>
    assert.ok(!reHeader.test("Description")));

  test("detects Fidelity per-share cost column", () => {
    assert.ok(reCostPS.test("Average Cost Basis"));
  });
  test("does not match total cost column as per-share", () => {
    assert.ok(!reCostPS.test("Cost Basis Total"));
  });
  test('detects "/share" variant', () =>
    assert.ok(reCostPS.test("Cost/Share")));
  test('detects "per share" variant', () =>
    assert.ok(reCostPS.test("Price Per Share")));

  test("detects Fidelity total cost column", () => {
    assert.ok(reCostTot.test("Cost Basis Total"));
  });
  test('detects "Total Cost Basis"', () =>
    assert.ok(reCostTot.test("Total Cost Basis")));

  test('skip rows: "--" prefix', () => assert.ok(reSkip.test("--")));
  test('skip rows: "Pending activity"', () =>
    assert.ok(reSkip.test("Pending activity")));
  test('skip rows: "Cash" row', () => assert.ok(reSkip.test("Cash")));
  test('skip rows: "Total" row', () =>
    assert.ok(reSkip.test("Total Account Value")));
  test("does not skip normal ticker", () => assert.ok(!reSkip.test("MSTY")));
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateNextExDate  (server.js)
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateNextExDate", () => {
  test("far-future anchor returned unchanged (loop does not run)", () => {
    assert.equal(estimateNextExDate("2099-06-15", 12), "2099-06-15");
  });

  test("result is always strictly in the future for old anchor", () => {
    const result = estimateNextExDate("2020-01-01", 12);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    assert.ok(
      new Date(result + "T12:00:00Z") > today,
      "result should be after today",
    );
  });

  test("monthly (12): one interval back from result is in the past", () => {
    const result = estimateNextExDate("2020-01-01", 12);
    const rDate = new Date(result + "T12:00:00Z");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const prevDate = new Date(rDate.getTime() - 30 * 86400000);
    assert.ok(rDate > today, "result is in the future");
    assert.ok(prevDate <= today, "one interval back is not in the future");
  });

  test("weekly (52): one interval back from result is in the past", () => {
    const result = estimateNextExDate("2020-01-01", 52);
    const rDate = new Date(result + "T12:00:00Z");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const prevDate = new Date(rDate.getTime() - 7 * 86400000);
    assert.ok(rDate > today);
    assert.ok(prevDate <= today);
  });

  test("quarterly (4): one interval back from result is in the past", () => {
    const result = estimateNextExDate("2020-01-01", 4);
    const rDate = new Date(result + "T12:00:00Z");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const prevDate = new Date(rDate.getTime() - 91 * 86400000);
    assert.ok(rDate > today);
    assert.ok(prevDate <= today);
  });

  test("returns a valid ISO date string", () => {
    assert.match(estimateNextExDate("2020-01-01", 12), /^\d{4}-\d{2}-\d{2}$/);
  });

  test("unknown frequency falls back to Math.round(365/freq)", () => {
    // frequency=6 (semi-monthly) → 365/6 ≈ 61 days; far-future anchor
    const result = estimateNextExDate("2099-01-01", 6);
    assert.equal(result, "2099-01-01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// projectionParams  (public/app.js)
// ─────────────────────────────────────────────────────────────────────────────

describe("projectionParams", () => {
  test("monthly frequency → 30-day interval", () => {
    const { intervalDays } = projectionParams({
      frequency: 12,
      exDividendDate: "2026-07-01",
      dividendDate: "2026-07-08",
    });
    assert.equal(intervalDays, 30);
  });

  test("weekly frequency → 7-day interval", () => {
    const { intervalDays } = projectionParams({
      frequency: 52,
      exDividendDate: "2026-07-01",
      dividendDate: "2026-07-05",
    });
    assert.equal(intervalDays, 7);
  });

  test("null frequency → 91-day interval default", () => {
    const { intervalDays } = projectionParams({
      frequency: null,
      exDividendDate: "2026-07-01",
      dividendDate: null,
    });
    assert.equal(intervalDays, 91);
  });

  test("payOffset computed from dividendDate − exDividendDate", () => {
    const { payOffset } = projectionParams({
      frequency: 12,
      exDividendDate: "2026-07-01",
      dividendDate: "2026-07-08",
    });
    assert.equal(payOffset, 7);
  });

  test("null dividendDate → payOffset falls back to 14", () => {
    const { payOffset } = projectionParams({
      frequency: 12,
      exDividendDate: "2026-07-01",
      dividendDate: null,
    });
    assert.equal(payOffset, 14);
  });

  test("null both dates → payOffset falls back to 14", () => {
    const { payOffset } = projectionParams({
      frequency: 12,
      exDividendDate: null,
      dividendDate: null,
    });
    assert.equal(payOffset, 14);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shapeTickerData  (server.js)
// ─────────────────────────────────────────────────────────────────────────────

describe("shapeTickerData", () => {
  const pc = (price) => ({ results: [{ c: price }] });
  const ref = (name) => ({ results: { name } });
  const divs = (...ds) => ({ results: ds });
  const div = (ex, pay, amount, freq = 12) => ({
    ex_dividend_date: ex,
    pay_date: pay,
    cash_amount: amount,
    frequency: freq,
  });

  test("extracts price and symbol", () => {
    const r = shapeTickerData("MSTY", pc(24.5), null, null, "2026-06-23");
    assert.equal(r.currentPrice, 24.5);
    assert.equal(r.symbol, "MSTY");
    assert.equal(r.currency, "USD");
  });

  test("throws notFound error when prevClose has no results", () => {
    assert.throws(
      () => shapeTickerData("FAKE", { results: [] }, null, null, "2026-06-23"),
      (err) => err.notFound === true,
    );
  });

  test("throws notFound error when prevClose is null", () => {
    assert.throws(
      () => shapeTickerData("FAKE", null, null, null, "2026-06-23"),
      (err) => err.notFound === true,
    );
  });

  test("uses tickerRef name", () => {
    const r = shapeTickerData(
      "MSTY",
      pc(24.5),
      null,
      ref("YieldMax MSTY Option Income"),
      "2026-06-23",
    );
    assert.equal(r.name, "YieldMax MSTY Option Income");
  });

  test("falls back to symbol when no tickerRef", () => {
    const r = shapeTickerData("MSTY", pc(24.5), null, null, "2026-06-23");
    assert.equal(r.name, "MSTY");
  });

  test("uses declared future ex-date when available", () => {
    const r = shapeTickerData(
      "MSTY",
      pc(24.5),
      divs(div("2026-07-01", "2026-07-08", 1.5)),
      null,
      "2026-06-23",
    );
    assert.equal(r.exDividendDate, "2026-07-01");
    assert.equal(r.dividendDate, "2026-07-08");
    assert.equal(r.isEstimated, false);
  });

  test("estimates next ex-date when all dividends are past", () => {
    const r = shapeTickerData(
      "MSTY",
      pc(24.5),
      divs(div("2026-06-01", "2026-06-08", 1.5)),
      null,
      "2026-06-23",
    );
    assert.ok(
      r.exDividendDate > "2026-06-23",
      "estimated ex-date should be in the future",
    );
    assert.equal(r.isEstimated, true);
  });

  test("estimated pay-date mirrors the historical ex→pay offset", () => {
    // last div: ex Jun 1, pay Jun 10 (9-day gap) — estimated pay should also be 9 days after next ex
    const r = shapeTickerData(
      "MSTY",
      pc(24.5),
      divs(div("2026-06-01", "2026-06-10", 1.5)),
      null,
      "2026-06-23",
    );
    const diff = Math.round(
      (new Date(r.dividendDate + "T12:00:00Z") -
        new Date(r.exDividendDate + "T12:00:00Z")) /
        86400000,
    );
    assert.equal(diff, 9);
  });

  test("computes annualDividendRate = distAmt × frequency", () => {
    const r = shapeTickerData(
      "MSTY",
      pc(24.5),
      divs(div("2026-07-01", "2026-07-08", 1.5, 12)),
      null,
      "2026-06-23",
    );
    assert.equal(r.annualDividendRate, 18);
  });

  test("builds history array ordered newest-first from API", () => {
    const r = shapeTickerData(
      "MSTY",
      pc(24.5),
      divs(
        div("2026-07-01", "2026-07-08", 1.5),
        div("2026-06-01", "2026-06-08", 1.48),
      ),
      null,
      "2026-06-23",
    );
    assert.equal(r.history.length, 2);
    assert.equal(r.history[0].date, "2026-07-01");
    assert.equal(r.history[0].amount, 1.5);
    assert.equal(r.history[0].payDate, "2026-07-08");
    assert.equal(r.history[1].date, "2026-06-01");
  });

  test("filters out zero-amount dividends", () => {
    const r = shapeTickerData(
      "MSTY",
      pc(24.5),
      divs(
        div("2026-07-01", "2026-07-08", 0), // zero — filtered
        div("2026-06-01", "2026-06-08", 1.48),
      ),
      null,
      "2026-06-23",
    );
    assert.equal(r.history.length, 1);
  });

  test("null divResp → empty history, null ex-date, zero annualDividendRate", () => {
    const r = shapeTickerData("MSTY", pc(24.5), null, null, "2026-06-23");
    assert.deepEqual(r.history, []);
    assert.equal(r.exDividendDate, null);
    assert.equal(r.frequency, null);
    assert.equal(r.annualDividendRate, 0);
  });

  test("future dividends: uses most-recent future entry (last in array)", () => {
    // future array sorted newest-first by Polygon; last entry = nearest future
    const r = shapeTickerData(
      "MSTY",
      pc(24.5),
      divs(
        div("2026-08-01", "2026-08-08", 1.52), // further future
        div("2026-07-01", "2026-07-08", 1.5), // nearest future
      ),
      null,
      "2026-06-23",
    );
    assert.equal(r.exDividendDate, "2026-07-01");
  });
});
