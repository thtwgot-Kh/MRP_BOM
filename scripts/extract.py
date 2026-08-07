# Extraction script used to build data/*.json from the authoritative MRP
# Excel workbook (DATA sheet) plus a sample order workbook (used only to
# mine additional Base(Pkg)-Color naming examples). Not meant to run
# unmodified — replace F_FULL / F_ORDER below with the path to your own
# source workbooks if you need to regenerate the data (see README.md
# "การแก้ไข/อัปเดตข้อมูลตั้งต้นในอนาคต"). Apps Script pulls data/*.json
# directly from GitHub at sync time (see apps-script/Code.gs
# resyncMasterData()) — there is no separate "seed data" build step beyond
# running this script and committing the resulting JSON files.
import openpyxl, json, re, collections, time

F_FULL = "/path/to/Material_MP_MRP_41_Ver_Toy.xlsm"   # authoritative MRP workbook (DATA sheet)
F_ORDER = "/path/to/FIRST_order_BOMSHEET.xlsx"         # sample order workbook (BOMSHEET (S) sheet)

t0 = time.time()
wb = openpyxl.load_workbook(F_FULL, data_only=True, keep_vba=False, read_only=True)
ws = wb['DATA']
print("loaded DATA sheet in", time.time() - t0, "s, max_row =", ws.max_row)


def norm(v):
    if v is None or v == '-' or v == '':
        return None
    return v


# Column layout (row 2 headers), columns A-U:
# A=ITEM, B=(RB weight, unused), C=CODE, D=DEPT, E=FORMULA, F=SE_COLOR,
# G=SE_LENGTH, H=HOLE, I=OUTER_SE, J=OUTER_RB, K=NAME, L=DEPT_MAKER,
# M=QTY_PER_SET, N=CUT_LENGTH, O=CUT_UNIT, P=PIECES_PER_RB, Q=PIECES_UNIT,
# R=QTY_PER_1GR, S=QTY_PER_1GR_UNIT, T=RB_COUNT_UNIT, U=RB_WEIGHT
recipe = []
row_count = 0
for row in ws.iter_rows(min_row=3, max_col=21, values_only=True):
    row_count += 1
    item = row[0]
    if not item:
        continue
    code = norm(row[2])
    name = norm(row[10])
    if not code and not name:
        continue
    rec = {
        'item': str(item).strip(),
        'code': code,
        'dept': norm(row[3]),
        'formula': norm(row[4]),
        'seColor': norm(row[5]),
        'seLength': norm(row[6]),
        'hole': norm(row[7]),
        'outerSE': norm(row[8]),
        'outerRB': norm(row[9]),
        'name': name,
        'deptMaker': norm(row[11]),
        'qtyPerSet': norm(row[12]),
        'cutLength': norm(row[13]),
        'cutUnit': norm(row[14]),
        'piecesPerRB': norm(row[15]),
        'piecesUnit': norm(row[16]),
        'qtyPer1GR': norm(row[17]),
        'qtyPer1GRUnit': norm(row[18]),
        'rbCountUnit': norm(row[19]),
        'rbWeight': norm(row[20]),
    }
    recipe.append(rec)

print("scanned rows:", row_count)
print("total recipe rows kept:", len(recipe))
print("unique items:", len(set(r['item'] for r in recipe)))
print("unique material codes:", len(set(r['code'] for r in recipe if r['code'])))

with open('/home/user/MRP_BOM/data/bom_master.json', 'w', encoding='utf-8') as fo:
    json.dump(recipe, fo, ensure_ascii=False, indent=None)

# Materials catalog: dedupe by code, keep the most common name/dept/unit
# seen across all the recipe rows that reference it.
by_code = collections.defaultdict(list)
for r in recipe:
    if r['code']:
        by_code[r['code']].append(r)

catalog = []
for code, rows in by_code.items():
    names = collections.Counter(r['name'] for r in rows if r['name'])
    depts = collections.Counter(r['deptMaker'] or r['dept'] for r in rows if (r['deptMaker'] or r['dept']))
    units = collections.Counter(r['cutUnit'] for r in rows if r['cutUnit'])
    if not units:
        units = collections.Counter(r['piecesUnit'] for r in rows if r['piecesUnit'])
    catalog.append({
        'code': code,
        'name': names.most_common(1)[0][0] if names else None,
        'dept': depts.most_common(1)[0][0] if depts else None,
        'unit': units.most_common(1)[0][0] if units else None,
        'usageCount': len(rows),
    })
catalog.sort(key=lambda x: -x['usageCount'])
print("materials catalog size:", len(catalog))
with open('/home/user/MRP_BOM/data/materials_catalog.json', 'w', encoding='utf-8') as fo:
    json.dump(catalog, fo, ensure_ascii=False, indent=None)

# Base model names / packaging codes / color shades: mine the
# "Base(Pkg)-Color" pattern (e.g. "GC-23/P(P)-Y") from ITEM, CODE and NAME
# across the full DATA sheet plus the sample order workbook. This list is
# unioned with the full set of legacy ITEM codes at sync time in
# apps-script/Code.gs (resyncMasterData), not here, so this file stays a
# clean "root model name" list on its own.
pat = re.compile(r'^(.+?)\(([A-Za-z0-9]{1,3})\)-([A-Za-z0-9]{1,3})$')
base_items = collections.Counter()
pkg_codes = collections.Counter()
color_codes = collections.Counter()


def scan_value(v):
    if not isinstance(v, str):
        return
    s = v.strip()
    s = re.sub(r'^(สินค้า|ประทีป-|ไทยเซ็นทรี-)\s*', '', s)
    m = pat.match(s)
    if m:
        base, pkg, color = m.groups()
        base_items[base.strip()] += 1
        pkg_codes[pkg] += 1
        color_codes[color] += 1


for r in recipe:
    scan_value(r['item'])
    scan_value(r['name'])
    scan_value(r['code'])

wb2 = openpyxl.load_workbook(F_ORDER, data_only=True)
for sn in wb2.sheetnames:
    ws2 = wb2[sn]
    for row in ws2.iter_rows(values_only=True):
        for v in row:
            scan_value(v)

print("mined base items:", len(base_items))
print("mined packaging codes:", dict(pkg_codes.most_common(30)))
print("mined color codes:", dict(color_codes.most_common(30)))

with open('/home/user/MRP_BOM/data/fg_base_items.json', 'w', encoding='utf-8') as fo:
    json.dump(sorted(base_items.keys()), fo, ensure_ascii=False, indent=None)
with open('/home/user/MRP_BOM/data/packaging_codes.json', 'w', encoding='utf-8') as fo:
    json.dump(sorted(pkg_codes.keys()), fo, ensure_ascii=False, indent=None)
with open('/home/user/MRP_BOM/data/color_shades.json', 'w', encoding='utf-8') as fo:
    json.dump(sorted(color_codes.keys()), fo, ensure_ascii=False, indent=None)

print("DONE in", time.time() - t0, "s")
