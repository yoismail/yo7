// Yo7 Foods — Supabase Edge Function: stripe-webhook
//
// THE PROBLEM THIS SOLVES: every order has only ever been created by the
// customer's own browser, right after Stripe confirms a charge
// (finishOrderAfterPayment() in index.html). That's fine for the vast
// majority of checkouts, but it depends on the browser staying alive and
// connected for that one extra round trip after the money has already
// moved — a dropped connection, a killed background tab, a crashed
// mobile browser, right in that window, genuinely charges the customer
// with no order ever created, and nothing on the business side finds out
// unless the customer notices the charge themselves and emails support.
//
// This function is the fix: it listens directly to Stripe's own servers
// for "this PaymentIntent succeeded," completely independent of whatever
// happened to the customer's browser. Stripe retries webhook delivery on
// its own if this endpoint is ever briefly down, which is far more
// durable than anything client-side can be.
//
// pending_checkouts (migration 33) is what bridges the gap: it's written
// by create-payment-intent the moment a PaymentIntent is created, using
// that function's own server-verified totals — this function reads it
// back by payment_intent_id and builds the real order from it. Idempotent
// against orders_stripe_payment_intent_id_key (migration 16): if the
// client's own fast path already created this order, this insert just
// hits a unique-violation and no-ops, exactly the same handling
// finishOrderAfterPayment() itself already uses for the reverse case.
// Whichever path gets there first wins; the other is always a safe no-op.
//
// Deploy with the Supabase CLI from the project root. --no-verify-jwt is
// required here specifically: Stripe's own servers call this endpoint
// with a "Stripe-Signature" header, not a Supabase JWT, so Supabase's own
// gateway would reject every real delivery before this code ever runs.
// The signature check below (using STRIPE_WEBHOOK_SECRET) is what
// actually verifies a request is genuinely from Stripe — it is not
// optional, and without it this endpoint would accept a forged
// "payment succeeded" event from anyone who found the URL:
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Secrets it needs:
//   supabase secrets set STRIPE_SECRET_KEY=sk_test_...     (same one create-payment-intent already uses)
//   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...   (from the Stripe Dashboard once the endpoint below is added)
//
// Then in the Stripe Dashboard: Developers -> Webhooks -> Add endpoint
//   URL: https://<project-ref>.supabase.co/functions/v1/stripe-webhook
//   Events to send: payment_intent.succeeded
// Copy the "Signing secret" shown after creating it into
// STRIPE_WEBHOOK_SECRET above.
//
// See supabase-payment-setup-guide.md for the full walkthrough.

import Stripe from "npm:stripe@17.5.0";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secretKey || !webhookSecret) {
    console.error("STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set — see this function's own header comment.");
    // 500 here is deliberate (unlike create-payment-intent's always-200
    // convention) — there is no browser waiting on `data.error` for this
    // endpoint, only Stripe's own retry logic, which is exactly what
    // should see this as a real failure and try again later.
    return new Response("Webhook not configured", { status: 500 });
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2024-12-18.acacia" });

  // Signature verification needs the RAW request body, byte for byte —
  // parsing it as JSON first (even to re-stringify) can change
  // whitespace/key order enough to break the signature check. Read it as
  // text exactly once, before anything else touches the request.
  const rawBody = await req.text();
  const signature = req.headers.get("Stripe-Signature");
  if (!signature) {
    return new Response("Missing Stripe-Signature header", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    // constructEventAsync (not the sync constructEvent) — Deno's runtime
    // doesn't have Node's synchronous crypto primitives Stripe's default
    // verifier expects, this is Stripe's own documented variant for
    // edge/worker runtimes.
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err instanceof Error ? err.message : err);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type !== "payment_intent.succeeded") {
    // Only subscribed to this one event type in the Dashboard, but
    // acknowledging anything else with 200 rather than erroring is the
    // documented-safe default if the subscription list ever changes.
    return new Response(JSON.stringify({ received: true, skipped: event.type }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supabaseUrl, serviceRoleKey);

  // Cheap, opportunistic cleanup of old abandoned rows — same pattern as
  // prune_rate_limit_hits, no separate cron needed for a table this small.
  db.rpc("prune_pending_checkouts").then(({ error }) => {
    if (error) console.error("prune_pending_checkouts failed (non-fatal):", error.message);
  });

  // finalize_order_from_pending (see its own comment, added alongside
  // decrement_stock) does the actual lookup-and-insert, inside an
  // advisory-locked transaction keyed to this payment — that's what
  // stops this fallback path and confirm-order's own (much more common)
  // fast path from ever both reaching the insert for the same order,
  // which used to burn two order_number sequence values every time they
  // raced (the loser's insert still fired the number-assigning trigger
  // before hitting the unique-constraint rejection). No payment_method
  // expansion here the way confirm-order does for its nicer "Visa ••••
  // 4242"-style summary — keeping this fallback path's one Stripe call
  // (already spent verifying the signature) rather than adding a second
  // one for a path that, by design, only actually fires rarely.
  const { data: result, error: finalizeError } = await db
    .rpc("finalize_order_from_pending", { p_payment_intent_id: paymentIntent.id })
    .single();

  if (finalizeError) {
    console.error("finalize_order_from_pending failed:", finalizeError.message);
    return new Response("Order finalize failed", { status: 500 }); // 500 so Stripe retries
  }
  if (!result?.order_number) {
    // Two honest possibilities: create-payment-intent's own
    // pending_checkouts insert never happened in the first place (it
    // logs but doesn't fail the payment if that insert itself fails —
    // see its own comment), or this really is an order this safety net
    // can't reconstruct. Either way there's nothing here to build an
    // order from, and this is not something retrying will fix.
    return new Response(JSON.stringify({ received: true, note: "no pending_checkouts row, nothing to reconstruct" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Order-confirmation email, admin new-order alert, and discount-
  // redemption tracking all fire automatically from the existing AFTER
  // INSERT trigger on orders — nothing else to do for those, and that
  // only fires once regardless of whether this call was the one that
  // actually inserted or found an order already made by a race with
  // confirm-order. Loyalty-reward issuance is NOT duplicated here on
  // purpose: it's a client-only nicety today (issueLoyaltyRewardIfEarned
  // relies on the caller's own auth context, which a webhook doesn't
  // have), so in the rare case this fallback path is what actually
  // saves an order, that one order's loyalty reward (if any) may need a
  // manual top-up — a real but minor, recoverable gap, not an order
  // silently lost.
  return new Response(JSON.stringify({ received: true, orderCreated: result.is_new, orderNumber: result.order_number }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
