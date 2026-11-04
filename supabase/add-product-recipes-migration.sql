-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Adds the column the new "Recipe ideas" product-page section writes to
-- and reads from: up to 3 short recipe ideas per product, stored as
-- [{title, description}, ...], the same way weight_variants already
-- stores a jsonb array on this same table.
--
-- Safe to run more than once: IF NOT EXISTS.

alter table public.product_overrides add column if not exists recipes jsonb;
