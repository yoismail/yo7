-- One-time manual migration: brings a live Supabase project up to date
-- with the second round of wholesale changes (minimum order quantity,
-- an email to the applicant when their trade account is approved,
-- rejected, or later revoked, and the ability to actually buy from the
-- wholesale store through the normal cart/checkout).
--
-- Run this once in the Supabase SQL editor, the same way
-- apply-wholesale-schema.sql was run. Safe to run even if some of these
-- objects already exist (CREATE OR REPLACE / IF NOT EXISTS throughout).
-- This script is additive only, no existing data or policy is touched.
--
-- The checkout side of this (buying wholesale items through the real
-- cart) also needs supabase/functions/create-payment-intent redeployed:
--   supabase functions deploy create-payment-intent

-- 1. Minimum order quantity per product
ALTER TABLE "public"."wholesale_products"
    ADD COLUMN IF NOT EXISTS "min_qty" integer DEFAULT 1 NOT NULL;

-- 2. Email the applicant when an admin approves, rejects, or revokes
-- (revoking just reuses 'rejected', see profiles_wholesale_status_check)
-- their trade account. Admin-triggered only - the existing
-- prevent_self_wholesale_status_escalation trigger already stops a
-- non-admin from setting their own status to anything but 'pending', so
-- there's no user-facing abuse path here worth rate-limiting.
CREATE OR REPLACE FUNCTION "public"."notify_wholesale_status_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_api_key text;
  v_email text;
  v_subject text;
  v_headline text;
  v_body text;
begin
  if new.wholesale_status not in ('approved', 'rejected') then
    return new;
  end if;

  select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_api_key is null then
    return new;
  end if;

  v_email := new.email;
  if v_email is null then
    return new;
  end if;

  if new.wholesale_status = 'approved' then
    v_subject := 'Your trade account is approved';
    v_headline := 'Your trade account is approved';
    v_body := 'You now have access to wholesale pricing on poultry, meat and fish. Head to the wholesale store to start ordering.';
  else
    v_subject := 'Your trade account application';
    v_headline := 'Your trade account application';
    v_body := 'We''re not able to offer wholesale pricing on your account right now. If you think this is a mistake, reply to this email and we''ll take another look.';
  end if;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_api_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'from', 'YO7 Foods <orders@yo7foods.co.uk>',
      'reply_to', 'hello@yo7foods.co.uk',
      'to', v_email,
      'subject', v_subject,
      'html',
        '<div style="font-family:''Montserrat Alternates'',Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">' ||
        '<div style="text-align:center;margin-bottom:14px;"><img src="https://yo7foods.co.uk/apple-touch-icon.png" width="52" height="52" alt="YO7 Foods" style="display:block;margin:0 auto;border-radius:12px;"></div>' ||
        '<h2 style="color:#063B00;">' || v_headline || '</h2>' ||
        '<p>' || v_body || '</p>' ||
        (case when new.wholesale_status = 'approved' then
          '<p style="margin:24px 0;"><a href="https://yo7foods.co.uk/#/wholesale" style="background:#90B800;color:#063B00;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;display:inline-block;">Go to the wholesale store</a></p>'
        else '' end) ||
        '<p style="color:#999;font-size:12px;">YO7 Foods &middot; 7 Lancaster Road, Ipswich, IP4 2NY</p>' ||
        '</div>',
      'text',
        v_headline || E'\n\n' || v_body ||
        (case when new.wholesale_status = 'approved' then E'\n\n' || 'Wholesale store: https://yo7foods.co.uk/#/wholesale' else '' end) ||
        E'\n\n' || 'YO7 Foods · 7 Lancaster Road, Ipswich, IP4 2NY'
    )
  );

  return new;
end;
$$;

ALTER FUNCTION "public"."notify_wholesale_status_change"() OWNER TO "postgres";

GRANT ALL ON FUNCTION "public"."notify_wholesale_status_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_wholesale_status_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_wholesale_status_change"() TO "service_role";

DROP TRIGGER IF EXISTS "trg_notify_wholesale_status_change" ON "public"."profiles";
CREATE TRIGGER "trg_notify_wholesale_status_change" AFTER UPDATE ON "public"."profiles" FOR EACH ROW WHEN (("new"."wholesale_status" IS DISTINCT FROM "old"."wholesale_status")) EXECUTE FUNCTION "public"."notify_wholesale_status_change"();
