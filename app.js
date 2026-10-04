(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants & state
  // ---------------------------------------------------------------------------
  const TX_COLS = ['id', 'date', 'description', 'category', 'amount', 'account', 'notes'];
  const BUDGET_COLS = ['category', 'monthly_budget'];
  const TX_FILE = 'transactions.csv';
  const BUDGET_FILE = 'budgets.csv';
  const LS = {
    tx: 'finances.transactions.csv',
    budgets: 'finances.budgets.csv',
    currency: 'finances.currency',
    exported: 'finances.exported', // fingerprints of the last exported CSVs
  };
  const DEFAULT_CATEGORIES = [
    'Groceries', 'Dining', 'Rent', 'Utilities', 'Transport', 'Shopping', 'Health',
    'Entertainment', 'Subscriptions', 'Travel', 'Salary', 'Transfer', 'Other',
  ];
  // Categories matching this are moves between your own accounts (e.g. paying off a
  // credit card) and are left out of income/expense totals.
  const TRANSFER_RE = /^transfers?$/i;

  const state = {
    tx: [],
    budgets: [],
    currency: 'USD',
    sort: { key: 'date', dir: -1 },
    budgetMonth: null,    // month shown on the Budget tab (YYYY-MM); null = current
    editingId: null,
    dir: null,            // FileSystemDirectoryHandle when a folder is connected
    pendingDir: null,     // saved handle awaiting a user gesture to re-grant permission
    folderError: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  let moneyFmt = null;
  function money(n, opts = {}) {
    if (!moneyFmt || moneyFmt.currency !== state.currency) {
      moneyFmt = {
        currency: state.currency,
        full: new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency }),
        short: new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency, notation: 'compact', maximumFractionDigits: 1 }),
      };
    }
    return (opts.short ? moneyFmt.short : moneyFmt.full).format(n || 0);
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const currentMonth = () => todayISO().slice(0, 7);

  function monthLabel(ym, style = 'long') {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, style === 'short' ? { month: 'short' } : { month: 'short', year: 'numeric' });
  }

  function shiftMonth(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    if (!y) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const isTransfer = t => TRANSFER_RE.test(t.category || '');

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } }

  // ---------------------------------------------------------------------------
  // CSV <-> model
  // ---------------------------------------------------------------------------
  function txFromCSV(text) {
    const { records } = CSV.parseObjects(text || '');
    const seen = new Set();
    return records.map(r => {
      let id = r.id || uid();
      if (seen.has(id)) id = uid();
      seen.add(id);
      return {
        id,
        date: parseDate(r.date) || r.date,
        description: r.description || '',
        category: r.category || '',
        amount: parseAmount(r.amount) ?? 0,
        account: r.account || '',
        notes: r.notes || '',
      };
    }).filter(t => t.date);
  }

  function txToCSV(list = state.tx) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    return CSV.stringify(TX_COLS, sorted.map(t => ({ ...t, amount: t.amount.toFixed(2) })));
  }

  function budgetsFromCSV(text) {
    const { records } = CSV.parseObjects(text || '');
    const map = new Map();
    for (const r of records) {
      const cat = (r.category || '').trim();
      const amt = parseAmount(r.monthly_budget ?? r.budget ?? r.amount);
      if (cat && amt > 0) map.set(cat.toLowerCase(), { category: cat, monthly_budget: amt });
    }
    return [...map.values()];
  }

  function budgetsToCSV() {
    const sorted = [...state.budgets].sort((a, b) => a.category.localeCompare(b.category));
    return CSV.stringify(BUDGET_COLS, sorted.map(b => ({ ...b, monthly_budget: b.monthly_budget.toFixed(2) })));
  }

  // Parse a money string such as "$1,234.56", "-12.00", "(45.10)", "1.234,56 €".
  function parseAmount(s) {
    if (typeof s === 'number') return s;
    if (s == null) return null;
    let str = String(s).trim();
    if (!str) return null;
    let neg = false;
    if (/^\(.*\)$/.test(str)) { neg = true; str = str.slice(1, -1); }
    if (/^-|-$|^\s*[^\d]*-/.test(str)) neg = true;
    if (/\bDR\b/i.test(str)) neg = true;
    str = str.replace(/[^\d.,]/g, '');
    if (!str) return null;
    const lastComma = str.lastIndexOf(',');
    const lastDot = str.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      str = lastComma > lastDot ? str.replace(/\./g, '').replace(',', '.') : str.replace(/,/g, '');
    } else if (lastComma > -1) {
      str = /,\d{1,2}$/.test(str) && (str.match(/,/g) || []).length === 1 ? str.replace(',', '.') : str.replace(/,/g, '');
    }
    const n = parseFloat(str);
    if (isNaN(n)) return null;
    return round2(neg ? -n : n);
  }

  // Parse a date into YYYY-MM-DD. `dayFirst` decides how to read 03/04/2026.
  function parseDate(s, dayFirst = false) {
    if (!s) return null;
    const str = String(s).trim();
    let y, m, d, mt;
    if ((mt = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
      [y, m, d] = [mt[1], mt[2], mt[3]].map(Number);
    } else if ((mt = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
      const a = Number(mt[1]), b = Number(mt[2]);
      y = Number(mt[3]);
      if (y < 100) y += 2000;
      if (dayFirst || a > 12) { d = a; m = b; } else { m = a; d = b; }
    } else if ((mt = str.match(/^(\d{4})(\d{2})(\d{2})$/))) {
      [y, m, d] = [mt[1], mt[2], mt[3]].map(Number);
    } else {
      const t = Date.parse(str);
      if (isNaN(t)) return null;
      const dt = new Date(t);
      [y, m, d] = [dt.getFullYear(), dt.getMonth() + 1, dt.getDate()];
    }
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900)) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Persistence: browser cache (CSV text) + optional folder on disk
  // ---------------------------------------------------------------------------
  function loadFromBrowser() {
    state.tx = txFromCSV(lsGet(LS.tx));
    state.budgets = budgetsFromCSV(lsGet(LS.budgets));
    state.currency = lsGet(LS.currency) || 'USD';
  }

  function persist() {
    const txCSV = txToCSV();
    const bCSV = budgetsToCSV();
    lsSet(LS.tx, txCSV);
    lsSet(LS.budgets, bCSV);
    if (state.dir) scheduleFolderWrite();
    renderAll();
  }

  // IndexedDB is only used to remember *which* folder you picked (browsers can't
  // store that handle anywhere else). Your financial data never goes in here.
  const idb = {
    open() {
      return new Promise((res, rej) => {
        const req = indexedDB.open('finances', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    },
    async get(k) {
      try {
        const db = await idb.open();
        return await new Promise((res, rej) => {
          const r = db.transaction('kv').objectStore('kv').get(k);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      } catch { return undefined; }
    },
    async set(k, v) {
      try {
        const db = await idb.open();
        await new Promise((res, rej) => {
          const tx = db.transaction('kv', 'readwrite');
          v === undefined ? tx.objectStore('kv').delete(k) : tx.objectStore('kv').put(v, k);
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
      } catch { /* ignore */ }
    },
  };

  const folderSupported = 'showDirectoryPicker' in window;

  async function readFolderFile(dir, name) {
    try {
      const fh = await dir.getFileHandle(name);
      return await (await fh.getFile()).text();
    } catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
  }

  async function writeFolderFile(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  let writeTimer = null;
  let writeChain = Promise.resolve();
  function scheduleFolderWrite() {
    clearTimeout(writeTimer);
    renderStatus('saving');
    writeTimer = setTimeout(() => {
      writeChain = writeChain.then(writeFolderNow);
    }, 250);
  }

  async function writeFolderNow() {
    const dir = state.dir;
    if (!dir) return;
    try {
      await writeFolderFile(dir, TX_FILE, txToCSV());
      await writeFolderFile(dir, BUDGET_FILE, budgetsToCSV());
      state.folderError = null;
    } catch (e) {
      console.error(e);
      state.folderError = e.message || String(e);
      toast('Could not save to folder — see the Data tab');
    }
    renderStatus();
  }

  async function ensurePermission(handle, prompt) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!prompt) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  async function connectFolder(handle) {
    const txText = await readFolderFile(handle, TX_FILE);
    const bText = await readFolderFile(handle, BUDGET_FILE);
    let useFolder = txText != null || bText != null;

    if (useFolder && state.tx.length) {
      const folderTx = txFromCSV(txText);
      if (txToCSV(folderTx) !== txToCSV()) {
        useFolder = confirm(
          `"${handle.name}" already has data that differs from what's in this browser.\n\n` +
          `Folder: ${folderTx.length} transactions\nThis browser: ${state.tx.length} transactions\n\n` +
          `OK — load the folder's files (replaces this browser's copy)\n` +
          `Cancel — overwrite the folder's files with this browser's data`
        );
      }
    }

    if (useFolder) {
      if (txText != null) state.tx = txFromCSV(txText);
      if (bText != null) state.budgets = budgetsFromCSV(bText);
    }

    state.dir = handle;
    state.pendingDir = null;
    state.folderError = null;
    await idb.set('dir', handle);
    persist(); // writes the cache, and the folder if it was missing either file
    toast(`Connected to folder "${handle.name}"`);
  }

  async function chooseFolder() {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'finances', mode: 'readwrite' });
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message);
      return;
    }
    if (!(await ensurePermission(handle, true))) { toast('Permission to edit the folder was denied'); return; }
    await connectFolder(handle);
  }

  async function reconnectFolder() {
    const handle = state.pendingDir;
    if (!handle) return;
    try {
      if (!(await ensurePermission(handle, true))) { toast('Permission was not granted'); return; }
      await connectFolder(handle);
    } catch (e) {
      toast(`Couldn't open "${handle.name}": ${e.message}`);
      state.pendingDir = null;
      await idb.set('dir', undefined);
      renderStatus();
    }
  }

  async function disconnectFolder() {
    clearTimeout(writeTimer);
    await writeChain;
    state.dir = null;
    state.pendingDir = null;
    state.folderError = null;
    await idb.set('dir', undefined);
    renderStatus();
    toast('Folder disconnected — files on disk were left as they are');
  }

  async function restoreFolder() {
    if (!folderSupported) return;
    const handle = await idb.get('dir');
    if (!handle) return;
    try {
      if (await ensurePermission(handle, false)) {
        await connectFolder(handle);
        return;
      }
    } catch { /* fall through to manual reconnect */ }
    state.pendingDir = handle;
    renderStatus();
  }

  function download(name, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Cheap fingerprint of a CSV so we can tell whether it changed since the last export.
  function fingerprint(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return `${text.length}:${h >>> 0}`;
  }

  function exportedPrints() {
    try { return JSON.parse(lsGet(LS.exported)) || {}; } catch { return {}; }
  }

  // Which files have changes that haven't been exported yet.
  function unexported() {
    const p = exportedPrints();
    const out = [];
    if (state.tx.length && p.tx !== fingerprint(txToCSV())) out.push(TX_FILE);
    if (state.budgets.length && p.budgets !== fingerprint(budgetsToCSV())) out.push(BUDGET_FILE);
    return out;
  }

  function exportFiles(which) {
    const p = exportedPrints();
    const files = [];
    if (which === 'both' || which === 'tx') {
      const t = txToCSV(); files.push([TX_FILE, t]); p.tx = fingerprint(t);
    }
    if (which === 'both' || which === 'budgets') {
      const b = budgetsToCSV(); files.push([BUDGET_FILE, b]); p.budgets = fingerprint(b);
    }
    // Stagger downloads slightly; some browsers drop a second one fired in the same tick.
    files.forEach(([name, text], i) => setTimeout(() => download(name, text), i * 400));
    lsSet(LS.exported, JSON.stringify(p));
    renderStatus();
    toast(`Exported ${files.map(f => f[0]).join(' and ')}`);
  }

  function pickFile() {
    return new Promise(resolve => {
      const input = $('#file-input');
      input.value = '';
      input.onchange = async () => {
        const f = input.files[0];
        resolve(f ? { name: f.name, text: await f.text() } : null);
      };
      input.click();
    });
  }

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------
  function allMonths() {
    const set = new Set(state.tx.map(t => t.date.slice(0, 7)));
    set.add(currentMonth());
    return [...set].sort().reverse();
  }

  function allCategories() {
    const set = new Set(DEFAULT_CATEGORIES);
    state.tx.forEach(t => t.category && set.add(t.category));
    state.budgets.forEach(b => set.add(b.category));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  function inPeriod(t, period) {
    return !period || t.date.startsWith(period);
  }

  function totals(list) {
    let income = 0, expense = 0;
    for (const t of list) {
      if (isTransfer(t)) continue;
      if (t.amount >= 0) income += t.amount; else expense += -t.amount;
    }
    return { income: round2(income), expense: round2(expense), net: round2(income - expense) };
  }

  function spendByCategory(list) {
    const map = new Map();
    for (const t of list) {
      if (isTransfer(t) || t.amount >= 0) continue;
      const k = t.category || 'Uncategorized';
      map.set(k, (map.get(k) || 0) - t.amount);
    }
    return [...map.entries()].map(([category, amount]) => ({ category, amount: round2(amount) })).sort((a, b) => b.amount - a.amount);
  }

  function spentInMonth(category, ym) {
    const key = category.toLowerCase();
    let s = 0;
    for (const t of state.tx) {
      if (t.amount < 0 && t.date.startsWith(ym) && (t.category || '').toLowerCase() === key) s -= t.amount;
    }
    return round2(s);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function fillMonthSelect(sel, { includeAll, allLabel = 'All time' }) {
    const prev = sel.value;
    const months = allMonths();
    sel.innerHTML = (includeAll ? `<option value="">${allLabel}</option>` : '') +
      months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('');
    if (prev !== '' && months.includes(prev)) sel.value = prev;
    else if (prev === '' && includeAll && sel.dataset.init) sel.value = '';
    else sel.value = sel.dataset.default ?? months[0];
    sel.dataset.init = '1';
  }

  function renderDatalists() {
    $('#category-options').innerHTML = allCategories().map(c => `<option value="${esc(c)}">`).join('');
    const accounts = [...new Set(state.tx.map(t => t.account).filter(Boolean))].sort();
    $('#account-options').innerHTML = accounts.map(a => `<option value="${esc(a)}">`).join('');
  }

  function renderReports() {
    const sel = $('#dash-period');
    fillMonthSelect(sel, { includeAll: true });
    const period = sel.value;
    const list = state.tx.filter(t => inPeriod(t, period));
    const { income, expense, net } = totals(list);

    $('#stat-income').textContent = money(income);
    $('#stat-expense').textContent = money(expense);
    const netEl = $('#stat-net');
    netEl.textContent = money(net);
    netEl.className = 'stat-value ' + (net > 0 ? 'pos' : net < 0 ? 'neg' : '');
    $('#stat-rate').textContent = income > 0 ? `${Math.round((net / income) * 100)}%` : '–';

    renderTrendChart(period || allMonths()[0]);
    renderCategoryChart(list, period);
  }

  function emptyState() {
    return `<div class="empty">
      <p>No transactions yet.</p>
      <div class="btn-row center">
        <button class="btn primary" data-action="add">Add a transaction</button>
        <button class="btn" data-action="goto-data">Import a CSV</button>
        <button class="btn ghost" data-action="sample">Try sample data</button>
      </div>
    </div>`;
  }

  function renderTrendChart(endMonth) {
    const months = [];
    for (let i = 11; i >= 0; i--) months.push(shiftMonth(endMonth, -i));
    const data = months.map(m => ({ m, ...totals(state.tx.filter(t => t.date.startsWith(m))) }));
    const max = Math.max(1, ...data.map(d => Math.max(d.income, d.expense)));
    const nice = niceMax(max);

    // Size the viewBox to the real container width so text stays legible on phones.
    const cw0 = $('#trend-chart').clientWidth;
    const W = cw0 ? Math.max(300, Math.round(cw0)) : 640;
    const H = W < 500 ? 200 : 240, padL = 48, padR = 4, padT = 10, padB = 26;
    const narrow = W < 460;
    const cw = (W - padL - padR) / months.length;
    const bw = Math.min(14, cw / 2 - 3);
    const y = v => padT + (H - padT - padB) * (1 - v / nice);

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly income and expenses">`;
    for (let i = 0; i <= 4; i++) {
      const v = (nice / 4) * i;
      svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text class="axis" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${esc(money(v, { short: true }))}</text>`;
    }
    data.forEach((d, i) => {
      const cx = padL + cw * i + cw / 2;
      const base = y(0);
      const tip = `${monthLabel(d.m)}\nIncome: ${money(d.income)}\nExpenses: ${money(d.expense)}\nNet: ${money(d.net)}`;
      svg += `<g class="col" data-month="${d.m}"><title>${esc(tip)}</title>`;
      svg += `<rect class="hit" x="${cx - cw / 2}" y="${padT}" width="${cw}" height="${H - padT - padB}"/>`;
      if (d.income) svg += `<rect class="bar inc" x="${cx - bw - 1}" y="${y(d.income)}" width="${bw}" height="${base - y(d.income)}" rx="2"/>`;
      if (d.expense) svg += `<rect class="bar exp" x="${cx + 1}" y="${y(d.expense)}" width="${bw}" height="${base - y(d.expense)}" rx="2"/>`;
      const lbl = narrow ? monthLabel(d.m, 'short').slice(0, 1) : monthLabel(d.m, 'short');
      svg += `<text class="axis${d.m === endMonth ? ' strong' : ''}" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(lbl)}</text></g>`;
    });
    svg += `<line class="baseline" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/></svg>`;
    $('#trend-chart').innerHTML = svg;
  }

  function niceMax(v) {
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return n * exp;
  }

  function renderCategoryChart(list, period) {
    const rows = spendByCategory(list);
    const el = $('#category-chart');
    if (!rows.length) { el.innerHTML = '<p class="muted">No spending in this period.</p>'; return; }
    let shown = rows;
    if (rows.length > 8) {
      const other = rows.slice(7).reduce((s, r) => s + r.amount, 0);
      shown = [...rows.slice(0, 7), { category: `${rows.length - 7} more`, amount: round2(other), other: true }];
    }
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const max = shown[0].amount;
    el.innerHTML = shown.map(r => `
      <button class="hbar" ${r.other ? 'disabled' : `data-category="${esc(r.category)}" data-period="${period}"`} title="${esc(r.category)}: ${esc(money(r.amount))}">
        <span class="hbar-label">${esc(r.category)}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(2, (r.amount / max) * 100)}%"></span></span>
        <span class="hbar-value">${money(r.amount)}<small>${Math.round((r.amount / total) * 100)}%</small></span>
      </button>`).join('');
  }

  // ---------------------------------------------------------------------------
  // Budget home: how this month's budget is going
  // ---------------------------------------------------------------------------
  function monthInfo(ym) {
    const [y, m] = ym.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const cur = currentMonth();
    const isCurrent = ym === cur;
    const day = ym < cur ? days : ym > cur ? 0 : new Date().getDate();
    return {
      days, day, isCurrent,
      isPast: ym < cur,
      isFuture: ym > cur,
      elapsed: day / days,
      daysLeft: isCurrent ? days - day + 1 : ym > cur ? days : 0, // includes today
    };
  }

  // Status of one budget line. "Fully spent" covers bills paid in one go (rent etc.)
  // so they don't look alarming early in the month.
  function budgetStatus(spent, budget, mi) {
    const pct = budget > 0 ? spent / budget : 0;
    if (spent > budget + 0.005) return { key: 'over', label: `Over by ${money(spent - budget)}` };
    if (pct >= 0.97) return { key: 'full', label: 'Fully spent' };
    if (mi.isCurrent && pct > mi.elapsed + 0.15) return { key: 'fast', label: 'Spending fast' };
    if (mi.isPast) return { key: 'ok', label: `Under by ${money(budget - spent)}` };
    return { key: 'ok', label: 'On track' };
  }

  function renderBudgetHome() {
    const ym = state.budgetMonth || currentMonth();
    const mi = monthInfo(ym);
    $('#bm-title').textContent = new Date(...ym.split('-').map((v, i) => i ? v - 1 : +v), 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    $('#bm-today').hidden = mi.isCurrent;
    const el = $('#budget-home');

    const monthTx = state.tx.filter(t => t.date.startsWith(ym));
    const budgetKeys = new Set(state.budgets.map(b => b.category.toLowerCase()));
    const lines = state.budgets.map(b => {
      const spent = spentInMonth(b.category, ym);
      return { ...b, spent, left: round2(b.monthly_budget - spent), status: budgetStatus(spent, b.monthly_budget, mi) };
    });
    const order = { over: 0, fast: 1, ok: 2, full: 3 };
    lines.sort((a, b) => order[a.status.key] - order[b.status.key] || (b.spent / b.monthly_budget) - (a.spent / a.monthly_budget));

    const totalBudget = round2(lines.reduce((a, l) => a + l.monthly_budget, 0));
    const totalSpent = round2(lines.reduce((a, l) => a + l.spent, 0));
    const left = round2(totalBudget - totalSpent);
    const unbudgeted = spendByCategory(monthTx).filter(r => !budgetKeys.has(r.category.toLowerCase()));
    const unbudgetedTotal = round2(unbudgeted.reduce((a, r) => a + r.amount, 0));
    const { income, expense } = totals(monthTx);
    const over = lines.filter(l => l.status.key === 'over');
    const fast = lines.filter(l => l.status.key === 'fast');

    let html = '';

    // --- Hero
    if (!state.budgets.length) {
      html += `<div class="card hero hero-empty">
        <h2>Set up your budget</h2>
        <p class="muted">Give each spending category a monthly limit, and this page will show how you're doing at any moment: what's left, what you can spend per day, and which categories need attention.</p>
        <div class="btn-row">
          <button class="btn primary" data-action="budget-helper">Create a budget for me</button>
          <button class="btn" data-action="edit-budgets">Set limits myself</button>
          ${state.tx.length ? '' : '<button class="btn" data-action="goto-data">Import a CSV</button><button class="btn ghost" data-action="sample">Try sample data</button>'}
        </div>
      </div>`;
    } else {
      let tone, headline;
      if (mi.isFuture) { tone = ''; headline = "This month hasn't started yet"; }
      else if (left < 0) { tone = 'bad'; headline = `Over budget by ${money(-left)}`; }
      else if (over.length) { tone = 'bad'; headline = `${over.length} ${over.length === 1 ? 'category is' : 'categories are'} over budget`; }
      else if (fast.length) { tone = 'warn'; headline = `${fast.length} ${fast.length === 1 ? 'category is' : 'categories are'} spending fast`; }
      else if (mi.isPast) { tone = 'good'; headline = `Finished ${money(left)} under budget`; }
      else { tone = 'good'; headline = "You're on track"; }

      const usedPct = totalBudget ? Math.round((totalSpent / totalBudget) * 100) : 0;
      const sub = mi.isCurrent
        ? `${usedPct}% of your budget used · ${Math.round(mi.elapsed * 100)}% of the month gone · ${mi.daysLeft} day${mi.daysLeft === 1 ? '' : 's'} left`
        : mi.isPast ? `${usedPct}% of your budget used` : `${money(totalBudget)} budgeted`;
      const perDay = mi.isCurrent && left > 0 ? left / mi.daysLeft : null;

      html += `<div class="card hero ${tone}">
        <div class="hero-top">
          <div>
            <div class="hero-label">${left < 0 ? 'Over budget' : mi.isPast ? 'Left unspent' : 'Left to spend'}</div>
            <div class="hero-amount ${left < 0 ? 'neg' : ''}">${money(Math.abs(left))}</div>
            <div class="hero-of muted">${money(totalSpent)} spent of ${money(totalBudget)}</div>
          </div>
          <div class="hero-status"><span class="pill ${tone}">${esc(headline)}</span></div>
        </div>
        <div class="meter big ${left < 0 ? 'over' : ''}">
          <div class="meter-fill" style="width:${Math.min(100, totalBudget ? (totalSpent / totalBudget) * 100 : 0)}%"></div>
          ${mi.isCurrent ? `<div class="meter-today" style="left:${mi.elapsed * 100}%" title="Today"></div>` : ''}
        </div>
        <p class="hero-sub muted small">${sub}</p>
        <div class="hero-stats">
          ${perDay != null ? `<div><span class="stat-label">You can spend</span><b>${money(perDay)}<small> / day</small></b></div>` : ''}
          <div><span class="stat-label">Not in budget</span><b class="${unbudgetedTotal ? 'warn-text' : ''}">${money(unbudgetedTotal)}</b></div>
          <div><span class="stat-label">Income</span><b class="pos">${money(income)}</b></div>
          <div><span class="stat-label">All spending</span><b>${money(expense)}</b></div>
        </div>
      </div>`;
    }

    // --- Category lines
    if (lines.length) {
      html += `<div class="card"><div class="card-head"><h2>Categories</h2>${mi.isCurrent ? '<span class="muted small legend-today"><i></i>today</span>' : ''}</div>
        <div class="lines">${lines.map(l => {
          const pct = l.monthly_budget ? l.spent / l.monthly_budget : 0;
          const perDay = mi.isCurrent && l.left > 0 ? `${money(l.left / mi.daysLeft)}/day` : '';
          return `<div class="line ${l.status.key}" data-category="${esc(l.category)}">
            <div class="line-top">
              <button class="line-name" data-filter-cat="${esc(l.category)}" title="See transactions">${esc(l.category)}</button>
              <span class="line-left ${l.left < 0 ? 'neg' : ''}">${l.left < 0 ? `${money(-l.left)} over` : `${money(l.left)} left`}</span>
            </div>
            <div class="meter">
              <div class="meter-fill" style="width:${Math.min(100, pct * 100)}%"></div>
              ${mi.isCurrent ? `<div class="meter-today" style="left:${mi.elapsed * 100}%"></div>` : ''}
            </div>
            <div class="line-foot">
              <span class="muted">${money(l.spent)} of ${money(l.monthly_budget)}${perDay ? ` · ${perDay}` : ''}</span>
              <span class="line-status">${esc(l.status.label)}</span>
              <button class="icon-btn add-to" data-add-cat="${esc(l.category)}" title="Add an expense to ${esc(l.category)}" aria-label="Add an expense to ${esc(l.category)}">+</button>
            </div>
          </div>`;
        }).join('')}</div></div>`;
    }

    // --- Spending outside the budget
    if (unbudgeted.length) {
      html += `<div class="card"><h2>Not in your budget</h2>
        <p class="muted small">Spending this month in categories without a limit.</p>
        <ul class="plain-list">${unbudgeted.map(r => `
          <li><button class="line-name" data-filter-cat="${esc(r.category)}">${esc(r.category)}</button>
            <span>${money(r.amount)}</span>
            ${r.category === 'Uncategorized' ? '' : `<button class="btn small-btn" data-budget-for="${esc(r.category)}" data-suggest="${r.amount}">Add to budget</button>`}</li>`).join('')}
        </ul></div>`;
    }

    // --- This month's transactions
    if (!state.tx.length) { el.innerHTML = html; return; }
    const recent = [...monthTx].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 8);
    html += `<div class="card"><div class="card-head"><h2>${mi.isCurrent ? 'Latest this month' : 'Transactions'}</h2>
      ${monthTx.length > recent.length ? `<button class="link small" data-filter-cat="">See all ${monthTx.length}</button>` : ''}</div>
      ${recent.length ? `<ul class="recent">${recent.map(t => `
        <li data-id="${esc(t.id)}">
          <span class="r-date">${esc(formatDate(t.date))}</span>
          <span class="r-desc">${esc(t.description)}<small>${esc(t.category || 'Uncategorized')}</small></span>
          <span class="r-amt ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</span>
        </li>`).join('')}</ul>` : '<p class="muted">Nothing recorded this month yet.</p>'}
    </div>`;

    el.innerHTML = html;
  }

  function showTransactionsFor(category, ym) {
    $('#f-search').value = '';
    $('#f-type').value = '';
    showView('transactions');
    renderTransactions();
    $('#f-month').value = ym || '';
    $('#f-category').value = category === 'Uncategorized' ? '__none__' : (category || '');
    renderTransactions();
  }

  // ---------------------------------------------------------------------------
  // Edit budget dialog
  // ---------------------------------------------------------------------------
  function beRow(category = '', amount = '') {
    return `<div class="be-row">
      <input class="be-cat" list="category-options" placeholder="Category" value="${esc(category)}" aria-label="Category">
      <input class="be-amt" type="number" min="0" step="any" inputmode="decimal" placeholder="0" value="${amount === '' ? '' : esc(amount)}" aria-label="Monthly limit">
      <button type="button" class="icon-btn be-del" title="Remove" aria-label="Remove">×</button>
    </div>`;
  }

  function openBudgetDialog(addCategory, suggest) {
    const rows = [...state.budgets].sort((a, b) => b.monthly_budget - a.monthly_budget);
    let html = rows.map(b => beRow(b.category, b.monthly_budget)).join('');
    if (addCategory && !state.budgets.some(b => b.category.toLowerCase() === addCategory.toLowerCase())) {
      html += beRow(addCategory, suggest ? tidy(suggest, true) : '');
    }
    if (!html) html = beRow();
    $('#be-rows').innerHTML = html;
    updateBudgetTotal();
    $('#budget-dialog').showModal();
    const focus = addCategory ? $$('#be-rows .be-amt').pop() : $('#be-rows .be-cat');
    if (focus) focus.focus();
  }

  function readBudgetRows() {
    const map = new Map();
    $$('#be-rows .be-row').forEach(r => {
      const cat = r.querySelector('.be-cat').value.trim();
      const amt = parseAmount(r.querySelector('.be-amt').value) || 0;
      if (cat && amt > 0) map.set(cat.toLowerCase(), { category: cat, monthly_budget: round2(amt) });
    });
    return [...map.values()];
  }

  function updateBudgetTotal() {
    const total = readBudgetRows().reduce((a, b) => a + b.monthly_budget, 0);
    // Typical monthly income over the last few complete months, for context.
    const months = helperMonths(3);
    const set = new Set(months);
    const inc = totals(state.tx.filter(t => set.has(t.date.slice(0, 7)))).income / (months.length || 1);
    $('#be-total').innerHTML = `Total <b>${money(total)}</b> / month` +
      (inc > 0 ? ` <span class="muted">· typical income ${money(inc)} · <span class="${inc - total < 0 ? 'neg' : 'pos'}">${money(inc - total)} left over</span></span>` : '');
  }

  function saveBudgetDialog() {
    state.budgets = readBudgetRows();
    $('#budget-dialog').close();
    persist();
    toast('Budget saved');
  }

  function filteredTx() {
    const q = $('#f-search').value.trim().toLowerCase();
    const month = $('#f-month').value;
    const cat = $('#f-category').value;
    const type = $('#f-type').value;
    const { key, dir } = state.sort;
    return state.tx
      .filter(t => !month || t.date.startsWith(month))
      .filter(t => !cat || (cat === '__none__' ? !t.category : t.category === cat))
      .filter(t => !type || (type === 'expense' ? t.amount < 0 : t.amount >= 0))
      .filter(t => !q || [t.description, t.notes, t.account, t.category, t.amount.toFixed(2)].some(v => v.toLowerCase().includes(q)))
      .sort((a, b) => {
        const av = a[key], bv = b[key];
        const c = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return (c || b.date.localeCompare(a.date) || a.id.localeCompare(b.id)) * (c ? dir : 1);
      });
  }

  function renderTransactions() {
    const fm = $('#f-month');
    fillMonthSelect(fm, { includeAll: true, allLabel: 'All months' });

    const fc = $('#f-category');
    const prevCat = fc.value;
    const used = [...new Set(state.tx.map(t => t.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    fc.innerHTML = '<option value="">All categories</option><option value="__none__">Uncategorized</option>' +
      used.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    fc.value = prevCat === '__none__' || used.includes(prevCat) ? prevCat : '';

    $$('.tx-table th.sortable').forEach(th => {
      th.classList.toggle('asc', th.dataset.sort === state.sort.key && state.sort.dir === 1);
      th.classList.toggle('desc', th.dataset.sort === state.sort.key && state.sort.dir === -1);
    });

    const list = filteredTx();
    const t = totals(list);
    $('#tx-summary').innerHTML = `<span>${list.length} transaction${list.length === 1 ? '' : 's'}</span>
      <span>In <b class="pos">${money(t.income)}</b></span>
      <span>Out <b class="neg">${money(t.expense)}</b></span>
      <span>Net <b>${money(t.net)}</b></span>`;

    const LIMIT = 1000;
    $('#tx-body').innerHTML = list.slice(0, LIMIT).map(t => `
      <tr data-id="${esc(t.id)}">
        <td class="nowrap">${esc(formatDate(t.date))}</td>
        <td class="desc">${esc(t.description)}${t.notes ? `<small>${esc(t.notes)}</small>` : ''}<small class="show-sm">${esc(t.category || 'Uncategorized')}</small></td>
        <td class="hide-sm">${t.category ? `<span class="chip${isTransfer(t) ? ' transfer' : ''}">${esc(t.category)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="hide-sm">${esc(t.account)}</td>
        <td class="num ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</td>
        <td class="row-act"><button class="icon-btn" title="Edit" aria-label="Edit">✎</button></td>
      </tr>`).join('') +
      (list.length > LIMIT ? `<tr><td colspan="6" class="muted center">Showing first ${LIMIT} of ${list.length}. Narrow the filters to see more.</td></tr>` : '');
    $('#tx-empty').hidden = list.length > 0;
  }

  function renderStatus(mode) {
    const el = $('#save-status');
    let html, cls;
    if (state.dir) {
      if (mode === 'saving') { cls = 'busy'; html = `Saving to <b>${esc(state.dir.name)}</b>…`; }
      else if (state.folderError) { cls = 'error'; html = `Not saved to folder`; }
      else { cls = 'ok'; html = `Saved to <b>${esc(state.dir.name)}</b>`; }
    } else if (state.pendingDir) {
      cls = 'warn'; html = `Reconnect <b>${esc(state.pendingDir.name)}</b>`;
    } else {
      cls = 'local'; html = 'Saved in this browser';
    }
    const pending = unexported();
    if (!state.dir && !state.pendingDir && pending.length) { cls = 'unexported'; html = '<span class="hide-sm">Saved in browser · </span><b>Not exported</b>'; }
    else if (!state.dir && !state.pendingDir && (state.tx.length || state.budgets.length)) html = 'Saved in browser<span class="hide-sm"> · exported</span>';
    el.className = 'save-status ' + cls;
    el.innerHTML = `<i></i><span>${html}</span>`;

    // Export button: flag unexported changes when no folder is keeping the CSVs up to date.
    const flag = !state.dir && pending.length > 0;
    $('.export-dot').hidden = !flag;
    $('#btn-export').classList.toggle('attention', flag);
    $('#export-note').textContent = state.dir
      ? `Your folder already has the latest CSVs. Exporting downloads an extra copy.`
      : flag ? `Changes not exported yet: ${pending.join(', ')}.` : (state.tx.length || state.budgets.length ? 'Everything has been exported.' : 'Nothing to export yet.');

    // Data tab
    $('#folder-supported').hidden = !folderSupported;
    $('#folder-unsupported').hidden = folderSupported;
    const re = $('#btn-reconnect');
    re.hidden = !state.pendingDir;
    if (state.pendingDir) re.textContent = `Reconnect “${state.pendingDir.name}”`;
    $('#btn-disconnect').hidden = !state.dir;
    $('#btn-open-folder').textContent = state.dir ? 'Choose a different folder…' : 'Choose folder…';
    const info = $('#folder-info');
    if (state.dir) {
      info.innerHTML = state.folderError
        ? `<span class="neg">Last save failed: ${esc(state.folderError)}.</span> Try reconnecting the folder.`
        : `Connected to <b>${esc(state.dir.name)}</b>. Changes are written to <code>${TX_FILE}</code> and <code>${BUDGET_FILE}</code> automatically.`;
    } else if (state.pendingDir) {
      info.textContent = 'Your browser needs you to re-approve access to the folder after a restart.';
    } else {
      info.textContent = 'No folder connected — data is kept in this browser only.';
    }
  }

  function renderAll() {
    $('#set-currency').value = state.currency;
    renderDatalists();
    renderBudgetHome();
    renderReports();
    renderTransactions();
    renderStatus();
  }

  function showView(name) {
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    if (name === 'reports') renderReports(); // chart sizing needs the view visible
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------------------
  // Transaction dialog
  // ---------------------------------------------------------------------------
  function openTxDialog(id, preset = {}) {
    const dlg = $('#tx-dialog');
    const f = $('#tx-form');
    const t = id ? state.tx.find(x => x.id === id) : null;
    state.editingId = t ? t.id : null;
    $('#tx-dialog-title').textContent = t ? 'Edit transaction' : 'Add transaction';
    $('#tx-delete').hidden = !t;
    f.reset();
    f.elements.kind.value = t && t.amount >= 0 ? 'income' : 'expense';
    f.elements.date.value = t ? t.date : todayISO();
    f.elements.amount.value = t ? Math.abs(t.amount).toFixed(2) : '';
    f.elements.description.value = t ? t.description : '';
    f.elements.category.value = t ? t.category : (preset.category || '');
    f.elements.account.value = t ? t.account : (lastAccount() || '');
    f.elements.notes.value = t ? t.notes : '';
    dlg.showModal();
    f.elements.amount.focus();
  }

  function lastAccount() {
    let latest = null;
    for (const t of state.tx) if (t.account && (!latest || t.date > latest.date)) latest = t;
    return latest && latest.account;
  }

  function saveTxFromForm() {
    const f = $('#tx-form');
    const amt = Math.abs(parseAmount(f.elements.amount.value) || 0);
    const rec = {
      date: f.elements.date.value,
      description: f.elements.description.value.trim(),
      category: f.elements.category.value.trim(),
      amount: round2(f.elements.kind.value === 'income' ? amt : -amt),
      account: f.elements.account.value.trim(),
      notes: f.elements.notes.value.trim(),
    };
    if (state.editingId) {
      const t = state.tx.find(x => x.id === state.editingId);
      Object.assign(t, rec);
      toast('Transaction updated');
    } else {
      state.tx.push({ id: uid(), ...rec });
      toast('Transaction added');
    }
    $('#tx-dialog').close();
    persist();
  }

  // Suggest a category from previous transactions with the same description.
  function suggestCategory(desc) {
    const d = desc.trim().toLowerCase();
    if (!d) return null;
    const match = [...state.tx].sort((a, b) => b.date.localeCompare(a.date)).find(t => t.category && t.description.toLowerCase() === d);
    return match ? match.category : null;
  }

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------
  const IMPORT_FIELDS = [
    { key: 'date', label: 'Date', re: /^(transaction |posted |posting |trans\.? )?date$|date/i, required: true },
    { key: 'description', label: 'Description', re: /desc|payee|merchant|memo|narrative|details|name|reference/i, required: true },
    { key: 'amount', label: 'Amount (signed)', re: /^amount|amount$|^value$|^sum$/i },
    { key: 'debit', label: 'Debit / money out', re: /debit|withdraw|money out|paid out|outflow/i },
    { key: 'credit', label: 'Credit / money in', re: /credit|deposit|money in|paid in|inflow/i },
    { key: 'category', label: 'Category', re: /categ/i },
    { key: 'account', label: 'Account', re: /account/i },
    { key: 'notes', label: 'Notes', re: /^notes?$|comment/i },
    { key: 'id', label: 'ID', re: /^id$/i },
  ];

  let importState = null;

  async function startImport() {
    const file = await pickFile();
    if (!file) return;
    const rows = CSV.parse(file.text);
    if (rows.length < 2) { toast('That file has no data rows'); return; }

    // Some bank exports put a few lines of preamble before the header. Use the
    // first row that looks like a header (mentions a date column).
    let hi = rows.findIndex(r => r.some(c => /date/i.test(c)));
    if (hi < 0) hi = 0;
    const headers = rows[hi].map(h => h.trim());
    const data = rows.slice(hi + 1);

    const map = {};
    const used = new Set();
    for (const f of IMPORT_FIELDS) {
      const idx = headers.findIndex((h, i) => !used.has(i) && f.re.test(h));
      if (idx > -1) {
        map[f.key] = idx; used.add(idx);
      } else map[f.key] = -1;
    }
    // If we found a signed amount, don't also use debit/credit (and vice versa).
    if (map.amount > -1 && (map.debit > -1 || map.credit > -1) && /^(debit|credit)/i.test(headers[map.amount])) map.amount = -1;

    // Detect day-first dates: any first component > 12 means DD/MM.
    const dateCol = map.date;
    const dayFirst = dateCol > -1 && data.some(r => {
      const m = String(r[dateCol] || '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
      return m && Number(m[1]) > 12;
    });

    importState = { name: file.name, headers, data, map, dayFirst };
    $('#import-file-info').textContent = `${file.name} — ${data.length} rows, ${headers.length} columns`;
    $('#import-flip').checked = false;
    $('#import-map').innerHTML = IMPORT_FIELDS.map(f => `
      <label>${f.label}${f.required ? ' *' : ''}
        <select data-field="${f.key}">
          <option value="-1">— none —</option>
          ${headers.map((h, i) => `<option value="${i}"${map[f.key] === i ? ' selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('')}
        </select>
      </label>`).join('') + `
      <label>Date format
        <select id="import-dayfirst">
          <option value="0"${dayFirst ? '' : ' selected'}>Month first (MM/DD/YYYY)</option>
          <option value="1"${dayFirst ? ' selected' : ''}>Day first (DD/MM/YYYY)</option>
        </select>
      </label>`;
    updateImportPreview();
    $('#import-dialog').showModal();
  }

  function mapImportRow(r, s, flip) {
    const get = k => (s.map[k] > -1 ? String(r[s.map[k]] ?? '').trim() : '');
    const date = parseDate(get('date'), s.dayFirst);
    if (!date) return null;
    let amount;
    if (s.map.amount > -1) {
      amount = parseAmount(get('amount'));
    } else if (s.map.debit > -1 || s.map.credit > -1) {
      const d = Math.abs(parseAmount(get('debit')) || 0);
      const c = Math.abs(parseAmount(get('credit')) || 0);
      if (!get('debit') && !get('credit')) amount = null; else amount = round2(c - d);
    }
    if (amount == null || isNaN(amount)) return null;
    if (flip) amount = -amount;
    const description = get('description');
    return {
      id: get('id'),
      date,
      description,
      category: get('category') || suggestCategory(description) || '',
      amount: round2(amount),
      account: get('account'),
      notes: get('notes'),
    };
  }

  const dedupeKey = t => `${t.date}|${t.amount.toFixed(2)}|${t.description.trim().toLowerCase()}`;

  // Work out which rows are new. Duplicates are matched one-for-one against existing
  // transactions, so re-importing the same file adds nothing, while two identical
  // purchases on the same day within one file are both kept.
  function planImport() {
    const s = importState;
    const flip = $('#import-flip').checked;
    const counts = new Map();
    const ids = new Set(state.tx.map(t => t.id));
    state.tx.forEach(t => { const k = dedupeKey(t); counts.set(k, (counts.get(k) || 0) + 1); });
    const out = { add: [], dup: 0, bad: 0 };
    for (const r of s.data) {
      const t = mapImportRow(r, s, flip);
      if (!t) { out.bad++; continue; }
      const k = dedupeKey(t);
      if ((t.id && ids.has(t.id)) || counts.get(k) > 0) {
        out.dup++;
        if (counts.get(k) > 0) counts.set(k, counts.get(k) - 1);
        continue;
      }
      if (!t.id || ids.has(t.id)) t.id = uid();
      ids.add(t.id);
      out.add.push(t);
    }
    return out;
  }

  function updateImportPreview() {
    const s = importState;
    $$('#import-map select[data-field]').forEach(sel => { s.map[sel.dataset.field] = Number(sel.value); });
    const df = $('#import-dayfirst');
    if (df) s.dayFirst = df.value === '1';

    const hasAmount = s.map.amount > -1 || s.map.debit > -1 || s.map.credit > -1;
    const ok = s.map.date > -1 && s.map.description > -1 && hasAmount;
    const plan = ok ? planImport() : { add: [], dup: 0, bad: 0 };
    const preview = plan.add.slice(0, 8);
    $('#import-preview').innerHTML = `<thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="num">Amount</th></tr></thead><tbody>` +
      (preview.length ? preview.map(t => `<tr><td class="nowrap">${esc(formatDate(t.date))}</td><td class="desc">${esc(t.description)}</td><td>${esc(t.category)}</td><td class="num ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</td></tr>`).join('')
        : `<tr><td colspan="4" class="muted center">${ok ? 'Nothing new to import.' : 'Choose the Date, Description and Amount (or Debit/Credit) columns.'}</td></tr>`) + '</tbody>';
    $('#import-stats').innerHTML = ok
      ? `<b>${plan.add.length}</b> new transaction${plan.add.length === 1 ? '' : 's'} to import` +
        (plan.dup ? ` · ${plan.dup} already in your data (skipped)` : '') +
        (plan.bad ? ` · <span class="neg">${plan.bad} row${plan.bad === 1 ? '' : 's'} couldn't be read (skipped)</span>` : '')
      : '';
    $('#import-go').disabled = !ok || !plan.add.length;
    s.plan = plan;
  }

  function finishImport() {
    const plan = planImport();
    state.tx.push(...plan.add);
    $('#import-dialog').close();
    importState = null;
    persist();
    toast(`Imported ${plan.add.length} transaction${plan.add.length === 1 ? '' : 's'}`);
  }


  // ---------------------------------------------------------------------------
  // Budget helper: suggest budgets from spending history
  // ---------------------------------------------------------------------------
  const NEEDS_RE = /rent|mortgage|housing|utilit|electric|water|grocer|health|medical|pharm|insur|transport|transit|gas|fuel|car|childcare|daycare|loan|debt|phone|internet|tax/i;

  let helperState = null;

  // Round up to a tidy number: $5 steps, $10 above $200, $25 above $1,000.
  function tidy(n, up) {
    const step = n > 1000 ? 25 : n > 200 ? 10 : 5;
    return (up ? Math.ceil(n / step) : Math.round(n / step)) * step;
  }

  // The complete months to average over: up to `n` months before the current one,
  // but never before your first transaction (so 2 months of data isn't averaged over 6).
  function helperMonths(n) {
    const first = state.tx.reduce((m, t) => (!m || t.date < m ? t.date : m), null);
    if (!first) return [];
    const firstMonth = first.slice(0, 7);
    const months = [];
    for (let i = 1; i <= n; i++) {
      const m = shiftMonth(currentMonth(), -i);
      if (m < firstMonth) break;
      months.push(m);
    }
    // Brand new data that only covers this month: use it rather than nothing.
    return months.length ? months : [currentMonth()];
  }

  function openHelper() {
    const has = state.tx.some(t => t.amount < 0 && !isTransfer(t));
    $('#helper-empty').hidden = has;
    $('#helper-body').hidden = !has;
    $('#helper-save').hidden = !has;
    helperState = { kinds: {} };
    if (has) buildHelper();
    $('#helper-dialog').showModal();
  }

  function buildHelper() {
    const months = helperMonths(Number($('#helper-basis').value));
    const set = new Set(months);
    const list = state.tx.filter(t => set.has(t.date.slice(0, 7)));
    const n = months.length;
    const income = round2(totals(list).income / n);
    const rows = spendByCategory(list).map(r => {
      const kind = helperState.kinds[r.category] || (NEEDS_RE.test(r.category) ? 'need' : 'want');
      return { category: r.category, kind, avg: round2(r.amount / n), budget: 0 };
    });
    helperState = { ...helperState, months, income, rows };

    const range = n === 1 ? monthLabel(months[0]) : `${monthLabel(months[n - 1])} – ${monthLabel(months[0])}`;
    $('#helper-basis-info').textContent = `Averaging ${n} month${n === 1 ? '' : 's'} of data (${range})${months[0] === currentMonth() ? ', which is still in progress' : ''}.`;
    $('#helper-goal').disabled = income <= 0;
    suggestBudgets();
  }

  function suggestBudgets() {
    const s = helperState;
    const goal = s.income > 0 ? Number($('#helper-goal').value || 0) : 0;
    const pctGoal = Math.round(goal * 100);
    // Needs keep their average (rounded up); wants get whatever room is left.
    let needsBudget = 0, wantsAvg = 0;
    for (const r of s.rows) {
      if (r.kind === 'need') { r.budget = tidy(r.avg, true); needsBudget += r.budget; }
      else wantsAvg += r.avg;
    }
    const wantsAsIs = s.rows.filter(r => r.kind === 'want').reduce((a, r) => a + tidy(r.avg, true), 0);
    let factor = 1;
    s.note = '';
    if (goal) {
      const room = s.income * (1 - goal) - needsBudget; // what wants can use and still hit the goal
      if (wantsAsIs <= room) {
        s.note = `You're already on track to save at least ${pctGoal}% — these budgets keep your spending where it is.`;
      } else if (wantsAvg > 0 && room >= wantsAvg * 0.5) {
        factor = room / wantsAvg;
        s.note = `To save ${pctGoal}%, your "wants" are trimmed by about ${Math.max(1, Math.round((1 - factor) * 100))}%.`;
      } else {
        // Trimming wants by more than half stops being a realistic plan, so cap it
        // and say so instead.
        factor = 0.5;
        s.note = `Saving ${pctGoal}% would mean cutting more than half of your "wants" spending, so this plan trims them by 50% and falls short. Look at your biggest needs too, or pick a smaller goal.`;
      }
    }
    for (const r of s.rows) {
      if (r.kind !== 'want') continue;
      // Round down when trimming so the rounding never pushes you past the goal.
      r.budget = factor === 1 ? tidy(r.avg, true) : Math.floor((r.avg * factor) / 5) * 5;
      if (r.avg > 0 && r.budget === 0) r.budget = 5;
    }
    renderHelper();
  }

  function renderHelper() {
    const s = helperState;
    $('#helper-rows').innerHTML = s.rows.map((r, i) => `
      <tr data-i="${i}">
        <td>${esc(r.category)}<small class="show-sm muted">avg ${money(r.avg)}</small></td>
        <td><select data-kind="${i}" class="kind-select"><option value="need"${r.kind === 'need' ? ' selected' : ''}>Need</option><option value="want"${r.kind === 'want' ? ' selected' : ''}>Want</option></select></td>
        <td class="num muted hide-sm">${money(r.avg)}</td>
        <td class="num"><input type="number" min="0" step="any" data-budget="${i}" value="${r.budget}" class="budget-input" aria-label="Budget for ${esc(r.category)}"></td>
      </tr>`).join('');
    $('#helper-note').textContent = s.note || '';
    renderHelperSummary();
  }

  function renderHelperSummary() {
    const s = helperState;
    const needs = s.rows.filter(r => r.kind === 'need').reduce((a, r) => a + r.budget, 0);
    const wants = s.rows.filter(r => r.kind === 'want').reduce((a, r) => a + r.budget, 0);
    const total = needs + wants;
    const left = s.income - total;
    const pct = v => (s.income > 0 ? Math.round((v / s.income) * 100) : 0);
    const bar = s.income > 0 ? `
      <div class="split-bar" title="Share of your average income">
        <span class="split-need" style="width:${Math.min(100, pct(needs))}%"></span>
        <span class="split-want" style="width:${Math.max(0, Math.min(100 - pct(needs), pct(wants)))}%"></span>
      </div>
      <div class="split-legend">
        <span><i class="sw split-need"></i>Needs ${pct(needs)}% <small>(guide: 50%)</small></span>
        <span><i class="sw split-want"></i>Wants ${pct(wants)}% <small>(guide: 30%)</small></span>
        <span><i class="sw split-save"></i>Savings ${pct(left)}% <small>(guide: 20%)</small></span>
      </div>` : '<p class="muted small">No income found in this period, so savings can\'t be estimated.</p>';
    $('#helper-summary').innerHTML = `
      <div class="helper-stats">
        <div><span class="stat-label">Avg income</span><b class="pos">${money(s.income)}</b></div>
        <div><span class="stat-label">Total budget</span><b>${money(total)}</b></div>
        <div><span class="stat-label">Left to save</span><b class="${left < 0 ? 'neg' : ''}">${money(left)}</b></div>
      </div>${bar}`;
  }

  function saveHelper() {
    const s = helperState;
    const plan = s.rows.filter(r => r.budget > 0);
    const keys = new Set(s.rows.map(r => r.category.toLowerCase()));
    state.budgets = state.budgets.filter(b => !keys.has(b.category.toLowerCase()));
    state.budgets.push(...plan.map(r => ({ category: r.category, monthly_budget: round2(r.budget) })));
    $('#helper-dialog').close();
    persist();
    showView('budget');
    toast(`Saved ${plan.length} budget${plan.length === 1 ? '' : 's'}`);
  }

  // ---------------------------------------------------------------------------
  // Sample data
  // ---------------------------------------------------------------------------
  function sampleData() {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const pick = a => a[Math.floor(rnd() * a.length)];
    const tx = [];
    const add = (date, description, category, amount, account = 'Checking', notes = '') =>
      tx.push({ id: uid() + tx.length, date, description, category, amount: round2(amount), account, notes });
    const today = todayISO();
    for (let i = 5; i >= 0; i--) {
      const ym = shiftMonth(currentMonth(), -i);
      const d = day => `${ym}-${String(day).padStart(2, '0')}`;
      const within = day => d(day) <= today;
      if (within(1)) add(d(1), 'Rent', 'Rent', -1650);
      if (within(1)) add(d(1), 'Paycheck', 'Salary', 2100);
      if (within(15)) add(d(15), 'Paycheck', 'Salary', 2100);
      if (within(5)) add(d(5), 'City Power & Water', 'Utilities', -(95 + rnd() * 60));
      if (within(8)) add(d(8), 'Internet', 'Utilities', -65);
      if (within(12)) add(d(12), 'Streaming service', 'Subscriptions', -15.49, 'Credit Card');
      if (within(20)) add(d(20), 'Phone plan', 'Utilities', -45);
      if (within(25)) add(d(25), 'Credit card payment', 'Transfer', -(600 + rnd() * 300));
      if (within(25)) add(d(25), 'Credit card payment', 'Transfer', 600 + rnd() * 300, 'Credit Card');
      for (let day = 2; day <= 28; day += 1 + Math.floor(rnd() * 2)) {
        if (!within(day)) break;
        const r = rnd();
        if (r < 0.35) add(d(day), pick(['Fresh Market', 'Corner Grocery', 'Costco']), 'Groceries', -(45 + rnd() * 90), 'Credit Card');
        else if (r < 0.6) add(d(day), pick(['Taco Spot', 'Noodle House', 'Pizza Place', 'Coffee Bar']), 'Dining', -(12 + rnd() * 65), 'Credit Card');
        else if (r < 0.75) add(d(day), pick(['Gas station', 'Transit pass', 'Rideshare']), 'Transport', -(12 + rnd() * 50), 'Credit Card');
        else if (r < 0.87) add(d(day), pick(['Bookstore', 'Hardware store', 'Online order']), 'Shopping', -(25 + rnd() * 140), 'Credit Card');
        else if (r < 0.95) add(d(day), pick(['Movie tickets', 'Concert', 'Bowling']), 'Entertainment', -(20 + rnd() * 80), 'Credit Card');
        else add(d(day), 'Pharmacy', 'Health', -(10 + rnd() * 40), 'Credit Card');
      }
    }
    const budgets = [
      ['Rent', 1650], ['Groceries', 450], ['Dining', 250], ['Health', 50], ['Transport', 150], ['Shopping', 150],
      ['Entertainment', 100], ['Utilities', 250], ['Subscriptions', 30],
    ].map(([category, monthly_budget]) => ({ category, monthly_budget }));
    return { tx, budgets };
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function bind() {
    $$('.tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    window.addEventListener('hashchange', () => {
      const v = location.hash.slice(1);
      if ($(`#view-${v}`)) showView(v);
    });

    $('#save-status').addEventListener('click', () => {
      if (state.pendingDir) reconnectFolder();
      else showView('data');
    });

    // Delegated actions (empty states, links)
    document.addEventListener('click', e => {
      const a = e.target.closest('[data-action]');
      if (!a) return;
      e.preventDefault();
      const act = a.dataset.action;
      if (act === 'add') openTxDialog();
      else if (act === 'edit-budgets') openBudgetDialog();
      else if (act === 'sample') { $$('dialog[open]').forEach(d => d.close()); loadSample(); }
      else if (act === 'goto-data') { $$('dialog[open]').forEach(d => d.close()); showView('data'); }
      else if (act === 'budget-helper') { $('#budget-dialog').close(); openHelper(); }
    });

    // Budget home
    const setBudgetMonth = ym => { state.budgetMonth = ym === currentMonth() ? null : ym; renderBudgetHome(); };
    $('#bm-prev').addEventListener('click', () => setBudgetMonth(shiftMonth(state.budgetMonth || currentMonth(), -1)));
    $('#bm-next').addEventListener('click', () => setBudgetMonth(shiftMonth(state.budgetMonth || currentMonth(), 1)));
    $('#bm-today').addEventListener('click', () => setBudgetMonth(currentMonth()));
    $('#budget-home').addEventListener('click', e => {
      const ym = state.budgetMonth || currentMonth();
      const f = e.target.closest('[data-filter-cat]');
      const add = e.target.closest('[data-add-cat]');
      const bf = e.target.closest('[data-budget-for]');
      const li = e.target.closest('li[data-id]');
      if (add) openTxDialog(null, { category: add.dataset.addCat });
      else if (bf) openBudgetDialog(bf.dataset.budgetFor, Number(bf.dataset.suggest));
      else if (f) showTransactionsFor(f.dataset.filterCat, ym);
      else if (li) openTxDialog(li.dataset.id);
    });

    // Edit budget dialog
    $('#be-add').addEventListener('click', () => {
      $('#be-rows').insertAdjacentHTML('beforeend', beRow());
      $$('#be-rows .be-cat').pop().focus();
    });
    $('#be-rows').addEventListener('click', e => {
      const d = e.target.closest('.be-del');
      if (d) { d.closest('.be-row').remove(); updateBudgetTotal(); }
    });
    $('#be-rows').addEventListener('input', updateBudgetTotal);
    $('#be-cancel').addEventListener('click', () => $('#budget-dialog').close());
    $('#budget-edit-form').addEventListener('submit', e => { e.preventDefault(); saveBudgetDialog(); });

    // Reports
    $('#dash-period').addEventListener('change', renderReports);
    $('#trend-chart').addEventListener('click', e => {
      const g = e.target.closest('.col');
      if (g) { $('#dash-period').value = g.dataset.month; renderReports(); }
    });
    $('#category-chart').addEventListener('click', e => {
      const b = e.target.closest('.hbar[data-category]');
      if (b) showTransactionsFor(b.dataset.category, b.dataset.period);
    });

    // Transactions
    $('#btn-add-tx').addEventListener('click', () => openTxDialog());
    ['#f-search', '#f-month', '#f-category', '#f-type'].forEach(s => $(s).addEventListener('input', renderTransactions));
    $$('.tx-table th.sortable').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.sort;
      state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === 'date' || k === 'amount' ? -1 : 1 };
      renderTransactions();
    }));
    $('#tx-body').addEventListener('click', e => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) openTxDialog(tr.dataset.id);
    });

    // Transaction dialog
    $('#tx-form').addEventListener('submit', e => { e.preventDefault(); saveTxFromForm(); });
    $('#tx-cancel').addEventListener('click', () => $('#tx-dialog').close());
    $('#tx-delete').addEventListener('click', () => {
      const t = state.tx.find(x => x.id === state.editingId);
      if (!t || !confirm(`Delete "${t.description}" (${money(t.amount)})?`)) return;
      state.tx = state.tx.filter(x => x.id !== t.id);
      $('#tx-dialog').close();
      persist();
      toast('Transaction deleted');
    });
    $('#tx-form').elements.description.addEventListener('change', e => {
      const catInput = $('#tx-form').elements.category;
      if (!catInput.value) {
        const s = suggestCategory(e.target.value);
        if (s) catInput.value = s;
      }
    });

    // Budget helper
    $('#helper-basis').addEventListener('change', buildHelper);
    $('#helper-goal').addEventListener('change', suggestBudgets);
    $('#helper-rows').addEventListener('change', e => {
      const k = e.target.dataset.kind;
      if (k != null) {
        const r = helperState.rows[k];
        r.kind = e.target.value;
        helperState.kinds[r.category] = r.kind;
        suggestBudgets();
      }
    });
    $('#helper-rows').addEventListener('input', e => {
      const i = e.target.dataset.budget;
      if (i != null) { helperState.rows[i].budget = Math.max(0, parseAmount(e.target.value) || 0); renderHelperSummary(); }
    });
    $('#helper-form').addEventListener('submit', e => { e.preventDefault(); saveHelper(); });
    $('#helper-cancel').addEventListener('click', () => $('#helper-dialog').close());

    // Data
    $('#btn-open-folder').addEventListener('click', chooseFolder);
    $('#btn-reconnect').addEventListener('click', reconnectFolder);
    $('#btn-disconnect').addEventListener('click', disconnectFolder);
    $('#btn-download-tx').addEventListener('click', () => exportFiles('tx'));
    $('#btn-download-budgets').addEventListener('click', () => exportFiles('budgets'));

    // Export menu
    const menu = $('#export-menu'), exportBtn = $('#btn-export');
    const setMenu = open => { menu.hidden = !open; exportBtn.setAttribute('aria-expanded', String(open)); };
    exportBtn.addEventListener('click', e => { e.stopPropagation(); setMenu(menu.hidden); });
    menu.addEventListener('click', e => {
      const b = e.target.closest('[data-export]');
      if (b) { setMenu(false); exportFiles(b.dataset.export); }
    });
    document.addEventListener('click', e => { if (!e.target.closest('.export-wrap')) setMenu(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
    $('#btn-import-tx').addEventListener('click', startImport);
    $('#btn-import-budgets').addEventListener('click', async () => {
      const f = await pickFile();
      if (!f) return;
      const b = budgetsFromCSV(f.text);
      if (!b.length) { toast('No budgets found — expected columns category,monthly_budget'); return; }
      if (state.budgets.length && !confirm(`Replace your ${state.budgets.length} budgets with ${b.length} from ${f.name}?`)) return;
      state.budgets = b;
      persist();
      toast(`Loaded ${b.length} budgets`);
    });
    $('#set-currency').addEventListener('change', e => {
      state.currency = e.target.value;
      lsSet(LS.currency, state.currency);
      renderAll();
    });
    $('#btn-sample').addEventListener('click', loadSample);
    $('#btn-clear').addEventListener('click', async () => {
      if (!confirm('Remove all transactions and budgets from this browser?\n\nAny connected folder will be disconnected first; its files are not deleted.')) return;
      if (state.dir || state.pendingDir) await disconnectFolder();
      state.tx = [];
      state.budgets = [];
      lsDel(LS.tx);
      lsDel(LS.budgets);
      renderAll();
      toast('All data cleared');
    });

    // Import dialog
    $('#import-map').addEventListener('change', updateImportPreview);
    $('#import-flip').addEventListener('change', updateImportPreview);
    $('#import-form').addEventListener('submit', e => { e.preventDefault(); finishImport(); });
    $('#import-cancel').addEventListener('click', () => { $('#import-dialog').close(); importState = null; });

    let resizeT;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { if ($('#view-reports').classList.contains('active')) renderReports(); }, 150);
    });

    // Warn before leaving if a folder write is still pending.
    window.addEventListener('beforeunload', e => {
      if ($('#save-status').classList.contains('busy')) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function loadSample() {
    const where = state.dir ? ` and the files in "${state.dir.name}"` : '';
    if ((state.tx.length || state.budgets.length) && !confirm(`Replace your current data${where} with sample data?`)) return;
    const s = sampleData();
    state.tx = s.tx;
    state.budgets = s.budgets;
    persist();
    showView('budget');
    toast('Sample data loaded');
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  loadFromBrowser();
  bind();
  renderAll();
  const initial = { dashboard: 'budget', budgets: 'budget' }[location.hash.slice(1)] || location.hash.slice(1);
  if ($(`#view-${initial}`)) showView(initial);
  restoreFolder();
})();
