'use strict';

/* ============================== Storage ==============================
 * DEFAULT_SCRIPT_URL pre-connects everyone who opens this site to the
 * shared BOM Google Sheet, so no one has to paste the Apps Script URL by
 * hand. Update it here (and redeploy) if the Apps Script is ever
 * redeployed under a new URL.
 */

const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwQdBaq0FAH7C6Uj7r7LHL1VCuqLQxqaU1IMHKRLrtFU7EDMl9---Bf5ukckOhbL7RRsA/exec';

const Store = {
  getScriptUrl: () => localStorage.getItem('bomapp.scriptUrl') || DEFAULT_SCRIPT_URL,
  setScriptUrl: (v) => localStorage.setItem('bomapp.scriptUrl', v),
  getCreatedBy: () => localStorage.getItem('bomapp.createdBy') || '',
  setCreatedBy: (v) => localStorage.setItem('bomapp.createdBy', v),
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
  bootstrap: () => Api.get('bootstrap'),
  recipe: (item) => Api.get('recipe', { item }),
  orders: () => Api.get('orders'),
  saveOrder: (order) => Api.post('saveOrder', { order }),
  addPackagingCode: (code, description) => Api.post('addPackagingCode', { code, description }),
  addColorShade: (code, description) => Api.post('addColorShade', { code, description }),
  addMaterial: (material) => Api.post('addMaterial', { material }),
  addBaseItem: (name) => Api.post('addBaseItem', { name }),
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
    document.addEventListener('click', (e) => {
      if (!this.mount.contains(e.target)) this._close();
    });
  }

  setItems(items) {
    this.items = items || [];
    this._render();
  }

  setValue(text) {
    this.input.value = text || '';
    this.value = text || '';
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

    results.forEach((it, i) => {
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

/* ============================== App State ============================== */

const App = {
  data: { materials: [], baseItems: [], packagingCodes: [], colorShades: [] },
  lines: [], // current BOM lines being edited: {rowId, materialCode, materialName, dept, unit, qtyPerFg, stockQty, remarks}
  itemBuild: { baseModel: '', packaging: '', color: '' },
  rowSeq: 1,
  connected: false,
};

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

/* ------------------------------ Connection ------------------------------ */

function setStatus(state, text) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusText');
  dot.className = 'status-dot' + (state ? ' is-' + state : '');
  label.textContent = text;
}

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
    setStatus('ok', 'เชื่อมต่อแล้ว');
    App.connected = true;
    await loadBootstrap();
  } catch (err) {
    setStatus('', 'เชื่อมต่อไม่สำเร็จ');
    App.connected = false;
    toast('เชื่อมต่อ Google Sheet ไม่สำเร็จ: ' + err.message, 'error');
  }
}

async function loadBootstrap() {
  const res = await Api.bootstrap();
  if (!res.ok) { toast('โหลดข้อมูลไม่สำเร็จ: ' + res.error, 'error'); return; }
  App.data.materials = res.materials || [];
  App.data.baseItems = res.baseItems || [];
  App.data.packagingCodes = res.packagingCodes || [];
  App.data.colorShades = res.colorShades || [];

  refreshBaseModelItems();
  refreshPackagingItems();
  refreshColorItems();
  refreshMaterialCatalogCache();
}

/* --------------------------- Item code builder --------------------------- */

let cbBaseModel, cbPackaging, cbColor, cbMaterialFactory;

function refreshBaseModelItems() {
  const items = App.data.baseItems.map((name) => ({ value: name, label: name }));
  cbBaseModel.setItems(items);
}
function refreshPackagingItems() {
  const items = App.data.packagingCodes.map((r) => ({
    value: r.CODE, label: r.CODE, sub: r.DESCRIPTION || '',
  }));
  cbPackaging.setItems(items);
}
function refreshColorItems() {
  const items = App.data.colorShades.map((r) => ({
    value: r.CODE, label: r.CODE, sub: r.DESCRIPTION || '(ยังไม่มีคำอธิบาย)',
  }));
  cbColor.setItems(items);
}

let materialCatalogItems = [];
function refreshMaterialCatalogCache() {
  materialCatalogItems = App.data.materials.map((m) => ({
    value: m.CODE, label: m.CODE, sub: [m.NAME, m.UNIT].filter(Boolean).join(' · '),
    __row: m,
  }));
}

function updateItemPreview() {
  const manual = document.getElementById('itemManualToggle').checked;
  const previewEl = document.getElementById('itemPreview');
  let value = '';
  if (manual) {
    value = document.getElementById('itemManualInput').value.trim();
  } else {
    const { baseModel, packaging, color } = App.itemBuild;
    if (baseModel && packaging && color) value = `${baseModel}(${packaging})-${color}`;
    else if (baseModel) value = baseModel + (packaging ? `(${packaging})` : '') + (color ? `-${color}` : '');
  }
  previewEl.textContent = value || '—';
  document.getElementById('loadRecipeBtn').disabled = !value;
  return value;
}

function currentItemCode() {
  return updateItemPreview();
}

async function ensureLookupCreated(kind, code) {
  try {
    if (kind === 'packaging') {
      await Api.addPackagingCode(code, '');
      if (!App.data.packagingCodes.some((r) => r.CODE === code)) {
        App.data.packagingCodes.push({ CODE: code, DESCRIPTION: '' });
        refreshPackagingItems();
      }
    } else if (kind === 'color') {
      await Api.addColorShade(code, '');
      if (!App.data.colorShades.some((r) => r.CODE === code)) {
        App.data.colorShades.push({ CODE: code, DESCRIPTION: '' });
        refreshColorItems();
      }
    } else if (kind === 'baseModel') {
      await Api.addBaseItem(code);
      if (!App.data.baseItems.includes(code)) {
        App.data.baseItems.push(code);
        refreshBaseModelItems();
      }
    }
    toast('เพิ่มรายการใหม่แล้ว: ' + code, 'success');
  } catch (err) {
    toast('บันทึกรายการใหม่ไม่สำเร็จ: ' + err.message, 'error');
  }
}

function initItemBuilder() {
  cbBaseModel = new Combobox(document.getElementById('cb-baseModel'), {
    placeholder: 'ค้นหาหรือพิมพ์รุ่นสินค้าใหม่...',
    allowCreate: true,
    createLabel: (q) => `+ เพิ่มรุ่นสินค้าใหม่: "${q}"`,
    onSelect: (item) => {
      App.itemBuild.baseModel = item.value;
      if (item.__created) ensureLookupCreated('baseModel', item.value);
      updateItemPreview();
    },
  });
  cbPackaging = new Combobox(document.getElementById('cb-packaging'), {
    placeholder: 'เช่น P, B, X, C...',
    allowCreate: true,
    createLabel: (q) => `+ เพิ่มรหัส Packaging ใหม่: "${q}"`,
    onSelect: (item) => {
      App.itemBuild.packaging = item.value;
      if (item.__created) ensureLookupCreated('packaging', item.value);
      updateItemPreview();
    },
  });
  cbColor = new Combobox(document.getElementById('cb-color'), {
    placeholder: 'เช่น A, Y, Z...',
    allowCreate: true,
    createLabel: (q) => `+ เพิ่มเฉดสีใหม่: "${q}"`,
    onSelect: (item) => {
      App.itemBuild.color = item.value;
      if (item.__created) ensureLookupCreated('color', item.value);
      updateItemPreview();
    },
  });

  document.getElementById('itemManualToggle').addEventListener('change', (e) => {
    document.getElementById('itemManualInput').disabled = !e.target.checked;
    updateItemPreview();
  });
  document.getElementById('itemManualInput').addEventListener('input', updateItemPreview);

  document.getElementById('loadRecipeBtn').addEventListener('click', loadRecipeFromMaster);
}

async function loadRecipeFromMaster() {
  const item = currentItemCode();
  const hint = document.getElementById('recipeHint');
  const btn = document.getElementById('loadRecipeBtn');

  btn.disabled = true;
  hint.textContent = 'กำลังค้นหาสูตรวัตถุดิบเดิม...';
  let rows;
  try {
    let res = await Api.recipe(item);
    if (!res.ok) throw new Error(res.error || 'unknown API error');
    rows = res.rows;
    if ((!rows || !rows.length) && App.itemBuild.baseModel && App.itemBuild.baseModel !== item) {
      res = await Api.recipe(App.itemBuild.baseModel);
      if (!res.ok) throw new Error(res.error || 'unknown API error');
      rows = res.rows;
    }
  } catch (err) {
    hint.textContent = 'ค้นหาสูตรวัตถุดิบไม่สำเร็จ: ' + err.message;
    btn.disabled = false;
    return;
  }
  btn.disabled = false;

  if (!rows || !rows.length) {
    hint.textContent = 'ไม่พบสูตรวัตถุดิบเดิมสำหรับรหัสนี้ในระบบเก่า — เพิ่มรายการเองได้ด้านล่าง';
    return;
  }
  if (App.lines.length && !confirm(`พบสูตรวัตถุดิบเดิม ${rows.length} รายการ — แทนที่รายการปัจจุบันหรือไม่?`)) {
    return;
  }
  App.lines = [];
  rows.forEach((r) => {
    addLine({
      materialCode: r.CODE || '',
      materialName: r.NAME || '',
      dept: r.DEPT_MAKER || r.DEPT || '',
      unit: r.CUT_UNIT || r.PIECES_UNIT || '',
      qtyPerFg: r.QTY_PER_SET || '',
      stockQty: '',
      remarks: '',
    });
  });
  hint.textContent = `โหลดสูตรวัตถุดิบเดิมแล้ว ${rows.length} รายการ`;
  renderLines();
}

/* ------------------------------- BOM lines ------------------------------- */

function addLine(prefill) {
  App.lines.push(Object.assign({
    rowId: App.rowSeq++,
    materialCode: '', materialName: '', dept: '', unit: '',
    qtyPerFg: '', stockQty: '', remarks: '',
  }, prefill || {}));
}

function removeLine(rowId) {
  App.lines = App.lines.filter((l) => l.rowId !== rowId);
  renderLines();
}

function orderQty() {
  const v = parseFloat(document.getElementById('f-orderQty').value);
  return isNaN(v) ? 0 : v;
}

function requiredQty(line) {
  const qpf = parseFloat(line.qtyPerFg);
  const stock = parseFloat(line.stockQty);
  if (isNaN(qpf)) return '';
  const need = qpf * orderQty() - (isNaN(stock) ? 0 : stock);
  return Math.round(need * 1000) / 1000;
}

function renderLines() {
  const tbody = document.getElementById('bomTableBody');
  tbody.innerHTML = '';
  document.getElementById('bomEmptyHint').style.display = App.lines.length ? 'none' : 'block';

  App.lines.forEach((line) => {
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
    nameInput.addEventListener('input', (e) => { line.materialName = e.target.value; });
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
          Api.addMaterial({ code: item.value, name: line.materialName, dept: line.dept, unit: line.unit })
            .then(() => {
              materialCatalogItems.push({ value: item.value, label: item.value, sub: '', __row: { CODE: item.value } });
              toast('เพิ่มรหัสวัตถุดิบใหม่แล้ว: ' + item.value, 'success');
            }).catch((err) => toast('เพิ่มวัตถุดิบไม่สำเร็จ: ' + err.message, 'error'));
        }
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
    qtyInput.addEventListener('input', (e) => { line.qtyPerFg = e.target.value; updateRequiredCell(tr, line); });
    tdQty.appendChild(qtyInput);
    tr.appendChild(tdQty);

    const tdUnit = document.createElement('td');
    const unitInput = document.createElement('input');
    unitInput.type = 'text';
    unitInput.value = line.unit;
    unitInput.addEventListener('input', (e) => { line.unit = e.target.value; });
    tdUnit.appendChild(unitInput);
    tr.appendChild(tdUnit);

    const tdStock = document.createElement('td');
    const stockInput = document.createElement('input');
    stockInput.type = 'number';
    stockInput.step = 'any';
    stockInput.value = line.stockQty;
    stockInput.addEventListener('input', (e) => { line.stockQty = e.target.value; updateRequiredCell(tr, line); });
    tdStock.appendChild(stockInput);
    tr.appendChild(tdStock);

    const tdReq = document.createElement('td');
    tdReq.className = 'required-cell';
    tdReq.textContent = fmtNum(requiredQty(line));
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
    delBtn.addEventListener('click', () => removeLine(line.rowId));
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);

    tbody.appendChild(tr);
  });
}

function updateRequiredCell(tr, line) {
  const cell = tr.children[5];
  const req = requiredQty(line);
  cell.textContent = fmtNum(req);
  cell.classList.toggle('required-negative', typeof req === 'number' && req < 0);
}

function recalcAllRequired() {
  const tbody = document.getElementById('bomTableBody');
  Array.from(tbody.children).forEach((tr) => {
    const rowId = Number(tr.dataset.rowId);
    const line = App.lines.find((l) => l.rowId === rowId);
    if (line) updateRequiredCell(tr, line);
  });
}

/* --------------------------------- Save ---------------------------------- */

function resetForm() {
  App.lines = [];
  App.itemBuild = { baseModel: '', packaging: '', color: '' };
  cbBaseModel.setValue(''); cbPackaging.setValue(''); cbColor.setValue('');
  document.getElementById('itemManualToggle').checked = false;
  document.getElementById('itemManualInput').value = '';
  document.getElementById('itemManualInput').disabled = true;
  document.getElementById('f-customer').value = '';
  document.getElementById('f-poref').value = '';
  document.getElementById('f-orderQty').value = '';
  document.getElementById('f-orderDate').value = '';
  document.getElementById('f-dueDate').value = '';
  document.getElementById('f-remarks').value = '';
  document.getElementById('recipeHint').textContent = '';
  updateItemPreview();
  renderLines();
}

async function saveOrder() {
  const item = currentItemCode();
  const msgEl = document.getElementById('saveMsg');
  if (!App.connected) { toast('กรุณาเชื่อมต่อ Google Sheet ก่อน (เมนู "การเชื่อมต่อ")', 'error'); return; }
  if (!item) { toast('กรุณากรอกรหัส ITEM ให้ครบก่อนบันทึก', 'error'); return; }

  const order = {
    item,
    baseModel: App.itemBuild.baseModel,
    packagingCode: App.itemBuild.packaging,
    colorCode: App.itemBuild.color,
    customer: document.getElementById('f-customer').value,
    orderQty: document.getElementById('f-orderQty').value,
    orderDate: document.getElementById('f-orderDate').value,
    dueDate: document.getElementById('f-dueDate').value,
    remarks: document.getElementById('f-remarks').value,
    createdBy: Store.getCreatedBy(),
    lines: App.lines.map((l) => ({
      materialCode: l.materialCode,
      materialName: l.materialName,
      dept: l.dept,
      qtyPerFg: l.qtyPerFg,
      unit: l.unit,
      stockQty: l.stockQty,
      requiredQty: requiredQty(l),
      remarks: l.remarks,
    })),
  };

  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  msgEl.textContent = 'กำลังบันทึก...';
  msgEl.className = 'save-bar-msg';
  try {
    const res = await Api.saveOrder(order);
    if (!res.ok) throw new Error(res.error || 'unknown error');
    msgEl.textContent = `บันทึกสำเร็จ (เลขที่: ${res.orderId})`;
    msgEl.className = 'save-bar-msg is-success';
    toast('บันทึก BOM ลง Google Sheet สำเร็จ', 'success');
    resetForm();
  } catch (err) {
    msgEl.textContent = 'บันทึกไม่สำเร็จ: ' + err.message;
    msgEl.className = 'save-bar-msg is-error';
    toast('บันทึกไม่สำเร็จ: ' + err.message, 'error');
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
    renderHistory();
  } catch (err) {
    listEl.innerHTML = '<div class="history-empty">โหลดประวัติไม่สำเร็จ: ' + err.message + '</div>';
  }
}

function renderHistory() {
  const listEl = document.getElementById('historyList');
  if (!historyCache) return;
  const q = document.getElementById('historySearch').value.trim().toLowerCase();

  const linesByOrder = new Map();
  historyCache.lines.forEach((l) => {
    if (!linesByOrder.has(l.ORDER_ID)) linesByOrder.set(l.ORDER_ID, []);
    linesByOrder.get(l.ORDER_ID).push(l);
  });

  let orders = historyCache.orders.slice().sort((a, b) => String(b.TIMESTAMP).localeCompare(String(a.TIMESTAMP)));
  if (q) {
    orders = orders.filter((o) =>
      [o.ITEM, o.CUSTOMER, o.ORDER_ID, o.BASE_MODEL].some((v) => v && String(v).toLowerCase().includes(q)));
  }

  listEl.innerHTML = '';
  if (!orders.length) {
    listEl.innerHTML = '<div class="history-empty">ไม่พบรายการ</div>';
    return;
  }

  orders.forEach((o) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const head = document.createElement('div');
    head.className = 'history-item-head';
    head.innerHTML = `
      <span class="hi-item">${escapeHtml(o.ITEM || '')}</span>
      <span class="hi-meta">${escapeHtml(o.CUSTOMER || '')}</span>
      <span class="hi-meta">จำนวน ${escapeHtml(o.ORDER_QTY || '')}</span>
      <span class="hi-meta">${escapeHtml(String(o.TIMESTAMP || '').slice(0, 16).replace('T', ' '))}</span>
      <span class="hi-spacer"></span>
      <button class="btn btn-secondary btn-sm hi-dup">ใช้เป็นแบบร่างใหม่</button>
    `;
    head.querySelector('.hi-dup').addEventListener('click', (e) => {
      e.stopPropagation();
      duplicateOrder(o, linesByOrder.get(o.ORDER_ID) || []);
    });
    head.addEventListener('click', () => item.classList.toggle('is-open'));

    const body = document.createElement('div');
    body.className = 'history-item-body';
    const lines = linesByOrder.get(o.ORDER_ID) || [];
    if (!lines.length) {
      body.innerHTML = '<div class="history-empty">ไม่มีรายการวัตถุดิบ</div>';
    } else {
      const rows = lines.map((l) => `
        <tr>
          <td>${escapeHtml(l.MATERIAL_CODE || '')}</td>
          <td>${escapeHtml(l.MATERIAL_NAME || '')}</td>
          <td>${escapeHtml(l.QTY_PER_FG || '')}</td>
          <td>${escapeHtml(l.UNIT || '')}</td>
          <td>${escapeHtml(l.REQUIRED_QTY || '')}</td>
        </tr>`).join('');
      body.innerHTML = `<table>
        <thead><tr><th>รหัส</th><th>ชื่อวัตถุดิบ</th><th>จำนวน/1FG</th><th>หน่วย</th><th>ต้องเบิก</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    item.appendChild(head);
    item.appendChild(body);
    listEl.appendChild(item);
  });
}

function duplicateOrder(order, lines) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === 'new'));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-new'));

  document.getElementById('itemManualToggle').checked = true;
  document.getElementById('itemManualInput').disabled = false;
  document.getElementById('itemManualInput').value = order.ITEM || '';
  document.getElementById('f-customer').value = order.CUSTOMER || '';
  document.getElementById('f-poref').value = '';
  document.getElementById('f-orderQty').value = order.ORDER_QTY || '';
  document.getElementById('f-remarks').value = order.REMARKS || '';

  App.lines = [];
  lines.forEach((l) => addLine({
    materialCode: l.MATERIAL_CODE, materialName: l.MATERIAL_NAME, dept: l.DEPT,
    qtyPerFg: l.QTY_PER_FG, unit: l.UNIT, stockQty: '', remarks: l.REMARKS,
  }));
  updateItemPreview();
  renderLines();
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
  initItemBuilder();
  initSettings();

  document.getElementById('addLineBtn').addEventListener('click', () => { addLine(); renderLines(); });
  document.getElementById('saveBtn').addEventListener('click', saveOrder);
  document.getElementById('f-orderQty').addEventListener('input', recalcAllRequired);
  document.getElementById('refreshHistoryBtn').addEventListener('click', loadHistory);
  document.getElementById('historySearch').addEventListener('input', renderHistory);

  renderLines();
  connect();
}

document.addEventListener('DOMContentLoaded', init);
