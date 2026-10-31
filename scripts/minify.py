#!/usr/bin/env python3
"""Minifies the shared <style> and main <script> blocks of every page this
site serves, and extracts each into its own content-hashed external file
(assets/app.<hash>.css, assets/app.<hash>.js), referenced from every page
via <link rel="stylesheet">/<script defer src> instead of being inlined.

These two blocks are byte-identical across every one of the ~260
generated pages (confirmed by direct comparison), but were previously
inlined into each page's own <style>/<script> tags - so a visitor's
browser could never cache them across page navigations: every full page
load re-downloaded and re-parsed the same ~700KB of CSS+JS from scratch,
even on a repeat visit days later. Extracting them to external files with
a content hash in the filename fixes that safely: the hash only changes
when the minified content changes, so _headers can give /assets/* a long
immutable cache lifetime without ever risking a returning visitor getting
served stale code under an unchanged URL - a content change always means
a new filename, never a cache that needs invalidating.

The <script> tag was already positioned at the very end of <body> (not
<head>), so switching it to `defer` changes nothing about execution
timing - defer already means "run after the document is parsed", which
is what being the last thing in <body> already achieved.

The small per-page theme-flash-prevention script (~1-1.5KB, differs by
one injected route-seed line per page) stays inline and unminified, same
as before - it has to run synchronously before first paint to avoid a
flash of the wrong theme, so it's never a candidate for this and is left
untouched by this script entirely.

IMPORTANT: .github/workflows/regenerate-pages.yml's `git add` step lists
every path this script and the two generators before it can change,
including assets/ - if a new path is ever added here, that workflow needs
the same update, or its automated commits will silently stop including
it and a page could end up referencing an asset file that was never
actually pushed.

Run this LAST, after generate-static-pages.py and generate-product-pages.py
have written their (unminified) output — both of those scripts depend on
src/index.html staying human-readable (patch_head() patches exact line
numbers; extract_categories() does marker-based text extraction), so
minifying before they run would break them. This script only ever reads
already-generated, already-correct HTML and shrinks/externalizes two
specific blocks; it changes no other content.

Uses a real HTML tokenizer (html.parser), not regex, to find <script>/
<style> boundaries — a naive regex was fooled by an HTML comment in
src/index.html's own <head> that happens to contain the literal text
"<script>" as example prose about the site's CSP.

Usage:
    python3 scripts/minify.py
Requires `npx` on PATH (uses terser for JS, csso-cli for CSS — both
fetched on demand via npx, same as this repo's other node-dependent
generator script).
"""
import glob
import hashlib
import os
import subprocess
import sys
from html.parser import HTMLParser

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SRC = os.path.join(REPO_ROOT, 'src', 'index.html')
ASSETS_DIR = os.path.join(REPO_ROOT, 'assets')

STATIC_PAGE_SLUGS = [
    'about', 'careers', 'contact', 'cookie-policy', 'delivery-info', 'delivery-policy',
    'guide', 'privacy', 'returns', 'terms', 'work-with-us',
]


class ScriptStyleFinder(HTMLParser):
    """Finds the character-offset boundaries of real <script>/<style> tags
    only (HTMLParser skips comment contents entirely, so text that merely
    looks like a tag inside a <!-- --> comment is never reported here)."""
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.line_starts = [0]
        for i, ch in enumerate(source):
            if ch == '\n':
                self.line_starts.append(i + 1)
        self.found = []  # (tag, tag_start_offset, content_start_offset)

    def _offset(self):
        line, col = self.getpos()
        return self.line_starts[line - 1] + col

    def handle_starttag(self, tag, attrs):
        if tag not in ('script', 'style'):
            return
        attrs_d = dict(attrs)
        if tag == 'script' and ('src' in attrs_d or 'type' in attrs_d):
            return  # external or typed (e.g. application/ld+json) — leave alone
        tag_start = self._offset()
        gt = self.source.index('>', tag_start)
        self.found.append((tag, tag_start, gt + 1))


def find_blocks(content):
    """Returns [(tag, tag_start, content_start, content_end, full_end, text), ...]
    for every real <style>/plain <script> block (>=50 chars, skips tiny
    snippets). tag_start/full_end bound the WHOLE element (opening tag
    through closing tag) for whole-element replacement; content_start/
    content_end bound just the inner text, for minifying."""
    finder = ScriptStyleFinder(content)
    finder.feed(content)
    blocks = []
    for tag, tag_start, content_start in finder.found:
        end_tag = f'</{tag}>'
        end_idx = content.index(end_tag, content_start)
        block_text = content[content_start:end_idx]
        if len(block_text.strip()) < 50:
            continue
        full_end = end_idx + len(end_tag)
        blocks.append((tag, tag_start, content_start, end_idx, full_end, block_text))
    return blocks


def minify_css(css_text):
    proc = subprocess.run(['npx', '--yes', 'csso-cli'], input=css_text,
                           capture_output=True, text=True, timeout=90)
    if proc.returncode != 0:
        raise RuntimeError(f'csso failed: {proc.stderr}')
    return proc.stdout


def minify_js(js_text):
    proc = subprocess.run(['npx', '--yes', 'terser', '--compress', '--mangle'],
                           input=js_text, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f'terser failed: {proc.stderr}')
    return proc.stdout


def content_hash(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:10]


def write_asset(minified_text, prefix, ext):
    """Writes minified_text to assets/<prefix>.<hash>.<ext>, removes any
    stale same-prefix/ext file left from a previous run with a different
    hash (the content changed since then), and returns the absolute
    public path to reference from <link>/<script src>."""
    os.makedirs(ASSETS_DIR, exist_ok=True)
    h = content_hash(minified_text)
    filename = f'{prefix}.{h}.{ext}'
    path = os.path.join(ASSETS_DIR, filename)
    for stale in glob.glob(os.path.join(ASSETS_DIR, f'{prefix}.*.{ext}')):
        if os.path.basename(stale) != filename:
            os.remove(stale)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(minified_text)
    return f'/assets/{filename}'


def apply_to_file(path, replacements_by_original_element):
    """replacements_by_original_element: {original_full_element_text: new_tag_html}.
    Finds each page's own <style>/<script> blocks, and for any block whose
    exact FULL element text (opening tag through closing tag) is a known
    key, replaces the whole element with the given new tag markup. Any
    block that doesn't match (e.g. this page's own small theme-flash-
    prevention script) is skipped, left untouched."""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    original_len = len(content)

    blocks = find_blocks(content)
    subs = []
    for tag, tag_start, content_start, content_end, full_end, text in blocks:
        full_element = content[tag_start:full_end]
        if full_element in replacements_by_original_element:
            subs.append((tag_start, full_end, replacements_by_original_element[full_element]))

    new_content = content
    for start, end, new_text in sorted(subs, key=lambda x: -x[0]):
        new_content = new_content[:start] + new_text + new_content[end:]

    with open(path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    return original_len, len(new_content)


def main():
    with open(SRC, 'r', encoding='utf-8') as f:
        source_html = f.read()

    blocks = find_blocks(source_html)
    style_blocks = [b for b in blocks if b[0] == 'style']
    script_blocks = [b for b in blocks if b[0] == 'script']
    # The big app script is the largest plain <script> block; the small
    # theme-flash-prevention one is intentionally left inline/unminified
    # (see module docstring) and untouched by this script entirely.
    big_script = max(script_blocks, key=lambda b: len(b[5]))

    print('Minifying the shared <style> block once...')
    minified_css = minify_css(style_blocks[0][5])
    print(f'  style: {len(style_blocks[0][5]):,} -> {len(minified_css):,} bytes')

    print('Minifying the shared main <script> block once...')
    minified_js = minify_js(big_script[5])
    print(f'  script: {len(big_script[5]):,} -> {len(minified_js):,} bytes')

    css_path = write_asset(minified_css, 'app', 'css')
    js_path = write_asset(minified_js, 'app', 'js')
    print(f'  -> {css_path}')
    print(f'  -> {js_path}')

    _, style_tag_start, _, _, style_full_end, _ = style_blocks[0]
    _, script_tag_start, _, _, script_full_end, _ = big_script
    original_style_element = source_html[style_tag_start:style_full_end]
    original_script_element = source_html[script_tag_start:script_full_end]

    replacements = {
        original_style_element: f'<link rel="stylesheet" href="{css_path}">',
        original_script_element: f'<script defer src="{js_path}"></script>',
    }

    total_before = 0
    total_after = 0

    print('\nApplying to every page...')
    targets = [os.path.join(REPO_ROOT, 'index.html')]
    for slug in STATIC_PAGE_SLUGS:
        path = os.path.join(REPO_ROOT, slug, 'index.html')
        if not os.path.exists(path):
            raise FileNotFoundError(f'{path} missing — run generate-static-pages.py first.')
        targets.append(path)

    product_root = os.path.join(REPO_ROOT, 'product')
    if not os.path.isdir(product_root):
        raise FileNotFoundError(f'{product_root} missing — run generate-product-pages.py first.')
    for entry in sorted(os.listdir(product_root)):
        path = os.path.join(product_root, entry, 'index.html')
        if os.path.isfile(path):
            targets.append(path)

    # repo-root index.html is a pure build artifact now (never hand-edited
    # — src/index.html is), so it's always rewritten fresh from source
    # before minifying, every run. Doing this only "if missing" would
    # leave a stale, already-processed index.html from a *previous* run in
    # place on the next run, and its blocks wouldn't match the original
    # (unprocessed) element text being replaced, so nothing would get
    # substituted and the page would silently go stale.
    with open(targets[0], 'w', encoding='utf-8') as f:
        f.write(source_html)

    for path in targets:
        before, after = apply_to_file(path, replacements)
        total_before += before
        total_after += after

    print(f'{len(targets)} pages minified.')
    print(f'Total: {total_before:,} -> {total_after:,} bytes '
          f'({100 * (1 - total_after / total_before):.1f}% smaller)')


if __name__ == '__main__':
    main()
