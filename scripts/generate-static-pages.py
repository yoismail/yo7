#!/usr/bin/env python3
"""Generates real, separately-crawlable URLs for Yo7 Foods' informational
pages (About Us, Delivery Information, FAQ/guide, Contact Us, and the 5
legal pages), which otherwise only exist as hash routes (#/about) that
Google never indexes as distinct pages.

This is NOT a build pipeline — the site has none by design, and this
script doesn't turn it into one. It's a small manual step: whenever
index.html changes, re-run this before pushing, the same way perftest.html
already gets regenerated before every ship. It takes the current
index.html (the single source of truth for every line of app logic) and
writes 9 near-identical copies, each to a real path GitHub Pages serves
directly as <path>/index.html for a request to /<path>/. Every copy is
byte-identical to the source except:

  1. <title>, meta description, canonical link, and the og:/twitter: tags
     (swapped for that page's own copy, from PAGES below).
  2. One line added to the early theme-flash-prevention <script> in <head>
     (runs before the main app script), seeding window.location.hash via
     history.replaceState so the app's own existing route() function (at
     the very end of the main script) shows the right view immediately on
     load, with zero duplicated routing logic.

Usage:
    python3 scripts/generate-static-pages.py
Run from anywhere; paths below are relative to the repo root the script
lives in.
"""
import os

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(REPO_ROOT, 'index.html')
BASE_URL = 'https://yo7foods.co.uk'

# slug -> (hash route, <title>, meta description)
# og:title/twitter:title and og:description/twitter:description reuse the
# same title/description below — no reason for them to diverge here.
PAGES = [
    ('about', '#/about',
     'About Us | Yo7 Foods &mdash; Fresh African &amp; Caribbean Groceries',
     "Yo7 Foods brings authentic African and Caribbean groceries to UK households with modern convenience &mdash; our story, mission, and values."),
    ('delivery-info', '#/delivery-info',
     'Delivery Information | Yo7 Foods',
     "UK-wide delivery or pickup in Ipswich. Check your postcode, delivery fees by weight, and how long delivery takes."),
    ('guide', '#/guide',
     'FAQs &amp; New Here? | Yo7 Foods',
     "New to Yo7 Foods? How ordering works, plus answers to common questions about delivery, payment, and stock."),
    ('contact', '#/contact',
     'Contact Us | Yo7 Foods',
     "Get in touch with Yo7 Foods &mdash; WhatsApp, email, opening hours, and our Ipswich address for pickup."),
    ('privacy', '#/privacy',
     'Privacy Policy | Yo7 Foods',
     "How Yo7 Foods collects, uses, and protects your personal information."),
    ('terms', '#/terms',
     'Terms &amp; Conditions | Yo7 Foods',
     "The terms and conditions for shopping with Yo7 Foods."),
    ('returns', '#/returns',
     'Returns &amp; Refunds Policy | Yo7 Foods',
     "Our policy on damaged, incorrect, or unsatisfactory orders &mdash; replacements and refunds."),
    ('delivery-policy', '#/delivery-policy',
     'Delivery Policy | Yo7 Foods',
     "Delivery terms, timelines, and responsibilities for orders placed with Yo7 Foods."),
    ('cookie-policy', '#/cookie-policy',
     'Cookie Policy | Yo7 Foods',
     "How Yo7 Foods uses cookies, including the strictly-necessary ones used to process payments securely."),
]

# The exact homepage-wide values currently in index.html's <head>. If any
# of these ever go missing, the <head> has changed shape since this script
# was written and its line-index assumptions below need updating first —
# replace_line() raises rather than silently writing a broken page.
OLD_TITLE = 'Yo7 Foods | Fresh African &amp; Caribbean Groceries, Essex &amp; Suffolk'
OLD_DESC = 'Fresh African and Caribbean groceries, delivered UK-wide or collected in Ipswich. Authentic flavours, premium quality, trusted by households everywhere.'
OLD_TWITTER_DESC = 'Fresh African and Caribbean groceries, delivered UK-wide or collected in Ipswich. Authentic flavours, premium quality.'


def patch_head(lines, path_slug, title, description):
    canonical_url = f'{BASE_URL}/{path_slug}/'

    def replace_line(idx, old_fragment, new_fragment):
        if old_fragment not in lines[idx]:
            raise ValueError(f'Expected fragment not found on line {idx + 1}: {old_fragment!r}\nActual line: {lines[idx]!r}')
        lines[idx] = lines[idx].replace(old_fragment, new_fragment, 1)

    replace_line(6, f'<title>{OLD_TITLE}</title>', f'<title>{title}</title>')
    replace_line(7, f'content="{OLD_DESC}"', f'content="{description}"')
    replace_line(10, f'content="{OLD_TITLE}"', f'content="{title}"')  # og:title
    replace_line(11, f'content="{OLD_DESC}"', f'content="{description}"')  # og:description
    replace_line(13, f'content="{BASE_URL}/"', f'content="{canonical_url}"')  # og:url
    replace_line(19, f'content="{OLD_TITLE}"', f'content="{title}"')  # twitter:title
    replace_line(20, f'content="{OLD_TWITTER_DESC}"', f'content="{description}"')  # twitter:description
    replace_line(22, f'href="{BASE_URL}/" id="canonicalLink"', f'href="{canonical_url}" id="canonicalLink"')
    return lines


def inject_route_seed(html, hash_route):
    # Seeds the hash before the main app script runs, inside the existing
    # early theme-flash-prevention <script> block (its IIFE closes with
    # "})();" right before "</script>"). Uses history.replaceState, not
    # location.hash=, so this doesn't push an extra history entry — a
    # visitor arriving from Google and hitting Back once should leave the
    # site, not bounce back to this same page with the hash stripped.
    marker = "        })();\n    </script>\n</head>"
    if marker not in html:
        raise ValueError('Theme-flash-prevention script block marker not found — index.html <head> script shape changed, update this script to match.')
    seed_line = f"        history.replaceState(null, '', location.pathname + location.search + '{hash_route}');\n"
    replacement = "        })();\n" + seed_line + "    </script>\n</head>"
    return html.replace(marker, replacement, 1)


def main():
    with open(SOURCE, 'r', encoding='utf-8') as f:
        source_html = f.read()
    source_lines = source_html.split('\n')

    for slug, hash_route, title, description in PAGES:
        lines = patch_head(list(source_lines), slug, title, description)
        html = '\n'.join(lines)
        html = inject_route_seed(html, hash_route)

        out_dir = os.path.join(REPO_ROOT, slug)
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, 'index.html')
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(html)
        print(f'wrote {os.path.relpath(out_path, REPO_ROOT)} ({len(html):,} bytes)')


if __name__ == '__main__':
    main()
