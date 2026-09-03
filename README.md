# yo7

Yo7 Foods — a single-file static site (`index.html`) backed by Supabase,
deployed via GitHub Pages. No build pipeline by design.

## SEO: real per-page URLs

The site is a hash-routed SPA (`#/about`, `#/product/rice/0`, ...) — on
its own, that's one URL to Google. Two manual generator scripts stamp
near-identical copies of `index.html` to real paths GitHub Pages serves
directly, so individual pages and products can be indexed on their own.
Neither is CI/automated — re-run them by hand, the same way `perftest.html`
gets rebuilt before every ship, whenever `index.html` changes:

```
python3 scripts/generate-static-pages.py    # the 9 content pages (About, Contact, legal, ...)
python3 scripts/generate-product-pages.py   # the 76 statically-defined products
```

`generate-product-pages.py` needs `node` on `PATH` (only to parse the
`CATEGORIES` array literal out of `index.html` — the one place this repo
needs a JS runtime at all) and also rewrites `sitemap.xml` with the
product URLs each time it runs. It only covers the 76 hardcoded products,
not ones added via the admin panel (those live only in Supabase, which
this environment can't reach at generation time).

Commit the generated `about/`, `contact/`, ..., `product/*/` directories
and `sitemap.xml` alongside the `index.html` change.
