-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Seeds Recipe ideas for the Oils category (oils::0 through oils::5),
-- same pattern as seed-recipe-ideas-flour-category.sql: standard,
-- widely-documented Nigerian culinary uses for each product, a starting
-- point to build the content layer from, edit any of these directly on
-- the product page afterwards (edit mode > Edit recipe ideas).
--
-- Safe to run more than once: upsert by product_key.

insert into public.product_overrides (product_key, recipes, updated_at)
values
  ('oils::0', '[
    {"title": "Banga Soup", "description": "The classic Niger Delta palm fruit soup, made with concentrate or fresh palm fruit and this oil for its signature colour and flavour."},
    {"title": "Efo Riro", "description": "A generous splash gives this spinach stew its rich red colour and depth."},
    {"title": "Ayamase (Ofada Stew)", "description": "Bleach the oil first over heat for the smoky, peppery \"designer stew\" traditionally served with ofada rice."}
  ]'::jsonb, now()),
  ('oils::1', '[
    {"title": "Akara", "description": "Deep-fry blended black-eyed bean batter in hot groundnut oil for crisp, golden bean cakes."},
    {"title": "Dodo (Fried Plantain)", "description": "A neutral, high-heat oil that fries ripe plantain slices to a deep golden brown without overpowering the flavour."},
    {"title": "Chin Chin", "description": "Deep-fry small dough cubes until crisp for a classic sweet, crunchy snack."}
  ]'::jsonb, now()),
  ('oils::2', '[
    {"title": "Jollof Rice", "description": "A neutral base oil for sautéing the pepper mix before the rice goes in."},
    {"title": "Fried Rice", "description": "Use to stir-fry the rice and vegetables over high heat without adding a strong flavour of its own."},
    {"title": "Chicken Stew", "description": "Brown the chicken and build the tomato stew base in this oil before simmering."}
  ]'::jsonb, now()),
  ('oils::3', '[
    {"title": "Coconut Rice", "description": "Cook the rice in coconut milk with a spoon of this oil stirred through for extra richness."},
    {"title": "Dodo (Fried Plantain)", "description": "Fry ripe plantain slices in coconut oil for a subtle sweetness alongside the caramelised edges."}
  ]'::jsonb, now()),
  ('oils::4', '[
    {"title": "Coconut Rice", "description": "Cook the rice in coconut milk with a spoon of this oil stirred through for extra richness."},
    {"title": "Sautéed Greens", "description": "Finish a pan of ugu or efo (greens) with a spoon of this for a light coconut note."}
  ]'::jsonb, now()),
  ('oils::5', '[
    {"title": "Coconut Rice", "description": "Cook the rice in coconut milk with a spoon of this oil stirred through for extra richness."},
    {"title": "Sautéed Greens", "description": "Finish a pan of ugu or efo (greens) with a spoon of this for a light coconut note."}
  ]'::jsonb, now())
on conflict (product_key) do update
  set recipes = excluded.recipes,
      updated_at = excluded.updated_at;
