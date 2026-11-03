-- One-time manual fix: public.html_escape() is referenced by the
-- wholesale application notification trigger (and by the job
-- application notification trigger, which predates it) but doesn't
-- exist yet on the live project, causing:
--   function public.html_escape(text) does not exist
-- on submit. Run this once in the Supabase SQL editor.

CREATE OR REPLACE FUNCTION "public"."html_escape"("s" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select replace(replace(replace(replace(replace(coalesce(s, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$$;

ALTER FUNCTION "public"."html_escape"("s" "text") OWNER TO "postgres";

GRANT ALL ON FUNCTION "public"."html_escape"("s" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."html_escape"("s" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."html_escape"("s" "text") TO "service_role";
