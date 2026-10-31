// Shared, pure delivery-pricing logic used by every edge function that
// needs to turn a cart's total weight into a delivery fee tier.
//
// Deliberately has no Stripe/Supabase imports and touches no I/O. The
// whole point is that this can be unit-tested with `deno test` against
// plain objects, no live network access needed, see delivery.test.ts
// alongside this file. create-payment-intent is the only edge function
// that currently calls resolveWeightTierFee(), but the bug this file
// exists to prevent (see safeWeight's own comment) could just as easily
// have been introduced in a second call site, so this stays its own
// shared, tested module rather than living inline in that one function.

export interface WeightTier {
  // Infinity for the top/catch-all tier (no upper bound), the same
  // convention create-payment-intent already uses after mapping a null
  // maxWeight out of pricing_settings.
  maxWeight: number;
  fee: number;
}

// Every client-side weight read in index.html guards with
// `typeof x.weight === "number"` before trusting it, treating anything
// else as unweighed (0kg), see cartTotalWeight() there. This is the
// server-side equivalent of that same guard, and the fix for a real bug:
// without it, a single malformed weight value (a stray non-numeric
// string, Infinity) silently turns a sum into NaN, and `NaN <= x` is
// false for every comparison, so a tier lookup keyed off it falls
// through to the LAST (most expensive) tier instead of the correct one.
// A customer was quoted a low weight-tier delivery fee and then charged
// the top tier at payment because of exactly this.
export function safeWeight(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

// `tiers` is assumed sorted ascending by maxWeight (pricing_settings
// already stores it that way, and create-payment-intent's own fallback
// default array is written in that order), this does not re-sort, a
// caller whose tiers aren't already ascending will get a wrong answer
// from `.find()` short-circuiting on the first match, not a crash, so
// that assumption is worth keeping in mind if this is ever reused
// against a different data source.
export function resolveWeightTierFee(weight: unknown, tiers: WeightTier[]): number {
  const safe = safeWeight(weight);
  const tier = tiers.find((t) => safe <= t.maxWeight) ?? tiers[tiers.length - 1];
  return tier.fee;
}
