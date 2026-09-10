# yo7

Yo7 Foods — a single-file static site (`index.html`) backed by Supabase,
deployed via GitHub Pages. No build pipeline by design.

## SEO: real per-page URLs

The site is a hash-routed SPA (`#/about`, `#/product/rice/0`, ...) — on
its own, that's one URL to Google. Two generator scripts stamp
near-identical copies of `index.html` to real paths GitHub Pages serves
directly, so individual pages and products can be indexed on their own:

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

**This runs automatically now** — `.github/workflows/regenerate-pages.yml`
re-runs both scripts on every push to `main` that touches `index.html`,
and pushes back any resulting diff in the generated pages/`sitemap.xml`
on its own. You only need to run them by hand for local testing/preview;
committing their output yourself is no longer required.

## Supabase backend

`supabase/schema.sql` and `supabase/functions/*/index.ts` are a
version-controlled mirror of the live project (mcxfzfvhdtcjfyjmnamr) —
not a build artifact, nothing here deploys automatically. After changing
an Edge Function or the schema directly in the Supabase dashboard/CLI,
re-export and commit here too, so the repo stays a true record of what's
actually live:

```
supabase db dump -f supabase/schema.sql
supabase functions download create-payment-intent
supabase functions download stripe-webhook
supabase functions download refresh-google-reviews
```

To deploy a change made here back to the live project:

```
supabase functions deploy <name>
```

There's no equivalent one-command push for `schema.sql` — it was
captured via `db dump` for reference/diffing, not `db push` migration
tracking, since the project's schema history was never managed through
the CLI. Apply schema changes directly (SQL editor or `db push` against
a proper migration), then re-dump to keep this file in sync.
