// Yo7 Foods: Supabase Edge Function: update-push-preferences
//
// THE PROBLEM THIS SOLVES: the #/notifications page's category toggles
// (Order Updates / Announcements / Offers) need to update an EXISTING
// push_subscriptions row's notify_* columns, for every caller, not just
// an anonymous one. push_subscriptions' anon RLS policy is INSERT-only
// on purpose (see that policy's own comment in schema.sql): granting
// UPDATE would also require granting SELECT, which would let any
// anonymous client read every other anonymous subscriber's endpoint/
// p256dh/auth_key. A signed-in customer's own existing RLS (auth.uid()
// = user_id) looks like it should cover UPDATE directly instead - but a
// subscription first created before that device ever signed in still
// has user_id = NULL forever (nothing else ever migrates it), so a
// direct update from a now-signed-in session silently touches zero rows
// (RLS just excludes it, no error) instead of actually changing
// anything. This function is the one, narrow, service-role-backed door
// around both cases: it updates exactly one row, matched by its exact
// endpoint (an unguessable secret only the owning browser knows, same
// trust model the rest of this feature already uses), claims an
// ownerless row for a signed-in caller as part of that same update
// (so this stops being a problem on this device after the very first
// successful call), and never returns any row data back to the caller.
//
// Deploy with the Supabase CLI from the project root:
//   supabase functions deploy update-push-preferences
// (JWT verification stays ON, the default, unlike send-push/
// verify-email-domain, this IS called by a real browser, signed in or
// not, and Supabase already accepts the anon key's own token for that.)
//
// No extra secrets needed beyond what Supabase injects automatically
// (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).

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

// Same allowlist/reasoning as send-push's own isAllowedPushEndpoint,
// not a security boundary here (this function never fetches the
// endpoint itself), just a cheap, correct sanity check that what's
// being matched against really is a push-service URL, not junk.
const ALLOWED_PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge, other Chromium browsers
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari
];
function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed." }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!endpoint || !isAllowedPushEndpoint(endpoint)) {
    return new Response(JSON.stringify({ error: "Invalid endpoint." }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const update: Record<string, boolean> = {};
  if (typeof body.notify_orders === "boolean") update.notify_orders = body.notify_orders;
  if (typeof body.notify_announcements === "boolean") update.notify_announcements = body.notify_announcements;
  if (typeof body.notify_offers === "boolean") update.notify_offers = body.notify_offers;
  if (Object.keys(update).length === 0) {
    return new Response(JSON.stringify({ error: "Nothing to update." }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Carries the caller's own token so auth.getUser() tells us who's
  // actually asking, can't read anything RLS wouldn't already let this
  // user read.
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  // Bypasses RLS entirely, the only way this can reach an anonymous
  // (user_id IS NULL) row at all, since that row's own RLS grants anon
  // nothing past INSERT. Never exposed to the client.
  const db = createClient(supabaseUrl, serviceRoleKey);

  const { data: row, error: lookupError } = await db
    .from("push_subscriptions")
    .select("user_id")
    .eq("endpoint", endpoint)
    .maybeSingle();
  if (lookupError || !row) {
    return new Response(JSON.stringify({ error: "Subscription not found." }), {
      status: 404,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // A row tied to a signed-in account can only be changed by that same
  // account - the endpoint-as-secret trust model is what protects an
  // anonymous row (there's no account to check it against), but an
  // authenticated one gets this extra check for free since a session is
  // right there to verify. Fetched regardless of row.user_id, not just
  // when it's set, since an authenticated caller is also how an
  // ownerless row gets claimed below.
  const { data: userData } = await authClient.auth.getUser();
  const callerId = userData?.user?.id ?? null;
  if (row.user_id && callerId !== row.user_id) {
    return new Response(JSON.stringify({ error: "Not authorized to change this subscription." }), {
      status: 403,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const updatePayload: Record<string, boolean | string> = { ...update };
  if (!row.user_id && callerId) {
    // This subscription predates being signed in on this device -
    // link it to the account that's signed in here now, the same way a
    // fresh subscribe already would (src/index.html's
    // saveNewPushSubscriptionRow()). From here on, a direct supabase-js
    // read/update from that account (RLS: auth.uid() = user_id) starts
    // working for this row too, not just this function.
    updatePayload.user_id = callerId;
  }

  const { error: updateError } = await db.from("push_subscriptions").update(updatePayload).eq("endpoint", endpoint);
  if (updateError) {
    console.error("update-push-preferences: update failed:", updateError.message);
    return new Response(JSON.stringify({ error: "Could not save your preferences." }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
