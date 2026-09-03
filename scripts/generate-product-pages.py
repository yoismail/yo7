#!/usr/bin/env python3
"""Generates real, separately-crawlable URLs for Yo7 Foods' 76 statically
defined products (the CATEGORIES array in index.html — 19 categories x 4
products each). Right now every product only exists behind a hash route
(#/product/<catSlug>/<idx>), which Google never indexes as a distinct
page — a search for a specific item can only ever land on the homepage.
This is the same approach already used for the 9 content pages
(scripts/generate-static-pages.py, reused directly here for head-patching):
one near-identical copy of index.html per product, written to a real path
GitHub Pages serves directly (product/<slug>/index.html for a request to
/product/<slug>/).

Scope: only the 76 hardcoded products. Admin-added products
(the `custom_products` Supabase table) aren't covered — this script reads
CATEGORIES directly out of index.html, no network access, so it can't see
anything that only exists in Supabase. That's a deliberate v1 limit, not
an oversight.

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
style of generate-static-pages.py.

Usage:
    python3 scripts/generate-product-pages.py
Run from anywhere; paths below are relative to the repo root the script
lives in. Requires `node` on PATH (for the one CATEGORIES-parsing step
only — this is the one place this repo needs a JS runtime at all).
"""
import html as html_lib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import date

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SOURCE = os.path.join(REPO_ROOT, 'index.html')
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


def load_categories():
    """Extracts CATEGORIES and CATEGORY_CODE_PREFIX out of index.html as
    real data, by having node evaluate the actual JS literals (the only
    safe way to parse a genuine JS array/object literal — unquoted keys,
    embedded SVG markup, \\' escapes)."""
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
    return data['CATEGORIES'], data['CATEGORY_CODE_PREFIX']


def assign_product_codes(categories, code_prefix):
    """Mirrors assignProductCodes() in index.html exactly."""
    for cat in categories:
        prefix = code_prefix.get(cat['slug'], cat['slug'][:3].upper())
        for i, p in enumerate(cat['products']):
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


def main():
    categories, code_prefix = load_categories()
    assign_product_codes(categories, code_prefix)

    with open(SOURCE, 'r', encoding='utf-8') as f:
        source_lines = f.read().split('\n')

    today = date.today().isoformat()
    used_slugs = set()
    product_locs = []
    written = 0

    for cat in categories:
        cat_slug = cat['slug']
        cat_name_escaped = cat['name']  # already HTML-escaped in the source, e.g. "Fruits &amp; Vegetables"
        cat_name_plain = decode_pre_escaped_amp(cat_name_escaped)

        for idx, p in enumerate(cat['products']):
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

            title_html = f'{name_html} | Yo7 Foods'
            json_ld_text = build_json_ld(name_plain, description_plain, p['code'], cat_name_plain, page_url, price, availability)

            lines = gsp.patch_head(list(source_lines), path_slug, title_html, description_html)
            html = '\n'.join(lines)
            html = inject_route_seed_and_marker(html, cat_slug, idx, real_path)
            html = inject_json_ld(html, json_ld_text)

            out_dir = os.path.join(REPO_ROOT, path_slug)
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, 'index.html')
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(html)
            print(f'wrote {os.path.relpath(out_path, REPO_ROOT)} ({len(html):,} bytes)')
            written += 1
            product_locs.append(page_url)

    print(f'\n{written} product pages written.')
    rebuild_sitemap(product_locs, today)


if __name__ == '__main__':
    main()
