#!/usr/bin/env python3
"""Minifies the inline <style> and main <script> blocks of every page this
site serves, writing the result to the real served path — repo-root
index.html, and every already-generated about/, product/*, etc. page in
place.

Run this LAST, after generate-static-pages.py and generate-product-pages.py
have written their (unminified) output — both of those scripts depend on
src/index.html staying human-readable (patch_head() patches exact line
numbers; extract_categories() does marker-based text extraction), so
minifying before they run would break them. This script only ever reads
already-generated, already-correct HTML and shrinks it; it changes no
content, only whitespace/comments/identifier names inside <style>/<script>.

Performance: the <style> block and the big application <script> block are
byte-identical across every one of the ~260 generated pages (the two
generator scripts only ever touch <head> meta tags and a small early
theme-flash-prevention script, never these two) — confirmed by direct
comparison before writing this. So each is minified via npx exactly ONCE
(from src/index.html) and the result is substituted into every page with
plain string replacement, not run through terser/csso 260 times. The tiny
per-page theme-flash-prevention script (~1-1.5KB, differs by one injected
route-seed line per page) is left unminified — its own weight is trivial
next to the ~700KB it sits inside, and minifying it would need its own
per-page subprocess call for a few hundred bytes of saving.

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
import os
import subprocess
import sys
from html.parser import HTMLParser

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SRC = os.path.join(REPO_ROOT, 'src', 'index.html')

STATIC_PAGE_SLUGS = [
    'about', 'contact', 'cookie-policy', 'delivery-info', 'delivery-policy',
    'guide', 'privacy', 'returns', 'terms',
]


class ScriptStyleFinder(HTMLParser):
    """Finds the character-offset content boundaries of real <script>/
    <style> tags only — HTMLParser skips comment contents entirely, so
    text that merely looks like a tag inside a <!-- --> comment is never
    reported here."""
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.line_starts = [0]
        for i, ch in enumerate(source):
            if ch == '\n':
                self.line_starts.append(i + 1)
        self.found = []  # (tag, content_start_offset)

    def _offset(self):
        line, col = self.getpos()
        return self.line_starts[line - 1] + col

    def handle_starttag(self, tag, attrs):
        if tag not in ('script', 'style'):
            return
        attrs_d = dict(attrs)
        if tag == 'script' and ('src' in attrs_d or 'type' in attrs_d):
            return  # external or typed (e.g. application/ld+json) — leave alone
        off = self._offset()
        gt = self.source.index('>', off)
        self.found.append((tag, gt + 1))


def find_blocks(content):
    """Returns [(tag, content_start, content_end, text), ...] for every
    real <style>/plain <script> block (>=50 chars, skips tiny snippets)."""
    finder = ScriptStyleFinder(content)
    finder.feed(content)
    blocks = []
    for tag, content_start in finder.found:
        end_tag = f'</{tag}>'
        end_idx = content.index(end_tag, content_start)
        block_text = content[content_start:end_idx]
        if len(block_text.strip()) < 50:
            continue
        blocks.append((tag, content_start, end_idx, block_text))
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


def apply_to_file(path, replacements_by_original_text):
    """replacements_by_original_text: {original_block_text: minified_text}.
    Finds each page's own <style>/<script> blocks, and for any block whose
    exact text is a known key, substitutes the precomputed minified version
    (skips — leaves untouched — any block that doesn't match, e.g. this
    page's own small theme-flash-prevention script)."""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    original_len = len(content)

    blocks = find_blocks(content)
    subs = []
    for tag, start, end, text in blocks:
        if text in replacements_by_original_text:
            subs.append((start, end, replacements_by_original_text[text]))

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
    # theme-flash-prevention one is intentionally left unminified (see
    # module docstring).
    big_script = max(script_blocks, key=lambda b: len(b[3]))

    print('Minifying the shared <style> block once...')
    minified_css = minify_css(style_blocks[0][3])
    print(f'  style: {len(style_blocks[0][3]):,} -> {len(minified_css):,} bytes')

    print('Minifying the shared main <script> block once...')
    minified_js = minify_js(big_script[3])
    print(f'  script: {len(big_script[3]):,} -> {len(minified_js):,} bytes')

    replacements = {
        style_blocks[0][3]: minified_css,
        big_script[3]: minified_js,
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
    # leave a stale, already-minified index.html from a *previous* run in
    # place on the next run — its blocks wouldn't match the newly
    # minified replacements (minified text != unminified block text), so
    # nothing would get substituted and the page would silently go stale.
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
