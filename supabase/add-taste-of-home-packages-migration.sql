-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Adds the column the "Send a Taste of Home" care packages are persisted
-- in, the same way dish_templates_data already persists Build a Bundle's
-- dishes. Nullable and with no default, so existing rows are unaffected
-- until an admin edit actually writes to it (the client falls back to its
-- own hardcoded defaults whenever this column is null).
--
-- Safe to run more than once: ADD COLUMN IF NOT EXISTS.

ALTER TABLE "public"."pricing_settings"
    ADD COLUMN IF NOT EXISTS "taste_of_home_packages_data" "jsonb";
