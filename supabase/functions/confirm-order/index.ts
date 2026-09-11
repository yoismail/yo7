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

  // Idempotent: if this order already exists (the webhook got there
  // first, or this is a retried request after a dropped response),
  // return it as-is rather than trying to create it again. Checked
  // before touching Stripe at all — cheaper, and this is the common
  // case on a retry.
  async function existingOrder() {
    return await db.from("orders").select("id, order_number").eq("stripe_payment_intent_id", paymentIntentId).maybeSingle();
  }
  const { data: already } = await existingOrder();
  if (already) {
    return new Response(JSON.stringify({ ok: true, orderNumber: already.order_number }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let paymentIntent: Stripe.PaymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
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

  const { data: pending, error: pendingError } = await db
    .from("pending_checkouts")
    .select("*")
    .eq("payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (pendingError) {
    console.error("Looking up pending_checkouts failed:", pendingError.message);
    return new Response(JSON.stringify({ error: "Something went wrong finishing your order, please try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (!pending) {
    // The webhook may have already consumed and deleted this row between
    // the existingOrder() check above and now — re-check once more
    // before giving up, since that's the common honest reason this
    // happens, not tampering.
    const { data: raceOrder } = await existingOrder();
    if (raceOrder) {
      return new Response(JSON.stringify({ ok: true, orderNumber: raceOrder.order_number }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    // Genuinely nothing to build an order from — the rare, documented,
    // best-effort gap (see create-payment-intent's own comment on this
    // insert): the payment definitely succeeded, but this safety net
    // can't reconstruct the order's actual contents from nothing. Not
    // something retrying this same request will fix.
    console.error(`confirm-order: no pending_checkouts row for ${paymentIntentId}, nothing to build an order from.`);
    return new Response(JSON.stringify({
      error: "Your payment went through, but we need a moment to finish setting up your order. Please contact us on WhatsApp or at hello@yo7foods.co.uk with this reference: " + paymentIntentId,
    }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const { data: order, error: orderError } = await db.from("orders").insert({
    user_id: pending.user_id,
    status: "placed",
    fulfilment_method: pending.fulfilment_method,
    items: pending.items,
    subtotal: pending.subtotal,
    delivery_fee: pending.delivery_fee,
    discount: pending.discount,
    total: pending.total,
    delivery_name: pending.delivery_name,
    delivery_address: pending.delivery_address,
    delivery_postcode: pending.delivery_postcode,
    delivery_phone: pending.delivery_phone,
    notes: pending.notes,
    stripe_payment_intent_id: paymentIntentId,
    payment_method_summary: "Paid online",
    discount_id: pending.discount_id,
    discount_code: pending.discount_code,
  }).select("id, order_number").single();

  if (orderError) {
    if (orderError.code === "23505") {
      // Lost a race with the webhook between the checks above and this
      // insert — vanishingly unlikely, but the same safe no-op either
      // path already handles.
      const { data: raceOrder } = await existingOrder();
      await db.from("pending_checkouts").delete().eq("payment_intent_id", paymentIntentId);
      return new Response(JSON.stringify({ ok: true, orderNumber: raceOrder?.order_number }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    console.error("Order insert failed:", orderError.message);
    return new Response(JSON.stringify({ error: "Something went wrong finishing your order, please try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Best-effort, same as everything else here that isn't the charge or
  // the order itself: a failure decrementing stock should never make an
  // already-paid order look like it failed to the customer.
  if (Array.isArray(pending.stock_lines) && pending.stock_lines.length > 0) {
    const { error: stockError } = await db.rpc("decrement_stock", { p_lines: pending.stock_lines });
    if (stockError) console.error("decrement_stock failed (non-fatal):", stockError.message);
  }

  // Order-confirmation email, admin new-order alert, and discount-
  // redemption tracking all fire automatically from the existing AFTER
  // INSERT trigger on orders — nothing else to do for those. Loyalty-
  // reward issuance is still a client-only nicety (issueLoyaltyRewardIfEarned
  // needs the caller's own auth context), called by index.html right
  // after this function returns success, same as before.
  await db.from("pending_checkouts").delete().eq("payment_intent_id", paymentIntentId);

  return new Response(JSON.stringify({ ok: true, orderNumber: order.order_number }), {
    status: 200, headers: { ...cors, "Content-Type": "application/json" },
  });
});
