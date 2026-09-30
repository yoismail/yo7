# Style

- Never use em dashes (—) in code, commit messages, comments, or any user-facing text. Use commas, periods, or parentheses instead.

# UX standards

- Customer-facing copy should be explicit, not terse shorthand. Spell out relationship words ("over", "in", "for") rather than compressing them out (e.g. "over £70 in Ipswich" beats "£70+ Ipswich").
- A pill/badge with a full stadium border-radius (e.g. `border-radius: 999px`) only looks right on short, single-line content. If its text can wrap to two or more lines (longer copy, a narrow viewport, a future admin-editable value), use a fixed moderate radius instead (e.g. `14px`), or the curve pinches the wrapped text against the edges.
- When an icon sits next to text that might wrap to multiple lines, align the icon to `flex-start`, not `center`. Centering an icon against a two-line block looks fine by accident on short text but drifts once the text wraps.
- When changing or adding UI, actually look at it (screenshot or browser) at a narrow mobile width before calling it done, not just at the code. This is a mobile-first storefront; most real traffic is a phone screen, not a desktop viewport.

# Supabase schema

- `supabase/schema.sql` is a full schema dump, not incremental migrations. Every table in it carries explicit `GRANT ... TO anon/authenticated/service_role` statements (near the end of the file) plus RLS policies that do the real access control. Since October 30 2026, Supabase no longer auto-grants Data API access to new public tables, so any new table added to this file must include its own grant block (matching the pattern used for existing tables like `favorites`) in the same change that creates it, or it will be unreachable through supabase-js/PostgREST once created live.

# Business location (provisional)

- The business address (currently 7 Lancaster Road, Ipswich, IP4 2NY, in Suffolk) has not been finalized by stakeholders as of September 2026 and may change. Do not treat "Ipswich"/"Suffolk" as permanent, and do not change any of it without the user's explicit go-ahead.
- This isn't just display text: `isIpswichPostcode()`/`isSuffolkPostcode()` in `src/index.html` match on the "IP" postcode prefix and drive the region-scoped free-delivery thresholds (`IPSWICH_FREE_RULE_ID`/`OUTSIDE_IPSWICH_FREE_RULE_ID`) and the local-vs-standard delivery ETA copy. A real relocation needs new postcode-matching logic, not just a find-replace of the city name.
- Also referenced in: page title/meta/OG/Twitter tags and the LocalBusiness JSON-LD in `src/index.html`'s `<head>`, `scripts/generate-static-pages.py`'s per-page meta descriptions and its `OLD_TITLE`/`OLD_DESC`/`OLD_TWITTER_DESC` constants, `manifest.json`, the `YO7_STORE_ADDRESS` pickup-address constant, the Contact page's embedded Google Maps query, the order PDF/receipt text, and the customer-facing transactional email templates in `supabase/schema.sql` (order confirmation/status-change, newsletter and coming-soon signup), which all end with the same "7 Lancaster Road, Ipswich, IP4 2NY" footer line. The admin-only alert emails (new order, new job application) don't carry that footer, so don't assume every template in that file has the address just because most do.
