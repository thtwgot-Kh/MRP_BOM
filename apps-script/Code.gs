/**
 * BOM Data Entry — Google Apps Script backend.
 *
 * Bind this script to the target Google Sheet (Extensions > Apps Script),
 * paste this whole file in as Code.gs, run initializeSheet() once (creates
 * the tabs), then run resyncMasterData() to pull the reference data
 * (BOM_Master / Materials_Catalog / FG_Base_Items / Packaging_Codes /
 * Color_Shades) from the JSON files in this repo's data/ folder. Re-run
 * resyncMasterData() any time the repo's data/*.json is updated — it never
 * touches BOM_Orders / BOM_Order_Lines. Deploy as a Web App ("Execute as:
 * Me", "Who has access: Anyone"). See README.md.
 */

// Where the authoritative reference data lives. Update the branch name here
// if the repo's default branch ever changes.
var RAW_BASE_URL = 'https://raw.githubusercontent.com/thtwgot-Kh/MRP_BOM/claude/bom-data-entry-website-w8av10/data/';

var SHEETS = {
  BOM_MASTER: 'BOM_Master',
  MATERIALS: 'Materials_Catalog',
  BASE_ITEMS: 'FG_Base_Items',
  PACKAGING: 'Packaging_Codes',
  COLORS: 'Color_Shades',
  ORDERS: 'BOM_Orders',
  LINES: 'BOM_Order_Lines'
};

var HEADERS = {
  BOM_Master: ['ITEM','CODE','DEPT','FORMULA','SE_COLOR','SE_LENGTH','HOLE','OUTER_SE','OUTER_RB',
    'NAME','DEPT_MAKER','QTY_PER_SET','CUT_LENGTH','CUT_UNIT','PIECES_PER_RB','PIECES_UNIT',
    'QTY_PER_1GR','QTY_PER_1GR_UNIT','RB_COUNT_UNIT','RB_WEIGHT'],
  Materials_Catalog: ['CODE','NAME','DEPT','UNIT','USAGE_COUNT'],
  FG_Base_Items: ['NAME'],
  Packaging_Codes: ['CODE','DESCRIPTION'],
  Color_Shades: ['CODE','DESCRIPTION'],
  BOM_Orders: ['ORDER_ID','TIMESTAMP','ITEM','BASE_MODEL','PACKAGING_CODE','COLOR_CODE',
    'CUSTOMER','ORDER_QTY','ORDER_DATE','DUE_DATE','REMARKS','CREATED_BY'],
  BOM_Order_Lines: ['ORDER_ID','LINE_NO','MATERIAL_CODE','MATERIAL_NAME','DEPT','QTY_PER_FG',
    'UNIT','STOCK_QTY','REQUIRED_QTY','REMARKS']
};

// bom_master.json rows are objects keyed like this (see scripts/extract.py).
var RECIPE_FIELDS = ['item','code','dept','formula','seColor','seLength','hole','outerSE','outerRB',
  'name','deptMaker','qtyPerSet','cutLength','cutUnit','piecesPerRB','piecesUnit',
  'qtyPer1GR','qtyPer1GRUnit','rbCountUnit','rbWeight'];
var CATALOG_FIELDS = ['code','name','dept','unit','usageCount'];

function getSS_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet_(name) {
  var ss = getSS_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  }
  var headers = HEADERS[name];
  if (headers) {
    var firstRow = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    var needsHeader = headers.some(function (h, i) { return firstRow[i] !== h; });
    if (needsHeader) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

/** Menu for convenience when opening the sheet directly. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('BOM App')
    .addItem('1. Initialize sheets (create tabs)', 'initializeSheet')
    .addItem('2. Sync master data from GitHub (replace)', 'resyncMasterData')
    .addToUi();
}

/** Creates all tabs with headers. Safe to re-run any time — never touches data. */
function initializeSheet() {
  Object.keys(HEADERS).forEach(getOrCreateSheet_);
  return 'OK';
}

function fetchJson_(name) {
  var res = UrlFetchApp.fetch(RAW_BASE_URL + name + '.json', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error('Failed to fetch ' + name + '.json: HTTP ' + res.getResponseCode());
  }
  return JSON.parse(res.getContentText());
}

function clearAndWrite_(sheetName, rows) {
  var sh = getOrCreateSheet_(sheetName);
  var numCols = HEADERS[sheetName].length;
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, numCols).clearContent();
  }
  if (rows && rows.length) {
    sh.getRange(2, 1, rows.length, numCols).setValues(rows);
  }
}

/**
 * Pulls BOM_Master / Materials_Catalog / FG_Base_Items / Packaging_Codes /
 * Color_Shades from this repo's data/*.json (GitHub raw) and refreshes the
 * sheet:
 *  - BOM_Master, Materials_Catalog, FG_Base_Items are fully REPLACED —
 *    data/*.json is the authoritative source, so stale rows from a
 *    previous import are cleared out rather than merged.
 *  - Packaging_Codes / Color_Shades only get MISSING codes appended, so any
 *    descriptions you've already filled in are preserved.
 *  - BOM_Orders / BOM_Order_Lines (your saved production orders) are never
 *    touched.
 * Safe to re-run any time data/*.json is updated in the repo.
 */
function resyncMasterData() {
  Object.keys(HEADERS).forEach(getOrCreateSheet_);

  var bomMaster = fetchJson_('bom_master');
  var bomMasterRows = bomMaster.map(function (r) {
    return RECIPE_FIELDS.map(function (k) { return r[k] == null ? '' : r[k]; });
  });
  clearAndWrite_(SHEETS.BOM_MASTER, bomMasterRows);

  var catalog = fetchJson_('materials_catalog');
  var catalogRows = catalog.map(function (r) {
    return CATALOG_FIELDS.map(function (k) { return r[k] == null ? '' : r[k]; });
  });
  clearAndWrite_(SHEETS.MATERIALS, catalogRows);

  // FG_Base_Items = every unique legacy ITEM code (so "load recipe" and
  // reusing an exact existing item both work) unioned with the mined
  // "root model name" list (for composing brand-new item codes).
  var minedBaseItems = fetchJson_('fg_base_items');
  var itemSet = {};
  bomMaster.forEach(function (r) { if (r.item) itemSet[r.item] = true; });
  minedBaseItems.forEach(function (n) { itemSet[n] = true; });
  var allBaseItems = Object.keys(itemSet).sort();
  clearAndWrite_(SHEETS.BASE_ITEMS, allBaseItems.map(function (n) { return [n]; }));

  mergeMissingCodes_(SHEETS.PACKAGING, fetchJson_('packaging_codes'));
  mergeMissingCodes_(SHEETS.COLORS, fetchJson_('color_shades'));

  return 'Synced: ' + bomMasterRows.length + ' recipe rows, ' + catalogRows.length +
    ' materials, ' + allBaseItems.length + ' base items.';
}

function mergeMissingCodes_(sheetName, codes) {
  var sh = getOrCreateSheet_(sheetName);
  var existing = sheetToObjects_(sheetName).map(function (r) { return String(r.CODE); });
  var existingSet = {};
  existing.forEach(function (c) { existingSet[c] = true; });
  var missing = codes.filter(function (c) { return !existingSet[c]; });
  if (missing.length) {
    sh.getRange(sh.getLastRow() + 1, 1, missing.length, 2).setValues(
      missing.map(function (c) { return [c, '']; }));
  }
}

function sheetToObjects_(sheetName) {
  var sh = getSS_().getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];
  var headers = HEADERS[sheetName];
  var numCols = headers.length;
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, numCols).getValues();
  return values
    .filter(function (row) { return row.some(function (v) { return v !== '' && v !== null; }); })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

/** GET /exec?action=... */
function doGet(e) {
  var action = (e.parameter && e.parameter.action) || 'ping';
  try {
    switch (action) {
      case 'ping':
        return jsonOut_({ ok: true, time: new Date().toISOString() });
      case 'bootstrap':
        // BOM_Master is intentionally excluded here (tens of thousands of
        // rows) — use action=recipe to look up one item's recipe on demand.
        return jsonOut_({
          ok: true,
          materials: sheetToObjects_(SHEETS.MATERIALS),
          baseItems: sheetToObjects_(SHEETS.BASE_ITEMS).map(function (r) { return r.NAME; }),
          packagingCodes: sheetToObjects_(SHEETS.PACKAGING),
          colorShades: sheetToObjects_(SHEETS.COLORS)
        });
      case 'recipe':
        return jsonOut_({ ok: true, rows: getRecipeForItem_(e.parameter.item || '') });
      case 'orders':
        return jsonOut_({
          ok: true,
          orders: sheetToObjects_(SHEETS.ORDERS),
          lines: sheetToObjects_(SHEETS.LINES)
        });
      default:
        return jsonOut_({ ok: false, error: 'unknown action: ' + action });
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function getRecipeForItem_(item) {
  if (!item) return [];
  var all = sheetToObjects_(SHEETS.BOM_MASTER);
  return all.filter(function (r) { return r.ITEM === item; });
}

/**
 * POST /exec — body is a JSON string sent with Content-Type: text/plain
 * (avoids a CORS preflight, which Apps Script web apps cannot answer).
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'invalid JSON body' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    switch (body.action) {
      case 'saveOrder':
        return jsonOut_(saveOrder_(body.order));
      case 'addPackagingCode':
        return jsonOut_(addLookupRow_(SHEETS.PACKAGING, body.code, body.description));
      case 'addColorShade':
        return jsonOut_(addLookupRow_(SHEETS.COLORS, body.code, body.description));
      case 'addMaterial':
        return jsonOut_(addMaterial_(body.material));
      case 'addBaseItem':
        return jsonOut_(addBaseItem_(body.name));
      default:
        return jsonOut_({ ok: false, error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function nextOrderId_() {
  var tz = Session.getScriptTimeZone();
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd-HHmmss');
  return 'BOM-' + stamp + '-' + Math.floor(Math.random() * 900 + 100);
}

function saveOrder_(order) {
  if (!order || !order.item) {
    return { ok: false, error: 'missing order.item' };
  }
  var orderSheet = getOrCreateSheet_(SHEETS.ORDERS);
  var lineSheet = getOrCreateSheet_(SHEETS.LINES);

  var orderId = order.orderId || nextOrderId_();
  var now = new Date().toISOString();

  var headerRow = [
    orderId, now, order.item, order.baseModel || '', order.packagingCode || '',
    order.colorCode || '', order.customer || '', order.orderQty || '',
    order.orderDate || '', order.dueDate || '', order.remarks || '', order.createdBy || ''
  ];
  orderSheet.appendRow(headerRow);

  var lines = order.lines || [];
  if (lines.length) {
    var rows = lines.map(function (l, i) {
      return [
        orderId, i + 1, l.materialCode || '', l.materialName || '', l.dept || '',
        l.qtyPerFg || '', l.unit || '', l.stockQty || '', l.requiredQty || '', l.remarks || ''
      ];
    });
    lineSheet.getRange(lineSheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  return { ok: true, orderId: orderId };
}

function addLookupRow_(sheetName, code, description) {
  if (!code) return { ok: false, error: 'missing code' };
  var sh = getOrCreateSheet_(sheetName);
  var existing = sheetToObjects_(sheetName);
  var found = existing.some(function (r) { return String(r.CODE) === String(code); });
  if (!found) {
    sh.appendRow([code, description || '']);
  }
  return { ok: true, code: code };
}

function addMaterial_(material) {
  if (!material || !material.code) return { ok: false, error: 'missing material.code' };
  var sh = getOrCreateSheet_(SHEETS.MATERIALS);
  var existing = sheetToObjects_(SHEETS.MATERIALS);
  var found = existing.some(function (r) { return String(r.CODE) === String(material.code); });
  if (!found) {
    sh.appendRow([material.code, material.name || '', material.dept || '', material.unit || '', 0]);
  }
  return { ok: true, code: material.code };
}

function addBaseItem_(name) {
  if (!name) return { ok: false, error: 'missing name' };
  var sh = getOrCreateSheet_(SHEETS.BASE_ITEMS);
  var existing = sheetToObjects_(SHEETS.BASE_ITEMS).map(function (r) { return r.NAME; });
  if (existing.indexOf(name) === -1) {
    sh.appendRow([name]);
  }
  return { ok: true, name: name };
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
