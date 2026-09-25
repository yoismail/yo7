# Style

- Never use em dashes (—) in code, commit messages, comments, or any user-facing text. Use commas, periods, or parentheses instead.

# Supabase schema

- `supabase/schema.sql` is a full schema dump, not incremental migrations. Every table in it carries explicit `GRANT ... TO anon/authenticated/service_role` statements (near the end of the file) plus RLS policies that do the real access control. Since October 30 2026, Supabase no longer auto-grants Data API access to new public tables, so any new table added to this file must include its own grant block (matching the pattern used for existing tables like `favorites`) in the same change that creates it, or it will be unreachable through supabase-js/PostgREST once created live.
