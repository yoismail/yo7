-- Run this once in the Supabase SQL editor for the live yo7 project.
-- One-time migration for the Cloudflare image-proxy change (worker.js /
-- cdnImageUrl() in src/index.html): every admin-uploaded photo URL
-- already stored in the database still points at the raw Supabase
-- Storage domain, which is exactly the traffic that's been running up
-- "Cached Egress". New uploads from now on are stored pre-rewritten
-- (see cdnImageUrl()), but existing ones need this one-time rewrite to
-- actually start being served through the Cloudflare proxy/cache
-- instead of hitting Supabase directly.
--
-- Safe to run more than once: every statement only rewrites rows that
-- still start with the raw Supabase prefix, so a second run is a no-op.

do $$
declare
  v_prefix text := 'https://mcxfzfvhdtcjfyjmnamr.supabase.co/storage/v1/object/public/product-photos/';
begin
  update public.advert_banners
  set image_url = '/cdn-img/' || substring(image_url from length(v_prefix) + 1)
  where image_url like v_prefix || '%';

  update public.blog_posts
  set cover_image = '/cdn-img/' || substring(cover_image from length(v_prefix) + 1)
  where cover_image like v_prefix || '%';

  update public.custom_products
  set image_url = '/cdn-img/' || substring(image_url from length(v_prefix) + 1)
  where image_url like v_prefix || '%';

  update public.custom_products
  set image_thumb_url = '/cdn-img/' || substring(image_thumb_url from length(v_prefix) + 1)
  where image_thumb_url like v_prefix || '%';

  update public.pricing_settings
  set journal_hero_image = '/cdn-img/' || substring(journal_hero_image from length(v_prefix) + 1)
  where journal_hero_image like v_prefix || '%';

  update public.product_overrides
  set image_url = '/cdn-img/' || substring(image_url from length(v_prefix) + 1)
  where image_url like v_prefix || '%';

  update public.product_overrides
  set image_thumb_url = '/cdn-img/' || substring(image_thumb_url from length(v_prefix) + 1)
  where image_thumb_url like v_prefix || '%';

  update public.wholesale_products
  set image_url = '/cdn-img/' || substring(image_url from length(v_prefix) + 1)
  where image_url like v_prefix || '%';

  -- page_header_images: a flat {page-key: url} jsonb object.
  update public.pricing_settings
  set page_header_images = (
    select coalesce(jsonb_object_agg(
      key,
      to_jsonb(
        case when (value #>> '{}') like v_prefix || '%'
          then '/cdn-img/' || substring((value #>> '{}') from length(v_prefix) + 1)
          else value #>> '{}'
        end
      )
    ), '{}'::jsonb)
    from jsonb_each(page_header_images)
  )
  where page_header_images is not null and page_header_images <> '{}'::jsonb;

  -- category_overrides: {category-slug: {image?: url, tagline?: ..., ...}}
  -- - only the "image" sub-field is ever a Storage URL, every other
  -- field in each entry is left exactly as it was.
  update public.pricing_settings
  set category_overrides = (
    select coalesce(jsonb_object_agg(
      key,
      case
        when (value ? 'image') and ((value->>'image') like v_prefix || '%')
          then jsonb_set(value, '{image}', to_jsonb('/cdn-img/' || substring((value->>'image') from length(v_prefix) + 1)))
        else value
      end
    ), '{}'::jsonb)
    from jsonb_each(category_overrides)
  )
  where category_overrides is not null and category_overrides <> '{}'::jsonb;
end $$;
