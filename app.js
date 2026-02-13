/**
 * BOOTS PHARMACY - Backwall Tracker v4.2.0
 * 
 * Features:
 * - Enter key → next field navigation
 * - Full edit modal (name, batch, expiry, qty, rms, photo)
 * - Master database viewer & editor
 * - Search by GTIN/Barcode/RMS
 * - Timestamp on entries
 * - Photo capture
 * - Pre-loaded 18,124 products
 */

const CONFIG = {
  EXPIRY_SOON_DAYS: 90,
  DB_NAME: 'PharmacyTrackerDB',
  DB_VERSION: 4
};

const State = {
  db: null,
  masterIndex: { exact: new Map(), last8: new Map(), rms: new Map(), all: [] },
  currentFilter: 'all',
  searchQuery: '',
  scannerActive: false,
  html5QrCode: null,
  availableCameras: [],
  currentCameraIndex: 0
};

// ========================================
// DATABASE
// ========================================
const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      
      request.onerror = () => reject(request.error);
      
      request.onsuccess = () => {
        State.db = request.result;
        console.log('Database opened');
        resolve();
      };
      
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          historyStore.createIndex('timestamp', 'timestamp', { unique: false });
          historyStore.createIndex('gtin14', 'gtin14', { unique: false });
          historyStore.createIndex('gtinBatch', ['gtin14', 'batch'], { unique: false });
        }
        
        if (!db.objectStoreNames.contains('master')) {
          const masterStore = db.createObjectStore('master', { keyPath: 'barcode' });
          masterStore.createIndex('name', 'name', { unique: false });
          masterStore.createIndex('rms', 'rms', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  },
  
  async addHistory(item) {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      const request = store.add(item);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  
  async updateHistory(item) {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      const request = store.put(item);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },
  
  async getHistory(id) {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('history', 'readonly');
      const store = tx.objectStore('history');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  
  async deleteHistory(id) {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },
  
  async getAllHistory() {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('history', 'readonly');
      const store = tx.objectStore('history');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },
  
  async findByGtinBatch(gtin14, batch) {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('history', 'readonly');
      const store = tx.objectStore('history');
      const index = store.index('gtinBatch');
      const request = index.get([gtin14, batch || '']);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  
  async clearHistory() {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },
  
  async addMaster(item) {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('master', 'readwrite');
      const store = tx.objectStore('master');
      const request = store.put(item);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },
  
  async getMaster(barcode) {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('master', 'readonly');
      const store = tx.objectStore('master');
      const request = store.get(barcode);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  
  async deleteMaster(barcode) {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('master', 'readwrite');
      const store = tx.objectStore('master');
      const request = store.delete(barcode);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },
  
  async getAllMaster() {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('master', 'readonly');
      const store = tx.objectStore('master');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },
  
  async clearMaster() {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('master', 'readwrite');
      const store = tx.objectStore('master');
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },
  
  async addMasterBulk(items) {
    return new Promise((resolve, reject) => {
      const tx = State.db.transaction('master', 'readwrite');
      const store = tx.objectStore('master');
      let count = 0;
      
      for (const item of items) {
        store.put(item);
        count++;
      }
      
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  }
};

// ========================================
// GS1 PARSER
// ========================================
function parseGS1(code) {
  const result = {
    raw: code,
    gtin14: '',
    gtin13: '',
    expiryISO: '',
    expiryDDMMYY: '',
    expiryDisplay: '',
    batch: '',
    serial: '',
    qty: 1,
    isGS1: false
  };
  
  if (!code || typeof code !== 'string') return result;
  
  code = code.trim().replace(/[\r\n]/g, '');
  
  // Parentheses format
  if (code.includes('(')) {
    result.isGS1 = true;
    
    const gtinMatch = code.match(/\(01\)(\d{14})/);
    if (gtinMatch) {
      result.gtin14 = gtinMatch[1];
      result.gtin13 = result.gtin14.startsWith('0') ? result.gtin14.slice(1) : result.gtin14;
    }
    
    const expiryMatch = code.match(/\(17\)(\d{6})/);
    if (expiryMatch) {
      const parsed = parseExpiryDate(expiryMatch[1]);
      result.expiryISO = parsed.iso;
      result.expiryDDMMYY = parsed.ddmmyy;
      result.expiryDisplay = parsed.display;
    }
    
    const batchMatch = code.match(/\(10\)([^\(]+)/);
    if (batchMatch) {
      result.batch = batchMatch[1].trim();
    }
    
    const serialMatch = code.match(/\(21\)([^\(]+)/);
    if (serialMatch) {
      result.serial = serialMatch[1].trim();
    }
    
    const qtyMatch = code.match(/\(30\)(\d+)/);
    if (qtyMatch) {
      result.qty = parseInt(qtyMatch[1]) || 1;
    }
  }
  // Raw GS1 format
  else if (code.match(/^01\d{14}/)) {
    result.isGS1 = true;
    
    result.gtin14 = code.substring(2, 16);
    result.gtin13 = result.gtin14.startsWith('0') ? result.gtin14.slice(1) : result.gtin14;
    
    let remaining = code.substring(16);
    
    // Expiry (17)
    const exp17Idx = remaining.indexOf('17');
    if (exp17Idx !== -1 && remaining.length >= exp17Idx + 8) {
      const yymmdd = remaining.substring(exp17Idx + 2, exp17Idx + 8);
      if (/^\d{6}$/.test(yymmdd)) {
        const parsed = parseExpiryDate(yymmdd);
        result.expiryISO = parsed.iso;
        result.expiryDDMMYY = parsed.ddmmyy;
        result.expiryDisplay = parsed.display;
        remaining = remaining.substring(0, exp17Idx) + remaining.substring(exp17Idx + 8);
      }
    }
    
    // Batch (10)
    const batch10Idx = remaining.indexOf('10');
    if (batch10Idx !== -1) {
      let batchStart = batch10Idx + 2;
      let batchEnd = remaining.length;
      
      ['21', '30', '37'].forEach(ai => {
        const idx = remaining.indexOf(ai, batchStart);
        if (idx !== -1 && idx < batchEnd) batchEnd = idx;
      });
      
      result.batch = remaining.substring(batchStart, batchEnd).trim();
    }
  }
  // Plain barcode
  else {
    const digits = code.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 14) {
      result.gtin14 = digits.padStart(14, '0');
      result.gtin13 = result.gtin14.startsWith('0') ? result.gtin14.slice(1) : result.gtin14;
    } else if (digits.length >= 5) {
      result.gtin14 = digits.padStart(14, '0');
      result.gtin13 = digits;
    }
  }
  
  return result;
}

function parseExpiryDate(yymmdd) {
  const yy = parseInt(yymmdd.substring(0, 2));
  const mm = parseInt(yymmdd.substring(2, 4));
  let dd = parseInt(yymmdd.substring(4, 6));
  
  const year = 2000 + yy;
  
  if (dd === 0) {
    dd = new Date(year, mm, 0).getDate();
  }
  
  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const ddmmyy = `${String(dd).padStart(2, '0')}${String(mm).padStart(2, '0')}${String(yy).padStart(2, '0')}`;
  const display = `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${year}`;
  
  return { iso, ddmmyy, display };
}

function getExpiryStatus(expiryISO) {
  if (!expiryISO) return 'unknown';
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const expiry = new Date(expiryISO);
  expiry.setHours(0, 0, 0, 0);
  
  const diffDays = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) return 'expired';
  if (diffDays <= CONFIG.EXPIRY_SOON_DAYS) return 'expiring';
  return 'ok';
}

// ========================================
// PRODUCT MATCHING - GTIN/BARCODE/RMS
// ========================================
function buildMasterIndex(masterData) {
  const idx = { exact: new Map(), last8: new Map(), rms: new Map(), all: [] };
  
  for (const item of masterData) {
    const barcode = String(item.barcode || '').replace(/\D/g, '').trim();
    const name = item.name || '';
    const rms = String(item.rms || '').trim();
    
    if (!barcode && !rms) continue;
    if (!name) continue;
    
    // Store by barcode
    if (barcode) {
      idx.exact.set(barcode, name);
      
      const gtin14 = barcode.padStart(14, '0');
      idx.exact.set(gtin14, name);
      
      if (gtin14.startsWith('0')) {
        idx.exact.set(gtin14.slice(1), name);
      }
      
      const noZeros = barcode.replace(/^0+/, '');
      if (noZeros.length >= 5) {
        idx.exact.set(noZeros, name);
      }
      
      if (barcode.length >= 8) {
        const last8 = barcode.slice(-8);
        if (!idx.last8.has(last8)) {
          idx.last8.set(last8, []);
        }
        idx.last8.get(last8).push({ barcode, name });
      }
    }
    
    // Store by RMS code
    if (rms) {
      idx.rms.set(rms, name);
      idx.exact.set(rms, name);
    }
    
    idx.all.push({ barcode, name, rms });
  }
  
  console.log('Master index:', idx.exact.size, 'entries');
  return idx;
}

function matchProduct(gtin14, gtin13, rawCode) {
  const idx = State.masterIndex;
  
  // Try exact matches
  const tryExact = [gtin14, gtin13, rawCode, rawCode?.replace(/\D/g, '')].filter(Boolean);
  for (const code of tryExact) {
    if (idx.exact.has(code)) {
      return { name: idx.exact.get(code), type: 'EXACT' };
    }
    const noZeros = code.replace(/^0+/, '');
    if (noZeros.length >= 5 && idx.exact.has(noZeros)) {
      return { name: idx.exact.get(noZeros), type: 'EXACT' };
    }
  }
  
  // Try RMS match
  if (rawCode && idx.rms.has(rawCode)) {
    return { name: idx.rms.get(rawCode), type: 'RMS' };
  }
  
  // Try last 8 digits
  if (gtin14) {
    const last8 = gtin14.slice(-8);
    if (idx.last8.has(last8)) {
      const matches = idx.last8.get(last8);
      if (matches.length === 1) {
        return { name: matches[0].name, type: 'LAST8' };
      }
    }
  }
  
  return { name: '', type: 'NONE' };
}

// ========================================
// SCANNER
// ========================================
async function initScanner() {
  try {
    State.availableCameras = await Html5Qrcode.getCameras();
    if (State.availableCameras.length === 0) {
      showToast('No camera found', 'error');
      return false;
    }
    
    const backIdx = State.availableCameras.findIndex(c => 
      c.label.toLowerCase().includes('back') || c.label.toLowerCase().includes('rear')
    );
    State.currentCameraIndex = backIdx >= 0 ? backIdx : 0;
    return true;
  } catch (err) {
    showToast('Camera error', 'error');
    return false;
  }
}

async function startScanner() {
  if (State.scannerActive) {
    await stopScanner();
    return;
  }
  
  if (State.availableCameras.length === 0) {
    if (!await initScanner()) return;
  }
  
  try {
    State.html5QrCode = new Html5Qrcode('reader', { verbose: false });
    
    await State.html5QrCode.start(
      State.availableCameras[State.currentCameraIndex].id,
      {
        fps: 15,
        qrbox: (w, h) => ({ width: Math.floor(Math.min(w, h) * 0.7), height: Math.floor(Math.min(w, h) * 0.7) }),
        formatsToSupport: [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.QR_CODE
        ]
      },
      onScanSuccess,
      () => {}
    );
    
    State.scannerActive = true;
    document.getElementById('btnStartScanner').textContent = '⏹️ Stop';
    document.getElementById('scannerOverlay').style.display = 'flex';
    haptic('medium');
  } catch (err) {
    showToast('Scanner error: ' + err.message, 'error');
  }
}

async function stopScanner() {
  if (!State.scannerActive || !State.html5QrCode) return;
  
  try {
    await State.html5QrCode.stop();
    State.html5QrCode.clear();
  } catch (e) {}
  
  State.scannerActive = false;
  State.html5QrCode = null;
  document.getElementById('btnStartScanner').textContent = '▶️ Start';
  document.getElementById('scannerOverlay').style.display = 'none';
}

async function switchCamera() {
  if (State.availableCameras.length < 2) return;
  State.currentCameraIndex = (State.currentCameraIndex + 1) % State.availableCameras.length;
  if (State.scannerActive) {
    await stopScanner();
    setTimeout(startScanner, 300);
  }
}

async function onScanSuccess(decodedText) {
  await stopScanner();
  haptic('success');
  
  document.getElementById('scanResultData').textContent = decodedText;
  document.getElementById('scanResult').classList.add('show');
  
  const manualInput = document.getElementById('scanManualInput');
  if (manualInput) manualInput.value = decodedText;
  
  await processScan(decodedText);
}

// ========================================
// PROCESS SCAN
// ========================================
async function processScan(code) {
  if (!code?.trim()) {
    showToast('No barcode', 'warning');
    return;
  }
  
  code = code.trim();
  const parsed = parseGS1(code);
  
  if (!parsed.gtin14 && !parsed.gtin13) {
    const digits = code.replace(/\D/g, '');
    if (digits.length >= 5) {
      parsed.gtin14 = digits.padStart(14, '0');
      parsed.gtin13 = digits;
    } else {
      showToast('Invalid barcode', 'error');
      return;
    }
  }
  
  const match = matchProduct(parsed.gtin14, parsed.gtin13, code);
  
  // Check existing
  let existing = null;
  if (parsed.batch) {
    existing = await DB.findByGtinBatch(parsed.gtin14, parsed.batch);
  }
  
  if (existing) {
    existing.qty = (existing.qty || 1) + parsed.qty;
    existing.timestamp = Date.now();
    await DB.updateHistory(existing);
    showToast(`+${parsed.qty} (total: ${existing.qty})`, 'success');
  } else {
    const entry = {
      raw: code,
      gtin14: parsed.gtin14,
      gtin13: parsed.gtin13,
      name: match.name || 'Product Name Unknown',
      matchType: match.type,
      expiryISO: parsed.expiryISO,
      expiryDDMMYY: parsed.expiryDDMMYY,
      expiryDisplay: parsed.expiryDisplay,
      batch: parsed.batch,
      qty: parsed.qty,
      rms: '',
      photo: '',
      timestamp: Date.now()
    };
    
    const id = await DB.addHistory(entry);
    
    if (match.type === 'NONE') {
      showToast('Unknown product - add details', 'warning');
      setTimeout(() => editItem(id), 300);
    } else {
      showToast(`Added: ${entry.name}`, 'success');
    }
  }
  
  await refreshAll();
}

async function processMultipleCodes(text) {
  if (!text?.trim()) return;
  
  const lines = text.trim().split(/[\r\n]+/).filter(l => l.trim());
  showLoading(true);
  
  let processed = 0;
  for (const line of lines) {
    try {
      await processScan(line.trim());
      processed++;
    } catch (e) {}
  }
  
  showLoading(false);
  showToast(`Processed ${processed} items`, 'success');
}

// ========================================
// REFRESH
// ========================================
async function refreshAll() {
  await Promise.all([refreshHistory(), refreshStats(), refreshRecentItems()]);
}

async function refreshHistory() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);
  
  let filtered = history;
  
  if (State.currentFilter !== 'all') {
    filtered = history.filter(h => getExpiryStatus(h.expiryISO) === State.currentFilter);
  }
  
  if (State.searchQuery) {
    const q = State.searchQuery.toLowerCase();
    filtered = filtered.filter(h => 
      h.name?.toLowerCase().includes(q) ||
      h.gtin14?.includes(q) ||
      h.gtin13?.includes(q) ||
      h.batch?.toLowerCase().includes(q) ||
      h.rms?.toLowerCase().includes(q)
    );
  }
  
  renderHistoryList(filtered);
}

function renderHistoryList(items) {
  const container = document.getElementById('historyList');
  if (!container) return;
  
  if (!items?.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-title">No items</div></div>';
    return;
  }
  
  container.innerHTML = items.map(item => {
    const status = getExpiryStatus(item.expiryISO);
    const isUnknown = item.matchType === 'NONE' || item.name === 'Product Name Unknown';
    const time = item.timestamp ? new Date(item.timestamp).toLocaleString() : '';
    
    return `
      <div class="history-item ${status} ${isUnknown ? 'unknown-product' : ''}">
        <div class="item-header">
          <span class="item-name ${isUnknown ? 'needs-update' : ''}">${escapeHtml(item.name)}</span>
          <span class="item-qty">×${item.qty || 1}</span>
        </div>
        <div class="item-details">
          <div class="item-detail"><span class="item-detail-label">GTIN:</span><span class="item-detail-value">${item.gtin13 || item.gtin14 || '-'}</span></div>
          <div class="item-detail"><span class="item-detail-label">Batch:</span><span class="item-detail-value">${item.batch || '-'}</span></div>
          <div class="item-detail"><span class="item-detail-label">Expiry:</span><span class="item-expiry ${status}">${item.expiryDisplay || 'N/A'}</span></div>
          <div class="item-detail"><span class="item-detail-label">Time:</span><span class="item-detail-value" style="font-size:0.65rem;">${time}</span></div>
        </div>
        ${item.photo ? `<div style="margin-top:8px;"><img src="${item.photo}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;"></div>` : ''}
        <div class="item-actions">
          <button class="item-action-btn ${isUnknown ? 'highlight' : ''}" onclick="editItem(${item.id})">✏️ ${isUnknown ? 'Add Details' : 'Edit'}</button>
          <button class="item-action-btn delete" onclick="deleteItem(${item.id})">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

async function refreshRecentItems() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);
  
  const recent = history.slice(0, 3);
  const container = document.getElementById('recentItems');
  if (!container) return;
  
  if (!recent.length) {
    container.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-state-icon">📦</div><div class="empty-state-title">No scans yet</div></div>';
    return;
  }
  
  container.innerHTML = recent.map(item => {
    const status = getExpiryStatus(item.expiryISO);
    return `
      <div class="history-item ${status}" style="margin-bottom:8px;">
        <div class="item-header"><span class="item-name">${escapeHtml(item.name)}</span><span class="item-qty">×${item.qty || 1}</span></div>
        <div class="item-details">
          <div class="item-detail"><span class="item-detail-label">Expiry:</span><span class="item-expiry ${status}">${item.expiryDisplay || 'N/A'}</span></div>
          <div class="item-detail"><span class="item-detail-label">Batch:</span><span class="item-detail-value">${item.batch || '-'}</span></div>
        </div>
      </div>
    `;
  }).join('');
}

async function refreshStats() {
  const history = await DB.getAllHistory();
  let expired = 0, expiring = 0;
  
  history.forEach(h => {
    const s = getExpiryStatus(h.expiryISO);
    if (s === 'expired') expired++;
    else if (s === 'expiring') expiring++;
  });
  
  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  el('statTotal', history.length);
  el('statExpiring', expiring);
  el('statExpired', expired);
}

async function refreshMasterStats() {
  const master = await DB.getAllMaster();
  const el = document.getElementById('masterCount');
  if (el) el.textContent = master.length;
  
  State.masterIndex = buildMasterIndex(master);
}

// ========================================
// EDIT MODAL - Full Featured
// ========================================
async function editItem(id) {
  const item = await DB.getHistory(id);
  if (!item) {
    showToast('Item not found', 'error');
    return;
  }
  
  // Show barcode info
  document.getElementById('editBarcodeDisplay').textContent = item.gtin13 || item.gtin14 || item.raw || '-';
  document.getElementById('editGtin14Display').textContent = item.gtin14 || '-';
  document.getElementById('editTimestampDisplay').textContent = item.timestamp ? new Date(item.timestamp).toLocaleString() : '-';
  
  // Fill form
  document.getElementById('editItemId').value = id;
  document.getElementById('editName').value = item.name === 'Product Name Unknown' ? '' : (item.name || '');
  document.getElementById('editBatch').value = item.batch || '';
  document.getElementById('editExpiry').value = item.expiryISO || '';
  document.getElementById('editQty').value = item.qty || 1;
  document.getElementById('editRms').value = item.rms || '';
  document.getElementById('editPhoto').value = item.photo || '';
  
  // Show photo if exists
  const preview = document.getElementById('photoPreview');
  const img = document.getElementById('photoImg');
  if (item.photo) {
    img.src = item.photo;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }
  
  document.getElementById('editModal').classList.add('show');
  
  // Focus name field
  setTimeout(() => document.getElementById('editName').focus(), 100);
}

async function saveEdit() {
  const id = parseInt(document.getElementById('editItemId').value);
  const name = document.getElementById('editName').value.trim();
  const batch = document.getElementById('editBatch').value.trim();
  const expiryISO = document.getElementById('editExpiry').value;
  const qty = parseInt(document.getElementById('editQty').value) || 1;
  const rms = document.getElementById('editRms').value.trim();
  const photo = document.getElementById('editPhoto').value;
  
  if (!name) {
    showToast('Enter product name', 'warning');
    document.getElementById('editName').focus();
    return;
  }
  
  const item = await DB.getHistory(id);
  if (!item) {
    showToast('Item not found', 'error');
    return;
  }
  
  // Update item
  item.name = name;
  item.batch = batch;
  item.expiryISO = expiryISO;
  item.qty = qty;
  item.rms = rms;
  item.photo = photo;
  item.matchType = 'MANUAL';
  
  // Update expiry display
  if (expiryISO) {
    const [y, m, d] = expiryISO.split('-');
    item.expiryDisplay = `${d}/${m}/${y}`;
    item.expiryDDMMYY = `${d}${m}${y.slice(2)}`;
  }
  
  await DB.updateHistory(item);
  
  // Save ALL barcode variations to master
  const barcodes = new Set();
  if (item.gtin14) barcodes.add(item.gtin14);
  if (item.gtin13) barcodes.add(item.gtin13);
  if (item.raw) {
    const raw = item.raw.replace(/\D/g, '');
    if (raw.length >= 5) barcodes.add(raw);
  }
  
  for (const bc of barcodes) {
    await DB.addMaster({ barcode: bc, name, rms });
  }
  
  // Also save by RMS if provided
  if (rms) {
    await DB.addMaster({ barcode: rms, name, rms });
  }
  
  await refreshMasterStats();
  closeEditModal();
  await refreshAll();
  
  showToast('Saved to database!', 'success');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
}

async function deleteItem(id) {
  if (!confirm('Delete?')) return;
  await DB.deleteHistory(id);
  await refreshAll();
  showToast('Deleted', 'success');
}

// ========================================
// MASTER DATABASE VIEWER
// ========================================
async function openMasterViewer() {
  document.getElementById('masterViewModal').classList.add('show');
  document.getElementById('masterSearchInput').value = '';
  await renderMasterList('');
}

function closeMasterViewer() {
  document.getElementById('masterViewModal').classList.remove('show');
}

async function renderMasterList(searchQuery) {
  const master = await DB.getAllMaster();
  const container = document.getElementById('masterListContainer');
  
  let filtered = master;
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = master.filter(m => 
      m.barcode?.toLowerCase().includes(q) ||
      m.name?.toLowerCase().includes(q) ||
      m.rms?.toLowerCase().includes(q)
    );
  }
  
  // Limit display
  const display = filtered.slice(0, 100);
  
  if (!display.length) {
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">No products found</div>';
    return;
  }
  
  container.innerHTML = display.map(m => `
    <div style="padding:10px;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;align-items:center;">
      <div style="flex:1;">
        <div style="font-weight:600;font-size:0.85rem;">${escapeHtml(m.name || 'No name')}</div>
        <div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-mono);">${m.barcode}${m.rms ? ' | RMS: ' + m.rms : ''}</div>
      </div>
      <button onclick="editMasterItem('${m.barcode}')" style="padding:4px 8px;font-size:0.7rem;border:1px solid var(--border-default);border-radius:4px;background:var(--bg-surface);cursor:pointer;">Edit</button>
    </div>
  `).join('') + (filtered.length > 100 ? `<div style="text-align:center;padding:10px;color:var(--text-muted);">Showing 100 of ${filtered.length}</div>` : '');
}

async function editMasterItem(barcode) {
  const item = await DB.getMaster(barcode);
  if (!item) return;
  
  const newName = prompt('Edit product name:', item.name);
  if (newName !== null && newName.trim()) {
    item.name = newName.trim();
    await DB.addMaster(item);
    await refreshMasterStats();
    await renderMasterList(document.getElementById('masterSearchInput').value);
    showToast('Updated', 'success');
  }
}

// ========================================
// PHOTO CAPTURE
// ========================================
function setupPhotoCapture() {
  const btn = document.getElementById('btnTakePhoto');
  const input = document.getElementById('photoInput');
  
  btn?.addEventListener('click', () => input?.click());
  
  input?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      
      // Compress image
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 300;
        let w = img.width, h = img.height;
        
        if (w > h && w > maxSize) {
          h = (h / w) * maxSize;
          w = maxSize;
        } else if (h > maxSize) {
          w = (w / h) * maxSize;
          h = maxSize;
        }
        
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        
        const compressed = canvas.toDataURL('image/jpeg', 0.7);
        document.getElementById('editPhoto').value = compressed;
        document.getElementById('photoImg').src = compressed;
        document.getElementById('photoPreview').style.display = 'block';
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    
    e.target.value = '';
  });
}

// ========================================
// MASTER DATA UPLOAD
// ========================================
async function uploadMasterFile(file, append = false) {
  showLoading(true);
  
  try {
    const text = await file.text();
    const lines = text.trim().split(/[\r\n]+/);
    
    if (lines.length < 2) {
      showToast('Empty file', 'error');
      showLoading(false);
      return;
    }
    
    const header = lines[0].toLowerCase();
    const delim = header.includes('\t') ? '\t' : ',';
    const headers = header.split(delim).map(h => h.trim().replace(/['"]/g, ''));
    
    const barcodeIdx = headers.findIndex(h => ['barcode', 'gtin', 'ean', 'upc', 'code'].includes(h.replace(/\s/g, '')));
    const nameIdx = headers.findIndex(h => ['name', 'productname', 'description', 'product'].includes(h.replace(/\s/g, '')));
    const rmsIdx = headers.findIndex(h => ['rms', 'rmscode', 'rms_code', 'sku'].includes(h.replace(/\s/g, '')));
    
    if (barcodeIdx === -1) {
      showToast('No barcode column', 'error');
      showLoading(false);
      return;
    }
    
    if (!append) await DB.clearMaster();
    
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(delim).map(c => c.trim().replace(/['"]/g, ''));
      const barcode = cols[barcodeIdx];
      const name = nameIdx >= 0 ? cols[nameIdx] : '';
      const rms = rmsIdx >= 0 ? cols[rmsIdx] : '';
      
      if (barcode) items.push({ barcode, name, rms });
    }
    
    const count = await DB.addMasterBulk(items);
    await refreshMasterStats();
    
    showToast(`${append ? 'Added' : 'Loaded'} ${count} products`, 'success');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
  
  showLoading(false);
}

// ========================================
// EXPORT & BACKUP
// ========================================
async function exportCSV() {
  const history = await DB.getAllHistory();
  if (!history.length) {
    showToast('No data', 'warning');
    return;
  }
  
  const headers = ['RMS', 'BARCODE', 'DESCRIPTION', 'EXPIRY', 'BATCH', 'QTY', 'TIMESTAMP'];
  const rows = history.map(h => [
    h.rms || '',
    h.gtin14 || h.gtin13 || '',
    h.name || '',
    h.expiryDDMMYY || '',
    h.batch || '',
    h.qty || 1,
    h.timestamp ? new Date(h.timestamp).toLocaleString() : ''
  ]);
  
  let csv = headers.join(',') + '\n';
  rows.forEach(r => {
    csv += r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n';
  });
  
  downloadFile(csv, `boots-export-${formatDate(new Date())}.csv`, 'text/csv');
  showToast('Downloaded', 'success');
}

async function downloadBackup() {
  const history = await DB.getAllHistory();
  const master = await DB.getAllMaster();
  
  const backup = { version: '4.2.0', timestamp: Date.now(), history, master };
  downloadFile(JSON.stringify(backup), `boots-backup-${formatDate(new Date())}.json`, 'application/json');
  showToast('Backup saved', 'success');
}

async function restoreBackup(file) {
  showLoading(true);
  
  try {
    const backup = JSON.parse(await file.text());
    
    if (backup.history) {
      await DB.clearHistory();
      for (const item of backup.history) {
        delete item.id;
        await DB.addHistory(item);
      }
    }
    
    if (backup.master) {
      await DB.clearMaster();
      await DB.addMasterBulk(backup.master);
    }
    
    await refreshMasterStats();
    await refreshAll();
    showToast('Restored', 'success');
  } catch (err) {
    showToast('Error', 'error');
  }
  
  showLoading(false);
}

// ========================================
// UTILITIES
// ========================================
function showToast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
}

function showLoading(show) {
  document.getElementById('loadingOverlay')?.classList.toggle('show', show);
}

function haptic(type) {
  if (!navigator.vibrate) return;
  const patterns = { light: 10, medium: 30, success: [30, 50, 30], error: [100, 50, 100] };
  navigator.vibrate(patterns[type] || 10);
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function downloadFile(content, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
}

// ========================================
// NAVIGATION
// ========================================
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${pageId}`)?.classList.add('active');
  
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${pageId}"]`)?.classList.add('active');
  
  if (pageId !== 'scan' && State.scannerActive) stopScanner();
  if (pageId === 'scan') document.getElementById('scanResult')?.classList.remove('show');
  
  closeSideMenu();
}

function openSideMenu() {
  document.getElementById('menuOverlay')?.classList.add('show');
  document.getElementById('sideMenu')?.classList.add('show');
}

function closeSideMenu() {
  document.getElementById('menuOverlay')?.classList.remove('show');
  document.getElementById('sideMenu')?.classList.remove('show');
}

function updateOnlineStatus() {
  const el = document.getElementById('onlineStatus');
  if (el) {
    el.textContent = navigator.onLine ? '● Online' : '○ Offline';
    el.className = `online-status ${navigator.onLine ? 'online' : 'offline'}`;
  }
}

// ========================================
// ENTER KEY → NEXT FIELD
// ========================================
function setupEnterKeyNavigation() {
  document.querySelectorAll('.edit-field').forEach(field => {
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const nextId = field.dataset.next;
        if (nextId) {
          const next = document.getElementById(nextId);
          if (next) next.focus();
        }
      }
    });
  });
}

// ========================================
// EVENT LISTENERS
// ========================================
function setupEventListeners() {
  // Navigation
  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', () => showPage(el.dataset.page));
  });
  
  // Menu
  document.getElementById('btnMenu')?.addEventListener('click', openSideMenu);
  document.getElementById('menuOverlay')?.addEventListener('click', closeSideMenu);
  document.getElementById('closeSideMenu')?.addEventListener('click', closeSideMenu);
  
  // Scanner
  document.getElementById('btnStartScanner')?.addEventListener('click', startScanner);
  document.getElementById('btnSwitchCamera')?.addEventListener('click', switchCamera);
  document.getElementById('btnUploadImage')?.addEventListener('click', () => document.getElementById('fileInputImage')?.click());
  
  // Manual entry
  document.getElementById('btnProcessManual')?.addEventListener('click', () => {
    const input = document.getElementById('scanManualInput');
    if (input?.value.trim()) {
      processScan(input.value.trim());
      input.value = '';
    }
  });
  
  document.getElementById('btnProcessPaste')?.addEventListener('click', () => {
    const input = document.getElementById('pasteInput');
    if (input?.value.trim()) {
      processMultipleCodes(input.value.trim());
      input.value = '';
    }
  });
  
  // Search & filter
  document.getElementById('searchHistory')?.addEventListener('input', (e) => {
    State.searchQuery = e.target.value;
    refreshHistory();
  });
  
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      State.currentFilter = tab.dataset.filter;
      refreshHistory();
    });
  });
  
  // Master data
  document.getElementById('btnViewMaster')?.addEventListener('click', openMasterViewer);
  document.getElementById('closeMasterView')?.addEventListener('click', closeMasterViewer);
  document.getElementById('closeMasterViewBtn')?.addEventListener('click', closeMasterViewer);
  document.getElementById('masterSearchInput')?.addEventListener('input', (e) => renderMasterList(e.target.value));
  document.getElementById('masterViewModal')?.addEventListener('click', (e) => { if (e.target.id === 'masterViewModal') closeMasterViewer(); });
  
  document.getElementById('btnUploadMaster')?.addEventListener('click', () => document.getElementById('fileInputMaster')?.click());
  document.getElementById('fileInputMaster')?.addEventListener('change', (e) => { if (e.target.files[0]) { uploadMasterFile(e.target.files[0], false); e.target.value = ''; } });
  
  document.getElementById('btnAppendMaster')?.addEventListener('click', () => document.getElementById('fileInputAppend')?.click());
  document.getElementById('fileInputAppend')?.addEventListener('change', (e) => { if (e.target.files[0]) { uploadMasterFile(e.target.files[0], true); e.target.value = ''; } });
  
  document.getElementById('fileInputImage')?.addEventListener('change', (e) => {
    if (e.target.files[0]) {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const tempScanner = new Html5Qrcode('reader');
        try {
          const result = await tempScanner.scanFile(e.target.files[0], false);
          tempScanner.clear();
          document.getElementById('scanResultData').textContent = result;
          document.getElementById('scanResult').classList.add('show');
          document.getElementById('scanManualInput').value = result;
          await processScan(result);
        } catch (err) {
          showToast('Cannot read barcode', 'error');
        }
      };
      reader.readAsDataURL(e.target.files[0]);
      e.target.value = '';
    }
  });
  
  // Export & backup
  document.getElementById('btnExportCSV')?.addEventListener('click', exportCSV);
  document.getElementById('menuExport')?.addEventListener('click', () => { closeSideMenu(); exportCSV(); });
  document.getElementById('btnBackup')?.addEventListener('click', downloadBackup);
  document.getElementById('menuBackup')?.addEventListener('click', () => { closeSideMenu(); downloadBackup(); });
  document.getElementById('btnRestore')?.addEventListener('click', () => document.getElementById('fileInputRestore')?.click());
  document.getElementById('fileInputRestore')?.addEventListener('change', (e) => { if (e.target.files[0]) { restoreBackup(e.target.files[0]); e.target.value = ''; } });
  
  // Clear
  document.getElementById('btnClearHistory')?.addEventListener('click', async () => {
    if (confirm('Clear ALL history?')) {
      await DB.clearHistory();
      await refreshAll();
      showToast('Cleared', 'success');
    }
  });
  
  // Edit modal
  document.getElementById('closeEditModal')?.addEventListener('click', closeEditModal);
  document.getElementById('cancelEdit')?.addEventListener('click', closeEditModal);
  document.getElementById('saveEdit')?.addEventListener('click', saveEdit);
  document.getElementById('editModal')?.addEventListener('click', (e) => { if (e.target.id === 'editModal') closeEditModal(); });
  
  // Photo
  setupPhotoCapture();
  
  // Enter key navigation
  setupEnterKeyNavigation();
  
  // Online status
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
}

// ========================================
// INIT
// ========================================
async function init() {
  console.log('BOOTS PHARMACY v4.2.0');
  
  try {
    await DB.init();
    
    // Load pre-loaded master data
    if (typeof loadPreloadedMasterData === 'function') {
      await loadPreloadedMasterData();
    }
    
    await refreshMasterStats();
    await refreshAll();
    setupEventListeners();
    updateOnlineStatus();
    
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    
    console.log('Ready!');
  } catch (err) {
    console.error('Init error:', err);
    showToast('Init error', 'error');
  }
}

document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
