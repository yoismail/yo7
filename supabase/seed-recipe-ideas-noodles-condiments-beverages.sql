-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Seeds Recipe ideas for three more categories: Noodles (noodles::0-3),
-- Sauces & Pastes / condiments (condiments::0-4), and Beverages
-- (beverages::0-17). Same pattern as the Flour and Oils seed files:
-- standard, widely-documented uses for each product, a starting point
-- to build the content layer from, edit any of these directly on the
-- product page afterwards (edit mode > Edit recipe ideas).
--
-- Safe to run more than once: upsert by product_key.

insert into public.product_overrides (product_key, recipes, updated_at)
values
  -- Noodles
  ('noodles::0', '[
    {"title": "Noodle Stir-Fry", "description": "Boil for 2 minutes, then toss with the seasoning, a beaten egg, and any vegetables you have for a quick stir-fry."},
    {"title": "Noodle Soup", "description": "Cook in a simple broth with vegetables and a protein for a warming one-pot meal."}
  ]'::jsonb, now()),
  ('noodles::1', '[
    {"title": "Noodle Stir-Fry", "description": "Boil for 2 minutes, then toss with the seasoning, a beaten egg, and any vegetables you have for a quick stir-fry."},
    {"title": "Noodle Soup", "description": "Cook in a simple broth with vegetables and a protein for a warming one-pot meal."}
  ]'::jsonb, now()),
  ('noodles::2', '[
    {"title": "Jollof Spaghetti", "description": "Cook the spaghetti, then toss it through a rich tomato and pepper sauce for a West African take on spaghetti."},
    {"title": "Spaghetti with Minced Meat Sauce", "description": "Serve with a simple tomato and minced meat sauce for a quick family meal."}
  ]'::jsonb, now()),
  ('noodles::3', '[
    {"title": "Stir-Fried Rice Vermicelli", "description": "Soak briefly in hot water, then stir-fry with vegetables and a protein of your choice."},
    {"title": "Vermicelli in Soup", "description": "Add to a clear broth for a light noodle base, or stir into pepper soup."}
  ]'::jsonb, now()),

  -- Sauces & Pastes (condiments)
  ('condiments::0', '[
    {"title": "Jollof Rice", "description": "The starting point for the tomato and pepper base most Nigerian jollof recipes build from."},
    {"title": "Tomato Stew", "description": "Fry with onions and pepper mix for the everyday stew that sits under rice, beans, or yam."}
  ]'::jsonb, now()),
  ('condiments::1', '[
    {"title": "Efo Riro", "description": "Stir straight into the frying onions as the pepper base for a quick spinach stew."},
    {"title": "Jollof Rice", "description": "A shortcut pepper base for jollof when you do not have time to blend fresh peppers."}
  ]'::jsonb, now()),
  ('condiments::2', '[
    {"title": "Shito Fried Rice", "description": "Stir through fried rice for a smoky, peppery Ghanaian heat."},
    {"title": "Waakye Side", "description": "Serve alongside waakye (rice and beans) the traditional way, as a condiment on the side."}
  ]'::jsonb, now()),
  ('condiments::3', '[
    {"title": "Groundnut Soup", "description": "The base for a rich West African groundnut stew, usually simmered with chicken or goat meat."},
    {"title": "Satay-Style Dip", "description": "Thin with a little hot water and lime for a quick dipping sauce for suya or grilled meat."}
  ]'::jsonb, now()),
  ('condiments::4', '[
    {"title": "Groundnut Soup", "description": "The base for a rich West African groundnut stew, usually simmered with chicken or goat meat."},
    {"title": "Spread for Bread or Toast", "description": "A simple everyday spread, no cooking needed."}
  ]'::jsonb, now()),

  -- Beverages
  ('beverages::0', '[
    {"title": "Hot Milo", "description": "Stir into hot milk or hot water for a warming malt drink."},
    {"title": "Milo Shake", "description": "Blend with cold milk and ice for a thick cold version."}
  ]'::jsonb, now()),
  ('beverages::1', '[
    {"title": "Hot Bournvita", "description": "Stir into hot milk for a classic morning malt drink."},
    {"title": "Bournvita Milkshake", "description": "Blend with cold milk and ice for a cold version."}
  ]'::jsonb, now()),
  ('beverages::2', '[
    {"title": "Classic Hot Tea", "description": "Steep in hot water, then add milk and sugar to taste."},
    {"title": "Iced Lemon Tea", "description": "Brew, chill, and add lemon for a refreshing iced tea."}
  ]'::jsonb, now()),
  ('beverages::3', '[
    {"title": "Made-Up Milk", "description": "Mix with warm water to make liquid milk for tea, cereal, or cooking."},
    {"title": "Pap (Akamu) Addition", "description": "Stir a spoonful into hot pap or custard for extra richness."}
  ]'::jsonb, now()),
  ('beverages::4', '[
    {"title": "Hot Milo", "description": "Stir into hot milk or hot water for a warming malt drink."},
    {"title": "Milo Shake", "description": "Blend with cold milk and ice for a thick cold version."}
  ]'::jsonb, now()),
  ('beverages::5', '[
    {"title": "Hot Milo", "description": "Stir into hot milk or hot water for a warming malt drink."},
    {"title": "Milo Shake", "description": "Blend with cold milk and ice for a thick cold version."}
  ]'::jsonb, now()),
  ('beverages::6', '[
    {"title": "Hot Milo", "description": "Stir into hot milk or hot water for a warming malt drink."},
    {"title": "Milo Shake", "description": "Blend with cold milk and ice for a thick cold version."}
  ]'::jsonb, now()),
  ('beverages::7', '[
    {"title": "Hot Milo", "description": "Stir into hot milk or hot water for a warming malt drink."},
    {"title": "Milo Shake", "description": "Blend with cold milk and ice for a thick cold version."}
  ]'::jsonb, now()),
  ('beverages::8', '[
    {"title": "Hot Milo", "description": "Stir into hot milk or hot water for a warming malt drink."},
    {"title": "Milo Shake", "description": "Blend with cold milk and ice for a thick cold version."}
  ]'::jsonb, now()),
  ('beverages::9', '[
    {"title": "Hot Ovaltine", "description": "Stir into hot milk for a smooth, malty drink."},
    {"title": "Ovaltine Milkshake", "description": "Blend with cold milk and ice for a cold version."}
  ]'::jsonb, now()),
  ('beverages::10', '[
    {"title": "Hot Ovaltine", "description": "Stir into hot milk for a smooth, malty drink."},
    {"title": "Ovaltine Milkshake", "description": "Blend with cold milk and ice for a cold version."}
  ]'::jsonb, now()),
  ('beverages::11', '[
    {"title": "Hot Bournvita", "description": "Stir into hot milk for a classic morning malt drink."},
    {"title": "Bournvita Milkshake", "description": "Blend with cold milk and ice for a cold version."}
  ]'::jsonb, now()),
  ('beverages::12', '[
    {"title": "Hot Ovaltine", "description": "Stir into hot milk for a smooth, malty drink."},
    {"title": "Ovaltine Milkshake", "description": "Blend with cold milk and ice for a cold version."}
  ]'::jsonb, now()),
  ('beverages::13', '[
    {"title": "Hot Chocolate", "description": "Stir into hot milk for a simple hot chocolate drink."}
  ]'::jsonb, now()),
  ('beverages::14', '[
    {"title": "Classic Hot Tea", "description": "Steep in hot water, then add milk and sugar to taste."},
    {"title": "Iced Lemon Tea", "description": "Brew, chill, and add lemon for a refreshing iced tea."}
  ]'::jsonb, now()),
  ('beverages::15', '[
    {"title": "Classic Hot Tea", "description": "Steep in hot water, then add milk and sugar to taste."},
    {"title": "Iced Lemon Tea", "description": "Brew, chill, and add lemon for a refreshing iced tea."}
  ]'::jsonb, now()),
  ('beverages::16', '[
    {"title": "Chilled, Ready to Drink", "description": "Serve straight from the fridge as a filling snack or light meal replacement."},
    {"title": "Milkshake Base", "description": "Blend with ice and a banana for a thicker shake."}
  ]'::jsonb, now()),
  ('beverages::17', '[
    {"title": "Quick Instant Coffee", "description": "Stir into hot water for a ready-sweetened coffee, no milk or sugar needed."},
    {"title": "Iced Coffee", "description": "Mix with a little hot water, then top with cold milk and ice."}
  ]'::jsonb, now())
on conflict (product_key) do update
  set recipes = excluded.recipes,
      updated_at = excluded.updated_at;
