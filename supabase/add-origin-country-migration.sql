-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Adds the origin_country column: turns the "Origin" field from a single
-- free-text paragraph into real structured data, a country picked from a
-- curated list in the admin editor (edit mode > Origin > Edit). The old
-- origin column is kept, now used as an optional short sourcing note
-- shown alongside the country rather than replacing it.
--
-- Safe to run more than once: IF NOT EXISTS.

alter table public.product_overrides add column if not exists origin_country text;
