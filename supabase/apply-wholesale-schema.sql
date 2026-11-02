-- One-time manual migration: brings a live Supabase project up to date
-- with the wholesale store schema from PR #212, before PR #212 has been
-- merged (schema.sql is a full dump of the end state, not something
-- applied automatically on merge, so the live project needs these
-- statements run directly).
--
-- Run this once against the live Supabase project's SQL editor, the same
-- way storage-setup-job-applications.sql is run. After this succeeds,
-- run seed-wholesale-products.sql to insert the 58 draft products.
--
-- This script is additive only (new column, new tables, new functions,
-- new triggers, new policies, new grants). It does not touch any
-- existing table's data or any existing policy/function.

-- 1. New column on the existing profiles table
ALTER TABLE "public"."profiles"
    ADD COLUMN "wholesale_status" "text" DEFAULT 'none'::"text" NOT NULL,
    ADD CONSTRAINT "profiles_wholesale_status_check" CHECK (("wholesale_status" = ANY (ARRAY['none'::"text", 'pending'::"text", 'approved'::"text", 'rejected'::"text"])));

-- 2. New tables
CREATE TABLE IF NOT EXISTS "public"."wholesale_applications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_name" "text" NOT NULL,
    "contact_name" "text" NOT NULL,
    "phone" "text",
    "message" "text",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."wholesale_applications" OWNER TO "postgres";

-- A dedicated table, not a wholesale-only row shape inside
-- custom_products: that table's own "Anyone can view custom products"
-- policy is USING (true), so anything stored there is readable by anyone
-- (including anon) over the public Supabase API regardless of what the
-- client-side UI chooses to show - fine for the regular catalogue, wrong
-- for a catalogue that's supposed to be wholesaler-only. price/unit are
-- nullable on purpose: these launch as real drafts (no price yet) rather
-- than a fake placeholder value, for an admin to fill in later.
CREATE TABLE IF NOT EXISTS "public"."wholesale_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cat_slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "unit" "text",
    "price" numeric,
    "stock" "text" DEFAULT 'out'::"text" NOT NULL,
    "description" "text",
    "image_url" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."wholesale_products" OWNER TO "postgres";

-- 3. Primary keys
ALTER TABLE ONLY "public"."wholesale_applications"
    ADD CONSTRAINT "wholesale_applications_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."wholesale_products"
    ADD CONSTRAINT "wholesale_products_pkey" PRIMARY KEY ("id");

-- 4. Foreign key
ALTER TABLE ONLY "public"."wholesale_applications"
    ADD CONSTRAINT "wholesale_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

-- 5. Indexes
CREATE INDEX "wholesale_applications_user_id_idx" ON "public"."wholesale_applications" USING "btree" ("user_id");

CREATE INDEX "wholesale_products_cat_slug_idx" ON "public"."wholesale_products" USING "btree" ("cat_slug");

-- 6. Row level security
ALTER TABLE "public"."wholesale_applications" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."wholesale_products" ENABLE ROW LEVEL SECURITY;

-- 7. Functions (must exist before the triggers below reference them)
CREATE OR REPLACE FUNCTION "public"."apply_for_wholesale_account"("p_business_name" "text", "p_contact_name" "text", "p_phone" "text" DEFAULT NULL::"text", "p_message" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to apply for a trade account.';
  END IF;

  IF NOT public.check_rpc_rate_limit('wholesale-apply', 3, 3600) THEN
    RAISE EXCEPTION 'Too many attempts, please try again later.';
  END IF;

  IF (SELECT wholesale_status FROM public.profiles WHERE id = auth.uid()) = ANY (ARRAY['pending'::"text", 'approved'::"text"]) THEN
    RAISE EXCEPTION 'You already have a trade account application on file.';
  END IF;

  INSERT INTO public.wholesale_applications (user_id, business_name, contact_name, phone, message)
  VALUES (auth.uid(), p_business_name, p_contact_name, p_phone, p_message);

  UPDATE public.profiles SET wholesale_status = 'pending' WHERE id = auth.uid();
END;
$$;

ALTER FUNCTION "public"."apply_for_wholesale_account"("p_business_name" "text", "p_contact_name" "text", "p_phone" "text", "p_message" "text") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."notify_wholesale_application_submitted"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_api_key text;
  v_admin record;
  v_business_html text;
  v_contact_html text;
  v_message_html text;
  v_phone_html text;
begin
  select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_api_key is null then
    return new;
  end if;

  if not public.check_rpc_rate_limit('wholesale-application-submitted', 5, 600) then
    return new;
  end if;

  v_business_html := public.html_escape(new.business_name);
  v_contact_html := public.html_escape(new.contact_name);
  v_phone_html := case when new.phone is not null then public.html_escape(new.phone) else null end;
  v_message_html := case when new.message is not null and length(trim(new.message)) > 0
    then public.html_escape(new.message)
    else null
  end;

  for v_admin in select email from public.profiles where is_admin = true and email is not null loop
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_api_key,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'from', 'YO7 Foods <orders@yo7foods.co.uk>',
        'to', v_admin.email,
        'subject', 'New trade account application from ' || new.business_name,
        'html',
          '<div style="font-family:''Montserrat Alternates'',Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">' ||
          '<div style="text-align:center;margin-bottom:14px;"><img src="https://yo7foods.co.uk/apple-touch-icon.png" width="52" height="52" alt="YO7 Foods" style="display:block;margin:0 auto;border-radius:12px;"></div>' ||
          '<h2 style="color:#063B00;">New trade account application</h2>' ||
          '<p><strong>' || v_business_html || '</strong>, contact ' || v_contact_html || '.</p>' ||
          (case when v_phone_html is not null then '<p style="color:#333;font-size:14px;">' || v_phone_html || '</p>' else '' end) ||
          (case when v_message_html is not null then '<p style="color:#333;font-size:14px;">' || v_message_html || '</p>' else '' end) ||
          '<p style="margin:24px 0;"><a href="https://yo7foods.co.uk/#/admin" style="background:#90B800;color:#063B00;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;display:inline-block;">Review in admin</a></p>' ||
          '<p style="color:#999;font-size:12px;">YO7 Foods admin notifications</p>' ||
          '</div>',
        'text',
          'New trade account application' || E'\n\n' ||
          new.business_name || ', contact ' || new.contact_name || '.' || E'\n' ||
          coalesce(new.phone, '') || E'\n\n' ||
          coalesce(new.message, '') || E'\n\n' ||
          'Review in admin: https://yo7foods.co.uk/#/admin'
      )
    );
  end loop;

  return new;
end;
$$;

ALTER FUNCTION "public"."notify_wholesale_application_submitted"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."prevent_self_wholesale_status_escalation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.wholesale_status IS DISTINCT FROM OLD.wholesale_status THEN
    IF NOT public.is_admin_user() AND NEW.wholesale_status <> 'pending' THEN
      RAISE EXCEPTION 'Only an existing admin can approve or reject a wholesale application.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."prevent_self_wholesale_status_escalation"() OWNER TO "postgres";

-- 8. Triggers
CREATE OR REPLACE TRIGGER "profiles_prevent_self_wholesale_status_escalation" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_self_wholesale_status_escalation"();

CREATE OR REPLACE TRIGGER "trg_notify_wholesale_application_submitted" AFTER INSERT ON "public"."wholesale_applications" FOR EACH ROW EXECUTE FUNCTION "public"."notify_wholesale_application_submitted"();

-- 9. RLS policies
CREATE POLICY "Admins can manage wholesale applications" ON "public"."wholesale_applications" USING ("public"."is_admin_user"()) WITH CHECK ("public"."is_admin_user"());

CREATE POLICY "Admins can manage wholesale products" ON "public"."wholesale_products" USING ("public"."is_admin_user"()) WITH CHECK ("public"."is_admin_user"());

CREATE POLICY "Approved wholesalers can view wholesale products" ON "public"."wholesale_products" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."wholesale_status" = 'approved'::"text")))));

CREATE POLICY "Users can view own wholesale applications" ON "public"."wholesale_applications" FOR SELECT USING (("auth"."uid"() = "user_id"));

-- 10. Grants (required since Oct 30 2026, Supabase no longer auto-grants
-- Data API access to new public tables/functions)
GRANT ALL ON FUNCTION "public"."apply_for_wholesale_account"("p_business_name" "text", "p_contact_name" "text", "p_phone" "text", "p_message" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_for_wholesale_account"("p_business_name" "text", "p_contact_name" "text", "p_phone" "text", "p_message" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_for_wholesale_account"("p_business_name" "text", "p_contact_name" "text", "p_phone" "text", "p_message" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."notify_wholesale_application_submitted"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_wholesale_application_submitted"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_wholesale_application_submitted"() TO "service_role";

GRANT ALL ON FUNCTION "public"."prevent_self_wholesale_status_escalation"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_self_wholesale_status_escalation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_self_wholesale_status_escalation"() TO "service_role";

GRANT ALL ON TABLE "public"."wholesale_applications" TO "anon";
GRANT ALL ON TABLE "public"."wholesale_applications" TO "authenticated";
GRANT ALL ON TABLE "public"."wholesale_applications" TO "service_role";

GRANT ALL ON TABLE "public"."wholesale_products" TO "anon";
GRANT ALL ON TABLE "public"."wholesale_products" TO "authenticated";
GRANT ALL ON TABLE "public"."wholesale_products" TO "service_role";
