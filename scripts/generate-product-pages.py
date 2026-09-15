#!/usr/bin/env python3
"""Generates real, separately-crawlable URLs for every product Yo7 Foods
sells — both the ~249 hardcoded ones (the CATEGORIES array in
src/index.html) and anything added or edited since through the live admin
panel (the `custom_products` and `product_overrides` Supabase tables).
Right now every product only exists behind a hash route
(#/product/<catSlug>/<idx>), which Google never indexes as a distinct
page — a search for a specific item can only ever land on the homepage.
This is the same approach already used for the 9 content pages
(scripts/generate-static-pages.py, reused directly here for head-patching):
one near-identical copy of index.html per product, written to a real path
GitHub Pages serves directly (product/<slug>/index.html for a request to
/product/<slug>/).

Scope: every product the live site would show, not just the 249 hardcoded
ones — this fetches custom_products and product_overrides from Supabase's
REST API (the same public anon key already embedded in src/index.html,
which both tables allow anyone to SELECT from — see their RLS policies in
supabase/schema.sql) and merges them on top of CATEGORIES, mirroring
exactly what loadCustomProducts()/applyProductOverrides() do client-side.
Without this, a static page's baked title/price/stock/JSON-LD would silently
drift from whatever's actually live the moment an admin edits a product
through the panel, and any product added purely through the panel would
never get a real URL at all — both were true before this fetch/merge step
existed. A product marked deleted (product_overrides.deleted) gets no page,
and any page it previously had (a since-deleted or since-renamed product)
is removed on this same run — see the orphan-pruning pass at the end of
main() — so a stale/dead page never lingers on disk after this script runs.

This talks to the network, so it can fail in ways a pure-local script
can't (Supabase down, rate limited, a bad response). On any such failure
it raises and exits non-zero *before* writing or deleting anything —
never partially regenerates from incomplete data, which could otherwise
silently prune legitimate pages or bake stale content into pages that
looked "successfully" regenerated. A failed run just means "nothing
changed this time"; the previously-committed pages stay exactly as they
were until the next successful run.

Two things happen per product, beyond what the 9-page script does:
  1. <head> is patched (title/description/canonical/og/twitter) exactly
     like a content page, via generate-static-pages.py's own patch_head().
  2. A real Product/Offer JSON-LD <script> is baked directly into <head>
     (matching updateProductJsonLd()'s shape in index.html, but with the
     page's own real URL instead of the hash-route form) so a crawler
     sees correct structured data in the raw HTTP response, before any JS
     runs. index.html's updateProductJsonLd() has a matching fix so it
     doesn't immediately clobber this back to the hash-route URL once the
     app boots (see the window.__STATIC_PRODUCT_PAGE__ marker seeded
     below, and the comment beside it in index.html).

The CATEGORIES array is genuine JavaScript (unquoted keys, embedded SVG
markup, escaped apostrophes) — there's no safe way to parse that with
Python's stdlib, so this shells out to `node` for exactly one step:
evaluating the extracted CATEGORIES/CATEGORY_CODE_PREFIX literals and
printing them as JSON. Everything else stays plain Python, matching the
style of generate-static-pages.py — Supabase's REST API is plain HTTP+JSON,
so those two fetches use only the standard library (urllib), no new
dependency to install in CI for it.

Usage:
    python3 scripts/generate-product-pages.py
Run from anywhere; paths below are relative to the repo root the script
lives in. Requires `node` on PATH (for the one CATEGORIES-parsing step
only — this is the one place this repo needs a JS runtime at all) and
outbound network access to Supabase.
"""
import html as html_lib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import date

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
# src/index.html, not repo-root index.html — see the matching comment in
# generate-static-pages.py. This script's CATEGORIES extraction and
# marker-based text patching below both need the readable original too.
SOURCE = os.path.join(REPO_ROOT, 'src', 'index.html')
SITEMAP = os.path.join(REPO_ROOT, 'sitemap.xml')
BASE_URL = 'https://yo7foods.co.uk'

# Reuse generate-static-pages.py's patch_head() (exact-string, fail-loud
# <head> patching) instead of re-deriving the same line indices here —
# importing it as a module doesn't run its main(), since __name__ won't be
# '__main__'.
_spec = importlib.util.spec_from_file_location(
    'generate_static_pages', os.path.join(SCRIPT_DIR, 'generate-static-pages.py'))
gsp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gsp)
assert gsp.BASE_URL == BASE_URL


def extract_statement(html, start_marker, end_marker, label):
    start = html.index(start_marker)  # raises ValueError if index.html's shape changed
    end = html.index(end_marker, start)
    if end == -1:
        raise ValueError(f'{label}: closing marker {end_marker!r} not found after start')
    return html[start:end + len(end_marker)]


def extract_const_string(html, name):
    """Pulls a single-line `const NAME = '...';` string literal out of the
    source verbatim — unlike CATEGORIES, SUPABASE_URL/SUPABASE_ANON_KEY are
    plain string literals, so a regex is safe here (no need for node)."""
    m = re.search(rf"const {re.escape(name)} = '([^']*)';", html)
    if not m:
        raise ValueError(f'{name} not found in src/index.html — has its declaration moved or changed shape?')
    return m.group(1)


def load_categories():
    """Extracts CATEGORIES and CATEGORY_CODE_PREFIX out of index.html as
    real data, by having node evaluate the actual JS literals (the only
    safe way to parse a genuine JS array/object literal — unquoted keys,
    embedded SVG markup, \\' escapes). Also returns the Supabase URL/anon
    key straight from the same source file, so there's exactly one place
    those ever need to be correct."""
    with open(SOURCE, 'r', encoding='utf-8') as f:
        source_html = f.read()

    categories_js = extract_statement(source_html, 'const CATEGORIES = [', '\n        ];', 'CATEGORIES')
    prefix_js = extract_statement(source_html, 'const CATEGORY_CODE_PREFIX = {', '\n        };', 'CATEGORY_CODE_PREFIX')

    script = categories_js + '\n' + prefix_js + '\n' + \
        'process.stdout.write(JSON.stringify({CATEGORIES: CATEGORIES, CATEGORY_CODE_PREFIX: CATEGORY_CODE_PREFIX}));\n'

    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as tf:
        tf.write(script)
        tmp_path = tf.name
    try:
        result = subprocess.run(['node', tmp_path], capture_output=True, text=True, check=True)
    except FileNotFoundError:
        print('ERROR: node is required (only to parse the CATEGORIES literal) but was not found on PATH.', file=sys.stderr)
        raise
    except subprocess.CalledProcessError as e:
        print(f'ERROR: node failed evaluating CATEGORIES/CATEGORY_CODE_PREFIX:\n{e.stderr}', file=sys.stderr)
        raise
    finally:
        os.unlink(tmp_path)

    data = json.loads(result.stdout)
    supabase_url = extract_const_string(source_html, 'SUPABASE_URL')
    supabase_anon_key = extract_const_string(source_html, 'SUPABASE_ANON_KEY')
    return data['CATEGORIES'], data['CATEGORY_CODE_PREFIX'], supabase_url, supabase_anon_key


def fetch_supabase_table(supabase_url, anon_key, table, order=None, attempts=3):
    """A plain REST GET against Supabase's PostgREST endpoint — the exact
    same public, RLS-gated read the live site's own supabase-js client
    does (select('*')), just without the SDK. Retries transient failures
    a couple of times (a scheduled CI run hitting one bad network blip
    shouldn't fail the whole regeneration), but always raises — never
    returns partial/empty data as if it were a real, empty result — once
    attempts are exhausted, so a caller can never mistake "couldn't reach
    Supabase" for "this table is genuinely empty."""
    url = f'{supabase_url}/rest/v1/{table}?select=*'
    if order:
        url += f'&order={order}'
    req = urllib.request.Request(url, headers={
        'apikey': anon_key,
        'Authorization': f'Bearer {anon_key}',
        'Accept': 'application/json',
    })
    last_err = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
            return json.loads(body.decode('utf-8'))
        except (urllib.error.URLError, ValueError) as e:
            last_err = e
    raise RuntimeError(f'Failed to fetch {table!r} from Supabase after {attempts} attempts: {last_err}') from last_err


def merge_custom_products(categories, rows):
    """Mirrors loadCustomProducts() in index.html exactly — admin-added
    products, inserted at their assigned index in their category's
    products list (extending it with placeholder gaps if a row's idx ever
    arrives ahead of where the list currently ends; shouldn't happen given
    idx is always assigned as "next free slot", but this stays correct
    either way rather than raising)."""
    by_slug = {c['slug']: c for c in categories}
    for row in rows:
        cat = by_slug.get(row.get('cat_slug'))
        if not cat:
            continue
        idx = row['idx']
        product = {'name': row['name'], 'unit': row['unit'], 'price': row['price'], 'stock': row.get('stock') or 'in'}
        if row.get('sale_price') is not None: product['salePrice'] = row['sale_price']
        if row.get('stock_quantity') is not None: product['stockQuantity'] = row['stock_quantity']
        if row.get('weight') is not None: product['weight'] = row['weight']
        if row.get('description'): product['description'] = row['description']
        if row.get('image_url'): product['image'] = row['image_url']
        if row.get('is_new'): product['isNew'] = True
        if row.get('is_best_seller'): product['isBestSeller'] = True
        products = cat['products']
        while len(products) <= idx:
            products.append(None)
        products[idx] = product


def merge_overrides(categories, rows):
    """Mirrors applyProductOverrides()'s merge loop in index.html exactly,
    field for field, tri-states (is_new) included — deliberately kept in
    lockstep with that function rather than "close enough", since any
    field this misses is a field a crawler sees stale forever until
    someone notices and fixes the drift by hand."""
    by_slug = {c['slug']: c for c in categories}
    for row in rows:
        cat_slug, sep, idx_str = str(row.get('product_key') or '').partition('::')
        if not sep or not idx_str.lstrip('-').isdigit():
            continue
        cat = by_slug.get(cat_slug)
        if not cat:
            continue
        idx = int(idx_str)
        if idx < 0 or idx >= len(cat['products']):
            continue
        product = cat['products'][idx]
        if product is None:
            continue
        if row.get('name'): product['name'] = row['name']
        if row.get('image_url'): product['image'] = row['image_url']
        if row.get('price') is not None: product['price'] = row['price']
        if row.get('sale_price') is not None: product['salePrice'] = row['sale_price']
        else: product.pop('salePrice', None)
        if row.get('stock'): product['stock'] = row['stock']
        if row.get('stock_quantity') is not None: product['stockQuantity'] = row['stock_quantity']
        else: product.pop('stockQuantity', None)
        if row.get('weight') is not None: product['weight'] = row['weight']
        else: product.pop('weight', None)
        if row.get('unit_override'): product['unitOverride'] = row['unit_override']
        if row.get('description'): product['description'] = row['description']
        wv = row.get('weight_variants')
        if isinstance(wv, list) and wv: product['weightVariants'] = wv
        elif wv is None: product.pop('weightVariants', None)
        is_new = row.get('is_new')
        if is_new is True: product['isNew'] = True
        elif is_new is False: product['isNew'] = False
        if row.get('origin'): product['origin'] = row['origin']
        if row.get('storage'): product['storage'] = row['storage']
        allergens = row.get('allergens')
        if isinstance(allergens, list) and allergens: product['allergens'] = allergens
        if row.get('allergy_note'): product['allergyNote'] = row['allergy_note']
        if row.get('nutrition'): product['nutrition'] = row['nutrition']
        if row.get('cooking_tip'): product['cookingTip'] = row['cooking_tip']
        product['deleted'] = row.get('deleted') is True


def assign_product_codes(categories, code_prefix):
    """Mirrors assignProductCodes() in index.html exactly."""
    for cat in categories:
        prefix = code_prefix.get(cat['slug'], cat['slug'][:3].upper())
        for i, p in enumerate(cat['products']):
            if p is None:
                continue
            p['code'] = f'{prefix}-{i + 1:02d}'


def slugify(name):
    s = name.lower()
    s = re.sub(r'[^a-z0-9]+', '-', s)
    s = s.strip('-')
    s = re.sub(r'-{2,}', '-', s)
    return s


def unique_slug(name, cat_slug, used):
    base = slugify(name)
    slug = base
    n = 2
    while slug in used:
        slug = f'{base}-{cat_slug}' if n == 2 else f'{base}-{cat_slug}-{n}'
        n += 1
    used.add(slug)
    return slug


def html_escape(text):
    return html_lib.escape(text, quote=True)


def decode_pre_escaped_amp(text):
    """Category names in CATEGORIES are already HTML-escaped in the source
    (contain a literal '&amp;'), same as index.html's own
    cat.name.replace(/&amp;/g, '&') — undo that one specific escaping to
    get plain text for non-HTML contexts (JSON-LD)."""
    return text.replace('&amp;', '&')


def build_json_ld(name_plain, description_plain, code, category_plain, page_url, price, availability):
    data = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        'name': name_plain,
        'description': description_plain,
        'sku': code,
        'category': category_plain,
        'image': f'{BASE_URL}/og-image.png',
        'url': page_url,
        'offers': {
            '@type': 'Offer',
            'priceCurrency': 'GBP',
            'price': f'{price:.2f}',
            'availability': availability,
            'url': page_url,
        },
    }
    # json.dumps won't escape "<", so guard against a literal "</script"
    # substring ever being able to close the <script> tag early.
    return json.dumps(data, ensure_ascii=False).replace('</', '<\\/')


def effective_unit(p):
    """Mirrors effectiveUnit()/unitOverrideLabel() in index.html exactly."""
    override = p.get('unitOverride')
    if isinstance(override, str):
        override = override.strip() or None
    elif isinstance(override, dict):
        qty = override.get('qty')
        override = f"{qty}{override.get('measure') or ''}" if isinstance(qty, (int, float)) and qty > 0 else None
    else:
        override = None
    return override or p['unit']


def stock_label(stock):
    """Mirrors stockLabel() in index.html exactly."""
    if stock == 'low': return 'Low stock'
    if stock == 'out': return 'Out of stock'
    return 'In stock'


def money(n):
    """Mirrors money() in index.html exactly."""
    return f'£{n:.2f}'


def require_one(html, needle, label):
    count = html.count(needle)
    if count != 1:
        raise ValueError(f'{label}: expected exactly 1 occurrence of {needle!r}, found {count} — has the #view-product markup in src/index.html changed shape?')


def inject_static_product_content(html, p, cat_slug, cat_name_escaped, name_html, description_html, price, stock, on_sale):
    """Bakes the product's real name/price/description/stock/image straight
    into the #view-product markup (name/price/desc/stock/breadcrumb, and the
    photo if one exists) instead of leaving it for renderProductPage() to
    fill in at runtime. renderProductPage() still runs exactly as before for
    a real visitor and overwrites every one of these with the identical
    values (showView()'s hidden-view toggle doesn't care what a view's
    initial state was) — this only changes what's in the raw HTTP response
    before any JS executes, which is what a non-JS-rendering crawler
    actually sees. Every #view-product field below starts genuinely empty
    in src/index.html (see renderProductPage() itself, which fills the exact
    same ids), so without this a text-only crawl of any of these 251 pages
    sees a page with a real <title>/meta and JSON-LD, but literally no
    visible product name, price, or description in the body at all."""
    unit_html = html_escape(effective_unit(p))
    code = p.get('code')
    code_html = f'Product code: {html_escape(code)}' if code else ''
    stock_label_html = html_escape(stock_label(stock))
    breadcrumb_html = (
        f'<a href="#/">Home</a> &rsaquo; '
        f'<a href="#/category/{cat_slug}">{cat_name_escaped}</a> &rsaquo; {name_html}'
    )

    replacements = [
        ('<div id="view-product" class="hidden-view">', '<div id="view-product">'),
        ('<div class="breadcrumb" id="pdCrumb"></div>', f'<div class="breadcrumb" id="pdCrumb">{breadcrumb_html}</div>'),
        ('<span class="stock-badge" id="pdStockBadge"></span>', f'<span class="stock-badge {stock}" id="pdStockBadge">{stock_label_html}</span>'),
        ('<div class="pd-cat-tag" id="pdCatTag"></div>', f'<div class="pd-cat-tag" id="pdCatTag">{cat_name_escaped}</div>'),
        ('<h1 id="pdName"></h1>', f'<h1 id="pdName">{name_html}</h1>'),
        ('<div class="pd-code" id="pdCode"></div>', f'<div class="pd-code" id="pdCode">{code_html}</div>'),
        ('<div class="pd-unit" id="pdUnit"></div>', f'<div class="pd-unit" id="pdUnit">{unit_html}</div>'),
        ('<div class="pd-price" id="pdPrice"></div>', f'<div class="pd-price" id="pdPrice">{money(price)}</div>'),
        ('<p class="pd-desc" id="pdDesc"></p>', f'<p class="pd-desc" id="pdDesc">{description_html}</p>'),
        ('<span id="pdStockText">In stock</span>', f'<span id="pdStockText">{stock_label_html}</span>'),
    ]
    if on_sale:
        replacements.append((
            '<span class="sale-badge" id="pdSaleBadge" style="display:none;">Sale</span>',
            '<span class="sale-badge" id="pdSaleBadge" style="display:block;">Sale</span>',
        ))
    image_url = p.get('image')
    if image_url:
        replacements.append((
            '<span class="pd-placeholder" id="pdPlaceholder"></span>',
            f'<img src="{html_escape(image_url)}" alt="{name_html}" loading="lazy" decoding="async" class="product-photo-img">'
            f'<span class="pd-placeholder" id="pdPlaceholder" style="display:none;"></span>',
        ))

    for needle, replacement in replacements:
        require_one(html, needle, 'inject_static_product_content')
        html = html.replace(needle, replacement, 1)
    return html


def inject_route_seed_and_marker(html, cat_slug, idx, real_path):
    # Same marker/guard pattern as generate-static-pages.py's
    # inject_route_seed(), extended with a second, unconditional line
    # recording which product this physical page was generated for — see
    # the comment beside window.__STATIC_PRODUCT_PAGE__ usage in
    # updateProductJsonLd() in index.html for why it's needed.
    marker = '        })();\n    </script>\n</head>'
    if marker not in html:
        raise ValueError('Theme-flash-prevention script block marker not found — index.html <head> script shape changed.')
    hash_route = f'#/product/{cat_slug}/{idx}'
    marker_line = (
        f"        window.__STATIC_PRODUCT_PAGE__ = "
        f"{{ catSlug: {json.dumps(cat_slug)}, idx: {idx}, path: {json.dumps(real_path)} }};\n"
    )
    seed_line = f"        if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '{hash_route}');\n"
    replacement = '        })();\n' + marker_line + seed_line + '    </script>\n</head>'
    return html.replace(marker, replacement, 1)


def inject_json_ld(html, json_ld_text):
    if html.count('</head>') != 1:
        raise ValueError(f'Expected exactly one </head>, found {html.count("</head>")}')
    tag = f'    <script type="application/ld+json" id="productJsonLd">{json_ld_text}</script>\n</head>'
    return html.replace('</head>', tag, 1)


def build_breadcrumb_json_ld(cat_name_plain, cat_slug, name_plain, page_url):
    # Home > Category > Product only, skipping the optional "group" level
    # (Basic Food Items, Spices & Cooking Oils, etc.) that index.html's own
    # updateBreadcrumbJsonLd() includes at runtime when a category belongs
    # to one, since GROUPS isn't parsed by this script. index.html's own JS
    # replaces this tag the instant it runs (same pattern as productJsonLd
    # above), so a real visitor always sees the full trail — this static
    # 3-level version is only what a crawler sees before JS executes, and
    # omitting a level there is a simplification, not a wrong claim.
    items = [
        {'@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': f'{BASE_URL}/'},
        {'@type': 'ListItem', 'position': 2, 'name': cat_name_plain, 'item': f'{BASE_URL}/#/category/{cat_slug}'},
        {'@type': 'ListItem', 'position': 3, 'name': name_plain, 'item': page_url},
    ]
    data = {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': items}
    return json.dumps(data, ensure_ascii=False).replace('</', '<\\/')


def inject_breadcrumb_json_ld(html, breadcrumb_json_ld_text):
    if html.count('</head>') != 1:
        raise ValueError(f'Expected exactly one </head>, found {html.count("</head>")}')
    tag = f'    <script type="application/ld+json" id="breadcrumbJsonLd">{breadcrumb_json_ld_text}</script>\n</head>'
    return html.replace('</head>', tag, 1)


def sitemap_url_block(loc, lastmod, changefreq, priority):
    return (f'<url>\n    <loc>{loc}</loc>\n    <lastmod>{lastmod}</lastmod>\n'
            f'    <changefreq>{changefreq}</changefreq>\n    <priority>{priority}</priority>\n  </url>')


def rebuild_sitemap(product_locs, today):
    with open(SITEMAP, 'r', encoding='utf-8') as f:
        content = f.read()
    header = content[:content.index('<url>')]
    blocks = re.findall(r'<url>.*?</url>', content, re.DOTALL)
    # Drop any product entries from a previous run of this script, so
    # re-running it doesn't duplicate/accumulate stale entries.
    kept = [b for b in blocks if '/product/' not in b]
    product_blocks = [sitemap_url_block(loc, today, 'weekly', '0.6') for loc in product_locs]
    body = '\n  '.join(kept + product_blocks)
    new_content = header + body + '\n</urlset>\n'
    with open(SITEMAP, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f'sitemap.xml: kept {len(kept)} existing entries, added {len(product_blocks)} product entries')


def prune_orphan_product_dirs(written_slugs):
    """Removes any product/<slug>/ directory this run didn't (re)write —
    a product that's since been deleted (product_overrides.deleted) or
    renamed (its old slug is no longer anyone's current name) would
    otherwise keep serving a real, indexable page forever, since nothing
    else in this pipeline ever deletes a file it once wrote. Only ever
    touches subdirectories of product/, one level deep, each of which is
    exclusively this script's own output."""
    product_root = os.path.join(REPO_ROOT, 'product')
    if not os.path.isdir(product_root):
        return
    existing = {d for d in os.listdir(product_root) if os.path.isdir(os.path.join(product_root, d))}
    orphans = sorted(existing - written_slugs)
    for slug in orphans:
        shutil.rmtree(os.path.join(product_root, slug))
        print(f'removed stale product/{slug}/ (no longer a live, non-deleted product)')
    if orphans:
        print(f'{len(orphans)} orphaned product page(s) removed.')


def main():
    categories, code_prefix, supabase_url, supabase_anon_key = load_categories()

    # Network first, and nothing written until both calls have actually
    # succeeded — see the module docstring for why: a half-applied merge
    # (custom products loaded but overrides not, say, because the second
    # call failed) would silently write pages that don't match any state
    # the live site was ever actually in.
    custom_product_rows = fetch_supabase_table(supabase_url, supabase_anon_key, 'custom_products', order='idx.asc')
    merge_custom_products(categories, custom_product_rows)
    assign_product_codes(categories, code_prefix)
    override_rows = fetch_supabase_table(supabase_url, supabase_anon_key, 'product_overrides')
    merge_overrides(categories, override_rows)

    with open(SOURCE, 'r', encoding='utf-8') as f:
        source_lines = f.read().split('\n')

    today = date.today().isoformat()
    used_slugs = set()
    product_locs = []
    written = 0
    skipped_deleted = 0

    for cat in categories:
        cat_slug = cat['slug']
        cat_name_escaped = cat['name']  # already HTML-escaped in the source, e.g. "Fruits &amp; Vegetables"
        cat_name_plain = decode_pre_escaped_amp(cat_name_escaped)

        for idx, p in enumerate(cat['products']):
            # A gap (a custom_products idx arriving ahead of where its
            # category's list currently ends — see merge_custom_products)
            # or a soft-deleted product: neither gets a page, and neither
            # occupies a slug, so a still-live product with the same name
            # gets the clean slug rather than being pushed to "-2".
            if p is None:
                continue
            if p.get('deleted'):
                skipped_deleted += 1
                continue

            name_plain = p['name']
            name_html = html_escape(name_plain)
            slug = unique_slug(name_plain, cat_slug, used_slugs)
            path_slug = f'product/{slug}'
            page_url = f'{BASE_URL}/{path_slug}/'
            real_path = f'/{path_slug}/'

            explicit_desc = p.get('description')
            if explicit_desc:
                description_html = html_escape(explicit_desc)
                description_plain = explicit_desc
            else:
                description_html = f"{name_html}, from Yo7 Foods' {cat_name_escaped} aisle."
                description_plain = f"{name_plain}, from Yo7 Foods' {cat_name_plain} aisle."

            stock = p.get('stock') or 'in'
            availability = 'https://schema.org/OutOfStock' if stock == 'out' else 'https://schema.org/InStock'
            sale_price = p.get('salePrice')
            price = sale_price if (isinstance(sale_price, (int, float)) and sale_price < p['price']) else p['price']

            on_sale = isinstance(sale_price, (int, float)) and sale_price < p['price']

            title_html = f'{name_html} | Yo7 Foods'
            json_ld_text = build_json_ld(name_plain, description_plain, p['code'], cat_name_plain, page_url, price, availability)
            breadcrumb_json_ld_text = build_breadcrumb_json_ld(cat_name_plain, cat_slug, name_plain, page_url)

            lines = gsp.patch_head(list(source_lines), path_slug, title_html, description_html)
            html = '\n'.join(lines)
            html = inject_route_seed_and_marker(html, cat_slug, idx, real_path)
            html = inject_json_ld(html, json_ld_text)
            html = inject_breadcrumb_json_ld(html, breadcrumb_json_ld_text)
            html = inject_static_product_content(html, p, cat_slug, cat_name_escaped, name_html, description_html, price, stock, on_sale)

            out_dir = os.path.join(REPO_ROOT, path_slug)
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, 'index.html')
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(html)
            print(f'wrote {os.path.relpath(out_path, REPO_ROOT)} ({len(html):,} bytes)')
            written += 1
            product_locs.append(page_url)

    print(f'\n{written} product pages written' + (f', {skipped_deleted} deleted product(s) skipped.' if skipped_deleted else '.'))
    prune_orphan_product_dirs(used_slugs)
    rebuild_sitemap(product_locs, today)


if __name__ == '__main__':
    main()
