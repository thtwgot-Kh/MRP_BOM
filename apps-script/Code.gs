/**
 * BOM Data Entry — Google Apps Script backend.
 *
 * Bind this script to the target Google Sheet (Extensions > Apps Script),
 * add SeedData.gs alongside it, run initializeSheet() once, then deploy as
 * a Web App ("Execute as: Me", "Who has access: Anyone"). See README.md.
 */

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
    .addItem('Initialize / Re-seed sheets', 'initializeSheet')
    .addItem('Add missing base items from SeedData', 'mergeMissingBaseItems')
    .addToUi();
}

/**
 * One-time (idempotent) setup: creates all tabs with headers, and seeds
 * BOM_Master / Materials_Catalog / FG_Base_Items / Packaging_Codes /
 * Color_Shades from SeedData.gs if those tabs are currently empty.
 */
function initializeSheet() {
  Object.keys(HEADERS).forEach(getOrCreateSheet_);

  seedIfEmpty_(SHEETS.BOM_MASTER, SEED_BOM_MASTER);
  seedIfEmpty_(SHEETS.MATERIALS, SEED_MATERIALS_CATALOG);
  seedIfEmpty_(SHEETS.BASE_ITEMS, SEED_FG_BASE_ITEMS.map(function (n) { return [n]; }));

  // Packaging / color code tables: seed the known codes with a blank
  // description column that the user fills in later.
  seedIfEmpty_(SHEETS.PACKAGING, SEED_PACKAGING_CODES.map(function (c) { return [c, '']; }));
  seedIfEmpty_(SHEETS.COLORS, SEED_COLOR_SHADES.map(function (c) { return [c, '']; }));

  return 'OK';
}

function seedIfEmpty_(sheetName, rows) {
  var sh = getOrCreateSheet_(sheetName);
  if (sh.getLastRow() > 1 || !rows || !rows.length) return;
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * Adds any base model / item codes from SeedData.gs that aren't already in
 * FG_Base_Items yet, without touching existing rows. Safe to re-run any
 * time SeedData.gs is updated with more codes (unlike initializeSheet(),
 * which only seeds a tab the first time it's empty).
 */
function mergeMissingBaseItems() {
  var sh = getOrCreateSheet_(SHEETS.BASE_ITEMS);
  var existing = sheetToObjects_(SHEETS.BASE_ITEMS).map(function (r) { return r.NAME; });
  var existingSet = {};
  existing.forEach(function (n) { existingSet[n] = true; });

  var missing = SEED_FG_BASE_ITEMS.filter(function (n) { return !existingSet[n]; });
  if (missing.length) {
    sh.getRange(sh.getLastRow() + 1, 1, missing.length, 1).setValues(missing.map(function (n) { return [n]; }));
  }
  return 'Added ' + missing.length + ' new base item(s), ' + existing.length + ' already present.';
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
        return jsonOut_({
          ok: true,
          bomMaster: sheetToObjects_(SHEETS.BOM_MASTER),
          materials: sheetToObjects_(SHEETS.MATERIALS),
          baseItems: sheetToObjects_(SHEETS.BASE_ITEMS).map(function (r) { return r.NAME; }),
          packagingCodes: sheetToObjects_(SHEETS.PACKAGING),
          colorShades: sheetToObjects_(SHEETS.COLORS)
        });
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
