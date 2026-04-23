'use strict';

let _watchlistView    = 'watchlist';
let _watchlistData    = [];
let _wlSortCol        = null;
let _wlSortDir        = 1;
let _wlQualView       = false;
let _wlDivFilter      = false;
let _wlQualLoaded     = false;
let _entryScores      = [];
let _signals          = [];

let _transactions = [];
let _portfolio    = [];
let _prices       = {};
let _currentFilter  = 'all';
let _txPage         = 1;
const TX_PAGE_SIZE  = 25;
let _holdingsFilter = 'all';
let _holdingsSearch = '';
let _sortCol        = null;
let _sortDir        = 1;
let _chartCompare   = null;
let _chartBar       = null;

const PALETTE = [
  '#6366f1','#22d3ee','#f59e0b','#10b981','#f43f5e',
  '#8b5cf6','#ec4899','#14b8a6','#f97316','#84cc16',
  '#06b6d4','#a855f7','#ef4444','#3b82f6','#eab308',
  '#64748b','#0ea5e9','#d946ef','#4ade80','#fb923c',
];

// ── Theme ────────────────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('fintual-theme');
  const prefer = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(saved || prefer);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('fintual-theme', next);
  applyTheme(next);
}

// ── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initBlurButtons();

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentFilter = btn.dataset.filter;
      _txPage = 1;
      renderTransactions();
    });
  });

  checkHealth();
  loadAll();
});

// ── API helpers ──────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Health check ─────────────────────────────────────────────────────────────

async function checkHealth() {
  try {
    const h = await api('/api/health');
    setDot('db-status',    h.tables);
    setDot('email-status', h.email);
    document.getElementById('setup-banner').style.display = h.tables ? 'none' : 'block';
    setLastSyncLabel(h.last_sync);
  } catch {
    setDot('db-status',    false);
    setDot('email-status', false);
  }
}

function setLastSyncLabel(isoDate) {
  const el = document.getElementById('last-sync-label');
  if (!isoDate) { el.style.display = 'none'; return; }
  el.style.display = 'inline';
  el.textContent = 'Actualizado ' + new Date(isoDate).toLocaleString('es-CL', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

function setDot(id, ok) {
  const el = document.getElementById(id);
  el.classList.toggle('ok',  ok);
  el.classList.toggle('err', !ok);
}

// ── Load all data ────────────────────────────────────────────────────────────

async function loadAll() {
  showLoading(true);
  try {
    [_transactions, _portfolio, _prices] = await Promise.all([
      api('/api/transactions'),
      api('/api/portfolio'),
      api('/api/prices'),
    ]);
    console.log(`📊 Datos cargados: ${_transactions.length} txs, ${_portfolio.length} posiciones, ${Object.keys(_prices).length} precios en caché`);
    renderSummary();
    renderCharts();
    renderHoldings();
    renderTransactions();
  } catch (e) {
    toast('Error al cargar datos: ' + e.message, 'error');
  } finally {
    showLoading(false);
  }
}

// ── Refresh prices ────────────────────────────────────────────────────────────

async function refreshPrices() {
  const btn = document.getElementById('prices-btn');
  btn.disabled = true;
  btn.textContent = 'Actualizando…';
  try {
    const r = await api('/api/prices/refresh', { method: 'POST' });
    console.group('💰 Precios actualizados');
    Object.entries(r.prices).sort().forEach(([t, p]) =>
      console.log(`  ${t}: $${p.toFixed(2)}`)
    );
    console.log(`Total: ${r.updated} tickers`);
    console.groupEnd();
    toast(`Precios actualizados: ${r.updated} tickers`, 'success');
    _prices = r.prices;
    renderSummary();
    renderCharts();
    renderHoldings();
  } catch (e) {
    toast('Error al actualizar precios: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Actualizar precios';
  }
}

async function fullSync() {
  const btn = document.getElementById('fullsync-btn');
  btn.disabled = true;
  btn.textContent = 'Re-sincronizando…';
  try {
    const r = await api('/api/sync/full', { method: 'POST' });
    toast(`Re-sync OK — ${r.added} transacciones actualizadas`, 'success');
    await loadAll();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-sync completo';
  }
}

// ── Sync ─────────────────────────────────────────────────────────────────────

async function syncEmails() {
  const btn = document.getElementById('sync-btn');
  btn.disabled   = true;
  btn.textContent = 'Sincronizando…';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    const msg = `Sync OK — ${r.added} transacciones guardadas` +
      (r.skipped > 0 ? `, ${r.skipped} saltadas` : '') +
      (r.errors.length > 0 ? ` (${r.errors.length} errores)` : '');
    const incremental = r.was_incremental ? ' (incremental)' : ' (completo)';
    toast(msg + incremental, r.errors.length > 0 ? 'info' : 'success');
    setLastSyncLabel(r.last_sync);
    await loadAll();
  } catch (e) {
    toast('Error al sincronizar: ' + e.message, 'error');
  } finally {
    btn.disabled   = false;
    btn.textContent = 'Sincronizar correos';
  }
}

// ── Render summary cards ──────────────────────────────────────────────────────

function renderSummary() {
  let totalCost  = 0;
  let totalValue = 0;
  let hasPrice   = false;

  for (const h of _portfolio) {
    totalCost += h.total_cost || 0;
    const price = _prices[h.ticker];
    if (price && h.total_shares > 0) {
      totalValue += price * h.total_shares;
      hasPrice = true;
    } else {
      totalValue += (h.avg_cost || 0) * h.total_shares;
    }
  }

  const pnl    = totalValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  setText('total-invested', fmtUSD(totalCost));
  setText('total-value', fmtUSD(totalValue));

  const note = document.getElementById('total-value-note');
  note.textContent = hasPrice ? 'Con precios de mercado' : 'Sin precio de mercado';

  const pnlEl = document.getElementById('total-pnl');
  pnlEl.textContent = `${fmtUSD(pnl)}  (${fmtPct(pnlPct)})`;
  pnlEl.className   = 'card-value ' + (pnl >= 0 ? 'pos' : 'neg');

  // Realized P&L: for each sell, gain = sell_proceeds - avg_cost_at_time * shares
  const avgCosts = {}; // key -> { totalCost, totalShares }
  const sorted = [..._transactions].sort((a, b) => new Date(a.date) - new Date(b.date));
  let realizedPnl = 0;
  for (const t of sorted) {
    const key = t.ticker || t.company_name;
    if (!avgCosts[key]) avgCosts[key] = { totalCost: 0, totalShares: 0 };
    const entry = avgCosts[key];
    const shares = parseFloat(t.shares) || 0;
    if (t.type === 'buy') {
      const cost = parseFloat(t.total_cost || t.amount_usd) || 0;
      entry.totalCost   += cost;
      entry.totalShares += shares;
    } else {
      const avgCost    = entry.totalShares > 0 ? entry.totalCost / entry.totalShares : 0;
      const proceeds   = parseFloat(t.amount_usd) || 0;
      realizedPnl     += proceeds - avgCost * shares;
      entry.totalShares = Math.max(0, entry.totalShares - shares);
      entry.totalCost   = avgCost * entry.totalShares;
    }
  }

  const realEl = document.getElementById('realized-pnl');
  realEl.textContent = fmtUSD(realizedPnl);
  realEl.className   = 'card-value ' + (realizedPnl >= 0 ? 'pos' : 'neg');
}

// ── Render charts ─────────────────────────────────────────────────────────────

function cssVar(v) {
  return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
}

function renderCharts() {
  const muted = cssVar('--muted');
  const gridColor = cssVar('--border');

  const filtered = getFilteredRows();

  // ── Grouped bar: Capital Invertido vs Valor Actual ──
  const compareData = filtered
    .filter(r => r.curValue !== null)
    .map(r => ({ label: r.h.ticker || r.h.company_name, capital: r.capital, curValue: r.curValue }))
    .sort((a, b) => b.capital - a.capital);

  if (_chartCompare) _chartCompare.destroy();
  _chartCompare = new Chart(document.getElementById('chart-compare'), {
    type: 'bar',
    data: {
      labels: compareData.map(d => d.label),
      datasets: [
        {
          label: 'Capital Invertido',
          data: compareData.map(d => d.capital),
          backgroundColor: '#6366f1',
          borderRadius: 3,
        },
        {
          label: 'Valor Actual',
          data: compareData.map(d => d.curValue),
          backgroundColor: compareData.map(d => d.curValue >= d.capital ? '#10b981' : '#f43f5e'),
          borderRadius: 3,
        },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: muted, font: { size: 11 }, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtUSD(ctx.parsed.y)}` } }
      },
      scales: {
        x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: muted, font: { size: 10 }, callback: v => fmtUSD(v) }, grid: { color: gridColor } }
      }
    }
  });

  // ── Bar: P&L per position (only positions with prices) ──
  const barData = filtered
    .filter(r => r.diff !== null)
    .map(r => ({ label: r.h.ticker || r.h.company_name, diff: r.diff }))
    .sort((a, b) => b.diff - a.diff);

  if (_chartBar) _chartBar.destroy();
  _chartBar = new Chart(document.getElementById('chart-bar'), {
    type: 'bar',
    data: {
      labels: barData.map(d => d.label),
      datasets: [{
        data: barData.map(d => d.diff),
        backgroundColor: barData.map(d => d.diff >= 0 ? '#10b981' : '#f43f5e'),
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${fmtUSD(ctx.parsed.y)}` } }
      },
      scales: {
        x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: muted, font: { size: 10 }, callback: v => fmtUSD(v) }, grid: { color: gridColor } }
      }
    }
  });
}

// ── Shared filter ─────────────────────────────────────────────────────────────

function getFilteredRows() {
  let rows = _portfolio.map(h => {
    const price    = _prices[h.ticker] ?? null;
    const capital  = h.total_cost;
    const curValue = price !== null ? price * h.total_shares : null;
    const diff     = curValue !== null ? curValue - capital : null;
    const pnlPct   = diff !== null && capital > 0 ? (diff / capital) * 100 : null;
    return { h, price, capital, curValue, diff, pnlPct };
  });

  if (_holdingsSearch) {
    const q = _holdingsSearch.toLowerCase();
    rows = rows.filter(({ h }) =>
      (h.company_name || '').toLowerCase().includes(q) ||
      (h.ticker || '').toLowerCase().includes(q)
    );
  }

  if (_holdingsFilter === 'winners') rows = rows.filter(r => r.diff !== null && r.diff > 0);
  if (_holdingsFilter === 'losers')  rows = rows.filter(r => r.diff !== null && r.diff < 0);

  return rows;
}

// ── Render holdings ───────────────────────────────────────────────────────────

function renderHoldings() {
  const tbody = document.getElementById('holdings-body');
  const count = document.getElementById('holdings-count');

  let rows = getFilteredRows();

  // Sort
  if (_sortCol) {
    rows.sort((a, b) => {
      let va, vb;
      switch (_sortCol) {
        case 'company_name': va = a.h.company_name || ''; vb = b.h.company_name || ''; break;
        case 'ticker':       va = a.h.ticker || '';       vb = b.h.ticker || '';       break;
        case 'total_shares': va = a.h.total_shares;       vb = b.h.total_shares;       break;
        case 'avg_cost':     va = a.h.avg_cost;           vb = b.h.avg_cost;           break;
        case 'capital':      va = a.capital;              vb = b.capital;              break;
        case 'price':        va = a.price    ?? -Infinity; vb = b.price    ?? -Infinity; break;
        case 'curValue':     va = a.curValue ?? -Infinity; vb = b.curValue ?? -Infinity; break;
        case 'diff':         va = a.diff     ?? -Infinity; vb = b.diff     ?? -Infinity; break;
        case 'pnlPct':       va = a.pnlPct   ?? -Infinity; vb = b.pnlPct   ?? -Infinity; break;
        default: return 0;
      }
      if (typeof va === 'string') return _sortDir * va.localeCompare(vb);
      return _sortDir * (va - vb);
    });
  }

  count.textContent = rows.length + ' posiciones';

  if (rows.length === 0) {
    const msg = _portfolio.length === 0
      ? 'No hay posiciones abiertas. Sincroniza tus correos primero.'
      : 'Sin resultados para el filtro aplicado.';
    tbody.innerHTML = `<tr><td colspan="9" class="empty">${msg}</td></tr>`;
    updateSortIndicators();
    return;
  }

  tbody.innerHTML = rows.map(({ h, price, capital, curValue, diff, pnlPct }) => {
    const cls = diff === null ? '' : diff >= 0 ? 'pos' : 'neg';
    return `<tr>
      <td>${esc(h.company_name)}</td>
      <td>${tickerCell(h.company_name, h.ticker)}</td>
      <td class="r">${parseFloat(h.total_shares).toFixed(2)}</td>
      <td class="r">${fmtUSD(h.avg_cost)}</td>
      <td class="r">${fmtUSD(capital)}</td>
      <td class="r">${price !== null ? fmtUSD(price) : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="r">${curValue !== null ? fmtUSD(curValue) : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="r ${cls}">${diff !== null ? fmtUSD(diff) : '—'}</td>
      <td class="r ${cls}">${pnlPct !== null ? fmtPct(pnlPct) : '—'}</td>
    </tr>`;
  }).join('');

  updateSortIndicators();
}

function setSortCol(col) {
  if (_sortCol === col) _sortDir *= -1;
  else { _sortCol = col; _sortDir = 1; }
  renderHoldings();
}

function setHoldingsFilter(f) {
  _holdingsFilter = f;
  document.querySelectorAll('[data-hfilter]').forEach(b =>
    b.classList.toggle('active', b.dataset.hfilter === f)
  );
  renderCharts();
  renderHoldings();
}

function onHoldingsSearch() {
  _holdingsSearch = document.getElementById('holdings-search').value;
  renderCharts();
  renderHoldings();
}

function updateSortIndicators() {
  document.querySelectorAll('th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (!icon) return;
    icon.textContent = th.dataset.col === _sortCol ? (_sortDir === 1 ? '↑' : '↓') : '';
  });
}

function tickerCell(company, ticker) {
  if (ticker) {
    return `<span class="ticker-chip">${esc(ticker)}</span>`;
  }
  const safeCompany = esc(company).replace(/'/g, "\\'");
  return `<button class="ticker-add" onclick="promptTicker('${safeCompany}')">+ ticker</button>`;
}

// ── Render transactions ───────────────────────────────────────────────────────

function renderTransactions() {
  const tbody    = document.getElementById('tx-body');
  const filtered = _currentFilter === 'all'
    ? _transactions
    : _transactions.filter(t => t.type === _currentFilter);

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Sin transacciones</td></tr>';
    renderTxPaginator(0, 0);
    return;
  }

  const totalPages = Math.ceil(filtered.length / TX_PAGE_SIZE);
  _txPage = Math.min(_txPage, totalPages);
  const page = filtered.slice((_txPage - 1) * TX_PAGE_SIZE, _txPage * TX_PAGE_SIZE);

  tbody.innerHTML = page.map(t => {
    const isBuy = t.type === 'buy';
    return `<tr>
      <td>${fmtDate(t.date)}</td>
      <td><span class="badge ${isBuy ? 'buy' : 'sell'}">${isBuy ? 'Compra' : 'Venta'}</span></td>
      <td>${esc(t.company_name)}</td>
      <td>${t.ticker ? `<span class="ticker-chip">${esc(t.ticker)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="r">${fmtShares(t.shares)}</td>
      <td class="r">${t.price_per_share ? fmtUSD(t.price_per_share) : '—'}</td>
      <td class="r">${fmtUSD(t.amount_usd)}</td>
    </tr>`;
  }).join('');

  renderTxPaginator(totalPages, filtered.length);
}

function renderTxPaginator(totalPages, total) {
  const el = document.getElementById('tx-paginator');
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const prev = `<button class="page-btn" onclick="txGoTo(${_txPage - 1})" ${_txPage === 1 ? 'disabled' : ''}>‹</button>`;
  const next = `<button class="page-btn" onclick="txGoTo(${_txPage + 1})" ${_txPage === totalPages ? 'disabled' : ''}>›</button>`;

  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - _txPage) <= 1) {
      pages.push(`<button class="page-btn ${i === _txPage ? 'active' : ''}" onclick="txGoTo(${i})">${i}</button>`);
    } else if (pages[pages.length - 1] !== '<span class="page-ellipsis">…</span>') {
      pages.push('<span class="page-ellipsis">…</span>');
    }
  }

  el.innerHTML = `<span class="page-info">${total} transacciones</span>${prev}${pages.join('')}${next}`;
}

function txGoTo(page) {
  _txPage = page;
  renderTransactions();
}

// ── Ticker editor ─────────────────────────────────────────────────────────────

async function promptTicker(company) {
  const ticker = prompt(`Ingresa el ticker para:\n"${company}"\n\nEj: AAPL, SOUN, MCHP`);
  if (!ticker || !ticker.trim()) return;
  try {
    await api(`/api/ticker/${encodeURIComponent(company)}`, {
      method: 'PUT',
      body: JSON.stringify({ ticker: ticker.trim().toUpperCase() }),
    });
    toast(`Ticker actualizado: ${ticker.toUpperCase()}`, 'success');
    await loadAll();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

// ── Card blur toggle ──────────────────────────────────────────────────────────

const EYE_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function initBlurButtons() {
  document.querySelectorAll('.blur-btn').forEach(btn => {
    const isBlurred = btn.closest('.card').querySelector('.card-body').classList.contains('blurred');
    btn.innerHTML = isBlurred ? EYE_OFF : EYE_OPEN;
    btn.title     = isBlurred ? 'Mostrar' : 'Ocultar';
  });
}

function toggleBlur(btn) {
  const body      = btn.closest('.card').querySelector('.card-body');
  const isBlurred = body.classList.toggle('blurred');
  btn.innerHTML   = isBlurred ? EYE_OFF : EYE_OPEN;
  btn.title       = isBlurred ? 'Mostrar' : 'Ocultar';
}

// ── Tab navigation ────────────────────────────────────────────────────────────

const _TABS = ['portfolio', 'futuro', 'oportunidades'];

function switchTab(tab) {
  _TABS.forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  if (tab === 'futuro') {
    _loadCachedMlResults();
    _loadWatchlistCached();
  }
  if (tab === 'oportunidades') {
    _initScreener();
  }
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

async function addToWatchlist() {
  const input  = document.getElementById('wl-add-input');
  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return;
  input.disabled = true;
  try {
    const r = await api(`/api/watchlist/${encodeURIComponent(ticker)}`, { method: 'POST' });
    toast(`${r.company_name} (${r.ticker}) agregado a la watchlist`, 'success');
    input.value = '';
    await loadWatchlistPrices();
  } catch (e) {
    toast('Error al agregar: ' + e.message, 'error');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function removeFromWatchlist(ticker) {
  try {
    await api(`/api/watchlist/${encodeURIComponent(ticker)}`, { method: 'DELETE' });
    _watchlistData = _watchlistData.filter(r => r.ticker !== ticker);
    renderWatchlistTable();
    toast(`${ticker} eliminado`, 'info');
  } catch (e) {
    toast('Error al eliminar: ' + e.message, 'error');
  }
}

function toggleWlView() {
  _wlQualView = !_wlQualView;
  const btn = document.getElementById('wl-view-btn');
  btn.textContent = _wlQualView ? 'Cualitativo' : 'Cuantitativo';
  document.querySelectorAll('.col-quant').forEach(el =>
    el.style.display = _wlQualView ? 'none' : ''
  );
  document.querySelectorAll('.col-qual').forEach(el =>
    el.style.display = _wlQualView ? '' : 'none'
  );
  // Lazy-load qualitative data (sector, recommendation, etc.) on first toggle
  if (_wlQualView && !_wlQualLoaded && _watchlistData.length > 0) {
    _loadWatchlistQual();
    return;
  }
  renderWatchlistTable();
}

async function _loadWatchlistQual() {
  const btn = document.getElementById('wl-view-btn');
  btn.disabled = true;
  try {
    const qualMap = await api(`/api/watchlist/qual?view=${_watchlistView}`);
    _watchlistData = _watchlistData.map(r => {
      const q = qualMap[r.ticker];
      return q ? { ...r, ...q } : r;
    });
    _wlQualLoaded = true;
  } catch (e) {
    toast('Error al cargar datos cualitativos: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
  renderWatchlistTable();
}

function setWatchlistView(view) {
  _watchlistView = view;
  _watchlistData = [];
  _wlSortCol     = null;
  _wlQualLoaded  = false;
  document.querySelectorAll('[data-wview]').forEach(b =>
    b.classList.toggle('active', b.dataset.wview === view)
  );
  _loadWatchlistCached();
}

async function _loadWatchlistCached() {
  if (_watchlistData.length > 0) return;
  const tbody = document.getElementById('watchlist-body');
  tbody.innerHTML = '<tr><td colspan="13" class="empty">Cargando desde base de datos…</td></tr>';
  try {
    const data = await api(`/api/watchlist/cached?view=${_watchlistView}&qual=false`);
    const dateEl = document.getElementById('wl-date');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="empty">Sin datos — presiona "Actualizar datos" para descargar</td></tr>';
      dateEl.style.display = 'none';
      return;
    }
    const maxDate = data.reduce((mx, r) => r.date > mx ? r.date : mx, '');
    if (maxDate) {
      dateEl.textContent   = fmtDate(maxDate);
      dateEl.style.display = 'inline';
    }
    _watchlistData = data;
    renderWatchlistTable();
    _loadLivePrices();
  } catch (e) {
    const tbody = document.getElementById('watchlist-body');
    tbody.innerHTML = '<tr><td colspan="13" class="empty">Presiona "Actualizar datos" para cargar</td></tr>';
  }
}

async function _loadLivePrices() {
  try {
    const live = await api(`/api/watchlist/live?view=${_watchlistView}`);
    if (!live || Object.keys(live).length === 0) return;
    _watchlistData = _watchlistData.map(r =>
      live[r.ticker] !== undefined ? { ...r, price: live[r.ticker] } : r
    );
    renderWatchlistTable();
  } catch (_) {
    // live prices are best-effort — cached price remains visible
  }
}

async function loadWatchlistPrices() {
  const maxDate = _watchlistData.length > 0
    ? _watchlistData.reduce((mx, r) => r.date > mx ? r.date : mx, '')
    : '';
  const lastDate = maxDate
    ? `La última actualización fue el ${fmtDate(maxDate)}.`
    : 'No hay datos previos.';
  const confirmed = confirm(`¿Actualizar datos de precios desde Yahoo Finance?\n${lastDate}\n\nEsto puede tardar unos segundos.`);
  if (!confirmed) return;

  const btn = document.getElementById('wl-refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Cargando…';
  const tbody = document.getElementById('watchlist-body');
  tbody.innerHTML = '<tr><td colspan="13" class="empty">Obteniendo datos de mercado…</td></tr>';
  try {
    const data = await api(`/api/watchlist/prices?view=${_watchlistView}`);
    const dateEl = document.getElementById('wl-date');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="empty">Sin datos</td></tr>';
      dateEl.style.display = 'none';
      return;
    }
    const maxDate = data.reduce((mx, r) => r.date > mx ? r.date : mx, '');
    if (maxDate) {
      dateEl.textContent   = fmtDate(maxDate);
      dateEl.style.display = 'inline';
    }
    _watchlistData = data;
    _wlQualLoaded  = true;   // full refresh includes qualitative data
    renderWatchlistTable();
    _loadLivePrices();
  } catch (e) {
    toast('Error al cargar watchlist: ' + e.message, 'error');
    tbody.innerHTML = '<tr><td colspan="14" class="empty">Error al cargar datos</td></tr>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Actualizar datos';
  }
}

function setWlSort(col) {
  if (_wlSortCol === col) _wlSortDir *= -1;
  else { _wlSortCol = col; _wlSortDir = 1; }
  renderWatchlistTable();
}

function toggleWlDivFilter() {
  _wlDivFilter = !_wlDivFilter;
  const btn = document.getElementById('wl-div-btn');
  if (btn) btn.classList.toggle('active', _wlDivFilter);
  renderWatchlistTable();
}

function renderWatchlistTable() {
  const tbody     = document.getElementById('watchlist-body');
  const removable = _watchlistView === 'watchlist';

  let rows = _wlDivFilter ? _watchlistData.filter(r => r.has_dividend) : [..._watchlistData];

  if (_wlSortCol) {
    rows.sort((a, b) => {
      let va, vb;
      switch (_wlSortCol) {
        case 'company_name':   va = a.company_name   || ''; vb = b.company_name   || ''; break;
        case 'ticker':         va = a.ticker          || ''; vb = b.ticker          || ''; break;
        case 'recommendation': va = a.recommendation  || ''; vb = b.recommendation  || ''; break;
        case 'price':    va = a.price    ?? -Infinity; vb = b.price    ?? -Infinity; break;
        case 'close_1d': va = a.close_1d ?? -Infinity; vb = b.close_1d ?? -Infinity; break;
        case 'close_2d': va = a.close_2d ?? -Infinity; vb = b.close_2d ?? -Infinity; break;
        case 'close_3d': va = a.close_3d ?? -Infinity; vb = b.close_3d ?? -Infinity; break;
        case 'close_4d': va = a.close_4d ?? -Infinity; vb = b.close_4d ?? -Infinity; break;
        case 'close_5d': va = a.close_5d ?? -Infinity; vb = b.close_5d ?? -Infinity; break;
        case 'min_30d':  va = a.min_30d  ?? -Infinity; vb = b.min_30d  ?? -Infinity; break;
        case 'min_60d':  va = a.min_60d  ?? -Infinity; vb = b.min_60d  ?? -Infinity; break;
        case 'min_90d':  va = a.min_90d  ?? -Infinity; vb = b.min_90d  ?? -Infinity; break;
        default: return 0;
      }
      if (typeof va === 'string') return _wlSortDir * va.localeCompare(vb);
      return _wlSortDir * (va - vb);
    });
  }

  tbody.innerHTML = rows.map(r => {
    const p        = r.price;
    const recClass = recCls(r.recommendation);
    const arrow    = priceArrow(r);
    return `<tr>
      <td>${removable ? `<button class="wl-remove" onclick="removeFromWatchlist('${esc(r.ticker)}')" title="Eliminar">×</button>` : ''}</td>
      <td>${esc(r.company_name)}</td>
      <td><span class="ticker-chip">${esc(r.ticker)}</span></td>
      <td class="col-quant r" ${_wlQualView ? 'style="display:none"' : ''}><strong>${fmtUSD(p)}</strong> ${arrow}</td>
      <td class="col-quant r" ${_wlQualView ? 'style="display:none"' : ''}>${fmtHistPrice(r.close_1d, p)}</td>
      <td class="col-quant r" ${_wlQualView ? 'style="display:none"' : ''}>${fmtHistPrice(r.close_2d, p)}</td>
      <td class="col-quant r" ${_wlQualView ? 'style="display:none"' : ''}>${fmtHistPrice(r.close_3d, p)}</td>
      <td class="col-quant r" ${_wlQualView ? 'style="display:none"' : ''}>${fmtHistPrice(r.close_4d, p)}</td>
      <td class="col-quant r" ${_wlQualView ? 'style="display:none"' : ''}>${fmtHistPrice(r.close_5d, p)}</td>
      <td class="col-quant r" ${_wlQualView ? 'style="display:none"' : ''}>${fmtHistPrice(r.min_30d, p)}</td>
      <td class="col-quant r" ${_wlQualView ? 'style="display:none"' : ''}>${fmtHistPrice(r.min_60d, p)}</td>
      <td class="col-quant r" ${_wlQualView ? 'style="display:none"' : ''}>${fmtHistPrice(r.min_90d, p)}</td>
      <td><span class="${recClass}">${esc(r.recommendation)}</span></td>
      <td class="col-qual" ${!_wlQualView ? 'style="display:none"' : ''}>${esc(r.sector)}</td>
      <td class="col-qual" ${!_wlQualView ? 'style="display:none"' : ''}>${esc(r.industry)}</td>
      <td class="col-qual" ${!_wlQualView ? 'style="display:none"' : ''}>${esc(r.country)}</td>
      <td class="col-qual r" ${!_wlQualView ? 'style="display:none"' : ''}>${r.market_cap ? fmtMarketCap(r.market_cap) : '—'}</td>
      <td class="col-qual r" ${!_wlQualView ? 'style="display:none"' : ''}>${r.div_yield != null ? (r.div_yield * 100).toFixed(2) + '%' : '—'}</td>
    </tr>`;
  }).join('');

  // Update sort indicators
  document.querySelectorAll('#tab-futuro th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = th.dataset.col === _wlSortCol ? (_wlSortDir === 1 ? '↑' : '↓') : '';
  });
}

const ARROW_UP   = `<span class="price-arrow up" title="Precio subiendo">↑</span>`;
const ARROW_DOWN = `<span class="price-arrow down" title="Precio bajando">↓</span>`;

function priceArrow(r) {
  const closes = [r.close_1d, r.close_2d, r.close_3d, r.close_4d, r.close_5d].filter(v => v != null);
  if (!closes.length || !r.price) return '';
  const rising  = closes.filter(v => v < r.price).length;
  const falling = closes.filter(v => v > r.price).length;
  if (rising > falling)  return ARROW_UP;
  if (falling > rising)  return ARROW_DOWN;
  return '';
}

function recCls(rec) {
  if (!rec) return '';
  const r = rec.toLowerCase();
  if (r.includes('fuerte') && r.includes('compra')) return 'rec-strong-buy';
  if (r.includes('compra')) return 'rec-buy';
  if (r.includes('mantener')) return 'rec-hold';
  if (r.includes('vend')) return 'rec-sell';
  return '';
}

function fmtHistPrice(value, currentPrice) {
  if (value === null || value === undefined) return '—';
  const formatted = fmtUSD(value);
  if (!currentPrice) return formatted;
  const diff = (value - currentPrice) / currentPrice;

  const pct    = parseFloat(((currentPrice - value) / value * 100).toFixed(2));
  const why    = [{ label: 'Variación desde este cierre', value: pct }];
  const enc    = encodeURIComponent(JSON.stringify(why));
  const icon   = `<span class="close-pct-icon"
    onmouseenter="mlShowTooltip(event,JSON.parse(decodeURIComponent('${enc}')))"
    onmouseleave="mlHideTooltip()">i</span>`;

  if (diff < -0.5) return `<span class="price-down-far">${formatted}</span>${icon}`;
  if (diff < 0)    return `<span class="price-down">${formatted}</span>${icon}`;
  if (diff > 0.5)  return `<span class="price-up-far">${formatted}</span>${icon}`;
  if (diff > 0)    return `<span class="price-up">${formatted}</span>${icon}`;
  return `<span class="price-at-min">${formatted}</span>${icon}`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const fmtMarketCap = n => {
  if (n == null) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n}`;
};

const fmtUSD = n =>
  n == null ? '—' :
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);

const fmtPct = n =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

const fmtShares = n =>
  n == null ? '—' : parseFloat(n).toFixed(6).replace(/\.?0+$/, '');

const fmtDate = d =>
  new Date(d).toLocaleDateString('es-CL', { year: 'numeric', month: 'short', day: 'numeric' });

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setText(id, val) {
  document.getElementById(id).textContent = val;
}

function showLoading(v) {
  document.getElementById('loading').style.display = v ? 'block' : 'none';
}

let _toastTimer = null;

function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent  = msg;
  el.className    = `toast ${type}`;
  el.style.display = 'block';
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ── ML: Tooltip global ───────────────────────────────────────────────────────

const _mlTooltip = () => document.getElementById('ml-tooltip');

const _FACTOR_DESC = {
  'Dist. mínimo 30d':       '% por encima del mínimo de 30 días. Bajo = precio cerca del suelo reciente.',
  'Dist. mínimo 60d':       '% por encima del mínimo de 60 días. Bajo = posible zona de acumulación.',
  'Dist. mínimo 90d':       '% por encima del mínimo de 90 días. Bajo = cerca de soporte trimestral.',
  'Momentum 5d':            'Cambio de precio en los últimos 5 días hábiles. Positivo = impulso alcista reciente.',
  'Recomendación analistas':'Consenso de analistas según Yahoo Finance.',
};

function mlShowTooltip(event, why, probs) {
  const el = _mlTooltip();
  if (!el) return;
  let html = '<div class="ml-tt-title">Factores del modelo</div>';
  (why || []).forEach(w => {
    const val = typeof w.value === 'number'
      ? `<span class="ml-tt-val">${w.value > 0 ? '+' : ''}${w.value}%</span>`
      : `<span class="ml-tt-val">${esc(String(w.value))}</span>`;
    const desc = _FACTOR_DESC[w.label] || '';
    html += `<div class="ml-tt-row">
      <span class="ml-tt-label-wrap">
        <span class="ml-tt-label">${esc(w.label)}</span>
        ${desc ? `<span class="ml-tt-desc">${esc(desc)}</span>` : ''}
      </span>${val}</div>`;
  });
  if (probs) {
    html += '<div class="ml-tt-sep"></div><div class="ml-tt-title">Probabilidades</div>';
    Object.entries(probs).forEach(([label, pct]) => {
      html += `<div class="ml-tt-row"><span class="ml-tt-label">${esc(label)}</span><span class="ml-tt-val">${pct}%</span></div>`;
    });
  }
  el.innerHTML = html;
  el.style.display = 'block';
  mlPositionTooltip(event);
}

function mlShowMetrics(event, metrics) {
  const el = _mlTooltip();
  if (!el || !metrics) return;
  const pct = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const num = v => v != null ? v.toLocaleString() : '—';
  let html = '<div class="ml-tt-title">Métricas del modelo (CV 3-fold)</div>';
  html += `<div class="ml-tt-row"><span class="ml-tt-label">Accuracy</span><span class="ml-tt-val">${pct(metrics.accuracy_cv)} ± ${pct(metrics.accuracy_cv_std)}</span></div>`;
  html += `<div class="ml-tt-row"><span class="ml-tt-label">Precisión (positiva)</span><span class="ml-tt-val">${pct(metrics.precision_buy)}</span></div>`;
  html += `<div class="ml-tt-row"><span class="ml-tt-label">Recall (positiva)</span><span class="ml-tt-val">${pct(metrics.recall_buy)}</span></div>`;
  html += `<div class="ml-tt-row"><span class="ml-tt-label">F1 (positiva)</span><span class="ml-tt-val">${pct(metrics.f1_buy)}</span></div>`;
  html += '<div class="ml-tt-sep"></div>';
  html += `<div class="ml-tt-row"><span class="ml-tt-label">Muestras entrenamiento</span><span class="ml-tt-val">${num(metrics.n_train)}</span></div>`;
  html += `<div class="ml-tt-row"><span class="ml-tt-label">% días positivos</span><span class="ml-tt-val">${pct(metrics.pct_positive)}</span></div>`;
  el.innerHTML = html;
  el.style.display = 'block';
  mlPositionTooltip(event);
}

function mlPositionTooltip(event) {
  const el = _mlTooltip();
  if (!el || el.style.display === 'none') return;
  const x = event.clientX + 14;
  const y = event.clientY - 10;
  const rect = el.getBoundingClientRect();
  el.style.left = (x + rect.width  > window.innerWidth  ? event.clientX - rect.width  - 14 : x) + 'px';
  el.style.top  = (y + rect.height > window.innerHeight ? event.clientY - rect.height      : y) + 'px';
}

function mlHideTooltip() {
  const el = _mlTooltip();
  if (el) el.style.display = 'none';
}

document.addEventListener('mousemove', e => {
  if (e.target.closest('.ml-info') || e.target.closest('.ml-metrics-icon')) mlPositionTooltip(e);
});

// ── ML: helpers ──────────────────────────────────────────────────────────────

function _fmtRunAt(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)   return 'hace un momento';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  const days = Math.floor(diff / 86400);
  if (days === 0)  return `hace ${Math.floor(diff / 3600)}h`;
  if (days === 1)  return 'hace 1 día';
  return `hace ${days} días`;
}

function _setMlHeader(cardId, runAt, metrics) {
  const badge = document.getElementById(`${cardId}-badge`);
  const mIcon = document.getElementById(`${cardId}-metrics`);
  if (badge) badge.textContent = runAt ? _fmtRunAt(runAt) : '';
  if (mIcon && metrics) {
    mIcon.style.display = 'inline-flex';
    mIcon.onmouseenter = e => mlShowMetrics(e, metrics);
    mIcon.onmouseleave = mlHideTooltip;
  }
}

function _applyMlResponse(model, data) {
  if (model === 'entry_score') {
    _entryScores = data.results || [];
    _setMlHeader('entry-score', data.run_at, data.metrics);
    renderEntryScoreCard();
  } else {
    _signals = data.results || [];
    _setMlHeader('signal', data.run_at, data.metrics);
    renderSignalTable();
  }
}

async function _loadCachedMlResults() {
  try {
    const [es, sig] = await Promise.all([
      fetch('/api/ml/entry-score').then(r => r.ok ? r.json() : null),
      fetch('/api/ml/signal').then(r => r.ok ? r.json() : null),
    ]);
    if (es  && es.results?.length)  _applyMlResponse('entry_score', es);
    if (sig && sig.results?.length) _applyMlResponse('signal', sig);
  } catch (_) { /* silent — user can recalculate */ }
}

// ── ML: Modelo 1 – Entry Point Score ─────────────────────────────────────────

async function runEntryScore() {
  const btn     = document.getElementById('entry-score-btn');
  const content = document.getElementById('entry-score-content');
  btn.disabled  = true;
  btn.textContent = 'Entrenando…';
  content.className = 'ml-loading';
  content.innerHTML = '⏳ Descargando datos históricos y entrenando modelo… puede tardar ~45 segundos.';
  try {
    const res = await fetch(`/api/ml/entry-score?view=${_watchlistView}`, { method: 'POST' });
    if (!res.ok) { const d = await res.json(); throw new Error(d.detail || res.statusText); }
    _applyMlResponse('entry_score', await res.json());
  } catch (e) {
    content.className = 'ml-error';
    content.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Recalcular';
  }
}

function renderEntryScoreCard() {
  const content = document.getElementById('entry-score-content');
  if (!_entryScores.length) {
    content.className = 'ml-placeholder';
    content.textContent = 'Sin resultados';
    return;
  }
  content.className = '';

  const rows = _entryScores.map(r => {
    const s     = r.score ?? 0;
    const color = s >= 65 ? 'var(--green)' : s >= 40 ? '#e3b341' : 'var(--red)';
    const bg    = s >= 65 ? 'rgba(63,185,80,0.12)' : s >= 40 ? 'rgba(227,179,65,0.12)' : 'rgba(248,81,73,0.12)';
    const why   = r.why || [];
    const whyEnc = encodeURIComponent(JSON.stringify(why));
    return `<div class="score-row">
      <span class="score-label">${esc(r.ticker)}</span>
      <div class="score-track">
        <div class="score-fill" style="width:${s}%;background:${color};box-shadow:0 0 6px ${color}44"></div>
        <div class="score-fill-bg" style="background:${bg}"></div>
      </div>
      <span class="score-num" style="color:${color}">${s}</span>
      <span class="ml-info"
        onmouseenter="mlShowTooltip(event,JSON.parse(decodeURIComponent('${whyEnc}')))"
        onmouseleave="mlHideTooltip()">ℹ</span>
    </div>`;
  }).join('');

  content.innerHTML = `<div class="score-list">${rows}</div>
    <div class="ml-legend">
      <span class="ml-legend-dot" style="background:var(--green)"></span>≥65 Buen punto
      <span class="ml-legend-dot" style="background:#e3b341"></span>40–64 Neutral
      <span class="ml-legend-dot" style="background:var(--red)"></span>&lt;40 Evitar
    </div>`;
}

// ── ML: Modelo 2 – Señal de Posición ─────────────────────────────────────────

async function runSignal() {
  const btn     = document.getElementById('signal-btn');
  const content = document.getElementById('signal-content');
  btn.disabled  = true;
  btn.textContent = 'Entrenando…';
  content.className = 'ml-loading';
  content.innerHTML = '⏳ Descargando datos históricos y entrenando modelo… puede tardar ~45 segundos.';
  try {
    const res = await fetch(`/api/ml/signal?view=${_watchlistView}`, { method: 'POST' });
    if (!res.ok) { const d = await res.json(); throw new Error(d.detail || res.statusText); }
    _applyMlResponse('signal', await res.json());
  } catch (e) {
    content.className = 'ml-error';
    content.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Recalcular';
  }
}

function renderSignalTable() {
  const content = document.getElementById('signal-content');
  if (!_signals.length) {
    content.className = 'ml-placeholder';
    content.textContent = 'Sin resultados';
    return;
  }
  content.className = '';

  const sigClass = key => key === 'buy' ? 'rec-strong-buy' : key === 'sell' ? 'rec-strong-sell' : 'rec-hold';

  const rows = _signals.map(r => {
    const why   = r.why   || [];
    const probs = r.probs || null;
    const whyEnc   = encodeURIComponent(JSON.stringify(why));
    const probsEnc = encodeURIComponent(JSON.stringify(probs));
    const confColor = (r.confidence||0) >= 60 ? 'var(--green)' : (r.confidence||0) >= 45 ? '#e3b341' : 'var(--red)';
    return `<tr>
      <td><span class="ticker-chip">${esc(r.ticker)}</span></td>
      <td><span class="${sigClass(r.signal_key)}">${esc(r.signal)}</span></td>
      <td class="r" style="color:${confColor};font-weight:600">${r.confidence ?? '—'}%</td>
      <td class="r">
        <span class="ml-info"
          onmouseenter="mlShowTooltip(event,JSON.parse(decodeURIComponent('${whyEnc}')),JSON.parse(decodeURIComponent('${probsEnc}')))"
          onmouseleave="mlHideTooltip()">ℹ</span>
      </td>
    </tr>`;
  }).join('');

  content.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>Ticker</th><th>Señal</th>
      <th class="r">Confianza</th><th class="r"></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

// ── Screener de Oportunidades ─────────────────────────────────────────────────

let _scData          = [];
let _scSortCol       = 'dist_90d_low';
let _scSortDir       = 1;
let _scSectorsLoaded = false;

// S&P 500 GICS sectors — hardcoded so the tab loads instantly
// Values are the official GICS names (used by Wikipedia S&P 500 list and the API).
// Labels are the yfinance/Morningstar names the user sees in the Cualitativo view.
const _SP500_SECTORS = [
  'Communication Services', 'Consumer Discretionary', 'Consumer Staples',
  'Energy', 'Financials', 'Health Care', 'Industrials',
  'Information Technology', 'Materials', 'Real Estate', 'Utilities',
];
const _SECTOR_LABELS = {
  'Information Technology': 'Technology',
  'Consumer Discretionary': 'Consumer Cyclical',
  'Consumer Staples':       'Consumer Defensive',
  'Health Care':            'Healthcare',
  'Financials':             'Financial Services',
  'Materials':              'Basic Materials',
};

async function _initScreener() {
  if (!_scSectorsLoaded) {
    _buildSectorDropdown();
  }
  // Load cached result for currently selected sector (if any)
  const sector = document.getElementById('sc-sector').value;
  if (sector) _loadScreenerCached(sector);
}

function _buildSectorDropdown() {
  const sel = document.getElementById('sc-sector');
  sel.innerHTML = '<option value="">Seleccionar sector…</option>';
  _SP500_SECTORS.forEach(s => {
    const opt = document.createElement('option');
    opt.value       = s;                          // GICS name sent to API
    opt.textContent = _SECTOR_LABELS[s] || s;     // user-friendly display name
    sel.appendChild(opt);
  });
  sel.onchange = () => {
    const s = sel.value;
    document.getElementById('sc-run-btn').disabled = !s;
    if (s) _loadScreenerCached(s);
  };
  _scSectorsLoaded = true;

  // Pre-select first sector that has cached results in Supabase
  api('/api/screener/cached-sectors').then(cached => {
    if (!cached.length) return;
    const first = _SP500_SECTORS.find(s => cached.includes(s));
    if (first) {
      sel.value = first;
      document.getElementById('sc-run-btn').disabled = false;
      _loadScreenerCached(first);
    }
  }).catch(() => {});
}

async function _loadScreenerCached(sector) {
  try {
    const data = await api(`/api/screener/results?sector=${encodeURIComponent(sector)}`);
    if (data.results && data.results.length > 0) {
      _scData = data.results;
      _setScMeta(data.run_at, data.results.length);
      renderScreenerTable();
    } else {
      _scData = [];
      document.getElementById('sc-meta').style.display = 'none';
      document.getElementById('sc-body').innerHTML =
        '<tr><td colspan="10" class="empty">Sin resultados guardados — presiona "Buscar oportunidades"</td></tr>';
    }
  } catch (e) {
    console.error('screener cached:', e);
  }
}

async function runScreener() {
  const sector = document.getElementById('sc-sector').value;
  if (!sector) return;

  const btn     = document.getElementById('sc-run-btn');
  const loadBar = document.getElementById('sc-loading');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  loadBar.style.display = 'block';
  document.getElementById('sc-meta').style.display = 'none';

  // Animated dots message
  const tbody = document.getElementById('sc-body');
  let dots = 0;
  const timer = setInterval(() => {
    dots = (dots + 1) % 4;
    tbody.innerHTML = `<tr><td colspan="10" class="empty sc-loading-msg">
      Descargando precios de ${esc(sector)}${'·'.repeat(dots || 1)}
      <span class="sc-loading-hint">puede tardar 30–60s la primera vez</span>
    </td></tr>`;
  }, 500);

  try {
    const data = await api(`/api/screener/run?sector=${encodeURIComponent(sector)}`, { method: 'POST' });
    _scData = data.results || [];
    _setScMeta(data.run_at, _scData.length);
    renderScreenerTable();
    if (_scData.length === 0) {
      toast(`Sin oportunidades en ${sector} con los criterios actuales`, 'info');
    } else {
      toast(`${_scData.length} oportunidad${_scData.length > 1 ? 'es' : ''} encontrada${_scData.length > 1 ? 's' : ''} en ${sector}`, 'success');
    }
  } catch (e) {
    toast('Error al ejecutar screener: ' + e.message, 'error');
    tbody.innerHTML = '<tr><td colspan="10" class="empty">Error al buscar — intenta nuevamente</td></tr>';
  } finally {
    clearInterval(timer);
    btn.disabled = false;
    btn.textContent = 'Buscar oportunidades';
    loadBar.style.display = 'none';
  }
}

function _setScMeta(runAt, count) {
  const meta    = document.getElementById('sc-meta');
  const lastRun = document.getElementById('sc-last-run');
  meta.style.display = 'flex';
  document.getElementById('sc-count').textContent = `${count} resultado${count !== 1 ? 's' : ''}`;

  if (!runAt) { lastRun.innerHTML = ''; return; }

  const diffDays = Math.floor((Date.now() - new Date(runAt).getTime()) / 86400000);
  const dateStr  = new Date(runAt).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
  const relStr   = _fmtRunAt(runAt);

  if (diffDays >= 7) {
    lastRun.innerHTML =
      `<span title="Datos del ${dateStr}">Actualizado ${relStr}</span>` +
      `<span class="sc-stale-badge">⚠ datos desactualizados · ${dateStr}</span>`;
  } else {
    lastRun.textContent = `Actualizado ${relStr}`;
  }
}

function setScSort(col) {
  if (_scSortCol === col) _scSortDir *= -1;
  else { _scSortCol = col; _scSortDir = 1; }
  renderScreenerTable();
}

function renderScreenerTable() {
  const tbody = document.getElementById('sc-body');
  if (!_scData.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">Sin resultados</td></tr>';
    return;
  }

  let rows = [..._scData];
  if (_scSortCol) {
    rows.sort((a, b) => {
      const va = a[_scSortCol] ?? '';
      const vb = b[_scSortCol] ?? '';
      return typeof va === 'number'
        ? (va - vb) * _scSortDir
        : String(va).localeCompare(String(vb)) * _scSortDir;
    });
  }

  // Color helpers for dist columns
  const distCls = v => v <= 5 ? 'sc-dist-hot' : v <= 10 ? 'sc-dist-warm' : 'sc-dist-ok';
  const momCls  = v => v >= 0 ? 'price-up' : v >= -5 ? '' : 'price-down';

  tbody.innerHTML = rows.map(r => `<tr>
    <td><span class="ticker-chip">${esc(r.ticker)}</span></td>
    <td>${esc(r.company_name || r.ticker)}</td>
    <td class="r"><strong>${fmtUSD(r.price)}</strong></td>
    <td class="r"><span class="${distCls(r.dist_30d_low)}">${r.dist_30d_low != null ? '+' + r.dist_30d_low.toFixed(1) + '%' : '—'}</span></td>
    <td class="r"><span class="${distCls(r.dist_60d_low)}">${r.dist_60d_low != null ? '+' + r.dist_60d_low.toFixed(1) + '%' : '—'}</span></td>
    <td class="r"><span class="${distCls(r.dist_90d_low)}">${r.dist_90d_low != null ? '+' + r.dist_90d_low.toFixed(1) + '%' : '—'}</span></td>
    <td class="r"><span class="${momCls(r.momentum_5d)}">${r.momentum_5d != null ? (r.momentum_5d >= 0 ? '+' : '') + r.momentum_5d.toFixed(1) + '%' : '—'}</span></td>
    <td class="r muted">${fmtUSD(r.min_30d)}</td>
    <td class="r muted">${fmtUSD(r.min_60d)}</td>
    <td class="r muted">${fmtUSD(r.min_90d)}</td>
  </tr>`).join('');

  // Update sort icons
  document.querySelectorAll('#sc-table th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = th.dataset.col === _scSortCol ? (_scSortDir === 1 ? '↑' : '↓') : '';
  });
}

