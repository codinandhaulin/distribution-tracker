// ── State ──────────────────────────────────────────────────────────
const S = {
  tickers: [],   // [{symbol, costBasis, shares}]
  data:    {},   // {symbol: apiResponse | null}
  loading: {},   // {symbol: bool}
  errors:  {}    // {symbol: string | null}
};

let calView    = true;
let calYear    = new Date().getFullYear();
let calMonth   = new Date().getMonth(); // 0-indexed
let _editSym   = null;
let currentUser = null;
let _statusTimer = null;
let calEvents  = {};

const parseISO = s => new Date(s + 'T12:00:00Z');
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const diffDays = (a, b) => Math.round((a - b) / 86400000);

function setStatus(text, loading = false) {
  const el = document.getElementById('last-updated');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('status-loading', loading);
}

// ── Auth ───────────────────────────────────────────────────────────
async function login() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-err');
  errEl.style.display = 'none';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const j = await r.json();
    if (!r.ok) { errEl.textContent = j.error || 'Login failed'; errEl.style.display = 'block'; return; }
    currentUser = j.username;
    document.getElementById('login-screen').style.display = 'none';
    await startApp();
  } catch { errEl.textContent = 'Connection error'; errEl.style.display = 'block'; }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

// ── Persistence ────────────────────────────────────────────────────
function persist() {
  fetch('/api/portfolio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(S.tickers)
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
    .catch(e => { console.error('Failed to save portfolio:', e); toast('Failed to save', true); });
}
async function hydrate() {
  try {
    const r = await fetch('/api/portfolio');
    if (r.ok) S.tickers = await r.json();
  } catch {}
}

// ── Format helpers ─────────────────────────────────────────────────
const fmt$ = (v, d=2) => v == null || isNaN(v) ? '—' :
  '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = v => v == null || isNaN(v) ? '—' : Number(v).toFixed(2) + '%';
const fmtN = (v, d=3) => v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });

function fmtDate(iso) {
  if (!iso) return '—';
  const d = parseISO(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' });
}

function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = parseISO(iso); d.setHours(0,0,0,0);
  return isNaN(d) ? null : Math.round((d - today) / 86400000);
}

const FREQ_LABEL = { 52:'Weekly', 12:'Monthly', 4:'Quarterly', 2:'Semi-Ann', 1:'Annual' };
const freqLabel = f => FREQ_LABEL[f] || `×${f}/yr`;

// ── API ────────────────────────────────────────────────────────────
// Server handles caching and Polygon rate limiting via a queue.
// Client just awaits the response; cache hits return immediately,
// uncached tickers are spaced 30s apart by the server queue.

async function fetchTicker(symbol, force = false, progress = '', silent = false) {
  S.loading[symbol] = true; S.errors[symbol] = null;
  if (!silent) {
    render();
    clearInterval(_statusTimer);
    let secs = 0;
    const QUEUE_INTERVAL = 30;
    const label = () => {
      const remaining = Math.max(0, QUEUE_INTERVAL - secs);
      return `⟳ Fetching ${symbol}${progress ? ' ' + progress : ''} · next in ~${remaining}s`;
    };
    setStatus(label(), true);
    _statusTimer = setInterval(() => { secs++; setStatus(label(), true); }, 1000);
  }
  try {
    const url = `/api/ticker/${encodeURIComponent(symbol)}${force ? '?force=1' : ''}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    S.data[symbol] = j;
    S.errors[symbol] = null;
  } catch (e) {
    S.data[symbol] = null;
    S.errors[symbol] = e.message;
  }
  clearInterval(_statusTimer);
  S.loading[symbol] = false;
  if (!silent) render();
}

// ── Actions ────────────────────────────────────────────────────────
async function addTicker() {
  const se = document.getElementById('inp-symbol');
  const ce = document.getElementById('inp-cost');
  const she = document.getElementById('inp-shares');

  const symbol    = se.value.trim().toUpperCase();
  const costBasis = parseFloat(ce.value);
  const shares    = she.value ? parseFloat(she.value) : null;

  if (!symbol) { se.focus(); return; }
  if (!costBasis || costBasis <= 0) { toast('Enter a valid cost basis per share.', true); ce.focus(); return; }
  if (S.tickers.find(t => t.symbol === symbol)) { toast(`${symbol} is already in your list.`, true); se.select(); return; }

  S.tickers.push({ symbol, costBasis, shares });
  persist();
  se.value = ''; ce.value = ''; she.value = '';
  se.focus();
  render();
  await fetchTicker(symbol);
}

function removeTicker(symbol) {
  S.tickers = S.tickers.filter(t => t.symbol !== symbol);
  delete S.data[symbol]; delete S.loading[symbol]; delete S.errors[symbol];
  persist(); render();
}

async function refreshAll() {
  if (!S.tickers.length) return;
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  await batchFetch(S.tickers);
  btn.disabled = false;
}

// ── Edit modal ─────────────────────────────────────────────────────
function openEditModal(symbol) {
  const t = S.tickers.find(t => t.symbol === symbol);
  if (!t) return;
  _editSym = symbol;
  const d = S.data[symbol];
  document.getElementById('modal-title').textContent =
    d?.name ? `${symbol} — ${d.name}` : symbol;
  document.getElementById('modal-cost').value   = t.costBasis;
  document.getElementById('modal-shares').value = t.shares ?? '';
  document.getElementById('edit-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('modal-cost').focus(), 50);
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
  _editSym = null;
}

function saveEdit() {
  const cost      = parseFloat(document.getElementById('modal-cost').value);
  const sharesVal = document.getElementById('modal-shares').value;
  const shares    = sharesVal ? parseFloat(sharesVal) : null;
  if (!cost || cost <= 0) { toast('Enter a valid cost basis.', true); return; }
  const t = S.tickers.find(t => t.symbol === _editSym);
  if (!t) return;
  t.costBasis = cost;
  t.shares    = shares;
  persist();
  closeEditModal();
  render();
}

// ── View toggle ────────────────────────────────────────────────────
function toggleAddCard(forceOpen) {
  const body    = document.getElementById('add-card-body');
  const chevron = document.getElementById('add-chevron');
  const open    = forceOpen !== undefined ? forceOpen : body.classList.contains('collapsed');
  body.classList.toggle('collapsed', !open);
  chevron.classList.toggle('open', open);
}

function toggleView(v) {
  calView = (v === 'cal');
  document.getElementById('btn-view-table').classList.toggle('active', !calView);
  document.getElementById('btn-view-cal').classList.toggle('active', calView);
  render();
}

// ── Calendar navigation ────────────────────────────────────────────
function calPrev() {
  if (calMonth === 0) { calMonth = 11; calYear--; } else calMonth--;
  renderCalendar();
}
function calNext() {
  if (calMonth === 11) { calMonth = 0; calYear++; } else calMonth++;
  renderCalendar();
}
function calGoToday() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar();
}

// ── Calendar helpers ───────────────────────────────────────────────
// Returns all dates in (year, month) congruent to anchorDateStr mod intervalDays
function occurrencesInMonth(anchorDateStr, intervalDays, year, month) {
  const anchor     = new Date(anchorDateStr + 'T12:00:00Z');
  const monthStart = new Date(Date.UTC(year, month, 1, 12));
  const monthEnd   = new Date(Date.UTC(year, month + 1, 0, 12));
  // Rewind to just before the month
  let d = new Date(anchor);
  while (d >= monthStart) d = new Date(d.getTime() - intervalDays * 86400000);
  // Advance through the month collecting hits
  const results = [];
  d = new Date(d.getTime() + intervalDays * 86400000);
  while (d <= monthEnd) {
    if (d >= monthStart) results.push(d.toISOString().split('T')[0]);
    d = new Date(d.getTime() + intervalDays * 86400000);
  }
  return results;
}

function projectionParams(d) {
  const intervalDays = d.frequency ? Math.round(365 / d.frequency) : 91;
  const payOffset = (d.dividendDate && d.exDividendDate)
    ? diffDays(parseISO(d.dividendDate), parseISO(d.exDividendDate))
    : 14;
  return { intervalDays, payOffset };
}

// ── Calendar render ────────────────────────────────────────────────
const CAL_MONTHS     = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
const CAL_MONTHS_ABR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CAL_DOWS       = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const CAL_DOWS_FULL  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function renderCalendar() {
  document.getElementById('cal-month-label').textContent = `${CAL_MONTHS[calMonth]} ${calYear}`;

  // Build event map: 'YYYY-MM-DD' -> [{symbol, type}]
  const events = {};
  const addEv = (date, symbol, type, amount, est = false, perShare = null, prevPerShare = null) => {
    if (!date) return;
    (events[date] ??= []);
    if (type === 'pay') {
      // Merge same-symbol pay events on the same date (e.g. regular + supplemental dividend)
      const ex = events[date].find(e => e.symbol === symbol && e.type === 'pay');
      if (ex) {
        if (amount)   ex.amount   = (ex.amount   ?? 0) + amount;
        if (perShare) ex.perShare = (ex.perShare ?? 0) + perShare;
        return;
      }
    }
    events[date].push({ symbol, type, amount, est, perShare, prevPerShare });
  };
  const calNow   = new Date();
  const todayStr = `${calNow.getFullYear()}-${String(calNow.getMonth()+1).padStart(2,'0')}-${String(calNow.getDate()).padStart(2,'0')}`;
  const monthPfx = `${calYear}-${String(calMonth+1).padStart(2,'0')}-`;

  for (const { symbol, shares } of S.tickers) {
    const d = S.data[symbol];
    if (!d) continue;

    // ── Actual history: plot real ex-dates and pay-dates ──
    const hist = d.history || [];
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i], prev = hist[i + 1]; // history is newest-first; prev is older
      if (h.date.startsWith(monthPfx))
        addEv(h.date, symbol, 'ex');
      if (h.payDate && h.payDate.startsWith(monthPfx)) {
        const payAmt = (h.amount && shares) ? shares * h.amount : null;
        addEv(h.payDate, symbol, 'pay', payAmt, false, h.amount ?? null, prev?.amount ?? null);
      }
    }

    // ── Future: project forward from the next estimated/declared ex-date ──
    if (!d.exDividendDate) continue;
    const histDates = new Set((d.history || []).map(h => h.date));
    const { intervalDays, payOffset: payOffsetDays } = projectionParams(d);
    const exType = d.isEstimated ? 'est' : 'ex';

    for (const exDate of occurrencesInMonth(d.exDividendDate, intervalDays, calYear, calMonth)) {
      if (exDate < todayStr || histDates.has(exDate)) continue;
      addEv(exDate, symbol, exType);
      const payDate = addDays(parseISO(exDate), payOffsetDays).toISOString().split('T')[0];
      const payAmt = (d.distributionAmount && shares) ? shares * d.distributionAmount : null;
      const prevPerSh = hist[0]?.amount ?? null;
      addEv(payDate, symbol, 'pay', payAmt, true, d.distributionAmount ?? null, prevPerSh);
    }
  }

  // Monthly total
  let monthlyTotal = 0, hasMonthlyAmt = false;
  for (const evs of Object.values(events)) {
    for (const ev of evs) {
      if (ev.type === 'pay' && ev.amount != null) { monthlyTotal += ev.amount; hasMonthlyAmt = true; }
    }
  }
  document.getElementById('cal-monthly-total').innerHTML = hasMonthlyAmt
    ? `<span class="mtl">Month Total</span><span class="mtv">${fmt$(monthlyTotal)}</span>`
    : '';

  // Build flat cell list then emit with week-total cells
  const firstDay    = new Date(calYear, calMonth, 1);
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const startPad    = firstDay.getDay();

  function makeChips(dateStr) {
    const evs = [...(events[dateStr] || [])];
    // Pay dates first (desc by amount, nulls last), then ex-dates
    evs.sort((a, b) => {
      const aPay = a.type === 'pay', bPay = b.type === 'pay';
      if (aPay !== bPay) return aPay ? -1 : 1;
      if (aPay && bPay) {
        if (a.amount == null && b.amount == null) return 0;
        if (a.amount == null) return 1;
        if (b.amount == null) return -1;
        return b.amount - a.amount;
      }
      return 0;
    });
    return evs.map(e => {
      const chipClass = e.type === 'pay' ? (e.est ? 'chip-pay-est' : 'chip-pay') : `chip-${e.type}`;

      if (e.type !== 'pay') {
        return `<span class="cal-chip ${chipClass}" onclick="openSymbolModal('${e.symbol}');event.stopPropagation()" style="cursor:pointer" title="Ex-date · ${e.symbol}">${e.symbol}</span>`;
      }

      // Build delta indicator (per-share comparison)
      let deltaHtml = '', titleExtra = '';
      if (e.perShare != null && e.prevPerShare != null && e.prevPerShare !== 0) {
        const pct = (e.perShare - e.prevPerShare) / e.prevPerShare * 100;
        if (Math.abs(pct) >= 0.1) {
          const up    = pct > 0;
          const color = up ? 'var(--green-hi)' : 'var(--red)';
          const arrow = up ? '▲' : '▼';
          deltaHtml   = ` <span style="font-size:.82em;opacity:.85;color:${color}">${arrow}${Math.abs(pct).toFixed(1)}%</span>`;
          titleExtra  = ` — Prev: ${fmt$(e.prevPerShare, 4)}/sh → ${fmt$(e.perShare, 4)}/sh (${up ? '+' : ''}${pct.toFixed(1)}%)`;
        }
      }

      const amtStr  = e.amount ? ` ${fmt$(e.amount)}` : '';
      const label   = `${e.symbol}${amtStr}${deltaHtml}`;
      const title   = `${e.est ? 'Estimated pay' : 'Pay'}-date · ${e.symbol}${titleExtra}`;
      return `<span class="cal-chip ${chipClass}" onclick="openSymbolModal('${e.symbol}');event.stopPropagation()" style="cursor:pointer" title="${title}">${label}</span>`;
    }).join('');
  }

  function weekTotalHtml(dateCells) {
    let tot = 0, has = false;
    for (const ds of dateCells) {
      if (!ds) continue;
      for (const ev of (events[ds] || [])) {
        if (ev.type === 'pay' && ev.amount != null) { tot += ev.amount; has = true; }
      }
    }
    return `<div class="cal-week-total">${has ? fmt$(tot) : ''}</div>`;
  }

  // All cells: [null = pad, 'YYYY-MM-DD' = real day]
  const cells = [
    ...Array(startPad).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const d = i + 1;
      return `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    })
  ];
  const trail = cells.length % 7;
  if (trail > 0) for (let i = 0; i < 7 - trail; i++) cells.push(null);

  calEvents = events;

  let html = CAL_DOWS.map(d => `<div class="cal-dow">${d}</div>`).join('') +
             `<div class="cal-dow-week">Week</div>`;

  for (let i = 0; i < cells.length; i++) {
    const ds = cells[i];
    if (ds === null) {
      html += `<div class="cal-cell other-month"></div>`;
    } else {
      const isToday  = ds === todayStr;
      const dayPayTotal = (events[ds] || [])
        .filter(e => e.type === 'pay' && e.amount)
        .reduce((s, e) => s + e.amount, 0);
      const dayTotalHtml = dayPayTotal > 0
        ? `<span class="cal-day-total">${fmt$(dayPayTotal)}</span>` : '';
      html += `<div class="cal-cell${isToday ? ' today' : ''}" onclick="openDayModal('${ds}')">
        <div class="cal-day-hdr"><div class="cal-day-num">${Number(ds.slice(8))}</div>${dayTotalHtml}</div>
        <div class="cal-events">${makeChips(ds)}</div>
      </div>`;
    }
    if ((i + 1) % 7 === 0) html += weekTotalHtml(cells.slice(i - 6, i + 1));
  }

  document.getElementById('cal-grid').innerHTML = html;
}

// ── Table render helpers ───────────────────────────────────────────
const COLS = [
  { key: 'symbol',    label: 'Ticker',       cls: '',      w: 66  },
  { key: 'name',      label: 'Company',      cls: ''             },  // flexible — absorbs remaining width
  { key: 'price',     label: 'Price',        cls: 'r',     w: 74  },
  { key: 'cost',      label: 'Cost / Sh',    cls: 'r',     w: 76  },
  { key: 'shares',    label: 'Shares',       cls: 'r',     w: 74  },
  { key: 'exdate',    label: 'Ex-Date',      cls: 'r',     w: 144 },
  { key: 'paydate',   label: 'Pay Date',     cls: 'r',     w: 92  },
  { key: 'dist',      label: 'Dist / Sh',    cls: 'r',     w: 76  },
  { key: 'freq',      label: 'Freq',         cls: '',      w: 82  },
  { key: 'annrate',   label: 'Ann. Rate',    cls: 'r',     w: 80  },
  { key: 'yop',       label: 'Yield/Price',  cls: 'r',     w: 96  },
  { key: 'yoc',       label: 'Yield/Cost',   cls: 'r hl',  w: 96  },
  { key: 'estpay',    label: 'Est. Payout',  cls: 'r',     w: 92  },
  { key: 'annpayout', label: 'Ann. Payout',  cls: 'r hl',  w: 92  },
  { key: null,        label: '',             cls: '',      w: 86  },
];

let sortCol = 'exdate', sortDir = 1; // 1=asc, -1=desc

function sortVal(col, t) {
  const d = S.data[t.symbol];
  switch (col) {
    case 'symbol':    return t.symbol;
    case 'name':      return d?.name || '';
    case 'price':     return d?.currentPrice ?? null;
    case 'cost':      return t.costBasis ?? null;
    case 'shares':    return t.shares ?? null;
    case 'exdate': {
      if (!d?.exDividendDate) return null;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const diff = (parseISO(d.exDividendDate) - today) / 86400000;
      return diff >= 0 ? diff : 1e9 - diff;
    }
    case 'paydate':   return d?.dividendDate || null;
    case 'dist':      return d?.distributionAmount ?? null;
    case 'freq':      return d?.frequency ?? null;
    case 'annrate':   return d?.annualDividendRate ?? null;
    case 'yop':       return (d?.currentPrice && d?.annualDividendRate) ? d.annualDividendRate / d.currentPrice : null;
    case 'yoc':       return (t.costBasis && d?.annualDividendRate) ? d.annualDividendRate / t.costBasis : null;
    case 'estpay':    return (t.shares && d?.distributionAmount) ? t.shares * d.distributionAmount : null;
    case 'annpayout': return (t.shares && d?.annualDividendRate) ? t.shares * d.annualDividendRate : null;
    default:          return null;
  }
}

function sortedTickers() {
  return [...S.tickers].sort((a, b) => {
    const va = sortVal(sortCol, a), vb = sortVal(sortCol, b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
    return (va - vb) * sortDir;
  });
}

function renderHeaders() {
  document.getElementById('thead-row').innerHTML = COLS.map(c => {
    const style = c.w ? ` style="width:${c.w}px"` : '';
    if (!c.key) return `<th${style}></th>`;
    const active = sortCol === c.key;
    const arrow  = active ? `<span class="sort-arrow">${sortDir === 1 ? '▲' : '▼'}</span>` : '';
    const cls    = [c.cls, active ? 'sort-active' : ''].filter(Boolean).join(' ');
    return `<th class="${cls}" data-sort="${c.key}"${style}>${c.label}${arrow}</th>`;
  }).join('');
}

const ICON_EDIT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const ICON_REFRESH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
const ICON_X = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function actionBtns(symbol) {
  return `<div class="actions" onclick="event.stopPropagation()">
    <button class="btn-icon" onclick="openEditModal('${symbol}')" title="Edit">${ICON_EDIT}</button>
    <button class="btn-icon" onclick="fetchTicker('${symbol}')" title="Refresh">${ICON_REFRESH}</button>
    <button class="btn-icon danger" onclick="removeTicker('${symbol}')" title="Remove">${ICON_X}</button>
  </div>`;
}

function renderRow({ symbol, costBasis, shares }) {
  const data = S.data[symbol], loading = S.loading[symbol], err = S.errors[symbol];

  const badgeHtml = `<span class="badge">${symbol}</span>`;

  if (loading) return `<tr data-symbol="${symbol}">
    <td>${badgeHtml}</td>
    <td colspan="13" class="cell-loading"><span class="spinner"></span>Loading…</td>
    <td>${actionBtns(symbol)}</td></tr>`;

  if (err) return `<tr data-symbol="${symbol}">
    <td>${badgeHtml}</td>
    <td colspan="13" class="cell-error">Error: ${esc(err)}</td>
    <td>${actionBtns(symbol)}</td></tr>`;

  if (!data) return `<tr data-symbol="${symbol}">
    <td>${badgeHtml}</td>
    <td colspan="13" style="color:var(--dim)">—</td>
    <td>${actionBtns(symbol)}</td></tr>`;

  const days = daysUntil(data.exDividendDate);
  const upcoming = days !== null && days >= 0;
  const isEst = data.isEstimated;

  let exCell = '<span style="color:var(--dim)">—</span>';
  if (data.exDividendDate) {
    let pillClass = 'pill-past', pillText = 'past';
    if (upcoming) {
      if (days <= 7)       { pillClass = 'pill-urgent'; pillText = days === 0 ? 'today' : `in ${days}d`; }
      else if (days <= 30) { pillClass = 'pill-soon';   pillText = `in ${days}d`; }
      else                 { pillClass = 'pill-future';  pillText = `in ${days}d`; }
    }
    if (isEst) { pillClass = 'pill-est'; pillText = 'est.'; }
    exCell = `<div class="ex-wrap">
      <span class="ex-str">${fmtDate(data.exDividendDate)}</span>
      <span class="days-pill ${pillClass}">${pillText}</span>
    </div>`;
  }

  const annRate   = data.annualDividendRate || 0;
  const price     = data.currentPrice;
  const yop       = price && annRate ? annRate / price * 100 : null;
  const yoc       = annRate && costBasis ? annRate / costBasis * 100 : null;
  const distAmt   = data.distributionAmount || 0;
  const estPay    = shares && distAmt ? shares * distAmt : null;
  const annPayout = shares && annRate ? shares * annRate : null;

  return `<tr data-symbol="${symbol}">
    <td><span class="badge">${symbol}</span></td>
    <td><span class="co-name" title="${esc(data.name)}">${esc(data.name)}</span></td>
    <td class="r mono">${fmt$(price)}</td>
    <td class="r mono" style="color:var(--muted)">${fmt$(costBasis)}</td>
    <td class="r mono">${shares != null ? fmtN(shares) : '<span style="color:var(--dim)">—</span>'}</td>
    <td class="r">${exCell}</td>
    <td class="r mono" style="color:var(--muted)">${fmtDate(data.dividendDate)}</td>
    <td class="r mono">${distAmt > 0 ? fmt$(distAmt, 4) : '<span style="color:var(--dim)">—</span>'}</td>
    <td>${data.frequency ? `<span class="freq-badge">${freqLabel(data.frequency)}</span>` : '—'}</td>
    <td class="r mono" style="color:var(--muted)">${annRate > 0 ? fmt$(annRate, 4) : '<span style="color:var(--dim)">—</span>'}</td>
    <td class="r yop">${fmtPct(yop)}</td>
    <td class="r yoc">${fmtPct(yoc)}</td>
    <td class="r mono">${estPay != null ? fmt$(estPay) : '<span style="color:var(--dim)">—</span>'}</td>
    <td class="r mono hl">${annPayout != null ? fmt$(annPayout) : '<span style="color:var(--dim)">—</span>'}</td>
    <td>${actionBtns(symbol)}</td>
  </tr>`;
}

function renderSummary() {
  const count = S.tickers.length;
  const now = new Date(); now.setHours(0,0,0,0);
  const in7  = new Date(now); in7.setDate(in7.getDate() + 7);
  const in30 = new Date(now); in30.setDate(in30.getDate() + 30);
  let urgent = 0, payout30 = 0, yocSum = 0, yocN = 0, yopSum = 0, yopN = 0;
  let annualTotal = 0, hasAnnual = false;
  let mktVal = 0, hasMktVal = false, totalCost = 0, hasCost = false;

  for (const { symbol, costBasis, shares } of S.tickers) {
    const d = S.data[symbol]; if (!d) continue;
    const ex = d.exDividendDate ? new Date(d.exDividendDate + 'T12:00:00Z') : null;
    if (ex && ex >= now && ex <= in7)  urgent++;
    if (ex && ex >= now && ex <= in30 && shares && d.distributionAmount > 0) payout30 += shares * d.distributionAmount;
    const r = d.annualDividendRate || 0;
    if (r > 0 && costBasis)      { yocSum += r / costBasis * 100; yocN++; }
    if (r > 0 && d.currentPrice) { yopSum += r / d.currentPrice * 100; yopN++; }
    if (shares) { annualTotal += r * shares; hasAnnual = true; }
    if (shares != null && d.currentPrice) { mktVal    += shares * d.currentPrice; hasMktVal = true; }
    if (shares != null && costBasis)      { totalCost += shares * costBasis;       hasCost   = true; }
  }

  document.getElementById('s-count').textContent  = count;
  document.getElementById('s-urgent').textContent  = urgent;
  document.getElementById('s-payout').textContent  = payout30 > 0 ? fmt$(payout30) : '—';
  document.getElementById('s-yoc').textContent     = yocN ? fmtPct(yocSum / yocN) : '—';
  document.getElementById('s-yop').textContent     = yopN ? fmtPct(yopSum / yopN) : '—';
  document.getElementById('s-annual').textContent  = hasAnnual ? fmt$(annualTotal) : '—';

  document.getElementById('s-mktval').textContent = hasMktVal ? fmt$(mktVal) : '—';
  document.getElementById('s-cost').textContent   = hasCost   ? fmt$(totalCost) : '—';

  const gainEl = document.getElementById('s-gain');
  if (hasMktVal && hasCost) {
    const gain = mktVal - totalCost;
    const gainPct = totalCost > 0 ? (gain / totalCost) * 100 : null;
    const sign = gain >= 0 ? '+' : '';
    gainEl.textContent = fmt$(gain) + (gainPct != null ? ` (${sign}${gainPct.toFixed(2)}%)` : '');
    gainEl.className = 'stat-value ' + (gain >= 0 ? 'green' : 'loss');
  } else {
    gainEl.textContent = '—';
    gainEl.className = 'stat-value';
  }
}

// ── 12-month payout chart ──────────────────────────────────────────
let chartMonths = [];
const fmtBar = v => !v ? '' : v >= 10000 ? `$${(v/1000).toFixed(0)}k` : v >= 1000 ? `$${(v/1000).toFixed(1)}k` : fmt$(v, 0);

function computeMonthlyProjections() {
  const now = new Date();
  const nowY = now.getFullYear(), nowM = now.getMonth();
  const months = Array.from({ length: 12 }, (_, i) => {
    const t = nowM + i, y = nowY + Math.floor(t / 12), m = t % 12;
    return { year: y, month: m, total: 0, breakdown: [] };
  });
  const idxMap = {};
  months.forEach((m, i) => { idxMap[`${m.year}-${String(m.month+1).padStart(2,'0')}`] = i; });

  for (const { symbol, shares } of S.tickers) {
    const d = S.data[symbol];
    if (!d?.exDividendDate || !d.distributionAmount || !shares) continue;
    const { intervalDays, payOffset } = projectionParams(d);
    for (const slot of months) {
      for (const exDate of occurrencesInMonth(d.exDividendDate, intervalDays, slot.year, slot.month)) {
        const pd = addDays(parseISO(exDate), payOffset);
        const key = `${pd.getUTCFullYear()}-${String(pd.getUTCMonth()+1).padStart(2,'0')}`;
        const si  = idxMap[key];
        if (si == null) continue;
        const amt = shares * d.distributionAmount;
        months[si].total += amt;
        const ex = months[si].breakdown.find(b => b.symbol === symbol);
        if (ex) ex.amount += amt; else months[si].breakdown.push({ symbol, amount: amt });
      }
    }
  }
  return months;
}

function renderChart() {
  chartMonths = computeMonthlyProjections();
  const totals  = chartMonths.map(m => m.total).filter(t => t > 0);
  const max     = Math.max(...totals, 1);
  const minVal  = totals.length ? Math.min(...totals) : 0;
  const floor   = minVal > 0 ? minVal * 0.8 : 0;
  const range   = max - floor || 1;
  const BAR_MAX_H = 120, now = new Date();
  const annTotal = chartMonths.reduce((s, m) => s + m.total, 0);
  document.getElementById('chart-annual-ttl').textContent = annTotal > 0 ? fmt$(annTotal) : '';
  const thisYear = now.getFullYear();
  document.getElementById('bar-chart').innerHTML = chartMonths.map((m, i) => {
    const h          = m.total > 0 ? Math.max(Math.round((m.total - floor) / range * BAR_MAX_H), 4) : 0;
    const isCur      = m.year === thisYear && m.month === now.getMonth();
    const isNextYear = m.year !== thisYear;
    const isBreak    = isNextYear && (i === 0 || chartMonths[i-1].year === thisYear);
    const cls = ['bar-col', isCur && 'cur-month', isNextYear && 'next-year', isBreak && 'year-break']
      .filter(Boolean).join(' ');
    return `<div class="${cls}" data-idx="${i}"${isBreak ? ` data-year="${m.year}"` : ''}>
      <div class="bar-spacer"></div>
      <div class="bar-amt">${fmtBar(m.total)}</div>
      <div class="bar" style="height:${h}px"></div>
      <div class="bar-lbl">${CAL_MONTHS_ABR[m.month]}</div>
    </div>`;
  }).join('');
}

// ── Ticker detail modal ────────────────────────────────────────────
function projectFutureDates(d, count = 4) {
  if (!d.exDividendDate || !d.frequency) return [];
  const { intervalDays, payOffset } = projectionParams(d);
  const results = [];
  let next = parseISO(d.exDividendDate);
  for (let i = 0; i < count; i++) {
    const exDate = next.toISOString().split('T')[0];
    const payDate = addDays(next, payOffset).toISOString().split('T')[0];
    results.push({ exDate, payDate, amount: d.distributionAmount, est: i === 0 ? d.isEstimated : true });
    next = addDays(next, intervalDays);
  }
  return results;
}

function openSymbolModal(symbol) {
  const d = S.data[symbol];
  const t = S.tickers.find(t => t.symbol === symbol);
  document.getElementById('sym-modal-title').textContent = d?.name ? `${symbol} — ${d.name}` : symbol;
  const body = document.getElementById('sym-modal-body');

  if (!d) {
    body.innerHTML = '<p style="color:var(--muted);padding:16px 18px">No data loaded for this ticker yet.</p>';
    document.getElementById('symbol-modal').classList.remove('hidden');
    return;
  }

  const yoc = (t?.costBasis && d.annualDividendRate) ? d.annualDividendRate / t.costBasis * 100 : null;
  const yop = (d.currentPrice && d.annualDividendRate) ? d.annualDividendRate / d.currentPrice * 100 : null;

  const statsHtml = `<div class="sym-stats">
    ${d.currentPrice ? `<span class="sym-stat">Price <strong>${fmt$(d.currentPrice)}</strong></span>` : ''}
    ${d.frequency ? `<span class="sym-stat">Freq <strong>${freqLabel(d.frequency)}</strong></span>` : ''}
    ${d.annualDividendRate ? `<span class="sym-stat">Ann. Rate <strong>${fmt$(d.annualDividendRate, 4)}</strong></span>` : ''}
    ${yop != null ? `<span class="sym-stat">Yield / Price <strong>${fmtPct(yop)}</strong></span>` : ''}
    ${yoc != null ? `<span class="sym-stat">Yield / Cost <strong class="hi">${fmtPct(yoc)}</strong></span>` : ''}
    ${t?.costBasis ? `<span class="sym-stat">Cost / sh <strong>${fmt$(t.costBasis)}</strong></span>` : ''}
    ${t?.shares ? `<span class="sym-stat">Shares <strong>${fmtN(t.shares)}</strong></span>` : ''}
  </div>`;

  // Bar chart: history (oldest→newest) + future projections
  const histOldFirst = [...(d.history || [])].reverse();
  const futures = projectFutureDates(d, 4);
  const allBars = [
    ...histOldFirst.map(h => ({ date: h.date, amount: h.amount, est: false })),
    ...futures.map(f => ({ date: f.exDate, amount: f.amount, est: true }))
  ];

  let chartHtml = '';
  if (allBars.length > 0) {
    const amounts = allBars.map(b => b.amount).filter(a => a > 0);
    const maxAmt  = amounts.length ? Math.max(...amounts) : 0.01;
    const minAmt  = amounts.length ? Math.min(...amounts) : 0;
    const floor   = minAmt > 0 ? minAmt * 0.8 : 0;
    const range   = maxAmt - floor || 0.01;
    const BAR_H   = 80;
    // Show label every N bars so we get ~6-8 visible labels
    const n = allBars.length;
    const step = n <= 6 ? 1 : n <= 12 ? 2 : n <= 20 ? 3 : 4;

    chartHtml = `<div class="sym-section">
      <div class="sym-section-lbl">Distribution / Share — last ${histOldFirst.length} + ${futures.length} projected</div>
      <div class="hist-chart">
        ${allBars.map((b, i) => {
          const h   = b.amount > 0 ? Math.max(Math.round((b.amount - floor) / range * BAR_H), 2) : 0;
          const dt = parseISO(b.date);
          const lbl = (i % step === 0 || i === allBars.length - 1)
            ? `${CAL_MONTHS_ABR[dt.getUTCMonth()]} '${String(dt.getUTCFullYear()).slice(2)}`
            : '';
          const tip = `${b.est ? 'Projected' : 'Actual'} ex-date: ${b.date}\nDist/sh: ${fmt$(b.amount, 4)}`;
          return `<div class="hist-bar-col${b.est ? ' hbc-future' : ''}" title="${tip}">
            <div class="hbc-spacer"></div>
            <div class="hist-bar" style="height:${h}px"></div>
            <div class="hist-bar-lbl">${lbl}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // Table: upcoming first, then past (newest→oldest)
  const histNewFirst = d.history || [];
  const shortDate = iso => {
    if (!iso) return '—';
    const dt = parseISO(iso);
    return `${CAL_MONTHS_ABR[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
  };

  let rows = '';
  // Upcoming / projected rows — reversed so furthest future is at top, nearest just above the divider
  for (const f of [...futures].reverse()) {
    const estBadge = f.est
      ? `<span style="font-size:10px;color:var(--purple);font-weight:600;font-family:var(--font)">est</span>`
      : `<span style="font-size:10px;color:var(--blue);font-weight:600;font-family:var(--font)">confirmed</span>`;
    rows += `<tr class="est-row">
      <td>${shortDate(f.exDate)}</td>
      <td>${shortDate(f.payDate)}</td>
      <td style="text-align:right">${fmt$(f.amount, 4)}</td>
      <td style="text-align:right">—</td>
      <td class="label">${estBadge}</td>
    </tr>`;
  }

  if (futures.length && histNewFirst.length) {
    rows += `<tr class="divider"><td colspan="5">Past distributions (newest first)</td></tr>`;
  }

  // Past history rows
  for (let i = 0; i < histNewFirst.length; i++) {
    const h = histNewFirst[i], prev = histNewFirst[i + 1];
    let delta = '<span style="color:var(--dim)">—</span>';
    if (h.amount && prev?.amount) {
      const pct = (h.amount - prev.amount) / prev.amount * 100;
      if (Math.abs(pct) >= 0.1) {
        const up = pct > 0;
        delta = `<span style="color:${up ? 'var(--green-hi)' : 'var(--red)'}">${up ? '+' : ''}${pct.toFixed(1)}%</span>`;
      }
    }
    rows += `<tr>
      <td>${shortDate(h.date)}</td>
      <td style="color:var(--muted)">${shortDate(h.payDate)}</td>
      <td style="text-align:right">${fmt$(h.amount, 4)}</td>
      <td style="text-align:right">${delta}</td>
      <td></td>
    </tr>`;
  }

  if (!rows) rows = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px 18px;font-family:var(--font)">No distribution history available</td></tr>`;

  const tableHtml = `<table class="hist-table">
    <thead><tr>
      <th>Ex-Date</th><th>Pay Date</th>
      <th class="r">$ / Share</th><th class="r">Δ vs Prior</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  body.innerHTML = statsHtml + chartHtml + `<div style="padding-top:14px">${tableHtml}</div>`;
  document.getElementById('symbol-modal').classList.remove('hidden');
}

function closeSymbolModal() {
  document.getElementById('symbol-modal').classList.add('hidden');
}

// ── Day detail modal ───────────────────────────────────────────────
function openDayModal(dateStr) {
  const evs = calEvents[dateStr] || [];
  if (!evs.length) return;

  const dt = parseISO(dateStr);
  const dayName = CAL_DOWS_FULL[dt.getUTCDay()];
  document.getElementById('day-modal-title').textContent =
    `${dayName}, ${CAL_MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;

  const payTotal = evs.filter(e => e.type === 'pay').reduce((s, e) => s + (e.amount || 0), 0);

  const sorted = [...evs].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'pay' ? -1 : 1;
    return (b.amount || 0) - (a.amount || 0);
  });

  let html = '';
  if (payTotal > 0)
    html += `<div class="day-modal-total">${fmt$(payTotal)}</div>`;

  html += sorted.map(ev => {
    const isPay = ev.type === 'pay';
    const typeColor = isPay
      ? (ev.est ? 'var(--muted)' : 'var(--green)')
      : (ev.type === 'est' ? 'var(--purple)' : 'var(--red)');
    const typeLabel = isPay ? 'PAY' : 'EX';
    const amt = isPay && ev.amount ? fmt$(ev.amount) : ev.perShare ? `${fmt$(ev.perShare, 4)}/sh` : '';
    const estBadge = ev.est ? `<span class="day-modal-est" style="color:${typeColor}">est</span>` : '';

    let deltaHtml = '', titleExtra = '';
    if (isPay && ev.perShare != null && ev.prevPerShare != null && ev.prevPerShare !== 0) {
      const pct = (ev.perShare - ev.prevPerShare) / ev.prevPerShare * 100;
      if (Math.abs(pct) >= 0.1) {
        const up = pct > 0;
        const color = up ? 'var(--green-hi)' : 'var(--red)';
        const arrow = up ? '▲' : '▼';
        deltaHtml  = `<span style="font-size:11px;color:${color};margin-left:4px">${arrow}${Math.abs(pct).toFixed(1)}%</span>`;
        titleExtra = ` — Prev: ${fmt$(ev.prevPerShare, 4)}/sh → ${fmt$(ev.perShare, 4)}/sh (${up ? '+' : ''}${pct.toFixed(1)}%)`;
      }
    }
    const title = isPay
      ? `${ev.est ? 'Estimated pay' : 'Pay'}-date · ${ev.symbol}${titleExtra}`
      : `${ev.type === 'est' ? 'Estimated ex' : 'Ex'}-date · ${ev.symbol}`;

    return `<div class="day-modal-row" onclick="openSymbolModal('${ev.symbol}')" title="${title}">
      <span class="badge">${ev.symbol}</span>
      <span class="day-modal-type" style="color:${typeColor}">${typeLabel}</span>
      <span class="day-modal-amt" style="color:${typeColor}">${amt}${estBadge}${deltaHtml}</span>
    </div>`;
  }).join('');

  document.getElementById('day-modal-body').innerHTML = html;
  document.getElementById('day-modal').classList.remove('hidden');
}

function closeDayModal() {
  document.getElementById('day-modal').classList.add('hidden');
}

// ── Render ─────────────────────────────────────────────────────────
function render() {
  const has = S.tickers.length > 0;
  document.getElementById('empty-state').classList.toggle('hidden', has);
  document.getElementById('summary-strip').classList.toggle('hidden', !has);
  document.getElementById('chart-card').classList.toggle('hidden', !has);
  document.getElementById('table-card').classList.toggle('hidden', !has || calView);
  document.getElementById('calendar-card').classList.toggle('hidden', !has || !calView);
  if (!has) return;
  renderSummary();
  renderChart();
  if (calView) renderCalendar();
  else {
    renderHeaders();
    document.getElementById('tbody').innerHTML = sortedTickers().map(renderRow).join('');
  }
}

// ── Toast ──────────────────────────────────────────────────────────
let _tt;
function toast(msg, isError=false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'error show' : 'show';
  clearTimeout(_tt);
  _tt = setTimeout(() => { el.className = isError ? 'error' : ''; }, 3000);
}

// ── Escape HTML ────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ── Batch fetch ────────────────────────────────────────────────────
// Server-side queue paces Polygon calls, so no explicit delay needed here.
// Sequential awaits let the server queue do its job and give us a progress counter.
async function batchFetch(tickers, force = false) {
  for (let i = 0; i < tickers.length; i++) {
    await fetchTicker(tickers[i].symbol, force, `(${i + 1}/${tickers.length})`);
  }
  setStatus('Updated ' + new Date().toLocaleTimeString());
}

// ── CSV Import ─────────────────────────────────────────────────────
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

async function handleCSVFile(input) {
  const file = input.files[0]; if (!file) return;
  input.value = '';
  const text = await file.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);

  // Find the header row
  let headerIdx = -1, rawHeaders = [];
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const cols = parseCSVRow(lines[i]);
    if (cols.some(c => /^(symbol|ticker)$/i.test(c))) {
      headerIdx = i; rawHeaders = cols; break;
    }
  }
  if (headerIdx < 0) { toast('No "Ticker" or "Symbol" column found — check CSV format.', true); return; }

  const h = rawHeaders.map(c => c.toLowerCase());
  const symIdx    = h.findIndex(c => /^(symbol|ticker)$/.test(c));
  const sharesIdx = h.findIndex(c => /^(quantity|shares|units|qty)$/.test(c));

  const costPSIdx = h.findIndex(c =>
    /^average cost basis$|\/share|per share|avg(erage)?\s+cost(?!\s+(basis\s+)?total)/i.test(c)
  );
  const costTotIdx = costPSIdx < 0
    ? h.findIndex(c => /cost basis total|total cost basis|total cost|^cost basis$/i.test(c))
    : -1;

  const positions = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    const raw    = cols[symIdx] || '';
    const symbol = raw.toUpperCase().replace(/[^A-Z0-9.\-/]/g, '');
    if (!symbol || symbol.length > 12 || /^(--|cash|pending|total|account)/i.test(raw)) continue;

    const shares = sharesIdx >= 0 ? parseNum(cols[sharesIdx]) : null;
    let costBasis = costPSIdx >= 0 ? parseNum(cols[costPSIdx]) : null;
    if (costBasis == null && costTotIdx >= 0) {
      const tot = parseNum(cols[costTotIdx]);
      if (tot != null && shares > 0) costBasis = tot / shares;
    }
    if (!costBasis || costBasis <= 0) continue;
    positions.push({ symbol, costBasis, shares: shares > 0 ? shares : null });
  }

  // Merge duplicate tickers: sum shares, weighted-average cost basis
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
  const imported = [...bySymbol.values()];

  if (!imported.length) { toast('No valid positions found — check CSV format.', true); return; }

  const replaceAll = document.getElementById('csv-replace-all').checked;

  if (replaceAll) {
    S.tickers = imported;
    S.data = {}; S.loading = {}; S.errors = {};
    persist();
    render();
    toast(`Replaced portfolio with ${imported.length} ticker${imported.length !== 1 ? 's' : ''} — fetching data…`);
    await batchFetch(S.tickers);
  } else {
    // Merge: update existing, add new, leave untouched tickers alone
    const newSymbols = [];
    for (const p of imported) {
      const idx = S.tickers.findIndex(t => t.symbol === p.symbol);
      if (idx >= 0) {
        S.tickers[idx] = p;
      } else {
        S.tickers.push(p);
        newSymbols.push(p.symbol);
      }
    }
    persist();
    render();
    const updatedCount = imported.length - newSymbols.length;
    const parts = [];
    if (updatedCount > 0) parts.push(`updated ${updatedCount}`);
    if (newSymbols.length > 0) parts.push(`added ${newSymbols.length} new`);
    toast(`CSV import: ${parts.join(', ')}${newSymbols.length ? ' — fetching new tickers…' : ''}`);
    if (newSymbols.length) await batchFetch(newSymbols.map(s => ({ symbol: s })));
    else setStatus('Updated ' + new Date().toLocaleTimeString());
  }
}

// ── Init ───────────────────────────────────────────────────────────
async function startApp() {
  await hydrate();
  toggleAddCard(S.tickers.length === 0);
  render();

  const chartTip = document.getElementById('chart-tip');
  document.getElementById('bar-chart').addEventListener('mouseover', e => {
    const col = e.target.closest('.bar-col[data-idx]');
    if (!col) return;
    const m = chartMonths[+col.dataset.idx];
    if (!m?.total) { chartTip.style.display = 'none'; return; }
    const rows = [...m.breakdown].sort((a, b) => b.amount - a.amount)
      .map(b => `<div class="tip-row"><span class="tip-sym">${b.symbol}</span><span class="tip-amt">${fmt$(b.amount)}</span></div>`)
      .join('');
    chartTip.innerHTML = `<div class="tip-header"><span>${CAL_MONTHS[m.month]} ${m.year}</span><span class="tip-total">${fmt$(m.total)}</span></div>${rows}`;
    chartTip.style.display = 'block';
    const colR  = col.getBoundingClientRect();
    const chartR = document.getElementById('bar-chart').getBoundingClientRect();
    const tw = chartTip.offsetWidth, th = chartTip.offsetHeight;
    let left = colR.left + colR.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = chartR.top - th - 8;
    if (top < 8) top = chartR.bottom + 8;
    chartTip.style.left = left + 'px';
    chartTip.style.top  = top + 'px';
  });
  document.getElementById('bar-chart').addEventListener('mouseleave', () => {
    chartTip.style.display = 'none';
  });

  document.getElementById('thead-row').addEventListener('click', e => {
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    const col = th.dataset.sort;
    if (sortCol === col) sortDir *= -1;
    else { sortCol = col; sortDir = 1; }
    render();
  });

  document.getElementById('tbody').addEventListener('click', e => {
    if (e.target.closest('.actions')) return;
    const row = e.target.closest('tr[data-symbol]');
    if (!row) return;
    openSymbolModal(row.dataset.symbol);
  });

  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    document.getElementById('setup-banner').classList.toggle('hidden', cfg.hasKey);
  } catch {}

  if (S.tickers.length > 0) {
    // Show all as loading immediately, then fire parallel fetches silently.
    // Each resolves independently; a single render after Promise.all settles.
    // batchFetch (sequential + progress) is reserved for Refresh All and CSV import.
    S.tickers.forEach(t => { S.loading[t.symbol] = true; });
    render();
    await Promise.all(S.tickers.map(t => fetchTicker(t.symbol, false, '', true)));
    render();
    setStatus('Updated ' + new Date().toLocaleTimeString());
  }

  // Auto-refresh every 12 hours — matches the server-side cache TTL
  setInterval(refreshAll, 12 * 60 * 60 * 1000);
}

async function init() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeEditModal(); closeSymbolModal(); closeDayModal(); }
  });

  try {
    const vr = await fetch('/api/version');
    if (vr.ok) {
      const v = await vr.json();
      document.getElementById('footer-version').textContent = `v${v.version}`;
    }
  } catch {}

  try {
    const r = await fetch('/api/me');
    if (!r.ok) {
      const ls = document.getElementById('login-screen');
      ls.style.display = 'flex';
      document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
      document.getElementById('login-user').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-pass').focus(); });
      return;
    }
    const me = await r.json();
    currentUser = me.username;
    if (me.authEnabled) {
      const chip = document.getElementById('user-chip');
      document.getElementById('user-label').textContent = me.username;
      chip.style.display = 'flex';
    }
  } catch {
    document.getElementById('login-screen').style.display = 'flex';
    return;
  }
  await startApp();
}

init();
