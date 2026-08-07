# Builds the static reference data the web app reads directly from GitHub
# Pages (docs/data/), from the canonical data/*.json produced by extract.py.
#
# Why static files instead of reading these through Apps Script: the web app
# would otherwise depend on the Apps Script Web App deployment being
# re-published every time the backend gains a new action, which is an easy
# step to miss and fails with a confusing "unknown action" error. Reference
# data never changes at runtime, so serving it from the same origin as the
# page is both more robust and much faster. Apps Script is still used for
# the write path (saving orders) and history.
#
# Recipes are emitted one file per item so the browser fetches ~10KB instead
# of the full ~15MB table. index.json maps item name -> numeric file id,
# which sidesteps having to encode Thai text, slashes and quotes into
# filenames.
import json
import os
import shutil

DATA_DIR = '/home/user/MRP_BOM/data'
OUT_DIR = '/home/user/MRP_BOM/docs/data'

with open(f'{DATA_DIR}/bom_master.json', encoding='utf-8') as f:
    recipe = json.load(f)
with open(f'{DATA_DIR}/materials_catalog.json', encoding='utf-8') as f:
    catalog = json.load(f)
with open(f'{DATA_DIR}/fg_base_items.json', encoding='utf-8') as f:
    mined_base_items = json.load(f)
with open(f'{DATA_DIR}/packaging_codes.json', encoding='utf-8') as f:
    packaging_codes = json.load(f)
with open(f'{DATA_DIR}/color_shades.json', encoding='utf-8') as f:
    color_shades = json.load(f)

if os.path.isdir(OUT_DIR):
    shutil.rmtree(OUT_DIR)
os.makedirs(f'{OUT_DIR}/recipes')


def s(v):
    return '' if v is None else v


# Keys are upper-cased to match the column names the Apps Script backend
# returns, so the rendering code treats both sources identically.
by_item = {}
for r in recipe:
    by_item.setdefault(r['item'], []).append({
        'CODE': s(r.get('code')),
        'NAME': s(r.get('name')),
        'DEPT': s(r.get('dept')),
        'DEPT_MAKER': s(r.get('deptMaker')),
        'QTY_PER_SET': s(r.get('qtyPerSet')),
        'CUT_UNIT': s(r.get('cutUnit')),
        'PIECES_UNIT': s(r.get('piecesUnit')),
        'CUT_LENGTH': s(r.get('cutLength')),
        'RB_COUNT_UNIT': s(r.get('rbCountUnit')),
    })

index = {}
for i, (item, rows) in enumerate(sorted(by_item.items())):
    index[item] = i
    with open(f'{OUT_DIR}/recipes/{i}.json', 'w', encoding='utf-8') as fo:
        json.dump(rows, fo, ensure_ascii=False, separators=(',', ':'))

with open(f'{OUT_DIR}/recipes/index.json', 'w', encoding='utf-8') as fo:
    json.dump(index, fo, ensure_ascii=False, separators=(',', ':'))

materials = [{
    'CODE': s(m.get('code')),
    'NAME': s(m.get('name')),
    'DEPT': s(m.get('dept')),
    'UNIT': s(m.get('unit')),
    'USAGE_COUNT': s(m.get('usageCount')),
} for m in catalog]
with open(f'{OUT_DIR}/materials.json', 'w', encoding='utf-8') as fo:
    json.dump(materials, fo, ensure_ascii=False, separators=(',', ':'))

# Base items = every legacy ITEM code (so an exact existing item resolves to
# its recipe) plus the mined root model names (for composing new codes).
base_items = sorted(set(by_item.keys()) | set(mined_base_items))

meta = {
    'baseItems': base_items,
    'packagingCodes': [{'CODE': c, 'DESCRIPTION': ''} for c in packaging_codes],
    'colorShades': [{'CODE': c, 'DESCRIPTION': ''} for c in color_shades],
    'counts': {
        'items': len(by_item),
        'recipeRows': len(recipe),
        'materials': len(materials),
        'baseItems': len(base_items),
    },
}
with open(f'{OUT_DIR}/meta.json', 'w', encoding='utf-8') as fo:
    json.dump(meta, fo, ensure_ascii=False, separators=(',', ':'))

print('recipe files:', len(index))
print('materials:', len(materials))
print('base items:', len(base_items))
print('packaging codes:', len(packaging_codes), 'color shades:', len(color_shades))
