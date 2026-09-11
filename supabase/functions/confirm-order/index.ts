// Yo7 Foods — Supabase Edge Function: confirm-order
//
// THE PROBLEM THIS SOLVES: until now, the browser itself inserted the
// `orders` row straight after Stripe confirmed a charge
// (finishOrderAfterPayment() in index.html), using the Supabase client
// SDK directly. The `orders` INSERT RLS policy only ever checked that
// `auth.uid() = user_id` — nothing tied the items/total actually written
// to what was actually charged. A customer's own browser (devtools,
// intercepted request, anything) could insert a real, believable-looking
// order with a different item list or total than whatever Stripe
// actually processed, and nothing would catch it.
//
// This function replaces that insert. The client now sends only a
// paymentIntentId — no items, no total, nothing pricing-related — and
// every actual field comes from here: Stripe's own record of the
// PaymentIntent (confirming it really succeeded, and that it belongs to
// the calling user, not someone else's payment) plus pending_checkouts
// (written by create-payment-intent using its own server-verified totals
// the moment the PaymentIntent was created). The orders table's INSERT
// policy for regular users is dropped entirely by the same migration
// that adds this function — from here on, only the service role (this
// function, and stripe-webhook's own independent fallback path) can ever
// create an order.
//
// This is also where stock actually gets decremented — the one place
// that's definitely true both "this payment succeeded" and "these are
// the exact line items being charged for", via decrement_stock() using
// the same stock_lines create-payment-intent already worked out while
// pricing the cart.
//
// Deploy with the Supabase CLI from the project root — NOT
// --no-verify-jwt: this one is called by a logged-in customer's own
// browser right after their own payment succeeds, using their own
// session token, and needs Supabase's gateway to have already confirmed
// that token is real before this code even runs:
//   supabase functions deploy confirm-order
//
// Secrets it needs — same STRIPE_SECRET_KEY create-payment-intent
// already uses, nothing new to set. SUPABASE_URL, SUPABASE_ANON_KEY, and
// SUPABASE_SERVICE_ROLE_KEY are injected automatically by Supabase for
// every Edge Function.

import Stripe from "npm:stripe@17.5.0";
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

function getClientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? "unknown";
}

// Same fixed-window counter as create-payment-intent's own — see that
// function's comment for why this shape (backed by rate_limit_hits,
// self-pruning as a side effect).
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

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secretKey) {
    console.error("STRIPE_SECRET_KEY is not set.");
    return new Response(JSON.stringify({ error: "Payment isn't configured on the server yet." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const stripe = new Stripe(secretKey, { apiVersion: "2024-12-18.acacia" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Carries the caller's own token, so auth.getUser() tells us who's
  // actually asking — this is what lets the metadata check below refuse
  // to build an order from someone else's PaymentIntent.
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  // Bypasses RLS entirely — the only client capable of inserting into
  // orders at all now that the client-insert policy is gone.
  const db = createClient(supabaseUrl, serviceRoleKey);

  const clientIp = getClientIp(req);
  if (!(await checkRateLimit(db, `confirm-order:${clientIp}`, 20, 60))) {
    return new Response(JSON.stringify({ error: "Too many requests, please wait a moment and try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json", "Retry-After": "30" },
    });
  }

  const { data: userData } = await authClient.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) {
    return new Response(JSON.stringify({ error: "Please log in again and retry." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid request." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const paymentIntentId = typeof body.paymentIntentId === "string" ? body.paymentIntentId.trim() : "";
  if (!paymentIntentId) {
    return new Response(JSON.stringify({ error: "Missing paymentIntentId." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let paymentIntent: Stripe.PaymentIntent;
  try {
    // expand: payment_method is what makes the real "Visa •••• 4242" /
    // "Apple Pay" summary below possible in one round trip, instead of
    // the separate action:"summarize" call this function used to leave
    // the client to make on its own (whose result then went nowhere,
    // since the old insert-directly-from-the-client code never actually
    // read it back — that's the bug this replaces).
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method"] });
  } catch (err) {
    console.error("Stripe paymentIntents.retrieve failed:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Couldn't verify that payment right now, please try again in a moment." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (paymentIntent.status !== "succeeded") {
    return new Response(JSON.stringify({ error: "That payment hasn't actually succeeded yet." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  // Stops one signed-in user from confirming an order against a
  // PaymentIntent that isn't theirs — create-payment-intent stamps
  // yo7_user_id into metadata itself, server-side, at creation time, so
  // this can't be spoofed by the client.
  if (paymentIntent.metadata?.yo7_user_id !== userId) {
    console.error(`confirm-order: PaymentIntent ${paymentIntentId} metadata user (${paymentIntent.metadata?.yo7_user_id}) doesn't match caller (${userId}).`);
    return new Response(JSON.stringify({ error: "This payment doesn't belong to your account." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Same brand/wallet formatting create-payment-intent's own
  // action:"summarize" path already used.
  let paymentMethodSummary = "Paid online";
  const pm = paymentIntent.payment_method;
  if (pm && typeof pm === "object" && pm.type === "card" && pm.card) {
    const wallet = pm.card.wallet?.type;
    if (wallet === "apple_pay") paymentMethodSummary = "Apple Pay";
    else if (wallet === "google_pay") paymentMethodSummary = "Google Pay";
    else {
      const brand = pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1);
      paymentMethodSummary = `${brand} •••• ${pm.card.last4}`;
    }
  }

  // finalize_order_from_pending (see its own comment) does the actual
  // work — looks up pending_checkouts, inserts the order from it, and
  // decrements stock, all inside one advisory-locked transaction so
  // this and stripe-webhook's own independent fallback path can never
  // both reach the insert for the same payment (they still both call
  // this, they just can't race past the lock at the same time).
  const { data: result, error: finalizeError } = await db
    .rpc("finalize_order_from_pending", { p_payment_intent_id: paymentIntentId, p_payment_method_summary: paymentMethodSummary })
    .single();

  if (finalizeError) {
    console.error("finalize_order_from_pending failed:", finalizeError.message);
    return new Response(JSON.stringify({ error: "Something went wrong finishing your order, please try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (!result?.order_number) {
    // Genuinely nothing to build an order from — the rare, documented,
    // best-effort gap (see create-payment-intent's own comment on the
    // pending_checkouts insert): the payment definitely succeeded, but
    // this safety net can't reconstruct the order's actual contents
    // from nothing. Not something retrying this same request will fix.
    console.error(`confirm-order: nothing to build an order from for ${paymentIntentId}.`);
    return new Response(JSON.stringify({
      error: "Your payment went through, but we need a moment to finish setting up your order. Please contact us on WhatsApp or at hello@yo7foods.co.uk with this reference: " + paymentIntentId,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Order-confirmation email, admin new-order alert, and discount-
  // redemption tracking all fire automatically from the existing AFTER
  // INSERT trigger on orders — nothing else to do for those, and that
  // only fires once regardless of whether this call was the one that
  // actually inserted (is_new) or found an order already made by a
  // race with the webhook. Loyalty-reward issuance is still a
  // client-only nicety (issueLoyaltyRewardIfEarned needs the caller's
  // own auth context), called by index.html right after this function
  // returns success, same as before.
  return new Response(JSON.stringify({ ok: true, orderNumber: result.order_number, paymentMethodSummary }), {
    status: 200, headers: { ...cors, "Content-Type": "application/json" },
  });
});
