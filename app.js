/**
 * Oasis Pharmacy - Tracker v3.0
 * GS1 Barcode Scanner PWA
 * 
 * Features:
 * - PIN protected editing (5-min timeout)
 * - Master data persists until changed
 * - 10 recent scans on home
 * - CSV export only
 * - Medicine API lookup
 */

const CONFIG = {
  PIN: '9633',
  PIN_TIMEOUT: 5 * 60 * 1000,
  EXPIRY_SOON_DAYS: 90,
  MAX_RECENT_SCANS: 10,
  DEBOUNCE_MS: 2000,
  API: {
    OPEN_FDA: 'https://api.fda.gov/drug/ndc.json',
    DAILYMED: 'https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json',
    OPEN_FOOD_FACTS: 'https://world.openfoodfacts.org/api/v0/product/'
  }
};

const State = {
  scanning: false,
  lastScan: { code: '', time: 0 },
  scanner: null,
  masterData: new Map(),
  masterIndex: { exact: new Map(), last8: new Map() },
  history: [],
  filteredHistory: [],
  currentPage: 'home',
  searchQuery: '',
  activeFilter: 'all',
  pinCallback: null,
  pinInput: '',
  lastPinSuccess: 0,
  editingEntry: null,
  apiLookupEnabled: true,
  hapticEnabled: true
};

// Database
const DB = {
  name: 'oasis-pharmacy-v3',
  version: 1,
  instance: null,
  
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, this.version);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { this.instance = req.result; resolve(); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('history')) {
          const store = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          store.createIndex('gtin14', 'gtin14');
          store.createIndex('gtinBatch', ['gtin14', 'batch']);
        }
        if (!db.objectStoreNames.contains('master')) {
          db.createObjectStore('master', { keyPath: 'gtin' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  },
  
  async put(store, data) {
    return new Promise((resolve, reject) => {
      const tx = this.instance.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  
  async get(store, key) {
    return new Promise((resolve, reject) => {
      const tx = this.instance.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  
  async getAll(store) {
    return new Promise((resolve, reject) => {
      const tx = this.instance.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  
  async delete(store, key) {
    return new Promise((resolve, reject) => {
      const tx = this.instance.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  
  async clear(store) {
    return new Promise((resolve, reject) => {
      const tx = this.instance.transaction(store, 'readwrite');
      const req = tx.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  
  async findByGtinBatch(gtin14, batch) {
    return new Promise((resolve, reject) => {
      const tx = this.instance.transaction('history', 'readonly');
      const idx = tx.objectStore('history').index('gtinBatch');
      const req = idx.get([gtin14, batch || '']);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
};

// Haptic
const Haptic = {
  light() { if (State.hapticEnabled && navigator.vibrate) navigator.vibrate(10); },
  medium() { if (State.hapticEnabled && navigator.vibrate) navigator.vibrate(30); },
  success() { if (State.hapticEnabled && navigator.vibrate) navigator.vibrate([30, 50, 30]); },
  error() { if (State.hapticEnabled && navigator.vibrate) navigator.vibrate([100, 50, 100]); }
};

// GS1 Parsing
function parseGS1(raw) {
  const result = { valid: false, raw, gtin14: '', gtin13: '', expiry: null, expiryFormatted: '', expiryStatus: 'missing', batch: '', serial: '', qty: 1 };
  if (!raw || typeof raw !== 'string') return result;
  
  let code = raw.trim().replace(/\x1d/g, '|');
  
  if (/^\d{8,14}$/.test(code) && !code.includes('(')) {
    result.gtin14 = code.padStart(14, '0');
    result.gtin13 = result.gtin14.startsWith('0') ? result.gtin14.substring(1) : result.gtin14;
    result.valid = true;
    return result;
  }
  
  if (!code.includes('(') && /^\d{2}/.test(code)) {
    code = convertToParenthesized(code);
  }
  
  const gtinMatch = code.match(/\(01\)(\d{12,14})/);
  if (gtinMatch) {
    result.gtin14 = gtinMatch[1].padStart(14, '0');
    result.gtin13 = result.gtin14.startsWith('0') ? result.gtin14.substring(1) : result.gtin14;
    result.valid = true;
  }
  
  const expiryMatch = code.match(/\(17\)(\d{6})/);
  if (expiryMatch) {
    const p = parseExpiryDate(expiryMatch[1]);
    result.expiry = p.iso;
    result.expiryFormatted = p.formatted;
    result.expiryStatus = getExpiryStatus(p.date);
  }
  
  const batchMatch = code.match(/\(10\)([^\(|\x1d]+)/);
  if (batchMatch) result.batch = batchMatch[1].replace(/\|/g, '').trim();
  
  const serialMatch = code.match(/\(21\)([^\(|\x1d]+)/);
  if (serialMatch) result.serial = serialMatch[1].replace(/\|/g, '').trim();
  
  const qtyMatch = code.match(/\(30\)(\d+)/);
  if (qtyMatch) result.qty = parseInt(qtyMatch[1], 10) || 1;
  
  return result;
}

function convertToParenthesized(code) {
  let result = '', pos = 0;
  const aiLengths = { '01': 14, '02': 14, '10': 'v', '11': 6, '13': 6, '15': 6, '17': 6, '20': 2, '21': 'v', '30': 'v', '37': 'v' };
  
  while (pos < code.length) {
    let matched = false;
    for (const [ai, len] of Object.entries(aiLengths)) {
      if (code.substring(pos).startsWith(ai)) {
        pos += ai.length;
        let value;
        if (len === 'v') {
          const sep = code.indexOf('|', pos);
          value = sep !== -1 ? code.substring(pos, sep) : code.substring(pos);
          pos = sep !== -1 ? sep + 1 : code.length;
        } else {
          value = code.substring(pos, pos + len);
          pos += len;
        }
        result += `(${ai})${value}`;
        matched = true;
        break;
      }
    }
    if (!matched) pos++;
  }
  return result || code;
}

function parseExpiryDate(yymmdd) {
  const yy = parseInt(yymmdd.substring(0, 2), 10);
  const mm = parseInt(yymmdd.substring(2, 4), 10);
  let dd = parseInt(yymmdd.substring(4, 6), 10);
  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  if (dd === 0) dd = new Date(year, mm, 0).getDate();
  const date = new Date(year, mm - 1, dd);
  return {
    date,
    iso: date.toISOString().split('T')[0],
    formatted: `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${year}`
  };
}

function getExpiryStatus(date) {
  if (!date) return 'missing';
  const now = new Date(); now.setHours(0,0,0,0);
  const exp = new Date(date); exp.setHours(0,0,0,0);
  const diff = Math.ceil((exp - now) / 86400000);
  if (diff < 0) return 'expired';
  if (diff <= CONFIG.EXPIRY_SOON_DAYS) return 'expiring';
  return 'ok';
}

// Master Data
async function loadMasterData() {
  try {
    const data = await DB.getAll('master');
    State.masterData.clear();
    State.masterIndex.exact.clear();
    State.masterIndex.last8.clear();
    
    data.forEach(item => {
      State.masterData.set(item.gtin, item);
      const g14 = item.gtin.padStart(14, '0');
      State.masterIndex.exact.set(g14, item);
      const l8 = g14.slice(-8);
      if (!State.masterIndex.last8.has(l8)) State.masterIndex.last8.set(l8, []);
      State.masterIndex.last8.get(l8).push(item);
    });
    
    updateMasterStats();
  } catch (err) { console.error('Load master failed:', err); }
}

async function saveMasterData(items) {
  try {
    await DB.clear('master');
    for (const item of items) await DB.put('master', item);
    await DB.put('settings', { key: 'masterUpdated', value: new Date().toISOString() });
    await loadMasterData();
    showToast(`Loaded ${items.length} products`, 'success');
  } catch (err) {
    console.error('Save master failed:', err);
    showToast('Failed to save', 'error');
  }
}

function parseMasterCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const delim = text.includes('\t') ? '\t' : ',';
  const headers = lines[0].toLowerCase().split(delim).map(h => h.trim().replace(/"/g, ''));
  const gtinCol = headers.findIndex(h => /gtin|ean|barcode|code|upc/i.test(h));
  const nameCol = headers.findIndex(h => /name|product|description|item/i.test(h));
  if (gtinCol === -1 || nameCol === -1) { showToast('Need GTIN and Name columns', 'error'); return []; }
  
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(delim).map(v => v.trim().replace(/^"|"$/g, ''));
    if (vals[gtinCol] && vals[nameCol]) {
      items.push({ gtin: vals[gtinCol].replace(/\D/g, '').padStart(14, '0'), name: vals[nameCol] });
    }
  }
  return items;
}

function matchProduct(gtin14) {
  if (State.masterIndex.exact.has(gtin14)) return { product: State.masterIndex.exact.get(gtin14), matchType: 'exact' };
  const l8 = gtin14.slice(-8);
  if (State.masterIndex.last8.has(l8)) {
    const m = State.masterIndex.last8.get(l8);
    if (m.length === 1) return { product: m[0], matchType: 'last8' };
  }
  return { product: null, matchType: 'none' };
}

// API Lookup
async function lookupProductAPI(gtin14) {
  if (!State.apiLookupEnabled || !navigator.onLine) return null;
  
  const ndc = gtin14.substring(3, 13).replace(/^0+/, '');
  const formattedNDC = ndc.padStart(11, '0');
  const ndcDash = `${formattedNDC.slice(0,5)}-${formattedNDC.slice(5,9)}-${formattedNDC.slice(9)}`;
  
  // Try OpenFDA
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${CONFIG.API.OPEN_FDA}?search=packaging.package_ndc:"${ndcDash}"&limit=1`, { signal: ctrl.signal });
    if (res.ok) {
      const data = await res.json();
      if (data.results?.length > 0) {
        const d = data.results[0];
        let name = d.brand_name || d.generic_name || '';
        if (d.active_ingredients?.[0]?.strength) name += ` ${d.active_ingredients[0].strength}`;
        if (d.dosage_form && !name.toLowerCase().includes(d.dosage_form.toLowerCase())) name += ` ${d.dosage_form}`;
        return { name: name.trim(), source: 'OpenFDA' };
      }
    }
  } catch (e) {}
  
  // Try DailyMed
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${CONFIG.API.DAILYMED}?ndc=${ndc}&pagesize=1`, { signal: ctrl.signal });
    if (res.ok) {
      const data = await res.json();
      if (data.data?.length > 0) return { name: data.data[0].title, source: 'DailyMed' };
    }
  } catch (e) {}
  
  // Try OpenFoodFacts
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const barcode = gtin14.replace(/^0+/, '');
    const res = await fetch(`${CONFIG.API.OPEN_FOOD_FACTS}${barcode}.json`, { signal: ctrl.signal });
    if (res.ok) {
      const data = await res.json();
      if (data.status === 1 && data.product?.product_name) return { name: data.product.product_name, source: 'OpenFoodFacts' };
    }
  } catch (e) {}
  
  return null;
}

// History
async function loadHistory() {
  try {
    State.history = await DB.getAll('history');
    State.history.sort((a, b) => new Date(b.scanTime) - new Date(a.scanTime));
    State.history.forEach(e => { if (e.expiry) e.expiryStatus = getExpiryStatus(new Date(e.expiry)); });
    filterHistory();
    renderRecentScans();
    updateStats();
  } catch (err) { console.error('Load history failed:', err); }
}

async function addToHistory(entry) {
  try {
    const existing = await DB.findByGtinBatch(entry.gtin14, entry.batch);
    if (existing) {
      existing.qty = (existing.qty || 1) + (entry.qty || 1);
      existing.scanTime = entry.scanTime;
      await DB.put('history', existing);
      showToast(`Updated qty: ${existing.qty}`, 'success');
    } else {
      await DB.put('history', entry);
      showToast('Added', 'success');
    }
    await loadHistory();
    Haptic.success();
  } catch (err) {
    console.error('Add failed:', err);
    showToast('Failed to save', 'error');
    Haptic.error();
  }
}

async function updateHistoryEntry(entry) {
  try {
    await DB.put('history', entry);
    await loadHistory();
    showToast('Updated', 'success');
  } catch (err) { showToast('Update failed', 'error'); }
}

async function deleteHistoryEntry(id) {
  try {
    await DB.delete('history', id);
    await loadHistory();
    showToast('Deleted', 'success');
  } catch (err) { showToast('Delete failed', 'error'); }
}

function filterHistory() {
  let filtered = [...State.history];
  if (State.searchQuery) {
    const q = State.searchQuery.toLowerCase();
    filtered = filtered.filter(e => 
      (e.name?.toLowerCase().includes(q)) || (e.gtin14?.includes(q)) || (e.batch?.toLowerCase().includes(q))
    );
  }
  if (State.activeFilter !== 'all') filtered = filtered.filter(e => e.expiryStatus === State.activeFilter);
  State.filteredHistory = filtered;
  renderHistory();
}

// Scanner
async function startScanner() {
  const placeholder = document.getElementById('scannerPlaceholder');
  const viewfinder = document.getElementById('viewfinder');
  const btn = document.getElementById('btnScanner');
  const btnText = document.getElementById('btnScannerText');
  
  if (State.scanning) { stopScanner(); return; }
  
  try {
    placeholder.classList.add('hidden');
    viewfinder.classList.add('active');
    btn.classList.add('stop');
    btnText.textContent = 'Stop Scanner';
    
    State.scanner = new Html5Qrcode('reader');
    await State.scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 120 }, aspectRatio: 1.2 },
      onScanSuccess,
      () => {}
    );
    State.scanning = true;
    Haptic.light();
  } catch (err) {
    console.error('Scanner error:', err);
    showToast('Camera access denied', 'error');
    stopScanner();
  }
}

function stopScanner() {
  const placeholder = document.getElementById('scannerPlaceholder');
  const viewfinder = document.getElementById('viewfinder');
  const btn = document.getElementById('btnScanner');
  const btnText = document.getElementById('btnScannerText');
  
  if (State.scanner) { State.scanner.stop().catch(() => {}); State.scanner = null; }
  State.scanning = false;
  placeholder.classList.remove('hidden');
  viewfinder.classList.remove('active');
  btn.classList.remove('stop');
  btnText.textContent = 'Start Scanner';
}

async function onScanSuccess(code) {
  const now = Date.now();
  if (code === State.lastScan.code && now - State.lastScan.time < CONFIG.DEBOUNCE_MS) return;
  State.lastScan = { code, time: now };
  Haptic.medium();
  await processScan(code);
}

async function processScan(code) {
  const parsed = parseGS1(code);
  if (!parsed.valid) { showToast('Invalid barcode', 'error'); Haptic.error(); return; }
  
  const match = matchProduct(parsed.gtin14);
  let name = match.product?.name || '';
  
  if (!name && State.apiLookupEnabled) {
    showToast('Looking up...', 'info');
    const api = await lookupProductAPI(parsed.gtin14);
    if (api) name = api.name;
  }
  
  const entry = {
    gtin14: parsed.gtin14,
    gtin13: parsed.gtin13,
    name: name || `Unknown (${parsed.gtin14.slice(-8)})`,
    expiry: parsed.expiry,
    expiryFormatted: parsed.expiryFormatted,
    expiryStatus: parsed.expiryStatus,
    batch: parsed.batch,
    serial: parsed.serial,
    qty: parsed.qty || 1,
    matchType: match.matchType,
    scanTime: new Date().toISOString(),
    raw: code
  };
  
  await addToHistory(entry);
}

// PIN
function isPinValid() { return (Date.now() - State.lastPinSuccess) < CONFIG.PIN_TIMEOUT; }

function requirePin(callback) {
  if (isPinValid()) { callback(); return; }
  State.pinCallback = callback;
  State.pinInput = '';
  updatePinDots();
  document.getElementById('pinError').classList.remove('show');
  document.getElementById('pinModal').classList.add('show');
}

function onPinKey(key) {
  if (key === 'back') State.pinInput = State.pinInput.slice(0, -1);
  else if (key && State.pinInput.length < 4) State.pinInput += key;
  updatePinDots();
  Haptic.light();
  if (State.pinInput.length === 4) verifyPin();
}

function updatePinDots() {
  document.querySelectorAll('.pin-dot').forEach((d, i) => d.classList.toggle('filled', i < State.pinInput.length));
}

function verifyPin() {
  if (State.pinInput === CONFIG.PIN) {
    State.lastPinSuccess = Date.now();
    document.getElementById('pinModal').classList.remove('show');
    Haptic.success();
    if (State.pinCallback) { State.pinCallback(); State.pinCallback = null; }
  } else {
    document.getElementById('pinError').classList.add('show');
    State.pinInput = '';
    updatePinDots();
    Haptic.error();
  }
}

// Rendering
function renderRecentScans() {
  const container = document.getElementById('recentScans');
  const empty = document.getElementById('emptyRecent');
  const recent = State.history.slice(0, CONFIG.MAX_RECENT_SCANS);
  
  if (recent.length === 0) {
    empty.style.display = 'block';
    container.innerHTML = '';
    container.appendChild(empty);
    return;
  }
  
  empty.style.display = 'none';
  container.innerHTML = recent.map(item => createHistoryItemHTML(item)).join('');
}

function renderHistory() {
  const container = document.getElementById('historyList');
  const empty = document.getElementById('emptyHistory');
  
  if (State.filteredHistory.length === 0) {
    empty.style.display = 'block';
    container.innerHTML = '';
    container.appendChild(empty);
    return;
  }
  
  empty.style.display = 'none';
  container.innerHTML = State.filteredHistory.map(item => createHistoryItemHTML(item)).join('');
}

function createHistoryItemHTML(item) {
  const status = item.expiryStatus || 'ok';
  const badgeText = status === 'expired' ? 'Expired' : status === 'expiring' ? 'Expiring' : 'OK';
  return `
    <div class="history-item ${status}" data-id="${item.id}">
      <div class="item-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
        </svg>
      </div>
      <div class="item-info">
        <div class="item-name">${escapeHtml(item.name || 'Unknown')}</div>
        <div class="item-details">${item.expiryFormatted || 'No expiry'}${item.batch ? ` • ${item.batch}` : ''}</div>
      </div>
      <span class="item-badge badge-${status}">${badgeText}</span>
      <div class="item-qty">${item.qty || 1}</div>
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateStats() {
  const el = document.getElementById('historyCount');
  if (el) el.textContent = State.history.length;
}

function updateMasterStats() {
  const el = document.getElementById('masterCount');
  if (el) el.textContent = State.masterData.size;
}

// Toast
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastWrap');
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'
  };
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-icon">${icons[type] || icons.info}</div><span class="toast-msg">${msg}</span>`;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Export CSV only
function exportCSV() {
  if (State.history.length === 0) { showToast('No data', 'warning'); return; }
  
  const headers = ['GTIN', 'Name', 'Expiry', 'Batch', 'Qty', 'Status', 'Scanned'];
  const rows = State.history.map(i => [
    i.gtin14, `"${(i.name || '').replace(/"/g, '""')}"`, i.expiryFormatted || '', i.batch || '', i.qty || 1, i.expiryStatus || '', i.scanTime || ''
  ]);
  
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pharmacy-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported', 'success');
}

// Navigation
function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  State.currentPage = page;
  if (page !== 'home' && State.scanning) stopScanner();
  Haptic.light();
}

// Edit Modal
function openEditModal(entry) {
  State.editingEntry = entry;
  document.getElementById('editName').value = entry.name || '';
  document.getElementById('editQty').value = entry.qty || 1;
  document.getElementById('editExpiry').value = entry.expiry || '';
  document.getElementById('editBatch').value = entry.batch || '';
  document.getElementById('editModal').classList.add('show');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
  State.editingEntry = null;
}

async function saveEdit() {
  if (!State.editingEntry) return;
  State.editingEntry.name = document.getElementById('editName').value;
  State.editingEntry.qty = parseInt(document.getElementById('editQty').value, 10) || 1;
  State.editingEntry.expiry = document.getElementById('editExpiry').value;
  State.editingEntry.batch = document.getElementById('editBatch').value;
  
  if (State.editingEntry.expiry) {
    const d = new Date(State.editingEntry.expiry);
    State.editingEntry.expiryStatus = getExpiryStatus(d);
    State.editingEntry.expiryFormatted = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }
  
  await updateHistoryEntry(State.editingEntry);
  closeEditModal();
}

// Confirm Modal
let confirmCallback = null;
function showConfirm(title, msg, cb) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMsg').textContent = msg;
  confirmCallback = cb;
  document.getElementById('confirmModal').classList.add('show');
}
function closeConfirm() {
  document.getElementById('confirmModal').classList.remove('show');
  confirmCallback = null;
}

// Bulk Entry
async function processBulkEntry() {
  const lines = document.getElementById('bulkInput').value.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) { showToast('Enter barcodes', 'warning'); return; }
  
  let total = lines.length, valid = 0, matched = 0;
  
  for (const line of lines) {
    const parsed = parseGS1(line.trim());
    if (parsed.valid) {
      valid++;
      const match = matchProduct(parsed.gtin14);
      let name = match.product?.name || '';
      if (match.product) matched++;
      if (!name && State.apiLookupEnabled) {
        const api = await lookupProductAPI(parsed.gtin14);
        if (api) name = api.name;
      }
      
      await addToHistory({
        gtin14: parsed.gtin14,
        gtin13: parsed.gtin13,
        name: name || `Unknown (${parsed.gtin14.slice(-8)})`,
        expiry: parsed.expiry,
        expiryFormatted: parsed.expiryFormatted,
        expiryStatus: parsed.expiryStatus,
        batch: parsed.batch,
        qty: parsed.qty || 1,
        matchType: match.matchType,
        scanTime: new Date().toISOString(),
        raw: line.trim()
      });
    }
  }
  
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statValid').textContent = valid;
  document.getElementById('statMatched').textContent = matched;
  showToast(`Processed ${valid}/${total}`, 'success');
}

// Side Menu
function closeSideMenu() {
  document.getElementById('sideMenuBg').classList.remove('show');
  document.getElementById('sideMenu').classList.remove('show');
}

// Settings
async function loadSettings() {
  try {
    const api = await DB.get('settings', 'apiLookup');
    if (api !== undefined) {
      State.apiLookupEnabled = api.value;
      document.getElementById('toggleApi').classList.toggle('on', State.apiLookupEnabled);
    }
    const haptic = await DB.get('settings', 'haptic');
    if (haptic !== undefined) {
      State.hapticEnabled = haptic.value;
      document.getElementById('toggleHaptic').classList.toggle('on', State.hapticEnabled);
    }
    const updated = await DB.get('settings', 'masterUpdated');
    if (updated) {
      const d = new Date(updated.value);
      document.getElementById('lastUpdated').textContent = `${d.getDate()}/${d.getMonth()+1}`;
    }
  } catch (e) {}
}

// Event Listeners
function initEventListeners() {
  // Nav
  document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => navigateTo(b.dataset.page)));
  
  // Scanner
  document.getElementById('btnScanner').addEventListener('click', startScanner);
  
  // Manual entry
  document.getElementById('btnManualAdd').addEventListener('click', () => {
    const input = document.getElementById('manualInput');
    if (input.value.trim()) { processScan(input.value.trim()); input.value = ''; }
  });
  document.getElementById('manualInput').addEventListener('keypress', e => { if (e.key === 'Enter') document.getElementById('btnManualAdd').click(); });
  
  // View all
  document.getElementById('viewAllHistory').addEventListener('click', () => navigateTo('history'));
  
  // Search
  document.getElementById('searchInput').addEventListener('input', e => { State.searchQuery = e.target.value; filterHistory(); });
  
  // Filters
  document.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      State.activeFilter = c.dataset.filter;
      filterHistory();
    });
  });
  
  // History item click
  document.addEventListener('click', e => {
    const item = e.target.closest('.history-item');
    if (item) {
      const id = parseInt(item.dataset.id, 10);
      const entry = State.history.find(h => h.id === id);
      if (entry) requirePin(() => openEditModal(entry));
    }
  });
  
  // Bulk
  document.getElementById('btnProcessBulk').addEventListener('click', processBulkEntry);
  document.getElementById('btnClearBulk').addEventListener('click', () => {
    document.getElementById('bulkInput').value = '';
    document.getElementById('statTotal').textContent = '0';
    document.getElementById('statValid').textContent = '0';
    document.getElementById('statMatched').textContent = '0';
  });
  
  // Master upload
  document.getElementById('uploadArea').addEventListener('click', () => document.getElementById('masterFileInput').click());
  document.getElementById('masterFileInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const items = parseMasterCSV(text);
    if (items.length > 0) await saveMasterData(items);
    e.target.value = '';
  });
  
  // Toggles
  document.getElementById('toggleApi').addEventListener('click', function() {
    this.classList.toggle('on');
    State.apiLookupEnabled = this.classList.contains('on');
    DB.put('settings', { key: 'apiLookup', value: State.apiLookupEnabled });
  });
  document.getElementById('toggleHaptic').addEventListener('click', function() {
    this.classList.toggle('on');
    State.hapticEnabled = this.classList.contains('on');
    DB.put('settings', { key: 'haptic', value: State.hapticEnabled });
  });
  
  // Export
  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
  
  // Clear all
  document.getElementById('btnClearAll').addEventListener('click', () => {
    requirePin(() => showConfirm('Clear All', 'Delete all scan history?', async () => {
      await DB.clear('history');
      await loadHistory();
      showToast('Cleared', 'success');
    }));
  });
  
  // PIN
  document.querySelectorAll('.pin-key').forEach(k => k.addEventListener('click', () => onPinKey(k.dataset.key)));
  
  // Edit modal
  document.getElementById('btnCancelEdit').addEventListener('click', closeEditModal);
  document.getElementById('btnSaveEdit').addEventListener('click', saveEdit);
  
  // Confirm modal
  document.getElementById('btnConfirmNo').addEventListener('click', closeConfirm);
  document.getElementById('btnConfirmYes').addEventListener('click', () => { if (confirmCallback) confirmCallback(); closeConfirm(); });
  
  // Side menu
  document.getElementById('btnMenu').addEventListener('click', () => {
    document.getElementById('sideMenuBg').classList.add('show');
    document.getElementById('sideMenu').classList.add('show');
  });
  document.getElementById('sideMenuBg').addEventListener('click', closeSideMenu);
  document.getElementById('menuExport').addEventListener('click', () => { closeSideMenu(); exportCSV(); });
  document.getElementById('menuClear').addEventListener('click', () => {
    closeSideMenu();
    requirePin(() => showConfirm('Clear', 'Delete all history?', async () => { await DB.clear('history'); await loadHistory(); showToast('Cleared', 'success'); }));
  });
  document.getElementById('menuAbout').addEventListener('click', () => { closeSideMenu(); showToast('Oasis Pharmacy v3.0', 'info'); });
  
  // Offline
  window.addEventListener('online', () => document.getElementById('offlineTag').classList.remove('show'));
  window.addEventListener('offline', () => document.getElementById('offlineTag').classList.add('show'));
}

// Init
async function init() {
  try {
    await DB.init();
    await loadMasterData();
    await loadHistory();
    await loadSettings();
    initEventListeners();
    
    if (!navigator.onLine) document.getElementById('offlineTag').classList.add('show');
    
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(e => console.error('SW failed:', e));
    }
    
    console.log('✅ Oasis Pharmacy v3.0 ready');
  } catch (err) {
    console.error('Init failed:', err);
    showToast('Failed to start', 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
