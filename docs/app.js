'use strict';

/* ============================== Storage ==============================
 * DEFAULT_SCRIPT_URL pre-connects everyone who opens this site to the
 * shared BOM Google Sheet, so no one has to paste the Apps Script URL by
 * hand. Update it here (and redeploy) if the Apps Script is ever
 * redeployed under a new URL.
 */

const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwAzU9wBuMdkF2SEhlvHvqLjbPm--y1CUUP1Q8VD5_Cu8b2na0JxKMqL5Kt9788zDNVsA/exec';

// Deployments that have been replaced. Publishing a *new* deployment (rather
// than a new version of the existing one) mints a new /exec URL and leaves
// the old one serving the old code, so anything still pointing at one of
// these is silently talking to a stale backend. A browser that saved one in
// settings is moved back onto the current default instead.
const RETIRED_SCRIPT_URLS = [
  'https://script.google.com/macros/s/AKfycbwQdBaq0FAH7C6Uj7r7LHL1VCuqLQxqaU1IMHKRLrtFU7EDMl9---Bf5ukckOhbL7RRsA/exec',
];

/** Production departments an order is scheduled through, in flow order. */
const DEPARTMENTS = ['RB', 'GR', 'PT', 'BG', 'PK', 'ST'];

const EMPTY_ADDITIONS = { baseItems: [], packagingCodes: [], colorShades: [], materials: [], customers: [] };

const Store = {
  getScriptUrl() {
    const saved = localStorage.getItem('bomapp.scriptUrl');
    if (!saved || RETIRED_SCRIPT_URLS.includes(saved)) return DEFAULT_SCRIPT_URL;
    return saved;
  },
  setScriptUrl: (v) => localStorage.setItem('bomapp.scriptUrl', v),
  getCreatedBy: () => localStorage.getItem('bomapp.createdBy') || '',
  setCreatedBy: (v) => localStorage.setItem('bomapp.createdBy', v),

  // Codes added from the web that aren't in the bundled reference data yet.
  // Kept locally so they survive a reload; also written to the sheet.
  getLocalAdditions() {
    try {
      return Object.assign({}, EMPTY_ADDITIONS, JSON.parse(localStorage.getItem('bomapp.additions') || '{}'));
    } catch (err) {
      return Object.assign({}, EMPTY_ADDITIONS);
    }
  },
  addLocal(kind, value) {
    const all = Store.getLocalAdditions();
    const list = all[kind];
    if (!list) return;
    const exists = kind === 'materials'
      ? list.some((m) => m.CODE === value.CODE)
      : list.includes(value);
    if (!exists) {
      list.push(value);
      localStorage.setItem('bomapp.additions', JSON.stringify(all));
    }
  },
};

/* ================================ API ================================ */

const Api = {
  async get(action, params) {
    const url = new URL(Store.getScriptUrl());
    url.searchParams.set('action', action);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    // Apps Script GET responses (served via script.googleusercontent.com)
    // can get cached by the browser keyed on the exact URL, so a stale
    // bootstrap/orders payload can stick around even after the sheet
    // changes. A cache-busting param plus no-store forces a fresh fetch.
    url.searchParams.set('_ts', Date.now());
    const res = await fetch(url.toString(), { method: 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  },
  async post(action, payload) {
    const res = await fetch(Store.getScriptUrl(), {
      method: 'POST',
      // text/plain avoids a CORS preflight OPTIONS request, which Apps
      // Script web apps cannot answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  },
  ping: () => Api.get('ping'),
  orders: () => Api.get('orders'),
  customers: () => Api.get('customers'),
  saveOrder: (order) => Api.post('saveOrder', { order }),
  addPackagingCode: (code, description) => Api.post('addPackagingCode', { code, description }),
  addColorShade: (code, description) => Api.post('addColorShade', { code, description }),
  addMaterial: (material) => Api.post('addMaterial', { material }),
  addBaseItem: (name) => Api.post('addBaseItem', { name }),
};

/* ============================ Static data =============================
 * Reference data (item list, materials, packaging/color codes, and the
 * per-item recipes) ships with the site and is fetched from the same
 * origin. Deliberately NOT read through Apps Script: that would make the
 * app depend on the Web App deployment being re-published whenever the
 * backend gains a new action — an easy step to miss, and it fails with an
 * opaque "unknown action" error. Apps Script is used only for the write
 * path (saving orders) and for reading back history.
 * Regenerate these files with scripts/build_web_data.py.
 */
const StaticData = {
  async json(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
    return res.json();
  },
  meta: () => StaticData.json('data/meta.json'),
  materials: () => StaticData.json('data/materials.json'),
  recipeIndex: () => StaticData.json('data/recipes/index.json'),
  recipe: (id) => StaticData.json('data/recipes/' + id + '.json'),
};

/* =============================== Toast ================================ */

let toastTimer = null;
function toast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast is-visible' + (kind ? ' is-' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

/* ============================= Combobox ================================
 * A search box + dropdown listbox. Type to filter; click/Enter to select;
 * optionally offers a "+ add new" row when the typed text has no match.
 */
class Combobox {
  constructor(mountEl, opts) {
    this.mount = mountEl;
    this.items = opts.items || []; // [{value, label, sub}]
    this.placeholder = opts.placeholder || '';
    this.onSelect = opts.onSelect || (() => {});
    this.allowCreate = !!opts.allowCreate;
    this.createLabel = opts.createLabel || ((q) => `+ เพิ่มใหม่: "${q}"`);
    this.value = '';
    this.activeIndex = -1;
    this._build();
  }

  _build() {
    this.mount.innerHTML = '';
    this.mount.classList.add('combobox');
    // Lets the shared document-level click handler below reach the
    // instance without every combobox registering its own listener —
    // item cards are rebuilt often, and per-instance listeners would pile
    // up on document for the lifetime of the page.
    this.mount.__combobox = this;
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'combobox-input';
    this.input.placeholder = this.placeholder;
    this.input.autocomplete = 'off';
    this.list = document.createElement('div');
    this.list.className = 'combobox-list';
    this.mount.appendChild(this.input);
    this.mount.appendChild(this.list);

    this.input.addEventListener('focus', () => this._open());
    this.input.addEventListener('input', () => { this._open(); this._render(); });
    this.input.addEventListener('keydown', (e) => this._onKeydown(e));
  }

  setItems(items) {
    this.items = items || [];
    this._render();
  }

  setValue(text) {
    this.input.value = text || '';
    this.value = text || '';
  }

  /** Raw text in the box — use when free text is acceptable (e.g. customer). */
  getText() {
    return this.input.value.trim();
  }

  _open() { this.mount.classList.add('is-open'); this._render(); }
  _close() { this.mount.classList.remove('is-open'); this.activeIndex = -1; }

  _filtered() {
    const q = this.input.value.trim().toLowerCase();
    if (!q) return this.items.slice(0, 60);
    return this.items
      .filter((it) =>
        (it.label && it.label.toLowerCase().includes(q)) ||
        (it.value && String(it.value).toLowerCase().includes(q)) ||
        (it.sub && it.sub.toLowerCase().includes(q)))
      .slice(0, 60);
  }

  _render() {
    const q = this.input.value.trim();
    const results = this._filtered();
    this.list.innerHTML = '';
    this._optionEls = [];

    if (!results.length && !q) {
      this.list.innerHTML = '<div class="combobox-empty">พิมพ์เพื่อค้นหา...</div>';
      return;
    }

    results.forEach((it) => {
      const opt = document.createElement('div');
      opt.className = 'combobox-option';
      opt.innerHTML = `<span class="opt-label"></span>` + (it.sub ? `<span class="opt-sub"></span>` : '');
      opt.querySelector('.opt-label').textContent = it.label;
      if (it.sub) opt.querySelector('.opt-sub').textContent = it.sub;
      opt.addEventListener('mousedown', (e) => { e.preventDefault(); this._select(it); });
      this.list.appendChild(opt);
      this._optionEls.push({ el: opt, item: it });
    });

    const exists = q && results.some((it) => it.label.toLowerCase() === q.toLowerCase());
    if (this.allowCreate && q && !exists) {
      const opt = document.createElement('div');
      opt.className = 'combobox-option opt-create';
      opt.textContent = this.createLabel(q);
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._select({ value: q, label: q, __created: true });
      });
      this.list.appendChild(opt);
      this._optionEls.push({ el: opt, item: { value: q, label: q, __created: true } });
    }

    if (!this._optionEls.length) {
      this.list.innerHTML = '<div class="combobox-empty">ไม่พบรายการ</div>';
    }
  }

  _select(item) {
    this.value = item.value;
    this.input.value = item.label;
    this._close();
    this.onSelect(item);
  }

  _onKeydown(e) {
    if (!this.mount.classList.contains('is-open')) return;
    const opts = this._optionEls || [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.activeIndex = Math.min(this.activeIndex + 1, opts.length - 1);
      this._highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeIndex = Math.max(this.activeIndex - 1, 0);
      this._highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.activeIndex >= 0 && opts[this.activeIndex]) {
        this._select(opts[this.activeIndex].item);
      }
    } else if (e.key === 'Escape') {
      this._close();
    }
  }

  _highlight() {
    (this._optionEls || []).forEach((o, i) => {
      o.el.classList.toggle('is-active', i === this.activeIndex);
      if (i === this.activeIndex) o.el.scrollIntoView({ block: 'nearest' });
    });
  }
}

document.addEventListener('click', (e) => {
  document.querySelectorAll('.combobox.is-open').forEach((el) => {
    if (!el.contains(e.target) && el.__combobox) el.__combobox._close();
  });
});

/* ============================== App State ==============================
 * One order = order header + a per-department schedule + N items, each
 * item carrying its own ordered quantity and its own BOM lines. Required
 * quantities are therefore computed per item (qtyPerFg × that item's
 * quantity) and rolled up across items in the summary table.
 */

const App = {
  data: { materials: [], baseItems: [], packagingCodes: [], colorShades: [], customers: [] },
  recipeIndex: {}, // item name -> recipe file id, from data/recipes/index.json
  recipeVariants: {}, // base model -> [{key, packaging, color}] built from recipeIndex
  items: [], // see makeItem()
  schedule: {}, // dept code -> {start, end}
  itemSeq: 1,
  rowSeq: 1,
  connected: false,
  backendVersion: 'unknown', // 'current' | 'outdated' | 'unknown'
  backendTag: '', // version string reported by the deployed Apps Script
};

DEPARTMENTS.forEach((d) => { App.schedule[d] = { start: '', end: '' }; });

function fmtNum(n) {
  if (n === '' || n === null || n === undefined || isNaN(n)) return '';
  const r = Math.round(n * 1000) / 1000;
  return String(r);
}

/* ---------------------------- View switching ---------------------------- */

function initNav() {
  document.getElementById('topnav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (!btn) return;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    const view = btn.dataset.view;
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + view));
    if (view === 'history') loadHistory();
  });
}

function showNewBomView() {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === 'new'));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-new'));
}

/* ------------------------------ Connection ------------------------------ */

function setStatus(state, text) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusText');
  dot.className = 'status-dot' + (state ? ' is-' + state : '');
  label.textContent = text;
}

/**
 * Loads the bundled reference data. This is what makes the pickers and the
 * recipe lookup work, and it is independent of Google Sheets — so the app
 * is usable even if the Apps Script connection is down.
 */
async function loadStaticData() {
  const [meta, materials, recipeIndex] = await Promise.all([
    StaticData.meta(),
    StaticData.materials(),
    StaticData.recipeIndex(),
  ]);

  App.data.baseItems = meta.baseItems || [];
  App.data.packagingCodes = meta.packagingCodes || [];
  App.data.colorShades = meta.colorShades || [];
  App.data.materials = materials || [];
  App.recipeIndex = recipeIndex || {};
  buildRecipeVariants();

  // Codes the user added from this browser are merged back in so they stay
  // selectable after a reload (they are also written to the sheet).
  const local = Store.getLocalAdditions();
  local.baseItems.forEach((n) => {
    if (!App.data.baseItems.includes(n)) App.data.baseItems.push(n);
  });
  local.packagingCodes.forEach((c) => {
    if (!App.data.packagingCodes.some((r) => r.CODE === c)) App.data.packagingCodes.push({ CODE: c, DESCRIPTION: '' });
  });
  local.colorShades.forEach((c) => {
    if (!App.data.colorShades.some((r) => r.CODE === c)) App.data.colorShades.push({ CODE: c, DESCRIPTION: '' });
  });
  local.materials.forEach((m) => {
    if (!App.data.materials.some((r) => r.CODE === m.CODE)) App.data.materials.push(m);
  });
  local.customers.forEach((c) => mergeCustomer(c));

  refreshMaterialCatalogCache();
  refreshItemPickers();
  refreshCustomerItems();
}

/**
 * Fetches the customer list and, in the same round-trip, tells us which
 * version of the Apps Script backend is actually deployed.
 *
 * `customers` only exists in the multi-item backend, so an "unknown
 * action" reply means the sheet is still running the pre-multi-item code.
 * That code rejects every save from this page (it looks for a single
 * `order.item`), and the raw error it returns is unreadable — so detect it
 * up front and say what to do about it.
 *
 * The customer list itself has no static source file: it is whatever has
 * been used on previous orders, plus any name typed in this browser.
 * Failing to reach the sheet must not break the picker — it stays a
 * free-text combobox either way.
 */
async function probeBackend() {
  try {
    const res = await Api.customers();
    if (res && res.ok && Array.isArray(res.customers)) {
      App.backendVersion = 'current';
      res.customers.forEach(mergeCustomer);
      refreshCustomerItems();
    } else if (res && res.ok === false && /unknown action/i.test(String(res.error || ''))) {
      App.backendVersion = 'outdated';
    } else {
      App.backendVersion = 'unknown';
    }
  } catch (err) {
    App.backendVersion = 'unknown';
  }
  renderBackendStatus();
}

const BACKEND_STATUS_TEXT = {
  current: 'เวอร์ชันล่าสุด (รองรับหลาย Item) ✓',
  outdated: 'เวอร์ชันเก่า — ต้องวางโค้ด Code.gs ล่าสุดแล้ว Deploy → Manage deployments → Version: New version',
  unknown: 'ตรวจสอบไม่ได้ (เชื่อมต่อไม่สำเร็จ)',
};

function renderBackendStatus() {
  document.getElementById('backendWarning').hidden = App.backendVersion !== 'outdated';
  const el = document.getElementById('backendStatus');
  if (!el) return;
  const tag = App.backendTag ? ` [${App.backendTag}]` : '';
  el.textContent = (BACKEND_STATUS_TEXT[App.backendVersion] || BACKEND_STATUS_TEXT.unknown) + tag;
}

/**
 * `missing order.item` (singular) can only come from the pre-multi-item
 * backend — the current one says `missing order.items`.
 */
function friendlySaveError(msg) {
  if (/missing order\.item\b/.test(msg)) {
    App.backendVersion = 'outdated';
    renderBackendStatus();
    return 'Apps Script ที่เชื่อมอยู่ยังเป็นโค้ดเวอร์ชันเก่า — ดูวิธีแก้ในกรอบสีเหลืองด้านบนสุดของหน้านี้';
  }
  return msg;
}

function mergeCustomer(name) {
  const clean = String(name || '').trim();
  if (clean && !App.data.customers.includes(clean)) App.data.customers.push(clean);
}

/** Checks the Apps Script link, which is only needed to save and to read history. */
async function connect() {
  const url = Store.getScriptUrl();
  if (!url) {
    setStatus('', 'ยังไม่เชื่อมต่อ');
    return;
  }
  setStatus('pending', 'กำลังเชื่อมต่อ...');
  try {
    const ping = await Api.ping();
    if (!ping.ok) throw new Error('ping failed');
    // Only the multi-item backend reports a version; a deployment serving
    // an older snapshot simply omits it.
    App.backendTag = ping.version || '';
    setStatus('ok', 'เชื่อมต่อแล้ว');
    App.connected = true;
    probeBackend();
  } catch (err) {
    setStatus('', 'บันทึกไม่ได้ (ตรวจสอบการเชื่อมต่อ)');
    App.connected = false;
    App.backendVersion = 'unknown';
    App.backendTag = '';
    renderBackendStatus();
    toast('เชื่อมต่อ Google Sheet ไม่สำเร็จ: ' + err.message + ' — ยังกรอกข้อมูลได้ แต่จะบันทึกไม่ได้', 'error');
  }
}

/* ---------------------------- Lookup pickers ---------------------------- */

let cbCustomer = null;

// Kept as one array that is mutated in place (never reassigned) so every
// material combobox already built keeps seeing new codes.
const materialCatalogItems = [];

function refreshMaterialCatalogCache() {
  materialCatalogItems.length = 0;
  App.data.materials.forEach((m) => materialCatalogItems.push({
    value: m.CODE, label: m.CODE, sub: [m.NAME, m.UNIT].filter(Boolean).join(' · '),
    __row: m,
  }));
}

function baseModelItems() {
  return App.data.baseItems.map((name) => ({ value: name, label: name }));
}
function packagingItems() {
  return App.data.packagingCodes.map((r) => ({ value: r.CODE, label: r.CODE, sub: r.DESCRIPTION || '' }));
}
function colorItems() {
  return App.data.colorShades.map((r) => ({
    value: r.CODE, label: r.CODE, sub: r.DESCRIPTION || '(ยังไม่มีคำอธิบาย)',
  }));
}

/** Pushes freshly added base/packaging/colour codes into every item card. */
function refreshItemPickers() {
  App.items.forEach((it) => {
    if (!it._cb) return;
    it._cb.base.setItems(baseModelItems());
    it._cb.packaging.setItems(packagingItems());
    it._cb.color.setItems(colorItems());
  });
}

function refreshCustomerItems() {
  if (cbCustomer) cbCustomer.setItems(App.data.customers.map((c) => ({ value: c, label: c })));
}

async function ensureLookupCreated(kind, code) {
  // Show it in the picker straight away and remember it locally, so a failed
  // or slow round-trip to the sheet never blocks data entry.
  if (kind === 'packaging') {
    Store.addLocal('packagingCodes', code);
    if (!App.data.packagingCodes.some((r) => r.CODE === code)) {
      App.data.packagingCodes.push({ CODE: code, DESCRIPTION: '' });
      refreshItemPickers();
    }
  } else if (kind === 'color') {
    Store.addLocal('colorShades', code);
    if (!App.data.colorShades.some((r) => r.CODE === code)) {
      App.data.colorShades.push({ CODE: code, DESCRIPTION: '' });
      refreshItemPickers();
    }
  } else if (kind === 'baseModel') {
    Store.addLocal('baseItems', code);
    if (!App.data.baseItems.includes(code)) {
      App.data.baseItems.push(code);
      refreshItemPickers();
    }
  }

  try {
    if (kind === 'packaging') await Api.addPackagingCode(code, '');
    else if (kind === 'color') await Api.addColorShade(code, '');
    else if (kind === 'baseModel') await Api.addBaseItem(code);
    toast('เพิ่มรายการใหม่แล้ว: ' + code, 'success');
  } catch (err) {
    toast('เพิ่มในเครื่องแล้ว แต่บันทึกลงชีทไม่สำเร็จ: ' + err.message, 'error');
  }
}

function initCustomerPicker() {
  cbCustomer = new Combobox(document.getElementById('cb-customer'), {
    placeholder: 'ค้นหาชื่อลูกค้า หรือพิมพ์ชื่อใหม่...',
    allowCreate: true,
    createLabel: (q) => `+ ใช้ชื่อลูกค้าใหม่: "${q}"`,
    onSelect: (item) => {
      if (item.__created) {
        Store.addLocal('customers', item.value);
        mergeCustomer(item.value);
        refreshCustomerItems();
      }
    },
  });
}

/* ----------------------- Department schedule (2) ------------------------ */

function renderSchedule() {
  const tbody = document.getElementById('scheduleBody');
  tbody.innerHTML = '';
  DEPARTMENTS.forEach((dept) => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.className = 'dept-cell';
    tdName.textContent = dept;
    tr.appendChild(tdName);

    ['start', 'end'].forEach((key) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'date';
      input.value = App.schedule[dept][key];
      input.addEventListener('input', (e) => { App.schedule[dept][key] = e.target.value; });
      td.appendChild(input);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

function setSchedule(values) {
  DEPARTMENTS.forEach((d) => {
    App.schedule[d] = {
      start: (values && values[d] && values[d].start) || '',
      end: (values && values[d] && values[d].end) || '',
    };
  });
  renderSchedule();
}

/* ------------------------------ Items (3) ------------------------------- */

function makeItem(prefill) {
  return Object.assign({
    itemId: App.itemSeq++,
    baseModel: '', packaging: '', color: '',
    manual: false, manualCode: '',
    qty: '',
    lines: [],
    hint: '',
  }, prefill || {});
}

function itemCode(it) {
  if (it.manual) return (it.manualCode || '').trim();
  const { baseModel, packaging, color } = it;
  if (!baseModel) return '';
  if (packaging && color) return `${baseModel}(${packaging})-${color}`;
  return baseModel + (packaging ? `(${packaging})` : '') + (color ? `-${color}` : '');
}

function itemQty(it) {
  const v = parseFloat(it.qty);
  return isNaN(v) ? 0 : v;
}

function addItem(prefill) {
  const it = makeItem(prefill);
  App.items.push(it);
  return it;
}

function removeItem(itemId) {
  App.items = App.items.filter((i) => i.itemId !== itemId);
  if (!App.items.length) addItem();
  renderItems();
  renderSummary();
}

function addLine(it, prefill) {
  it.lines.push(Object.assign({
    rowId: App.rowSeq++,
    materialCode: '', materialName: '', dept: '', unit: '',
    qtyPerFg: '', stockQty: '', remarks: '',
  }, prefill || {}));
}

function requiredQty(line, qty) {
  const qpf = parseFloat(line.qtyPerFg);
  const stock = parseFloat(line.stockQty);
  if (isNaN(qpf)) return '';
  const need = qpf * qty - (isNaN(stock) ? 0 : stock);
  return Math.round(need * 1000) / 1000;
}

/**
 * Items are shown twice: as one compact line each in section 3 (so the
 * whole order is scannable at a glance) and as a materials table each in
 * section 4. Both halves write into the same it._el, so a code or
 * quantity typed in the compact row updates the matching table heading.
 */
function renderItems() {
  const rowHost = document.getElementById('itemRows');
  const linesHost = document.getElementById('itemLinesList');
  rowHost.innerHTML = '';
  linesHost.innerHTML = '';
  App.items.forEach((it, index) => {
    it._el = {};
    rowHost.appendChild(buildItemRow(it, index));
    linesHost.appendChild(buildItemLinesBlock(it, index));
    syncItemLabels(it);
    renderItemLines(it);
  });
  updateLinesSectionHint();
}

/** Keeps every place an item's code/quantity is displayed in agreement. */
function syncItemLabels(it) {
  const el = it._el;
  if (!el) return;
  const code = itemCode(it);
  const qty = itemQty(it);
  if (el.rowCode) {
    // Only worth a line of its own when it says something the inputs on
    // the row don't already show verbatim — i.e. once packaging/colour
    // compose the base model into a different code.
    const showCode = !!code && code !== it.baseModel && code !== (it.manualCode || '').trim();
    el.rowCode.textContent = showCode ? code : '';
    el.rowSub.hidden = !showCode && !it.hint;
  }
  if (el.blockTitle) {
    el.blockTitle.textContent = `${el.blockNo} · ${code || '(ยังไม่เลือกรหัส)'}`;
  }
  if (el.blockQty) {
    el.blockQty.textContent = qty ? '× ' + qty.toLocaleString() : 'ยังไม่ระบุจำนวน';
    el.blockQty.classList.toggle('is-missing', !qty);
  }
}

function buildItemRow(it, index) {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.dataset.itemId = it.itemId;

  const cellNo = cell(row, '');
  const no = document.createElement('span');
  no.className = 'item-no';
  no.textContent = index + 1;
  cellNo.appendChild(no);

  const cellBase = cell(row, 'รุ่นสินค้า');
  const cellPkg = cell(row, 'Packaging');
  const cellColor = cell(row, 'เฉดสี');
  const mountBase = mountIn(cellBase);
  const mountPkg = mountIn(cellPkg);
  const mountColor = mountIn(cellColor);

  // Typing a full code by hand replaces the three pickers on this line.
  const manualInput = document.createElement('input');
  manualInput.type = 'text';
  manualInput.className = 'item-row-manual';
  manualInput.placeholder = 'พิมพ์รหัส ITEM แบบเต็ม';
  manualInput.value = it.manualCode;
  row.appendChild(manualInput);

  const cellQty = cell(row, 'จำนวนที่สั่ง');
  const qtyInput = document.createElement('input');
  qtyInput.type = 'number';
  qtyInput.min = '0';
  qtyInput.step = 'any';
  qtyInput.placeholder = '0';
  qtyInput.value = it.qty;
  cellQty.appendChild(qtyInput);

  // Grouped so narrow screens can move both buttons up next to the item
  // number; on wide screens the wrapper is `display: contents` and they sit
  // in their own grid columns.
  const actions = document.createElement('div');
  actions.className = 'item-row-actions';
  const manualBtn = document.createElement('button');
  manualBtn.className = 'icon-btn';
  manualBtn.textContent = '✎';
  manualBtn.title = 'พิมพ์รหัส ITEM เอง';
  const delBtn = document.createElement('button');
  delBtn.className = 'btn-danger-ghost';
  delBtn.textContent = '✕';
  delBtn.title = 'ลบ Item นี้';
  delBtn.addEventListener('click', () => removeItem(it.itemId));
  actions.append(manualBtn, delBtn);
  row.appendChild(actions);

  const sub = document.createElement('div');
  sub.className = 'item-row-sub';
  const rowCode = document.createElement('code');
  rowCode.className = 'item-row-code';
  const hintEl = document.createElement('span');
  hintEl.className = 'hint-inline';
  hintEl.textContent = it.hint;
  sub.append(rowCode, hintEl);
  row.appendChild(sub);

  it._el.rowCode = rowCode;
  it._el.rowSub = sub;
  it._el.hintEl = hintEl;

  const applyManualMode = () => {
    row.classList.toggle('is-manual', it.manual);
    manualBtn.classList.toggle('is-active', it.manual);
    manualBtn.title = it.manual ? 'กลับไปเลือกจากรายการ' : 'พิมพ์รหัส ITEM เอง';
  };

  it._cb = {
    base: new Combobox(mountBase, {
      placeholder: 'ค้นหาหรือพิมพ์รุ่นสินค้าใหม่...',
      items: baseModelItems(),
      allowCreate: true,
      createLabel: (q) => `+ เพิ่มรุ่นสินค้าใหม่: "${q}"`,
      onSelect: (sel) => {
        it.baseModel = sel.value;
        if (sel.__created) ensureLookupCreated('baseModel', sel.value);
        syncItemLabels(it);
      },
    }),
    packaging: new Combobox(mountPkg, {
      placeholder: 'P, B, X...',
      items: packagingItems(),
      allowCreate: true,
      createLabel: (q) => `+ เพิ่มรหัส Packaging ใหม่: "${q}"`,
      onSelect: (sel) => {
        it.packaging = sel.value;
        if (sel.__created) ensureLookupCreated('packaging', sel.value);
        syncItemLabels(it);
      },
    }),
    color: new Combobox(mountColor, {
      placeholder: 'A, Y, Z...',
      items: colorItems(),
      allowCreate: true,
      createLabel: (q) => `+ เพิ่มเฉดสีใหม่: "${q}"`,
      onSelect: (sel) => {
        it.color = sel.value;
        if (sel.__created) ensureLookupCreated('color', sel.value);
        syncItemLabels(it);
      },
    }),
  };
  it._cb.base.setValue(it.baseModel);
  it._cb.packaging.setValue(it.packaging);
  it._cb.color.setValue(it.color);

  qtyInput.addEventListener('input', (e) => {
    it.qty = e.target.value;
    syncItemLabels(it);
    recalcItem(it);
    renderSummary();
  });
  manualInput.addEventListener('input', (e) => { it.manualCode = e.target.value; syncItemLabels(it); });
  manualBtn.addEventListener('click', () => {
    it.manual = !it.manual;
    applyManualMode();
    if (it.manual) manualInput.focus();
    syncItemLabels(it);
  });

  applyManualMode();
  return row;
}

function cell(parent, label) {
  const el = document.createElement('div');
  el.className = 'item-cell';
  if (label) el.dataset.label = label;
  parent.appendChild(el);
  return el;
}

function mountIn(parent) {
  const mount = document.createElement('div');
  mount.className = 'combobox-mount';
  parent.appendChild(mount);
  return mount;
}

function buildItemLinesBlock(it, index) {
  const block = document.createElement('div');
  block.className = 'item-lines-block';
  block.dataset.itemId = it.itemId;

  const head = document.createElement('div');
  head.className = 'item-lines-head';
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '▾';
  const title = document.createElement('span');
  title.className = 'item-lines-title';
  const qtyBadge = document.createElement('span');
  qtyBadge.className = 'item-qty-badge';
  const count = document.createElement('span');
  count.className = 'item-lines-count';
  const spacer = document.createElement('span');
  spacer.className = 'item-head-spacer';
  const addLineBtn = document.createElement('button');
  addLineBtn.className = 'btn btn-secondary btn-sm';
  addLineBtn.textContent = '+ เพิ่มรายการวัตถุดิบ';
  head.append(caret, title, qtyBadge, count, spacer, addLineBtn);
  head.addEventListener('click', (e) => {
    if (e.target === addLineBtn) return;
    block.classList.toggle('is-collapsed');
  });
  block.appendChild(head);

  const body = document.createElement('div');
  body.className = 'item-lines-body';
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'bom-table';
  table.innerHTML = `<thead><tr>
      <th style="width:26%">วัตถุดิบ</th>
      <th>แผนก</th>
      <th>จำนวนใช้ : 1 FG</th>
      <th>หน่วย</th>
      <th>คงคลัง</th>
      <th>ต้องเบิก/สั่งซื้อ</th>
      <th>หมายเหตุ</th>
      <th></th>
    </tr></thead>`;
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  wrap.appendChild(table);
  body.appendChild(wrap);
  const emptyHint = document.createElement('p');
  emptyHint.className = 'empty-hint';
  emptyHint.textContent = 'ยังไม่มีรายการวัตถุดิบสำหรับ Item นี้';
  body.appendChild(emptyHint);
  block.appendChild(body);

  addLineBtn.addEventListener('click', () => {
    block.classList.remove('is-collapsed');
    addLine(it);
    renderItemLines(it);
    renderSummary();
  });

  it._el.blockNo = 'Item ' + (index + 1);
  it._el.blockTitle = title;
  it._el.blockQty = qtyBadge;
  it._el.blockCount = count;
  it._el.tbody = tbody;
  it._el.emptyHint = emptyHint;
  return block;
}

/** Section 4 stays hidden-ish until there is anything to show. */
function updateLinesSectionHint() {
  const total = App.items.reduce((n, it) => n + it.lines.length, 0);
  document.getElementById('linesEmptyHint').style.display = total ? 'none' : 'block';
  document.getElementById('itemLinesList').style.display = total ? 'flex' : 'none';
  document.getElementById('linesHint').textContent = total ? `รวม ${total} รายการ` : '';
}

function renderItemLines(it) {
  if (!it._el || !it._el.tbody) return;
  const { tbody, emptyHint, blockCount } = it._el;
  tbody.innerHTML = '';
  emptyHint.style.display = it.lines.length ? 'none' : 'block';
  blockCount.textContent = `${it.lines.length} รายการ`;

  it.lines.forEach((line) => {
    const tr = document.createElement('tr');
    tr.dataset.rowId = line.rowId;

    const tdMaterial = document.createElement('td');
    const mCombo = document.createElement('div');
    tdMaterial.appendChild(mCombo);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'ชื่อวัตถุดิบ';
    nameInput.value = line.materialName;
    nameInput.style.marginTop = '4px';
    nameInput.addEventListener('input', (e) => { line.materialName = e.target.value; renderSummary(); });
    tdMaterial.appendChild(nameInput);
    tr.appendChild(tdMaterial);

    const combo = new Combobox(mCombo, {
      placeholder: 'ค้นหารหัสวัตถุดิบ...',
      items: materialCatalogItems,
      allowCreate: true,
      createLabel: (q) => `+ ใช้รหัสใหม่: "${q}"`,
      onSelect: (item) => {
        line.materialCode = item.value;
        if (item.__row) {
          line.materialName = item.__row.NAME || line.materialName;
          line.dept = item.__row.DEPT || line.dept;
          line.unit = item.__row.UNIT || line.unit;
          nameInput.value = line.materialName;
          deptInput.value = line.dept;
          unitInput.value = line.unit;
        } else if (item.__created) {
          const row = {
            CODE: item.value, NAME: line.materialName, DEPT: line.dept,
            UNIT: line.unit, USAGE_COUNT: 0,
          };
          Store.addLocal('materials', row);
          App.data.materials.push(row);
          materialCatalogItems.push({ value: item.value, label: item.value, sub: '', __row: row });
          Api.addMaterial({ code: item.value, name: line.materialName, dept: line.dept, unit: line.unit })
            .then(() => toast('เพิ่มรหัสวัตถุดิบใหม่แล้ว: ' + item.value, 'success'))
            .catch((err) => toast('เพิ่มในเครื่องแล้ว แต่บันทึกลงชีทไม่สำเร็จ: ' + err.message, 'error'));
        }
        renderSummary();
      },
    });
    combo.setValue(line.materialCode);

    const tdDept = document.createElement('td');
    const deptInput = document.createElement('input');
    deptInput.type = 'text';
    deptInput.value = line.dept;
    deptInput.addEventListener('input', (e) => { line.dept = e.target.value; });
    tdDept.appendChild(deptInput);
    tr.appendChild(tdDept);

    const tdQty = document.createElement('td');
    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.step = 'any';
    qtyInput.value = line.qtyPerFg;
    qtyInput.addEventListener('input', (e) => {
      line.qtyPerFg = e.target.value;
      updateRequiredCell(tr, line, itemQty(it));
      renderSummary();
    });
    tdQty.appendChild(qtyInput);
    tr.appendChild(tdQty);

    const tdUnit = document.createElement('td');
    const unitInput = document.createElement('input');
    unitInput.type = 'text';
    unitInput.value = line.unit;
    unitInput.addEventListener('input', (e) => { line.unit = e.target.value; renderSummary(); });
    tdUnit.appendChild(unitInput);
    tr.appendChild(tdUnit);

    const tdStock = document.createElement('td');
    const stockInput = document.createElement('input');
    stockInput.type = 'number';
    stockInput.step = 'any';
    stockInput.value = line.stockQty;
    stockInput.addEventListener('input', (e) => {
      line.stockQty = e.target.value;
      updateRequiredCell(tr, line, itemQty(it));
      renderSummary();
    });
    tdStock.appendChild(stockInput);
    tr.appendChild(tdStock);

    const tdReq = document.createElement('td');
    tdReq.className = 'required-cell';
    tr.appendChild(tdReq);

    const tdRemarks = document.createElement('td');
    const remarksInput = document.createElement('input');
    remarksInput.type = 'text';
    remarksInput.value = line.remarks;
    remarksInput.addEventListener('input', (e) => { line.remarks = e.target.value; });
    tdRemarks.appendChild(remarksInput);
    tr.appendChild(tdRemarks);

    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-danger-ghost';
    delBtn.textContent = '✕';
    delBtn.title = 'ลบรายการ';
    delBtn.addEventListener('click', () => {
      it.lines = it.lines.filter((l) => l.rowId !== line.rowId);
      renderItemLines(it);
      renderSummary();
    });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);

    updateRequiredCell(tr, line, itemQty(it));
    tbody.appendChild(tr);
  });

  updateLinesSectionHint();
}

function updateRequiredCell(tr, line, qty) {
  const cell = tr.children[5];
  const req = requiredQty(line, qty);
  cell.textContent = fmtNum(req);
  cell.classList.toggle('required-negative', typeof req === 'number' && req < 0);
}

function recalcItem(it) {
  if (!it._el) return;
  const qty = itemQty(it);
  Array.from(it._el.tbody.children).forEach((tr) => {
    const line = it.lines.find((l) => l.rowId === Number(tr.dataset.rowId));
    if (line) updateRequiredCell(tr, line, qty);
  });
}

/* -------------------- Recipe loading (all items at once) ----------------- */

const ITEM_CODE_RE = /^(.*)\((\w+)\)-(.+)$/;

/** Splits "EL-Corte-GB-21(B)-Y" into base / packaging / colour. */
function parseItemCode(code) {
  const m = ITEM_CODE_RE.exec(code || '');
  return m ? { base: m[1], packaging: m[2], color: m[3] } : null;
}

/**
 * Groups every legacy recipe key by its base model, so an item can fall
 * back to another variant of the same product. Needed because most legacy
 * items are only filed under a full "base(packaging)-colour" code — there
 * is no bare-base-model entry to fall back to (221 of the 1,374 selectable
 * base models have none).
 */
function buildRecipeVariants() {
  const out = {};
  Object.keys(App.recipeIndex).forEach((key) => {
    const parts = parseItemCode(key);
    if (!parts) return;
    (out[parts.base] = out[parts.base] || []).push({ key, packaging: parts.packaging, color: parts.color });
  });
  Object.values(out).forEach((list) => list.sort((a, b) => a.key.localeCompare(b.key)));
  App.recipeVariants = out;
}

/**
 * Finds the closest legacy recipe for an item, widening the search in
 * steps and reporting how close the hit was so the UI can warn when the
 * recipe came from a different variant:
 *
 *   exact   the item code itself
 *   base    the bare base model
 *   variant same base model + same packaging, different colour set
 *   loose   same base model, any packaging/colour
 *
 * Colour variants of one product share most of their materials but not
 * all (typically 10-16 of 15-22 codes), so anything past `base` is a
 * starting point to review, not an answer.
 */
function resolveRecipeId(it) {
  const code = itemCode(it);
  const parsed = parseItemCode(code);
  const base = it.baseModel || (parsed && parsed.base) || '';
  const packaging = it.packaging || (parsed && parsed.packaging) || '';

  const has = (key) => key && Object.prototype.hasOwnProperty.call(App.recipeIndex, key);
  if (has(code)) return { id: App.recipeIndex[code], matched: code, kind: 'exact' };
  if (has(base)) return { id: App.recipeIndex[base], matched: base, kind: 'base' };

  const variants = App.recipeVariants[base] || [];
  const samePackaging = packaging ? variants.filter((v) => v.packaging === packaging) : [];
  const pick = samePackaging[0] || variants[0];
  if (pick) {
    return {
      id: App.recipeIndex[pick.key],
      matched: pick.key,
      kind: samePackaging.length ? 'variant' : 'loose',
    };
  }
  return null;
}

function recipeSourceNote(found, code, count) {
  if (found.matched === code) return `โหลดสูตรเดิมแล้ว ${count} รายการ`;
  if (found.kind === 'base') return `โหลดสูตรเดิมแล้ว ${count} รายการ (จากรุ่น "${found.matched}")`;
  return `โหลดสูตรเดิมแล้ว ${count} รายการ — ดึงจาก "${found.matched}" ซึ่งเป็นคนละเฉดสี ⚠ ตรวจวัตถุดิบที่ขึ้นกับสีก่อนบันทึก`;
}

function setItemHint(it, text) {
  it.hint = text;
  if (!it._el || !it._el.hintEl) return;
  it._el.hintEl.textContent = text;
  syncItemLabels(it); // the sub-line may need to appear for the hint
}

/**
 * Pulls one item's legacy recipe in. Returns a short status string that the
 * single bulk loader below rolls up into one message — the confirmation to
 * overwrite is asked once there, not per item.
 */
async function loadRecipeForItem(it) {
  const code = itemCode(it);
  if (!code) {
    setItemHint(it, 'ยังไม่ได้เลือกรหัส ITEM');
    return 'skipped';
  }

  const found = resolveRecipeId(it);
  if (!found) {
    setItemHint(it, 'ไม่พบสูตรเดิมของรหัสนี้ — เพิ่มรายการเองได้ในหัวข้อ 4');
    return 'notfound';
  }

  setItemHint(it, 'กำลังโหลดสูตรวัตถุดิบเดิม...');
  let rows;
  try {
    rows = await StaticData.recipe(found.id);
  } catch (err) {
    setItemHint(it, 'โหลดสูตรวัตถุดิบไม่สำเร็จ: ' + err.message);
    return 'error';
  }

  if (!rows || !rows.length) {
    setItemHint(it, 'ไม่พบสูตรเดิมของรหัสนี้ — เพิ่มรายการเองได้ในหัวข้อ 4');
    return 'notfound';
  }

  it.lines = [];
  rows.forEach((r) => {
    // Every legacy recipe opens with a row for the finished good itself,
    // carrying the source item's own code. When the recipe was borrowed
    // from another variant, that row would otherwise save the wrong item
    // code against this order, so point it at the item being made.
    const isFinishedGoodRow = r.CODE && r.CODE === found.matched;
    addLine(it, {
      materialCode: isFinishedGoodRow ? code : (r.CODE || ''),
      materialName: isFinishedGoodRow
        ? String(r.NAME || '').split(found.matched).join(code)
        : (r.NAME || ''),
      dept: r.DEPT_MAKER || r.DEPT || '',
      // RB_COUNT_UNIT is the material's issuing unit — the legacy add_Item
      // macro maps this column (BM) into the BOM sheet's unit column (AI).
      unit: r.RB_COUNT_UNIT || r.CUT_UNIT || r.PIECES_UNIT || '',
      qtyPerFg: r.QTY_PER_SET || '',
      stockQty: '',
      remarks: '',
    });
  });
  setItemHint(it, recipeSourceNote(found, code, rows.length));
  renderItemLines(it);
  return 'loaded';
}

/** One click: pull every item's legacy recipe and recompute the whole order. */
async function loadAllRecipes() {
  const hint = document.getElementById('loadAllHint');
  const btn = document.getElementById('loadAllRecipesBtn');
  const targets = App.items.filter((it) => itemCode(it));

  if (!targets.length) {
    hint.textContent = 'ยังไม่ได้เลือกรหัส ITEM — เลือกรุ่นสินค้าอย่างน้อย 1 Item ก่อน';
    return;
  }
  const withLines = targets.filter((it) => it.lines.length);
  if (withLines.length &&
      !confirm(`มี ${withLines.length} Item ที่มีรายการวัตถุดิบอยู่แล้ว — แทนที่ทั้งหมดด้วยสูตรจากระบบเดิมหรือไม่?`)) {
    return;
  }

  btn.disabled = true;
  hint.textContent = `กำลังโหลดสูตรวัตถุดิบของ ${targets.length} Item...`;
  const results = await Promise.all(targets.map((it) => loadRecipeForItem(it)));
  btn.disabled = false;

  const loaded = results.filter((r) => r === 'loaded').length;
  const notFound = results.filter((r) => r === 'notfound').length;
  const failed = results.filter((r) => r === 'error').length;
  hint.textContent = [
    `โหลดสูตรสำเร็จ ${loaded}/${targets.length} Item`,
    notFound ? `ไม่พบสูตรเดิม ${notFound} Item` : '',
    failed ? `โหลดไม่สำเร็จ ${failed} Item` : '',
  ].filter(Boolean).join(' · ');

  renderSummary();
  if (loaded) toast(`โหลดสูตรและคำนวณให้ ${loaded} Item พร้อมกันแล้ว`, 'success');
}

/* ------------------------------ Summary (4) ------------------------------ */

/** Rolls every item's lines up by material so purchasing sees one number. */
function summaryRows() {
  const byMaterial = new Map();
  App.items.forEach((it) => {
    const qty = itemQty(it);
    const code = itemCode(it);
    it.lines.forEach((line) => {
      const key = line.materialCode || line.materialName;
      if (!key) return;
      if (!byMaterial.has(key)) {
        byMaterial.set(key, {
          code: line.materialCode, name: line.materialName, unit: line.unit,
          need: 0, stock: 0, items: new Set(),
        });
      }
      const agg = byMaterial.get(key);
      if (!agg.name) agg.name = line.materialName;
      if (!agg.unit) agg.unit = line.unit;
      const qpf = parseFloat(line.qtyPerFg);
      const stock = parseFloat(line.stockQty);
      if (!isNaN(qpf)) agg.need += qpf * qty;
      if (!isNaN(stock)) agg.stock += stock;
      if (code) agg.items.add(code);
    });
  });
  return Array.from(byMaterial.values());
}

function renderSummary() {
  const tbody = document.getElementById('summaryBody');
  const rows = summaryRows();
  tbody.innerHTML = '';
  document.getElementById('summaryEmptyHint').style.display = rows.length ? 'none' : 'block';

  const totalQty = App.items.reduce((sum, it) => sum + itemQty(it), 0);
  document.getElementById('summaryHint').textContent = rows.length
    ? `${App.items.filter((it) => itemCode(it)).length} Item · รวมสั่งผลิต ${totalQty.toLocaleString()} ชิ้น · วัตถุดิบ ${rows.length} รายการ`
    : '';

  rows.forEach((r) => {
    const required = Math.round((r.need - r.stock) * 1000) / 1000;
    const tr = document.createElement('tr');
    [
      r.code || '—',
      r.name || '',
      r.unit || '',
      String(r.items.size),
      fmtNum(r.need),
      fmtNum(r.stock),
      fmtNum(required),
    ].forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 6) {
        td.className = 'required-cell' + (required < 0 ? ' required-negative' : '');
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

/* --------------------------------- Save ---------------------------------- */

function resetForm() {
  App.items = [];
  addItem();
  renderItems();
  cbCustomer.setValue('');
  document.getElementById('f-poref').value = '';
  document.getElementById('f-orderDate').value = '';
  document.getElementById('f-dueDate').value = '';
  document.getElementById('f-remarks').value = '';
  document.getElementById('loadAllHint').textContent = '';
  setSchedule(null);
  renderSummary();
}

function collectOrder() {
  const items = App.items
    .map((it) => ({ it, code: itemCode(it) }))
    .filter((x) => x.code)
    .map(({ it, code }) => ({
      item: code,
      baseModel: it.baseModel,
      packagingCode: it.packaging,
      colorCode: it.color,
      orderQty: it.qty,
      lines: it.lines.map((l) => ({
        materialCode: l.materialCode,
        materialName: l.materialName,
        dept: l.dept,
        qtyPerFg: l.qtyPerFg,
        unit: l.unit,
        stockQty: l.stockQty,
        requiredQty: requiredQty(l, itemQty(it)),
        remarks: l.remarks,
      })),
    }));

  return {
    customer: cbCustomer.getText(),
    poRef: document.getElementById('f-poref').value,
    orderDate: document.getElementById('f-orderDate').value,
    dueDate: document.getElementById('f-dueDate').value,
    remarks: document.getElementById('f-remarks').value,
    createdBy: Store.getCreatedBy(),
    schedule: App.schedule,
    items,
  };
}

async function saveOrder() {
  const msgEl = document.getElementById('saveMsg');
  if (!App.connected) { toast('กรุณาเชื่อมต่อ Google Sheet ก่อน (เมนู "การเชื่อมต่อ")', 'error'); return; }

  const order = collectOrder();
  if (!order.items.length) { toast('กรุณาเลือกรหัส ITEM อย่างน้อย 1 รายการก่อนบันทึก', 'error'); return; }

  const noQty = order.items.filter((i) => !parseFloat(i.orderQty));
  if (noQty.length && !confirm(`มี ${noQty.length} Item ที่ยังไม่ได้ใส่จำนวนที่สั่ง — บันทึกต่อหรือไม่?`)) {
    return;
  }

  if (order.customer) {
    Store.addLocal('customers', order.customer);
    mergeCustomer(order.customer);
    refreshCustomerItems();
  }

  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  msgEl.textContent = 'กำลังบันทึก...';
  msgEl.className = 'save-bar-msg';
  try {
    const res = await Api.saveOrder(order);
    if (!res.ok) throw new Error(res.error || 'unknown error');
    msgEl.textContent = `บันทึกสำเร็จ (เลขที่: ${res.orderId}) — ${order.items.length} Item`;
    msgEl.className = 'save-bar-msg is-success';
    toast('บันทึก BOM ลง Google Sheet สำเร็จ', 'success');
    resetForm();
  } catch (err) {
    const detail = friendlySaveError(err.message);
    msgEl.textContent = 'บันทึกไม่สำเร็จ: ' + detail;
    msgEl.className = 'save-bar-msg is-error';
    toast('บันทึกไม่สำเร็จ: ' + detail, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* -------------------------------- History --------------------------------- */

let historyCache = null;

async function loadHistory() {
  const listEl = document.getElementById('historyList');
  if (!App.connected) {
    listEl.innerHTML = '<div class="history-empty">กรุณาเชื่อมต่อ Google Sheet ก่อน (เมนู "การเชื่อมต่อ")</div>';
    return;
  }
  listEl.innerHTML = '<div class="history-empty">กำลังโหลด...</div>';
  try {
    const res = await Api.orders();
    if (!res.ok) throw new Error(res.error);
    historyCache = res;
    (res.orders || []).forEach((o) => mergeCustomer(o.CUSTOMER));
    refreshCustomerItems();
    renderHistory();
  } catch (err) {
    listEl.innerHTML = '<div class="history-empty">โหลดประวัติไม่สำเร็จ: ' + err.message + '</div>';
  }
}

/**
 * Regroups a saved order into the multi-item shape the form now uses.
 * Orders saved before items existed have no BOM_Order_Items rows and no
 * ITEM_NO on their lines, so they collapse into a single item built from
 * the order header.
 */
function orderItemsOf(order) {
  const itemRows = (historyCache.items || []).filter((r) => r.ORDER_ID === order.ORDER_ID);
  const lines = (historyCache.lines || []).filter((l) => l.ORDER_ID === order.ORDER_ID);

  if (!itemRows.length) {
    return [{
      no: 1,
      item: order.ITEM || '',
      baseModel: order.BASE_MODEL || '',
      packagingCode: order.PACKAGING_CODE || '',
      colorCode: order.COLOR_CODE || '',
      orderQty: order.ORDER_QTY || '',
      lines,
    }];
  }

  return itemRows
    .slice()
    .sort((a, b) => Number(a.ITEM_NO || 0) - Number(b.ITEM_NO || 0))
    .map((r) => ({
      no: Number(r.ITEM_NO || 0),
      item: r.ITEM || '',
      baseModel: r.BASE_MODEL || '',
      packagingCode: r.PACKAGING_CODE || '',
      colorCode: r.COLOR_CODE || '',
      orderQty: r.ORDER_QTY || '',
      lines: lines.filter((l) => Number(l.ITEM_NO || 1) === Number(r.ITEM_NO || 0)),
    }));
}

function scheduleOf(order) {
  const out = {};
  DEPARTMENTS.forEach((d) => {
    out[d] = { start: dateValue(order[d + '_START']), end: dateValue(order[d + '_END']) };
  });
  return out;
}

/** Sheet date cells come back as ISO timestamps; <input type="date"> wants yyyy-mm-dd. */
function dateValue(v) {
  if (!v) return '';
  return String(v).slice(0, 10);
}

function renderHistory() {
  const listEl = document.getElementById('historyList');
  if (!historyCache) return;
  const q = document.getElementById('historySearch').value.trim().toLowerCase();

  let orders = historyCache.orders.slice().sort((a, b) => String(b.TIMESTAMP).localeCompare(String(a.TIMESTAMP)));
  if (q) {
    orders = orders.filter((o) =>
      [o.ITEM, o.CUSTOMER, o.ORDER_ID, o.BASE_MODEL, o.PO_REF].some((v) => v && String(v).toLowerCase().includes(q)));
  }

  listEl.innerHTML = '';
  if (!orders.length) {
    listEl.innerHTML = '<div class="history-empty">ไม่พบรายการ</div>';
    return;
  }

  orders.forEach((o) => {
    const items = orderItemsOf(o);
    const totalQty = items.reduce((s, i) => s + (parseFloat(i.orderQty) || 0), 0);

    const entry = document.createElement('div');
    entry.className = 'history-item';

    const head = document.createElement('div');
    head.className = 'history-item-head';
    head.innerHTML = `
      <span class="hi-item">${escapeHtml(items.map((i) => i.item).filter(Boolean).join(', ') || o.ITEM || '')}</span>
      <span class="hi-meta">${escapeHtml(o.CUSTOMER || '')}</span>
      <span class="hi-meta">${items.length} Item · รวม ${totalQty.toLocaleString()}</span>
      <span class="hi-meta">${escapeHtml(String(o.TIMESTAMP || '').slice(0, 16).replace('T', ' '))}</span>
      <span class="hi-spacer"></span>
      <button class="btn btn-secondary btn-sm hi-dup">ใช้เป็นแบบร่างใหม่</button>
    `;
    head.querySelector('.hi-dup').addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateOrder(o, items);
    });
    head.addEventListener('click', () => entry.classList.toggle('is-open'));

    const body = document.createElement('div');
    body.className = 'history-item-body';
    const scheduleText = DEPARTMENTS
      .map((d) => {
        const s = dateValue(o[d + '_START']);
        const e = dateValue(o[d + '_END']);
        return (s || e) ? `${d}: ${s || '—'} → ${e || '—'}` : '';
      })
      .filter(Boolean)
      .join('  |  ');
    body.innerHTML = scheduleText ? `<div class="history-schedule">${escapeHtml(scheduleText)}</div>` : '';

    items.forEach((it) => {
      const block = document.createElement('div');
      block.className = 'history-item-block';
      const title = document.createElement('div');
      title.className = 'history-item-block-title';
      title.textContent = `${it.item || '(ไม่มีรหัส)'} — จำนวน ${it.orderQty || '—'}`;
      block.appendChild(title);
      if (!it.lines.length) {
        block.insertAdjacentHTML('beforeend', '<div class="history-empty">ไม่มีรายการวัตถุดิบ</div>');
      } else {
        const rows = it.lines.map((l) => `
          <tr>
            <td>${escapeHtml(l.MATERIAL_CODE || '')}</td>
            <td>${escapeHtml(l.MATERIAL_NAME || '')}</td>
            <td>${escapeHtml(l.QTY_PER_FG || '')}</td>
            <td>${escapeHtml(l.UNIT || '')}</td>
            <td>${escapeHtml(l.REQUIRED_QTY || '')}</td>
          </tr>`).join('');
        block.insertAdjacentHTML('beforeend', `<table>
          <thead><tr><th>รหัส</th><th>ชื่อวัตถุดิบ</th><th>จำนวน/1FG</th><th>หน่วย</th><th>ต้องเบิก</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`);
      }
      body.appendChild(block);
    });

    entry.appendChild(head);
    entry.appendChild(body);
    listEl.appendChild(entry);
  });
}

function duplicateOrder(order, items) {
  showNewBomView();

  cbCustomer.setValue(order.CUSTOMER || '');
  document.getElementById('f-poref').value = order.PO_REF || '';
  document.getElementById('f-orderDate').value = dateValue(order.ORDER_DATE);
  document.getElementById('f-dueDate').value = dateValue(order.DUE_DATE);
  document.getElementById('f-remarks').value = order.REMARKS || '';
  setSchedule(scheduleOf(order));

  App.items = [];
  items.forEach((src) => {
    // The saved code is authoritative — reuse it verbatim rather than
    // trying to recompose it from base/packaging/colour.
    const it = addItem({
      baseModel: src.baseModel,
      packaging: src.packagingCode,
      color: src.colorCode,
      manual: true,
      manualCode: src.item,
      qty: src.orderQty === '' ? '' : String(src.orderQty),
    });
    src.lines.forEach((l) => addLine(it, {
      materialCode: l.MATERIAL_CODE, materialName: l.MATERIAL_NAME, dept: l.DEPT,
      qtyPerFg: l.QTY_PER_FG, unit: l.UNIT, stockQty: '', remarks: l.REMARKS,
    }));
  });
  if (!App.items.length) addItem();

  renderItems();
  renderSummary();
  toast('คัดลอกรายการเดิมมาเป็นแบบร่างใหม่แล้ว — แก้ไขแล้วกดบันทึก', 'success');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* -------------------------------- Settings --------------------------------- */

function initSettings() {
  document.getElementById('f-scriptUrl').value = Store.getScriptUrl();
  document.getElementById('f-createdBy').value = Store.getCreatedBy();

  document.getElementById('saveUrlBtn').addEventListener('click', async () => {
    const url = document.getElementById('f-scriptUrl').value.trim();
    if (!url) { toast('กรุณาวางลิงก์ Web App URL', 'error'); return; }
    Store.setScriptUrl(url);
    document.getElementById('settingsHint').textContent = 'กำลังทดสอบการเชื่อมต่อ...';
    await connect();
    document.getElementById('settingsHint').textContent = App.connected ? 'เชื่อมต่อสำเร็จ' : 'เชื่อมต่อไม่สำเร็จ ตรวจสอบลิงก์อีกครั้ง';
  });

  document.getElementById('saveNameBtn').addEventListener('click', () => {
    Store.setCreatedBy(document.getElementById('f-createdBy').value.trim());
    toast('บันทึกชื่อผู้บันทึกแล้ว', 'success');
  });
}

/* ---------------------------------- Init ------------------------------------ */

function init() {
  initNav();
  initCustomerPicker();
  initSettings();

  renderSchedule();
  addItem();
  renderItems();
  renderSummary();

  document.getElementById('addItemBtn').addEventListener('click', () => {
    addItem();
    renderItems();
    renderSummary();
  });
  document.getElementById('loadAllRecipesBtn').addEventListener('click', loadAllRecipes);
  document.getElementById('saveBtn').addEventListener('click', saveOrder);
  document.getElementById('refreshHistoryBtn').addEventListener('click', loadHistory);
  document.getElementById('historySearch').addEventListener('input', renderHistory);

  // Reference data and the Sheets connection are independent: the pickers
  // must work even when Apps Script is unreachable.
  loadStaticData().catch((err) => {
    toast('โหลดข้อมูลอ้างอิงไม่สำเร็จ: ' + err.message, 'error');
  });
  connect();
}

document.addEventListener('DOMContentLoaded', init);
