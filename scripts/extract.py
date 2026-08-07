# One-off extraction script used to build data/*.json and apps-script/SeedData.gs
# from the original MRP Excel workbooks. Not meant to run unmodified — replace
# f1/f2 below with the path to your own source workbooks if you need to
# regenerate the seed data (see README.md "การแก้ไข/อัปเดตข้อมูลตั้งต้นในอนาคต").
import openpyxl, json, re, collections

f1 = "/path/to/Test_Material_MP_MRP_4.1.xlsm"  # legacy MRP workbook (DATA sheet)
f2 = "/path/to/FIRST_order_BOMSHEET.xlsx"      # sample order workbook (BOMSHEET (S) sheet)

wb = openpyxl.load_workbook(f1, data_only=True, keep_vba=False)
ws = wb['DATA']

cols = ['item','no','code','dept','formula','seColor','seLength','hole','outerSE','outerRB',
        None,'name','deptMaker','qtyPerSet','cutLength','cutUnit','piecesPerRB','piecesUnit',
        'qtyPer1GR','qtyPer1GRUnit','rbCountUnit','rbWeight']
# columns A..U = 1..21, but J is index10 'outerRB', K index11 blank col? let's map by letter directly instead

def cellval(ws,r,c):
    v = ws.cell(row=r, column=c).value
    if v == '-' or v == '' :
        return None
    return v

recipe = []
for r in range(3, ws.max_row+1):
    item = cellval(ws, r, 1)
    if not item:
        continue
    rec = {
        'item': str(item).strip(),
        'no': cellval(ws,r,2),
        'code': cellval(ws,r,3),
        'dept': cellval(ws,r,4),
        'formula': cellval(ws,r,5),
        'seColor': cellval(ws,r,6),
        'seLength': cellval(ws,r,7),
        'hole': cellval(ws,r,8),
        'outerSE': cellval(ws,r,9),
        'outerRB': cellval(ws,r,10),
        'name': cellval(ws,r,11),
        'deptMaker': cellval(ws,r,12),
        'qtyPerSet': cellval(ws,r,13),
        'cutLength': cellval(ws,r,14),
        'cutUnit': cellval(ws,r,15),
        'piecesPerRB': cellval(ws,r,16),
        'piecesUnit': cellval(ws,r,17),
        'qtyPer1GR': cellval(ws,r,18),
        'qtyPer1GRUnit': cellval(ws,r,19),
        'rbCountUnit': cellval(ws,r,20),
        'rbWeight': cellval(ws,r,21),
    }
    if not rec['code'] and not rec['name']:
        continue
    recipe.append(rec)

print("total recipe rows:", len(recipe))
print("unique items:", len(set(r['item'] for r in recipe)))
print("unique material codes:", len(set(r['code'] for r in recipe if r['code'])))

with open('/home/user/MRP_BOM/data/bom_master.json','w',encoding='utf-8') as fo:
    json.dump(recipe, fo, ensure_ascii=False, indent=None)

# Build materials catalog: dedupe by code, pick most common name/unit/dept
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
print("catalog size:", len(catalog))
with open('/home/user/MRP_BOM/data/materials_catalog.json','w',encoding='utf-8') as fo:
    json.dump(catalog, fo, ensure_ascii=False, indent=None)

# Extract FG base items, packaging codes, color codes from BOMSHEET(S) in both files
wb2 = openpyxl.load_workbook(f2, data_only=True)
pat = re.compile(r'^(.*)\(([A-Za-z0-9]+)\)-([A-Za-z0-9]+)$')
base_items = {}
pkg_codes = set()
color_codes = set()

def scan_items(wb, sheetnames):
    for sn in sheetnames:
        if sn not in wb.sheetnames: continue
        ws = wb[sn]
        for row in ws.iter_rows():
            for cell in row:
                v = cell.value
                if isinstance(v, str):
                    m = pat.match(v.strip())
                    if m:
                        base, pkg, color = m.groups()
                        base_items[base] = base_items.get(base,0)+1
                        pkg_codes.add(pkg)
                        color_codes.add(color)

scan_items(wb2, wb2.sheetnames)
scan_items(wb, wb.sheetnames)

print("base items:", base_items)
print("pkg codes:", pkg_codes)
print("color codes:", color_codes)

with open('/home/user/MRP_BOM/data/fg_base_items.json','w',encoding='utf-8') as fo:
    json.dump(sorted(base_items.keys()), fo, ensure_ascii=False, indent=None)
with open('/home/user/MRP_BOM/data/packaging_codes.json','w',encoding='utf-8') as fo:
    json.dump(sorted(pkg_codes), fo, ensure_ascii=False, indent=None)
with open('/home/user/MRP_BOM/data/color_shades.json','w',encoding='utf-8') as fo:
    json.dump(sorted(color_codes), fo, ensure_ascii=False, indent=None)

print("DONE")
