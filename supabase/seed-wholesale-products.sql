-- One-time manual seed for the wholesale meat/poultry/fish store
-- (#/wholesale, gated to approved trade accounts - see wholesale_products
-- in schema.sql for the table itself and why it's separate from the
-- regular custom_products catalogue).
--
-- Run this once against the live Supabase project's SQL editor, the same
-- way storage-setup-job-applications.sql is run: this sandbox has no live
-- Supabase access to insert these rows directly.
--
-- Every row here is a genuine draft: no price, no unit, no photo, and
-- stock defaults to 'out' (so nothing is orderable even by an approved
-- account until an admin fills these in through the Wholesale Products
-- admin panel and flips stock to 'in'). Names are exactly as supplied,
-- unedited.

insert into public.wholesale_products (cat_slug, name, sort_order) values
  -- Poultry
  ('wholesale-poultry', 'Smoked Hen', 0),
  ('wholesale-poultry', 'Smoked Turkey Wings', 1),
  ('wholesale-poultry', 'Smoked Turkey Drumsticks', 2),
  ('wholesale-poultry', 'Smoked Turkey Tail', 3),
  ('wholesale-poultry', 'Turkey Midwings (Male)', 4),
  ('wholesale-poultry', 'Turkey Midwings (Female)', 5),
  ('wholesale-poultry', 'Fresh Turkey Wings', 6),
  ('wholesale-poultry', 'Fresh Turkey Drumsticks', 7),
  ('wholesale-poultry', 'Turkey Gizzard', 8),
  ('wholesale-poultry', 'Chicken Gizzard', 9),
  ('wholesale-poultry', 'Chicken Feet', 10),
  ('wholesale-poultry', 'Chicken Wings', 11),
  ('wholesale-poultry', 'Soft Chicken Leg and Thigh', 12),
  ('wholesale-poultry', 'Henko Leg and Thigh', 13),
  ('wholesale-poultry', 'Jolly Leg and Thigh', 14),
  ('wholesale-poultry', 'Soft Chicken Drumsticks', 15),

  -- Meat
  ('wholesale-meat', 'Roundabout', 0),
  ('wholesale-meat', 'ASKO Mixed Meat', 1),
  ('wholesale-meat', 'YF Mixed Meat', 2),
  ('wholesale-meat', 'Oxtail', 3),
  ('wholesale-meat', 'HC Shaki', 4),
  ('wholesale-meat', 'Goat Shaki', 5),
  ('wholesale-meat', 'Bible Shaki', 6),
  ('wholesale-meat', 'Shin Beef', 7),
  ('wholesale-meat', 'Beef Ribs', 8),
  ('wholesale-meat', 'Beef on the Bone', 9),
  ('wholesale-meat', 'Goat Meat Cubes', 10),
  ('wholesale-meat', 'BL Goat Meat Cubes', 11),
  ('wholesale-meat', 'Goat Feet', 12),
  ('wholesale-meat', 'Cowfoot 1kg', 13),
  ('wholesale-meat', 'Cowfoot (Loose)', 14),
  ('wholesale-meat', 'BL Cowfoot', 15),
  ('wholesale-meat', 'Beef Snout', 16),
  ('wholesale-meat', 'Reed Crown (Abodi)', 17),
  ('wholesale-meat', 'Beef Mask', 18),
  ('wholesale-meat', 'Cow Ears', 19),
  ('wholesale-meat', 'Cow Tongue', 20),
  ('wholesale-meat', 'Liver', 21),
  ('wholesale-meat', 'Kidney', 22),
  ('wholesale-meat', 'Heart', 23),
  ('wholesale-meat', 'Fuku/Lungs', 24),

  -- Fish & Seafood
  ('wholesale-fish-seafood', 'Tilapia (S)', 0),
  ('wholesale-fish-seafood', 'Tilapia (M)', 1),
  ('wholesale-fish-seafood', 'Tilapia (L)', 2),
  ('wholesale-fish-seafood', 'Hake', 3),
  ('wholesale-fish-seafood', 'Croaker', 4),
  ('wholesale-fish-seafood', 'Redfish Steak', 5),
  ('wholesale-fish-seafood', 'Redfish Whole', 6),
  ('wholesale-fish-seafood', 'Catfish', 7),
  ('wholesale-fish-seafood', 'Crabs', 8),
  ('wholesale-fish-seafood', 'King Prawns', 9),
  ('wholesale-fish-seafood', 'Prawns', 10),
  ('wholesale-fish-seafood', 'Iru/Locust Beans', 11),
  ('wholesale-fish-seafood', 'Periwinkle', 12),
  ('wholesale-fish-seafood', 'Mackerel', 13),
  ('wholesale-fish-seafood', 'Pangasious Steak', 14),
  ('wholesale-fish-seafood', 'Kobi Fish', 15),
  ('wholesale-fish-seafood', 'Seabass', 16);
