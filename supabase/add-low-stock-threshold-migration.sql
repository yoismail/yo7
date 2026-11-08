-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Replaces decrement_stock() so a tracked product's qualitative `stock`
-- status auto-flags to 'low' once its quantity drops to 10 or fewer (not
-- just 'out' at exactly zero, which is all it did before), the same
-- "more restrictive only, never loosen it back" rule the admin panel's
-- own save now applies client-side when a quantity is typed in directly.
-- An item an admin has already marked 'out' by hand stays 'out', this
-- never downgrades that back to 'low'.
--
-- Safe to run more than once: CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION "public"."decrement_stock"("p_lines" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  line jsonb;
  v_key text;
  v_qty int;
  v_cat_slug text;
  v_idx int;
  v_rows int;
BEGIN
  FOR line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_key := line->>'product_key';
    v_qty := (line->>'qty')::int;
    IF v_key IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
      CONTINUE;
    END IF;

    UPDATE public.product_overrides
    SET stock_quantity = stock_quantity - v_qty,
        stock = CASE
            WHEN stock_quantity - v_qty <= 0 THEN 'out'
            WHEN stock_quantity - v_qty <= 10 AND stock <> 'out' THEN 'low'
            ELSE stock
        END
    WHERE product_key = v_key AND stock_quantity IS NOT NULL AND stock_quantity >= v_qty;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      CONTINUE;
    END IF;

    v_cat_slug := split_part(v_key, '::', 1);
    v_idx := NULLIF(split_part(v_key, '::', 2), '')::int;
    IF v_idx IS NULL THEN
      CONTINUE;
    END IF;

    UPDATE public.custom_products
    SET stock_quantity = stock_quantity - v_qty,
        stock = CASE
            WHEN stock_quantity - v_qty <= 0 THEN 'out'
            WHEN stock_quantity - v_qty <= 10 AND stock <> 'out' THEN 'low'
            ELSE stock
        END
    WHERE cat_slug = v_cat_slug AND idx = v_idx AND stock_quantity IS NOT NULL AND stock_quantity >= v_qty;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows = 0 THEN
      IF EXISTS (
        SELECT 1 FROM public.product_overrides WHERE product_key = v_key AND stock_quantity IS NOT NULL
        UNION ALL
        SELECT 1 FROM public.custom_products WHERE cat_slug = v_cat_slug AND idx = v_idx AND stock_quantity IS NOT NULL
      ) THEN
        RAISE WARNING 'decrement_stock: shortfall for % (requested %)', v_key, v_qty;
      END IF;
    END IF;
  END LOOP;
END;
$$;
