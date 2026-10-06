// Yo7 Foods — Supabase Edge Function: update-fx-rates
//
// Fetches live GBP-based exchange rates and writes them into
// pricing_settings.fx_rates — but ONLY for whichever currencies the
// admin has switched to "Auto-update" in the currency rates admin panel
// (pricing_settings.fx_rates_auto, e.g. {"CAD": true, "USD": false}).
// A currency left on manual is never touched by this function at all;
// it keeps exactly whatever rate the admin typed in, same as before
// this function existed.
//
// WHY THIS EXISTS AS A SEPARATE FUNCTION FROM create-payment-intent:
// different trust boundary and different trigger (a daily cron ping, not
// a customer action) — keeping it separate means a bug here can never
// touch checkout, and vice versa. Closely mirrors
// refresh-google-reviews's own shape and trust model (same freshness
// guard + rate-limit pattern, same admin-verified force path), since
// it's solving the same kind of problem: a cheap daily refresh of
// something that doesn't need to be live-exact.
//
// COST/QUOTA SAFETY: the real call to the rate provider only happens if
// (a) at least one currency is actually set to auto-update, and (b) the
// cache is more than FRESHNESS_HOURS old — every other invocation
// (including the daily cron firing slightly early/late, or a stray
// repeat call) just returns instantly. An admin's own "Refresh now"
// button in the admin panel bypasses the freshness wait by passing
// { force: true }, but only once verified as an actual admin via their
// own Supabase session — never on say-so alone. On top of that, this
// function also has its own general rate limit (see checkRateLimit
// below), same pattern and same rate_limit_hits table as
// create-payment-intent/refresh-google-reviews.
//
// Rate source: https://open.er-api.com/v6/latest/GBP — free, no API key,
// broad currency coverage (includes NGN), updates roughly daily. This is
// retail price display, not a trading system; it doesn't need sub-daily
// precision, and the manual-rate escape hatch (fx_rates_auto off) is
// always there for a currency this provider gets wrong or stops
// covering.
//
// Deploy with the Supabase CLI from the project root. --no-verify-jwt is
// deliberate: the daily cron job (see this repo's schema.sql, "SCHEDULED
// JOBS" section near the end) pings this with no Authorization header at
// all, and the freshness guard above is what actually protects against
// over-calling the rate provider, not a login check on every caller:
//   supabase functions deploy update-fx-rates --no-verify-jwt
//
// SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are
// injected automatically by Supabase for every Edge Function, nothing to
// set for those.

import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://yo7foods.co.uk",
  "https://www.yo7foods.co.uk",
]);

function corsHeaders(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://yo7foods.co.uk";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// Same 20h margin refresh-google-reviews uses for its own daily cron —
// comfortably covers the cron firing a little early/late without ever
// going a full day without a refresh.
const FRESHNESS_HOURS = 20;
// Every currency this site has ever offered via the admin FX-rate panel
// (src/index.html's CURRENCY_NAMES/CURRENCY_SYMBOLS/CURRENCY_FLAGS) —
// GBP excluded, since it's the base currency every rate here converts
// FROM, never a rate to fetch.
const SUPPORTED_AUTO_CURRENCIES = ["CAD", "USD", "NGN"] as const;

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

type OpenErApiResponse = { result?: string; rates?: Record<string, number> };

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  // Service-role client: reads/writes pricing_settings regardless of
  // RLS, same pattern as create-payment-intent/refresh-google-reviews.
  const db = createClient(supabaseUrl, serviceRoleKey);

  const clientIp = getClientIp(req);
  if (!(await checkRateLimit(db, `update-fx-rates:${clientIp}`, 10, 60))) {
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
  // refresh-google-reviews verifies who's asking, via the caller's own
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

  const { data: settings } = await db.from("pricing_settings")
    .select("fx_rates, fx_rates_auto, fx_rates_fetched_at")
    .eq("id", true).maybeSingle();

  const fxRatesAuto = (settings?.fx_rates_auto && typeof settings.fx_rates_auto === "object")
    ? settings.fx_rates_auto as Record<string, boolean>
    : {};
  const autoCurrencies = SUPPORTED_AUTO_CURRENCIES.filter((c) => fxRatesAuto[c] === true);

  if (autoCurrencies.length === 0) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "No currency is set to auto-update." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const staleEnough = !settings?.fx_rates_fetched_at
    || (Date.now() - new Date(settings.fx_rates_fetched_at).getTime()) > FRESHNESS_HOURS * 60 * 60 * 1000;

  if (!staleEnough && !(body.force === true && isVerifiedAdmin)) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: "Rates were already refreshed recently." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  try {
    const resp = await fetch("https://open.er-api.com/v6/latest/GBP");
    const data = await resp.json() as OpenErApiResponse;
    if (!resp.ok || data.result !== "success" || !data.rates) {
      console.error("FX rate fetch failed:", JSON.stringify(data));
      return new Response(JSON.stringify({ error: "Couldn't fetch live exchange rates right now." }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Only the auto-enabled currencies are touched — spreading the
    // existing fx_rates first means a currency left on manual (or one
    // this provider doesn't return a usable rate for) keeps exactly
    // what was already there.
    const currentRates = (settings?.fx_rates && typeof settings.fx_rates === "object")
      ? settings.fx_rates as Record<string, number>
      : {};
    const nextRates = { ...currentRates };
    const updated: string[] = [];
    for (const code of autoCurrencies) {
      const rate = data.rates[code];
      if (typeof rate === "number" && rate > 0) {
        // Same 4dp precision the admin's own manual input already uses
        // (step="0.0001" on fxRateCadInput/fxRateUsdInput/fxRateNgnInput).
        nextRates[code] = Math.round(rate * 10000) / 10000;
        updated.push(code);
      }
    }

    await db.from("pricing_settings").update({
      fx_rates: nextRates,
      fx_rates_fetched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", true);

    return new Response(JSON.stringify({ ok: true, updated }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("update-fx-rates failed:", err);
    const message = err instanceof Error ? err.message : "Couldn't reach the exchange rate provider.";
    return new Response(JSON.stringify({ error: message }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
