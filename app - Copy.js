// ============================================================
//  app.js  –  Expiry Tracker PWA  (uses db.js)
// ============================================================

import {
  openDB,
  addProduct,
  updateProduct,
  deleteProduct,
  getProduct,
  getAllProducts,
  getSummary,
  importProducts,
  exportProducts,
  computeStatus,
  daysUntilExpiry,
} from './db.js';

// ── State ───────────────────────────────────────────────────
let currentFilter  = { category: '', status: '' };
let editingId      = null;
let notifPermission = Notification.permission;

// ── Boot ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await openDB();
  registerServiceWorker();
  bindUI();
  await refreshAll();
  scheduleExpiryNotifications();
});

// ── Service Worker ──────────────────────────────────────────
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(r => console.log('[SW] registered', r.scope))
      .catch(e => console.warn('[SW] error', e));
  }
}

// ── UI Binding ──────────────────────────────────────────────
function bindUI() {
  // Nav tabs
  document.querySelectorAll('.nav-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );

  // Add / Edit form
  document.getElementById('product-form')
    .addEventListener('submit', handleFormSubmit);

  document.getElementById('cancel-edit-btn')
    .addEventListener('click', resetForm);

  // Filters
  document.getElementById('filter-category')
    .addEventListener('change', applyFilter);
  document.getElementById('filter-status')
    .addEventListener('change', applyFilter);
  document.getElementById('search-input')
    .addEventListener('input',  handleSearch);

  // Import / Export
  document.getElementById('export-btn')
    .addEventListener('click', handleExport);
  document.getElementById('import-btn')
    .addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file')
    .addEventListener('change', handleImport);

  // Notification permission
  document.getElementById('notif-btn')?.addEventListener('click', requestNotifPermission);
}

// ── Tabs ────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.dataset.tab === tab)
  );
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
}

// ── Refresh ─────────────────────────────────────────────────
async function refreshAll() {
  await Promise.all([renderDashboard(), renderProductList()]);
}

// ── Dashboard ───────────────────────────────────────────────
async function renderDashboard() {
  const summary = await getSummary();
  setText('stat-total',   summary.total);
  setText('stat-fresh',   summary.fresh   || 0);
  setText('stat-warning', summary.warning || 0);
  setText('stat-expired', summary.expired || 0);

  // Upcoming expiry list (next 14 days)
  const upcoming = (await getAllProducts())
    .filter(p => {
      const d = daysUntilExpiry(p.expiryDate);
      return d !== null && d >= 0 && d <= 14;
    })
    .sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));

  const container = document.getElementById('upcoming-list');
  container.innerHTML = upcoming.length
    ? upcoming.map(p => upcomingCard(p)).join('')
    : '<p class="empty-msg">No items expiring in the next 14 days 🎉</p>';
}

function upcomingCard(p) {
  const days = daysUntilExpiry(p.expiryDate);
  return `
    <div class="upcoming-card status-${p.status}">
      <span class="item-name">${esc(p.name)}</span>
      <span class="item-days">${days === 0 ? 'Today!' : `${days}d`}</span>
    </div>`;
}

// ── Product List ─────────────────────────────────────────────
async function renderProductList(searchTerm = '') {
  const products = await getAllProducts(currentFilter);
  const filtered = searchTerm
    ? products.filter(p =>
        p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.category?.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : products;

  // Sort: expired first, then warning, then fresh; within group by date
  filtered.sort((a, b) => {
    const order = { expired: 0, warning: 1, fresh: 2 };
    const diff  = (order[a.status] ?? 3) - (order[b.status] ?? 3);
    return diff !== 0 ? diff : new Date(a.expiryDate) - new Date(b.expiryDate);
  });

  const container = document.getElementById('product-list');
  container.innerHTML = filtered.length
    ? filtered.map(p => productCard(p)).join('')
    : '<p class="empty-msg">No products found.</p>';

  // Bind card buttons
  container.querySelectorAll('.edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEditForm(Number(btn.dataset.id)))
  );
  container.querySelectorAll('.delete-btn').forEach(btn =>
    btn.addEventListener('click', () => handleDelete(Number(btn.dataset.id)))
  );
}

function productCard(p) {
  const days  = daysUntilExpiry(p.expiryDate);
  const label = days === null   ? '–'
              : days < 0        ? `Expired ${Math.abs(days)}d ago`
              : days === 0      ? 'Expires today!'
              :                   `${days} day${days !== 1 ? 's' : ''} left`;

  return `
    <div class="product-card status-${p.status}" data-id="${p.id}">
      <div class="card-header">
        <span class="badge badge-${p.status}">${p.status}</span>
        <span class="card-category">${esc(p.category || 'General')}</span>
      </div>
      <h3 class="card-name">${esc(p.name)}</h3>
      ${p.brand ? `<p class="card-brand">${esc(p.brand)}</p>` : ''}
      <div class="card-dates">
        <div class="date-row">
          <span class="date-label">Expiry</span>
          <span class="date-value">${formatDate(p.expiryDate)}</span>
        </div>
        ${p.openedDate ? `
        <div class="date-row">
          <span class="date-label">Opened</span>
          <span class="date-value">${formatDate(p.openedDate)}</span>
        </div>` : ''}
      </div>
      <p class="card-countdown status-text-${p.status}">${label}</p>
      ${p.notes ? `<p class="card-notes">${esc(p.notes)}</p>` : ''}
      <div class="card-actions">
        <button class="btn-icon edit-btn"   data-id="${p.id}" title="Edit">✏️</button>
        <button class="btn-icon delete-btn" data-id="${p.id}" title="Delete">🗑️</button>
      </div>
    </div>`;
}

// ── Form ─────────────────────────────────────────────────────
async function handleFormSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const data = {
    name:        form.elements['name'].value.trim(),
    brand:       form.elements['brand'].value.trim(),
    category:    form.elements['category'].value,
    expiryDate:  form.elements['expiryDate'].value,
    openedDate:  form.elements['openedDate'].value || null,
    notes:       form.elements['notes'].value.trim(),
  };

  if (!data.name || !data.expiryDate) {
    showToast('Name and expiry date are required.', 'error');
    return;
  }

  try {
    if (editingId !== null) {
      await updateProduct({ ...data, id: editingId });
      showToast('Product updated ✅');
    } else {
      await addProduct(data);
      showToast('Product added ✅');
    }
    resetForm();
    await refreshAll();
    switchTab('list');
  } catch (err) {
    console.error(err);
    showToast('Something went wrong.', 'error');
  }
}

async function openEditForm(id) {
  const product = await getProduct(id);
  if (!product) return;

  editingId = id;
  const form = document.getElementById('product-form');
  form.elements['name'].value       = product.name        || '';
  form.elements['brand'].value      = product.brand       || '';
  form.elements['category'].value   = product.category    || '';
  form.elements['expiryDate'].value = product.expiryDate  || '';
  form.elements['openedDate'].value = product.openedDate  || '';
  form.elements['notes'].value      = product.notes       || '';

  document.getElementById('form-title').textContent       = 'Edit Product';
  document.getElementById('submit-btn').textContent       = 'Update Product';
  document.getElementById('cancel-edit-btn').style.display = 'inline-flex';

  switchTab('add');
  form.elements['name'].focus();
}

function resetForm() {
  editingId = null;
  document.getElementById('product-form').reset();
  document.getElementById('form-title').textContent       = 'Add New Product';
  document.getElementById('submit-btn').textContent       = 'Add Product';
  document.getElementById('cancel-edit-btn').style.display = 'none';
}

// ── Delete ──────────────────────────────────────────────────
async function handleDelete(id) {
  if (!confirm('Delete this product?')) return;
  await deleteProduct(id);
  showToast('Product deleted 🗑️');
  await refreshAll();
}

// ── Filters & Search ────────────────────────────────────────
function applyFilter() {
  currentFilter.category = document.getElementById('filter-category').value;
  currentFilter.status   = document.getElementById('filter-status').value;
  renderProductList(document.getElementById('search-input').value);
}

function handleSearch(e) {
  renderProductList(e.target.value);
}

// ── Import / Export ─────────────────────────────────────────
async function handleExport() {
  const json = await exportProducts();
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `expiry-tracker-${today()}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported! 📦');
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text     = await file.text();
    const products = JSON.parse(text);
    if (!Array.isArray(products)) throw new Error('Expected JSON array');
    await importProducts(products.map(({ id, addedAt, status, ...rest }) => rest)); // strip meta
    showToast(`Imported ${products.length} products ✅`);
    await refreshAll();
  } catch (err) {
    showToast('Import failed – invalid file.', 'error');
    console.error(err);
  }
  e.target.value = '';
}

// ── Notifications ────────────────────────────────────────────
async function requestNotifPermission() {
  if (!('Notification' in window)) return showToast('Notifications not supported', 'error');
  const result = await Notification.requestPermission();
  notifPermission = result;
  showToast(result === 'granted' ? 'Notifications enabled 🔔' : 'Permission denied', result === 'granted' ? 'success' : 'error');
}

async function scheduleExpiryNotifications() {
  if (notifPermission !== 'granted') return;

  const products = await getAllProducts({ status: 'warning' });
  products.forEach(p => {
    const days = daysUntilExpiry(p.expiryDate);
    new Notification(`⚠️ ${p.name} expires soon!`, {
      body: `${days} day${days !== 1 ? 's' : ''} remaining`,
      icon: './icons/icon-192.png',
      tag:  `expiry-${p.id}`,
    });
  });
}

// ── Utilities ────────────────────────────────────────────────
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(str) {
  if (!str) return '–';
  return new Date(str).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

function today() {
  return new Date().toISOString().split('T')[0];
}

let toastTimer;
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent    = msg;
  toast.className      = `toast toast-${type} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}
