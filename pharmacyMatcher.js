/**
 * Pharmacy Matcher — integrated with Expiry Tracker DB
 * Matches products from DB.getAllMaster() by barcode (exact/series) or name.
 */

class PharmacyMatcher {
  constructor() {
    this.products = [];
    this._barcodeMap = new Map();
    this._ready = false;
  }

  /**
   * Load products from your existing IndexedDB via DB.getAllMaster().
   * Called automatically after loadPreloadedMasterData() in the boot sequence.
   */
  async init() {
    try {
      this.products = await DB.getAllMaster();
      this._barcodeMap.clear();
      for (const p of this.products) {
        if (p.barcode) this._barcodeMap.set(String(p.barcode).trim(), p);
      }
      this._ready = true;
      console.log(`[PharmacyMatcher] Ready — ${this.products.length} products indexed.`);
    } catch (err) {
      console.error('[PharmacyMatcher] init failed:', err);
    }
  }

  _checkReady() {
    if (!this._ready) throw new Error('PharmacyMatcher not initialised — call await matcher.init() first.');
  }

  // ── 1. EXACT BARCODE MATCH ────────────────────────────────────────────────
  matchExact(code) {
    this._checkReady();
    return this._barcodeMap.get(String(code).trim()) || null;
  }

  // ── 2. SERIES / PARTIAL BARCODE MATCH ────────────────────────────────────
  // e.g. scanner returns "062911091201" → matches "06291109120100"
  matchSeries(code, limit = 10) {
    this._checkReady();
    const query = String(code).trim();
    const results = [];

    for (const p of this.products) {
      const bc = String(p.barcode || '').trim();
      if (bc.startsWith(query) || query.startsWith(bc)) {
        results.push(p);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  // ── 3. NAME SEARCH ────────────────────────────────────────────────────────
  // Scores: exact name (3) → substring match (2) → all words present (1)
  matchByName(query, limit = 10) {
    this._checkReady();
    const q = query.trim().toUpperCase();
    const words = q.split(/\s+/).filter(Boolean);
    const results = [];

    for (const p of this.products) {
      const name = (p.name || '').toUpperCase();
      let score = 0;

      if (name === q)                              score = 3;
      else if (name.includes(q))                   score = 2;
      else if (words.every(w => name.includes(w))) score = 1;

      if (score > 0) results.push({ ...p, _score: score });
    }

    return results
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);
  }

  // ── 4. SMART MATCH — single entry point ───────────────────────────────────
  // Detects whether query is a barcode (digits only) or a name string.
  // Returns { type, results }
  //   type: 'exact_barcode' | 'series_barcode' | 'name' | 'no_match'
  smartMatch(query, limit = 10) {
    this._checkReady();
    const q = String(query).trim();
    const isBarcode = /^\d+$/.test(q);

    if (isBarcode) {
      const exact = this.matchExact(q);
      if (exact) return { type: 'exact_barcode', results: [exact] };

      const series = this.matchSeries(q, limit);
      if (series.length) return { type: 'series_barcode', results: series };
    }

    const byName = this.matchByName(q, limit);
    if (byName.length) return { type: 'name', results: byName };

    return { type: 'no_match', results: [] };
  }
}

// ── SINGLETON ──────────────────────────────────────────────────────────────
const matcher = new PharmacyMatcher();

// ── BOOT SEQUENCE ──────────────────────────────────────────────────────────
// Merges with your existing window load handler.
// loadPreloadedMasterData() runs first, then matcher indexes the DB.
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    setTimeout(async () => {
      await loadPreloadedMasterData(); // your existing function
      await matcher.init();           // indexes DB for matching
    }, 1000);
  });
}

// ── USAGE EXAMPLES ─────────────────────────────────────────────────────────
/*
  // Exact barcode scan:
  matcher.smartMatch('06291109120100');
  // → { type: 'exact_barcode', results: [{ barcode, name: 'Panadol Baby & Infant 100ml...', rms: '220219715' }] }

  // Partial/series barcode (scanner cut off):
  matcher.smartMatch('062911091201');
  // → { type: 'series_barcode', results: [ ...multiple Panadol products... ] }

  // Name search from text input:
  matcher.smartMatch('panadol');
  // → { type: 'name', results: [ ...all Panadol products, sorted by relevance... ] }

  // No match:
  matcher.smartMatch('xyz999');
  // → { type: 'no_match', results: [] }

  // Direct method access:
  matcher.matchExact('06291109120100');     // → product or null
  matcher.matchSeries('062911091201', 5);  // → up to 5 partial barcode matches
  matcher.matchByName('telfast', 10);      // → up to 10 name matches
*/
