# Style

- Never use em dashes (—) in code, commit messages, comments, or any user-facing text. Use commas, periods, or parentheses instead.

# UX standards

- Customer-facing copy should be explicit, not terse shorthand. Spell out relationship words ("over", "in", "for") rather than compressing them out (e.g. "over £70 in Ipswich" beats "£70+ Ipswich").
- A pill/badge with a full stadium border-radius (e.g. `border-radius: 999px`) only looks right on short, single-line content. If its text can wrap to two or more lines (longer copy, a narrow viewport, a future admin-editable value), use a fixed moderate radius instead (e.g. `14px`), or the curve pinches the wrapped text against the edges.
- When an icon sits next to text that might wrap to multiple lines, align the icon to `flex-start`, not `center`. Centering an icon against a two-line block looks fine by accident on short text but drifts once the text wraps.
- When changing or adding UI, actually look at it (screenshot or browser) at a narrow mobile width before calling it done, not just at the code. This is a mobile-first storefront; most real traffic is a phone screen, not a desktop viewport.

# Supabase schema

- `supabase/schema.sql` is a full schema dump, not incremental migrations. Every table in it carries explicit `GRANT ... TO anon/authenticated/service_role` statements (near the end of the file) plus RLS policies that do the real access control. Since October 30 2026, Supabase no longer auto-grants Data API access to new public tables, so any new table added to this file must include its own grant block (matching the pattern used for existing tables like `favorites`) in the same change that creates it, or it will be unreachable through supabase-js/PostgREST once created live.
