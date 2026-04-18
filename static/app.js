'use strict';

let _transactions = [];
let _portfolio    = [];
let _prices       = {};
let _currentFilter  = 'all';
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

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _currentFilter = btn.dataset.filter;
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
    return;
  }

  tbody.innerHTML = filtered.map(t => {
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

// ── Utilities ─────────────────────────────────────────────────────────────────

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
