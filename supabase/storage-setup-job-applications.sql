-- One-time manual setup for CV uploads on the Careers page (#/careers).
-- Run this once against the live Supabase project's SQL editor. Not part
-- of schema.sql, which is a dump of the "public" schema only and has
-- never included storage.* objects (see the "job-applications bucket"
-- reasoning in the CV upload path, src/index.html) - this sandbox has no
-- live Supabase access to add it there automatically.
--
-- Creates a PRIVATE bucket (CVs are applicant PII, never publicly
-- readable by URL) with a real server-side size/type limit, not just the
-- HTML file input's "accept" attribute, which is only a picker hint a
-- direct REST call can ignore entirely.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-applications',
  'job-applications',
  false,
  5242880, -- 5 MB
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Anyone can upload a CV, but only under a path whose first folder
-- segment names an actually-open vacancy (src/index.html's upload path
-- is `${vacancyId}/${Date.now()}-${filename}`) - the same "must be an
-- open vacancy" boundary the job_applications table RLS enforces at the
-- database layer, enforced again here at the storage layer, since the
-- file upload happens before the application row exists to check
-- against.
create policy "Anyone can upload a CV to job-applications"
  on storage.objects for insert
  with check (
    bucket_id = 'job-applications'
    and (storage.foldername(name))[1] in (
      select id::text from public.job_vacancies where is_open = true
    )
  );

-- Admins can read (download via signed URL) and delete (vacancy
-- deletion's CV cleanup) - mirrors "Admins can manage job applications"
-- on the table itself.
create policy "Admins can manage job-applications storage"
  on storage.objects for all
  using (bucket_id = 'job-applications' and public.is_admin_user())
  with check (bucket_id = 'job-applications' and public.is_admin_user());
