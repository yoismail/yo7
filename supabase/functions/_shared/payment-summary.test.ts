// Run with: deno test supabase/functions/_shared/payment-summary.test.ts
// (or `deno test supabase/functions/_shared/` to run every test in this
// folder together). No network access or live Stripe needed, plain mock
// objects shaped like Stripe.PaymentMethod, see payment-summary.ts's own
// header comment for why this is a shared, tested module at all.

import { assertEquals } from "jsr:@std/assert@1";
import { formatPaymentMethodSummary, PAYMENT_METHOD_FALLBACK_SUMMARY } from "./payment-summary.ts";

Deno.test("formatPaymentMethodSummary recognizes Apple Pay", () => {
  const pm = { type: "card", card: { brand: "visa", last4: "4242", wallet: { type: "apple_pay" } } };
  assertEquals(formatPaymentMethodSummary(pm), "Apple Pay");
});

Deno.test("formatPaymentMethodSummary recognizes Google Pay", () => {
  const pm = { type: "card", card: { brand: "mastercard", last4: "1234", wallet: { type: "google_pay" } } };
  assertEquals(formatPaymentMethodSummary(pm), "Google Pay");
});

Deno.test("formatPaymentMethodSummary formats a plain card as 'Brand •••• 1234'", () => {
  const pm = { type: "card", card: { brand: "visa", last4: "4242" } };
  assertEquals(formatPaymentMethodSummary(pm), "Visa •••• 4242");
});

Deno.test("formatPaymentMethodSummary capitalizes the brand (Stripe sends it lowercase)", () => {
  const pm = { type: "card", card: { brand: "mastercard", last4: "0005" } };
  assertEquals(formatPaymentMethodSummary(pm), "Mastercard •••• 0005");
});

Deno.test("formatPaymentMethodSummary treats a wallet type that's neither Apple nor Google Pay as a plain card", () => {
  // e.g. Stripe's "link" or any future wallet type this code doesn't
  // special-case yet, should still fall through to the brand/last4
  // format rather than silently dropping the wallet info.
  const pm = { type: "card", card: { brand: "visa", last4: "4242", wallet: { type: "link" } } };
  assertEquals(formatPaymentMethodSummary(pm), "Visa •••• 4242");
});

Deno.test("formatPaymentMethodSummary falls back to the generic summary for null/undefined", () => {
  assertEquals(formatPaymentMethodSummary(null), PAYMENT_METHOD_FALLBACK_SUMMARY);
  assertEquals(formatPaymentMethodSummary(undefined), PAYMENT_METHOD_FALLBACK_SUMMARY);
});

Deno.test("formatPaymentMethodSummary falls back to the generic summary for a non-card payment method", () => {
  const pm = { type: "paypal" };
  assertEquals(formatPaymentMethodSummary(pm), PAYMENT_METHOD_FALLBACK_SUMMARY);
});

Deno.test("formatPaymentMethodSummary falls back to the generic summary when type is 'card' but .card is missing", () => {
  // Shouldn't happen from a real Stripe response, but the fallback must
  // still be safe (not throw) if it ever does.
  const pm = { type: "card" };
  assertEquals(formatPaymentMethodSummary(pm), PAYMENT_METHOD_FALLBACK_SUMMARY);
});
