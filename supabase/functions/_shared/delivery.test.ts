// Run with: deno test supabase/functions/_shared/delivery.test.ts
// (or `deno test supabase/functions/_shared/` to run every test in this
// folder together). No network access or live Supabase/Stripe needed,
// that's the whole point, see delivery.ts's own header comment.

import { assertEquals } from "jsr:@std/assert@1";
import { resolveWeightTierFee, safeWeight, type WeightTier } from "./delivery.ts";

// Same shape and values as create-payment-intent's own fallback default
// (and index.html's deliveryWeightTiers default), not the live
// admin-configured numbers, just a realistic three-tier ladder to exercise
// the boundary logic against.
const TIERS: WeightTier[] = [
  { maxWeight: 10, fee: 7.99 },
  { maxWeight: 20, fee: 11.99 },
  { maxWeight: Infinity, fee: 15.99 },
];

Deno.test("safeWeight passes through valid finite numbers unchanged", () => {
  assertEquals(safeWeight(0), 0);
  assertEquals(safeWeight(0.5), 0.5);
  assertEquals(safeWeight(15), 15);
  assertEquals(safeWeight(1000), 1000);
});

Deno.test("safeWeight treats non-numeric input as unweighed (0)", () => {
  assertEquals(safeWeight("0.5kg"), 0);
  assertEquals(safeWeight("0.5"), 0); // even a numeric-looking string, still not typeof "number"
  assertEquals(safeWeight(null), 0);
  assertEquals(safeWeight(undefined), 0);
  assertEquals(safeWeight({}), 0);
  assertEquals(safeWeight([]), 0);
  assertEquals(safeWeight(true), 0);
});

Deno.test("safeWeight treats non-finite numbers as unweighed (0)", () => {
  assertEquals(safeWeight(NaN), 0);
  assertEquals(safeWeight(Infinity), 0);
  assertEquals(safeWeight(-Infinity), 0);
});

Deno.test("resolveWeightTierFee picks the right tier well inside its range", () => {
  assertEquals(resolveWeightTierFee(1.5, TIERS), 7.99);
  assertEquals(resolveWeightTierFee(15, TIERS), 11.99);
  assertEquals(resolveWeightTierFee(50, TIERS), 15.99);
});

Deno.test("resolveWeightTierFee is inclusive right at a tier boundary", () => {
  assertEquals(resolveWeightTierFee(10, TIERS), 7.99);
  assertEquals(resolveWeightTierFee(20, TIERS), 11.99);
});

Deno.test("resolveWeightTierFee moves to the next tier just past a boundary", () => {
  assertEquals(resolveWeightTierFee(10.01, TIERS), 11.99);
  assertEquals(resolveWeightTierFee(20.01, TIERS), 15.99);
});

Deno.test("resolveWeightTierFee treats unweighed (0/null/undefined) as the lowest tier", () => {
  assertEquals(resolveWeightTierFee(0, TIERS), 7.99);
  assertEquals(resolveWeightTierFee(null, TIERS), 7.99);
  assertEquals(resolveWeightTierFee(undefined, TIERS), 7.99);
});

// This is the actual regression test for the bug a real customer hit:
// quoted a low weight-tier delivery fee, then charged the top tier at
// payment. Root cause was a malformed weight value silently becoming NaN
// server-side, and NaN <= t.maxWeight being false for every tier, falling
// through to the last (most expensive) one instead of the correct, much
// cheaper tier a sensible (effectively unweighed) total should resolve
// to. Before the fix, every assertion below would have returned 15.99
// (TIERS[2].fee, the catch-all fallback) instead of 7.99.
Deno.test("resolveWeightTierFee: a malformed weight resolves to the LOWEST tier, not the highest", () => {
  assertEquals(resolveWeightTierFee("0.5kg", TIERS), 7.99);
  assertEquals(resolveWeightTierFee(NaN, TIERS), 7.99);
  assertEquals(resolveWeightTierFee(Infinity, TIERS), 7.99);
  assertEquals(resolveWeightTierFee({}, TIERS), 7.99);
});

Deno.test("resolveWeightTierFee falls back to the last tier if none match (single-tier edge case)", () => {
  assertEquals(resolveWeightTierFee(999, [{ maxWeight: 5, fee: 4.99 }]), 4.99);
});

// This is the actual regression test for a second real bug (separate
// from the malformed-weight one above): a customer with a cart well
// under 20kg was quoted the correct, cheap fee on the cart step, then
// charged the top tier's fee at payment. pricing_settings.delivery_
// weight_tiers is admin-editable, and the admin UI's "add weight tier"
// form appends to the end of the array no matter its maxWeight, so the
// stored array isn't guaranteed to already be ascending by maxWeight.
// Here, a new, cheaper 5kg tier was added after the original three,
// so the catch-all (Infinity) tier sits earlier in the array than it.
// Before the fix, `.find()` matched that catch-all first for every
// weight, including ones that should have hit the new, cheaper tier.
Deno.test("resolveWeightTierFee resolves correctly even when tiers aren't stored in ascending order", () => {
  const outOfOrderTiers: WeightTier[] = [
    { maxWeight: 10, fee: 7.99 },
    { maxWeight: 20, fee: 11.99 },
    { maxWeight: Infinity, fee: 15.99 },
    { maxWeight: 5, fee: 5.99 }, // admin-added afterwards, appended to the end
  ];
  assertEquals(resolveWeightTierFee(2, outOfOrderTiers), 5.99);
  assertEquals(resolveWeightTierFee(5, outOfOrderTiers), 5.99);
  assertEquals(resolveWeightTierFee(7, outOfOrderTiers), 7.99);
  assertEquals(resolveWeightTierFee(15, outOfOrderTiers), 11.99);
  assertEquals(resolveWeightTierFee(50, outOfOrderTiers), 15.99);
});
