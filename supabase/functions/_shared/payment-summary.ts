// Shared, pure payment-method-summary formatting. Turns a Stripe
// PaymentMethod into the "Visa •••• 4242" / "Apple Pay" / "Google Pay"
// text a customer sees on their invoice.
//
// Deliberately takes a plain structural shape, not Stripe.PaymentMethod
// itself, so this file has no dependency on the Stripe SDK and can be
// unit-tested with `deno test` against plain mock objects, no real
// Stripe call needed, see payment-summary.test.ts alongside this file.
//
// confirm-order and stripe-webhook both need this (a customer's order
// can be finalized by either, see stripe-webhook's own header comment
// for why there are two paths at all), this used to be copy-pasted
// between them, and stripe-webhook's copy fell behind confirm-order's
// (skipped the wallet detection entirely, defaulting every order it
// finalized to the generic fallback below) exactly because it was two
// separate copies instead of one shared, tested function. A real Apple
// Pay order was charged correctly but showed "Paid online" on its
// invoice because it happened to be finalized by the webhook path.

export const PAYMENT_METHOD_FALLBACK_SUMMARY = "Paid online";

export interface CardPaymentMethodLike {
  type: string;
  card?: {
    brand: string;
    last4: string;
    wallet?: { type?: string | null } | null;
  } | null;
}

export function formatPaymentMethodSummary(pm: CardPaymentMethodLike | null | undefined): string {
  if (!pm || pm.type !== "card" || !pm.card) return PAYMENT_METHOD_FALLBACK_SUMMARY;
  const wallet = pm.card.wallet?.type;
  if (wallet === "apple_pay") return "Apple Pay";
  if (wallet === "google_pay") return "Google Pay";
  const brand = pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1);
  return `${brand} •••• ${pm.card.last4}`;
}
