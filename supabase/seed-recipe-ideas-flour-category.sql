-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Seeds Recipe ideas (the section added in PR #233) for the first 4
-- products, the Flour category (flour::0 through flour::3). These are
-- standard, widely-documented Nigerian culinary uses for each product,
-- not claims specific to this business - a starting point to build the
-- content layer from, edit any of these directly on the product page
-- afterwards (edit mode > Edit recipe ideas) the same as any other one.
--
-- Safe to run more than once: upsert by product_key.

insert into public.product_overrides (product_key, recipes, updated_at)
values
  ('flour::0', '[
    {"title": "Semo Swallow", "description": "Stir into hot water for a smooth, stretchy swallow, the classic partner for egusi, okra, or afang soup."},
    {"title": "Semolina Breakfast Porridge", "description": "Cook with milk and a little sugar for a warm, creamy breakfast porridge."}
  ]'::jsonb, now()),
  ('flour::1', '[
    {"title": "Garri Soakings", "description": "Soak in cold water with sugar, milk, and roasted groundnuts for a quick, no-cook snack."},
    {"title": "Eba", "description": "Mix with hot water to make eba, served with egusi, ogbono, or vegetable soup."},
    {"title": "Garri and Fried Fish", "description": "Soak lightly and pair with fried fish and a hot pepper sauce for a simple, filling meal."}
  ]'::jsonb, now()),
  ('flour::2', '[
    {"title": "Eba", "description": "A milder, less sour eba than the yellow variety, mixed with hot water and served with any soup."},
    {"title": "Garri Soakings", "description": "Soak in cold water with sugar and milk for a lighter-tasting version of the classic snack."}
  ]'::jsonb, now()),
  ('flour::3', '[
    {"title": "Amala with Ewedu and Gbegiri", "description": "Stir into boiling water for the smooth, dark swallow traditionally served with ewedu and gbegiri soups."},
    {"title": "Amala with Efo Riro", "description": "Just as good paired with a rich efo riro (spinach stew) for a simpler combination."}
  ]'::jsonb, now())
on conflict (product_key) do update
  set recipes = excluded.recipes,
      updated_at = excluded.updated_at;
