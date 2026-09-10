// Yo7 Foods — Supabase Edge Function: refresh-google-reviews
//
// Fetches the real rating + up to 5 review snippets Google returns for
// this business (via the Places API "New" Place Details endpoint) and
// caches them in public.google_reviews_cache, which the homepage Reviews
// section reads from. Google's own API only ever returns up to 5 reviews,
// chosen by Google's own "most relevant" ranking — there is no way to
// pull more via this API, or to choose which 5. That's a Google
// limitation, not something this function can work around.
//
// WHY THIS EXISTS AS A SEPARATE FUNCTION FROM create-payment-intent:
// different trust boundary and different trigger (a daily cron ping, not
// a customer action) — keeping it separate means a bug here can never
// touch checkout, and vice versa.
//
// COST/QUOTA SAFETY: the real call to Google only happens if the cache is
// more than 20 hours old (see FRESHNESS_HOURS below) — every other
// invocation (including a hammering script, or the daily cron firing
// slightly early/late) just returns instantly without touching Google's
// API at all. An admin's own "Refresh now" button in the admin panel
// bypasses that wait by passing { force: true }, but only once verified
// as an actual admin via their own Supabase session — never on say-so
// alone. On top of that, this function also has its own general rate
// limit (see checkRateLimit below), same pattern and same
// rate_limit_hits table as create-payment-intent.
//
// Deploy with the Supabase CLI from the project root. --no-verify-jwt is
// deliberate: the daily cron job (see migration 32) pings this with no
// Authorization header at all, and the freshness guard above is what
// actually protects Google API cost/quota, not a login check on every
// caller:
//   supabase functions deploy refresh-google-reviews --no-verify-jwt
//
// Secrets it needs — GOOGLE_PLACES_API_KEY is the one you set yourself
// (see the setup guide for how to get one and lock it down):
//   supabase secrets set GOOGLE_PLACES_API_KEY=AIza...
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
// by Supabase for every Edge Function, nothing to set for those.

import { createClient } from "npm:@supabase/supabase-js@2";

// The workers.dev entry is temporary, for verifying the Cloudflare
// migration before yo7foods.co.uk's DNS actually points there — remove
// it once that cutover is done.
const ALLOWED_ORIGINS = new Set([
  "https://yo7foods.co.uk",
  "https://www.yo7foods.co.uk",
  "https://yo7.ismailyomi.workers.dev",
]);

function corsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://yo7foods.co.uk";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const FRESHNESS_HOURS = 20;

async function checkRateLimit(
  db: ReturnType<typeof createClient>,
  bucketKey: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { count } = await db
    .from("rate_limit_hits")
    .select("id", { count: "exact", head: true })
    .eq("bucket_key", bucketKey)
    .gte("created_at", windowStart);
  if ((count ?? 0) >= limit) return false;
  await db.from("rate_limit_hits").insert({ bucket_key: bucketKey });
  return true;
}

function getClientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? "unknown";
}

type GoogleReview = {
  rating?: number;
  relativePublishTimeDescription?: string;
  publishTime?: string;
  text?: { text?: string };
  authorAttribution?: { displayName?: string; photoUri?: string };
};
type GooglePlaceResponse = {
  rating?: number;
  userRatingCount?: number;
  reviews?: GoogleReview[];
  error?: { message?: string };
};

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  // Service-role client: reads/writes the cache and pricing_settings
  // regardless of RLS, same pattern as create-payment-intent.
  const db = createClient(supabaseUrl, serviceRoleKey);

  const clientIp = getClientIp(req);
  if (!(await checkRateLimit(db, `refresh-google-reviews:${clientIp}`, 10, 60))) {
    return new Response(JSON.stringify({ error: "Too many requests, please wait a moment and try again." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json", "Retry-After": "30" },
    });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty cron ping has no body at all, that's fine */ }

  // A forced refresh (the admin panel's "Refresh now" button) needs to
  // actually be from a verified admin, not just a truthy flag in the
  // request body someone could fake — checked the same way
  // create-payment-intent verifies who's asking, via the caller's own
  // Supabase session token, never trusted client-side alone.
  let isVerifiedAdmin = false;
  if (body.force === true) {
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: userData } = await authClient.auth.getUser();
    if (userData?.user?.id) {
      const { data: profile } = await db.from("profiles").select("is_admin").eq("id", userData.user.id).maybeSingle();
      isVerifiedAdmin = profile?.is_admin === true;
    }
  }

  const { data: cache } = await db.from("google_reviews_cache").select("fetched_at").eq("id", true).maybeSingle();
  const staleEnough = !cache?.fetched_at || (Date.now() - new Date(cache.fetched_at).getTime()) > FRESHNESS_HOURS * 60 * 60 * 1000;

  if (!staleEnough && !(body.force === true && isVerifiedAdmin)) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "Cache is still fresh, Google wasn't called." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!apiKey) {
    console.error("GOOGLE_PLACES_API_KEY is not set — run: supabase secrets set GOOGLE_PLACES_API_KEY=AIza...");
    return new Response(JSON.stringify({ error: "Google Places API isn't configured on the server yet." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { data: settings } = await db.from("pricing_settings").select("google_place_id").eq("id", true).maybeSingle();
  const placeId = settings?.google_place_id;
  if (!placeId) {
    return new Response(JSON.stringify({ error: "No Google Place ID set yet — add one in the admin panel's Review platforms section first." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "rating,userRatingCount,reviews",
      },
    });
    const place = await resp.json() as GooglePlaceResponse;
    if (!resp.ok) {
      console.error("Google Places API error:", place.error?.message);
      return new Response(JSON.stringify({ error: place.error?.message || "Google Places API request failed." }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const reviews = (place.reviews ?? []).map((r) => ({
      author_name: r.authorAttribution?.displayName ?? "Google user",
      author_photo_url: r.authorAttribution?.photoUri ?? null,
      rating: typeof r.rating === "number" ? r.rating : null,
      relative_time: r.relativePublishTimeDescription ?? null,
      publish_time: r.publishTime ?? null,
      text: r.text?.text ?? "",
    }));

    await db.from("google_reviews_cache").upsert({
      id: true,
      rating: typeof place.rating === "number" ? place.rating : null,
      review_count: typeof place.userRatingCount === "number" ? place.userRatingCount : null,
      reviews,
      fetched_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ ok: true, rating: place.rating, reviewCount: place.userRatingCount, reviewsFetched: reviews.length }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Google Places fetch failed:", err);
    const message = err instanceof Error ? err.message : "Couldn't reach Google Places API.";
    return new Response(JSON.stringify({ error: message }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
