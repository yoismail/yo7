# yo7

Yo7 Foods — a single-file static site backed by Supabase, deployed via
Cloudflare Workers (static assets, "Connect to Git" — see
`wrangler.jsonc`). Cloudflare itself runs no build step: whatever's
committed at a served path is exactly what's live.

`src/index.html` is the single source of truth for every page's content —
the one file to hand-edit. Repo-root `index.html`, and every page under
`about/`, `product/<slug>/`, etc., are **generated build artifacts**
(regenerated + minified from `src/index.html`, see below) — never edit
those directly, changes there get overwritten the next time the pipeline
runs.

## SEO: real per-page URLs, and a minified build

The site is a hash-routed SPA (`#/about`, `#/product/rice/0`, ...) — on
its own, that's one URL to Google. Three scripts turn `src/index.html`
into what's actually served:

```
python3 scripts/generate-static-pages.py    # the 9 content pages (About, Contact, legal, ...)
python3 scripts/generate-product-pages.py   # the statically-defined products
python3 scripts/minify.py                   # minifies repo-root index.html + every generated page, run last
```

`generate-product-pages.py` needs `node` on `PATH` (only to parse the
`CATEGORIES` array literal out of `src/index.html` — one of two places
this repo needs a JS runtime) and also rewrites `sitemap.xml` with the
product URLs each time it runs. It only covers the hardcoded products,
not ones added via the admin panel (those live only in Supabase, which
this environment can't reach at generation time).

`minify.py` needs `npx` on `PATH` (fetches `terser`/`csso-cli` on
demand) and must run **after** the two generators above — they depend on
`src/index.html` staying human-readable (exact-line-number and
marker-based text patching), so minifying first would break them. It
minifies the shared `<style>`/main `<script>` blocks once (confirmed
byte-identical across every generated page) and substitutes the result
into each page, rather than re-minifying 260 near-identical files from
scratch.

**This runs automatically now** — `.github/workflows/regenerate-pages.yml`
re-runs all three scripts on every push to `main` that touches
`src/index.html`, and pushes back any resulting diff in `index.html`,
the generated page directories, and `sitemap.xml` on its own. You only
need to run them by hand for local testing/preview; committing their
output yourself is no longer required.

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
