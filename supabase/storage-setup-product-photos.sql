-- One-time manual setup for the product-photos bucket (admin product/
-- category photo uploads and advert banner images, src/index.html's
-- editProductPhoto()/category edit panel/advert banner admin panel all
-- upload here then call getPublicUrl() to store the result). Run this
-- once against the live Supabase project's SQL editor. Not part of
-- schema.sql, which is a dump of the "public" schema only and has never
-- included storage.* objects (see storage-setup-job-applications.sql for
-- the same reasoning) - this sandbox has no live Supabase access to add
-- it there automatically.
--
-- A security audit flagged that this bucket, unlike job-applications,
-- had no committed policy file, so its live storage.objects RLS could
-- not be confirmed or reasoned about from the repo alone. Run this to
-- make sure writes are actually admin-gated at the database layer, not
-- just hidden behind the client's currentIsAdmin/editModeOn checks.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-photos',
  'product-photos',
  true, -- public read: every photo is rendered via getPublicUrl() on the storefront
  5242880, -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public bucket means anyone can already read any object by URL (by
-- design - that's how product/category photos render on the storefront
-- with no auth). Writes are the part that must be locked down: only an
-- admin may upload, overwrite, or delete, mirroring every other
-- admin-only mutation in this project (is_admin_user(), same function
-- schema.sql's own RLS policies already use).
create policy "Admins can manage product-photos storage"
  on storage.objects for all
  using (bucket_id = 'product-photos' and public.is_admin_user())
  with check (bucket_id = 'product-photos' and public.is_admin_user());

create policy "Anyone can view product-photos"
  on storage.objects for select
  using (bucket_id = 'product-photos');
