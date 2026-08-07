import json

with open('/home/user/MRP_BOM/data/bom_master.json', encoding='utf-8') as f:
    recipe = json.load(f)
with open('/home/user/MRP_BOM/data/materials_catalog.json', encoding='utf-8') as f:
    catalog = json.load(f)
with open('/home/user/MRP_BOM/data/fg_base_items.json', encoding='utf-8') as f:
    new_style_base_items = json.load(f)

# The searchable "base model" list combines the new Base(Pkg)-Color naming
# (from the sample order file) with every legacy ITEM code from the old MRP
# DATA sheet (recipe.item) — otherwise only ~20 items were searchable while
# 884 legacy FG codes stayed invisible in the picker even though their
# recipes were already loaded into BOM_Master.
legacy_items = sorted(set(r['item'] for r in recipe if r.get('item')))
base_items = sorted(set(legacy_items) | set(new_style_base_items))

# order of keys for compact arrays
RECIPE_FIELDS = ['item','code','dept','formula','seColor','seLength','hole','outerSE','outerRB',
                  'name','deptMaker','qtyPerSet','cutLength','cutUnit','piecesPerRB','piecesUnit',
                  'qtyPer1GR','qtyPer1GRUnit','rbCountUnit','rbWeight']
CATALOG_FIELDS = ['code','name','dept','unit','usageCount']

def norm(v):
    return '' if v is None else v

recipe_rows = [[norm(r.get(k)) for k in RECIPE_FIELDS] for r in recipe]
catalog_rows = [[norm(r.get(k)) for k in CATALOG_FIELDS] for r in catalog]

def js_array(rows):
    # One row per line (rather than one giant minified line) so the file is
    # actually readable/reviewable on GitHub and the row count is visible at
    # a glance instead of looking like "barely any data".
    if not rows:
        return '[]'
    lines = [json.dumps(r, ensure_ascii=False, separators=(',', ':')) for r in rows]
    return '[\n' + ',\n'.join('  ' + l for l in lines) + '\n]'

out = []
out.append("// Auto-generated seed data imported from the legacy MRP workbook (DATA sheet).")
out.append("// Do not edit by hand — regenerate via scripts/gen_seed.py if the source data changes.")
out.append("var SEED_RECIPE_FIELDS = %s;" % json.dumps(RECIPE_FIELDS, ensure_ascii=False))
out.append("var SEED_CATALOG_FIELDS = %s;" % json.dumps(CATALOG_FIELDS, ensure_ascii=False))
out.append("var SEED_BOM_MASTER = %s;" % js_array(recipe_rows))
out.append("var SEED_MATERIALS_CATALOG = %s;" % js_array(catalog_rows))
out.append("var SEED_FG_BASE_ITEMS = %s;" % json.dumps(base_items, ensure_ascii=False))
out.append("var SEED_PACKAGING_CODES = %s;" % json.dumps(['P','B','X','C'], ensure_ascii=False))
out.append("var SEED_COLOR_SHADES = %s;" % json.dumps(['A','Y','Z','B'], ensure_ascii=False))

content = "\n".join(out) + "\n"
with open('/home/user/MRP_BOM/apps-script/SeedData.gs', 'w', encoding='utf-8') as f:
    f.write(content)
print("SeedData.gs size:", len(content.encode('utf-8')), "bytes")
print("recipe rows:", len(recipe_rows), "catalog rows:", len(catalog_rows))
