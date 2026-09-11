// Yo7 Foods — Supabase Edge Function: create-payment-intent
//
// Creating a Stripe PaymentIntent has to happen with the secret key, and
// the secret key must never be shipped to a browser — that's the one
// piece of real payment that cannot live in the site's own client-side
// code. This function does that small server-side step, using the
// publishable key's counterpart (STRIPE_SECRET_KEY), which only ever
// lives in Supabase's own function secrets.
//
// It does a second job now too: it's the only place that computes the
// amount actually charged. Every previous version of this function
// trusted a client-submitted `amount` outright, checking only that it
// was a plausible positive number — since the whole product catalogue,
// every discount code, and every delivery rule lived purely as
// JavaScript in the page, a request could be edited in dev tools to
// charge far less than the real basket total. This version takes the
// cart's actual line items instead and recomputes the trusted total
// itself, from a real products table and a real discount_codes table,
// ignoring whatever the client claims the total should be.
//
// automatic_payment_methods lets Stripe decide what to actually offer
// (card, Apple Pay, Google Pay, etc.) based on the customer's browser
// and what's enabled in the Stripe Dashboard — the client mounts one
// Payment Element and gets all of it for free, no separate integration
// per payment method.
//
// A cart item's id can carry extra "::"-separated segments beyond
// "<catSlug>::<idx>" — a weight-variant's own label, a "::subN"
// subscription marker, or both — parseProductCartId() below is what
// pulls the real product back out of that; this replaces the previous
// strict "<catSlug>::<idx>" only regex, which meant every weight-variant
// or subscribed line item got rejected outright as an "unrecognised
// cart item" and failed the whole checkout with a non-2xx response.
//
// Every response this function ever sends — success or failure, for any
// reason — uses HTTP status 200, with { error: "..." } or { ok: false,
// error: "..." } in the body when something's actually wrong. This is
// deliberate, not an oversight: the Supabase JS client's
// functions.invoke() only hands the parsed response body back as `data`
// when the HTTP status is 2xx — on a non-2xx status, `data` comes back
// null and the caller only ever sees a generic transport-level message
// ("Edge Function returned a non-2xx status code"), with the real,
// specific reason this function actually generated (like "Unknown
// product: flour::4") silently discarded. That happened for real, twice,
// both times looking like a mystery to debug from a screenshot alone
// instead of a message that just said what was wrong. index.html's own
// checkout code already reads `data.error` first before falling back to
// a generic message — this is the other half of that contract: every
// error this function can produce needs to actually reach `data` to be
// shown. If you're adding a new failure path here, give it a real
// `error` string in the body and status: 200, not a "more correct" 4xx/
// 5xx that quietly throws the reason away.
//
// Deploy with the Supabase CLI from the project root:
//   supabase functions deploy create-payment-intent
//
// Secrets it needs — STRIPE_SECRET_KEY is the only one you set yourself
// (test key to start, per your test-mode plan):
//   supabase secrets set STRIPE_SECRET_KEY=sk_test_...
// SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are
// injected automatically by Supabase for every Edge Function, nothing
// to set for those.
//
// See supabase-payment-setup-guide.md for the full walkthrough.

import Stripe from "npm:stripe@17.5.0";
import { createClient } from "npm:@supabase/supabase-js@2";

// Swap for your real domain once this is live — restricting the
// allowed origin means this function can only ever be called from
// the actual site, not from a random page that copied the URL.
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

// ============================================================
// Bundle/combo item lists (which products, at what discount) are still
// content, not a setting — those stay fixed here. The discount PERCENTAGES
// below are just fallback defaults though: pricing_settings (see
// supabase-migration-21-pricing-settings.sql) is the real, live source
// for those, along with delivery weight tiers and the subscribe-and-save
// percentage, fetched fresh at the top of every request by
// loadPricingSettings() below and applied on top of these defaults. That
// migration is what turned these from permanently-hardcoded into
// something an admin's own edits actually reach a real customer through.
let SUBSCRIPTION_DISCOUNT_PCT = 10;
let DELIVERY_WEIGHT_TIERS: { maxWeight: number; fee: number }[] = [
  { maxWeight: 10, fee: 7.99 },
  { maxWeight: 20, fee: 11.99 },
  { maxWeight: Infinity, fee: 15.99 },
];
type ThresholdRule = { conditionType: "price" | "weight" | "items"; operator: "gte" | "lte"; value: number; effect: "free" | "fixed"; feeOverride?: number };
let DELIVERY_THRESHOLD_RULES: ThresholdRule[] = [
  { conditionType: "price", operator: "gte", value: 50, effect: "free" },
];
type BundleDef = { name: string; discountPercent: number; items: { catSlug: string; idx: number }[] };
const BUNDLES: BundleDef[] = [
  { name: "Classic Jollof Night", discountPercent: 10, items: [{ catSlug: "rice", idx: 1 }, { catSlug: "oils", idx: 2 }, { catSlug: "condiments", idx: 0 }, { catSlug: "seasoning", idx: 0 }] },
  { name: "Sunday Stew Pot", discountPercent: 10, items: [{ catSlug: "meat", idx: 0 }, { catSlug: "seasoning", idx: 2 }, { catSlug: "condiments", idx: 1 }, { catSlug: "oils", idx: 1 }] },
  { name: "Beans & Sauce", discountPercent: 5, items: [{ catSlug: "beans", idx: 0 }, { catSlug: "oils", idx: 0 }, { catSlug: "seasoning", idx: 1 }] },
];
const COMBOS: BundleDef[] = [
  { name: "Rice Night Combo", discountPercent: 8, items: [{ catSlug: "rice", idx: 1 }, { catSlug: "oils", idx: 2 }, { catSlug: "condiments", idx: 0 }] },
  { name: "Suya Night Combo", discountPercent: 8, items: [{ catSlug: "meat", idx: 2 }, { catSlug: "seasoning", idx: 3 }] },
  { name: "Soup Pot Combo", discountPercent: 10, items: [{ catSlug: "meat", idx: 0 }, { catSlug: "root-vegetables", idx: 0 }, { catSlug: "seasoning", idx: 2 }] },
  { name: "Snack Attack Combo", discountPercent: 5, items: [{ catSlug: "snacks-confectionary", idx: 0 }, { catSlug: "snacks-confectionary", idx: 1 }] },
  { name: "Fry-Up Combo", discountPercent: 5, items: [{ catSlug: "tropical-foods", idx: 0 }, { catSlug: "oils", idx: 1 }] },
];
// Deno Edge Function instances are reused across requests (a warm
// container serves many invocations), so this can't be a one-time
// module-load fetch — an admin's edit needs to show up on the very next
// request, not just the next cold start. Cheap enough to just do it
// every time: one extra indexed lookup on a single-row table.
async function loadPricingSettings(db: ReturnType<typeof createClient>) {
  const { data } = await db.from("pricing_settings").select("*").eq("id", true).maybeSingle();
  if (!data) return;
  if (Array.isArray(data.delivery_weight_tiers) && data.delivery_weight_tiers.length) {
    DELIVERY_WEIGHT_TIERS = data.delivery_weight_tiers.map((t: { maxWeight: number | null; fee: number }) => ({ maxWeight: t.maxWeight === null ? Infinity : t.maxWeight, fee: t.fee }));
  }
  if (Array.isArray(data.delivery_threshold_rules)) DELIVERY_THRESHOLD_RULES = data.delivery_threshold_rules;
  if (typeof data.subscription_discount_pct === "number") SUBSCRIPTION_DISCOUNT_PCT = data.subscription_discount_pct;
  const bundleDiscounts = data.bundle_discounts || {};
  BUNDLES.forEach((b, i) => { if (typeof bundleDiscounts[i] === "number") b.discountPercent = bundleDiscounts[i]; });
  const comboDiscounts = data.combo_discounts || {};
  COMBOS.forEach((c, i) => { if (typeof comboDiscounts[i] === "number") c.discountPercent = comboDiscounts[i]; });
}

type CartLineIn = { id: unknown; qty: unknown; isSubscription?: unknown };
type ProductRow = { cat_slug: string; idx: number; price: number; sale_price: number | null; stock: string; weight: number | null; stock_quantity?: number | null };
type WeightVariant = { label: string; price: number; weight?: number; salePrice?: number };
function effectiveVariantPrice(v: WeightVariant): number {
  return typeof v.salePrice === "number" && v.salePrice < v.price ? v.salePrice : v.price;
}
type OverrideRow = { product_key: string; price: number | null; sale_price: number | null; stock: string | null; weight: number | null; weight_variants: WeightVariant[] | null; stock_quantity?: number | null };

// A product-shaped cart id is "<catSlug>::<idx>" optionally followed by
// more "::"-separated segments — a weight-variant's own label
// (buildPdCartItem: id + '::' + variant.label) and/or a subscription
// marker (id + '::sub' + frequency), in either order, since a customer
// can subscribe to a specific weight option. This pulls out the base
// product key plus whichever trailing segment (if any) isn't the "subN"
// marker — that's the variant label to price against, when present.
function parseProductCartId(id: string): { baseKey: string; variantLabel: string | null } | null {
  const parts = id.split("::");
  if (parts.length < 2 || !/^[a-z0-9-]+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  let variantLabel: string | null = null;
  for (const seg of parts.slice(2)) {
    if (/^sub\d+$/.test(seg)) continue;
    variantLabel = seg;
  }
  return { baseKey: `${parts[0]}::${parts[1]}`, variantLabel };
}

function round2(n: number) { return Math.round(n * 100) / 100; }

// Supabase Edge Functions run behind Cloudflare, which sets its own
// header; x-forwarded-for is the fallback for other paths in. Neither is
// spoofable by the caller in a way that matters here — Cloudflare
// overwrites cf-connecting-ip itself, it isn't something a request can
// set to claim a different identity.
function getClientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? "unknown";
}

// A simple fixed-window counter backed by rate_limit_hits: count this
// bucket's rows within the window, reject if at/over the limit,
// otherwise record this request and let it through. Prunes old rows for
// the SAME bucket as a side effect, cheap and avoids needing a separate
// cron job to stop the table growing forever.
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

function rateLimitedResponse(cors: Record<string, string>) {
  return new Response(JSON.stringify({ error: "Too many requests, please wait a moment and try again." }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json", "Retry-After": "30" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secretKey) {
    console.error("STRIPE_SECRET_KEY is not set — run: supabase secrets set STRIPE_SECRET_KEY=sk_test_...");
    return new Response(JSON.stringify({ error: "Payment isn't configured on the server yet." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2024-12-18.acacia" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Two clients, two different jobs: this one carries the caller's own
  // token so auth.getUser() tells us who's actually asking (needed for
  // loyalty rewards and discount redemption limits) — it can't read
  // anything RLS wouldn't already let this user read.
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  // This one bypasses RLS entirely, it's what actually looks up trusted
  // prices, discount codes, and redemption history — never exposed to
  // the client, service-role key only ever lives in this function.
  const db = createClient(supabaseUrl, serviceRoleKey);

  // General flood guard, every action this function serves counts
  // against it — generous enough that a real checkout (a couple of
  // discount tries, one real charge, maybe a payment-summary lookup)
  // never comes close, but stops scripted hammering of an endpoint that
  // calls the real Stripe API.
  const clientIp = getClientIp(req);
  if (!(await checkRateLimit(db, `create-payment-intent:${clientIp}`, 40, 60))) {
    return rateLimitedResponse(cors);
  }
  // prune_rate_limit_hits (migration 22) has existed since rate limiting
  // was added, but nothing ever actually called it — this table has been
  // growing forever, one row per request, no cleanup. Pruned with low
  // probability rather than every call: this function runs on every cart
  // page/checkout-step load (much higher volume than actual orders), so
  // pruning on every single request would mean a needless extra write on
  // the hot path almost every time. ~2% of calls is enough to keep the
  // table from growing unbounded without adding real per-request cost.
  if (Math.random() < 0.02) {
    db.rpc("prune_rate_limit_hits").then(({ error }: { error: unknown }) => {
      if (error) console.error("prune_rate_limit_hits failed (non-fatal):", error);
    });
  }

  const { data: userData } = await authClient.auth.getUser();
  const userId = userData?.user?.id ?? null;

  // Second job this function does: once a payment's gone through, the
  // client only has a payment_method *id* (not brand/last4 — reading
  // that back requires the secret key too), so this is also how the
  // receipt/admin view gets something readable like "Visa •••• 4242"
  // instead of a raw Stripe id.
  if (body.action === "summarize") {
    const paymentIntentId = body.paymentIntentId;
    if (typeof paymentIntentId !== "string" || !paymentIntentId.startsWith("pi_")) {
      return new Response(JSON.stringify({ error: "Invalid payment intent id." }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method"] });
      const pm = pi.payment_method;
      let summary = "Paid online";
      if (pm && typeof pm === "object" && pm.type === "card" && pm.card) {
        const wallet = pm.card.wallet?.type;
        if (wallet === "apple_pay") summary = "Apple Pay";
        else if (wallet === "google_pay") summary = "Google Pay";
        else {
          const brand = pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1);
          summary = `${brand} •••• ${pm.card.last4}`;
        }
      }
      return new Response(JSON.stringify({ summary, status: pi.status }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Payment method summary lookup failed:", err);
      return new Response(JSON.stringify({ summary: "Paid online", status: "unknown" }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  // Only the two paths below (discount preview, real charge) need
  // pricing data at all — "summarize" already returned above without it.
  await loadPricingSettings(db);

  // ---- shared cart pricing, used by both "validate-discount" (a
  // live preview while typing a code) and the real charge below ----
  async function priceCart(items: CartLineIn[], discountCodeRaw: unknown) {
    const productKeys = new Set<string>();
    for (const it of items) {
      if (typeof it.id !== "string") continue;
      const parsed = parseProductCartId(it.id);
      if (parsed) productKeys.add(parsed.baseKey);
    }
    for (const b of [...BUNDLES, ...COMBOS]) {
      for (const ref of b.items) productKeys.add(`${ref.catSlug}::${ref.idx}`);
    }
    const catSlugs = [...new Set([...productKeys].map((k) => k.split("::")[0]))];

    const { data: productRows } = await db
      .from("products")
      .select("cat_slug, idx, price, sale_price, stock, weight")
      .in("cat_slug", catSlugs);
    // Admin-created products (the "Add a new product" form) never get a
    // row in the seeded `products` table above — they only ever exist
    // in custom_products, full details rather than a delta, same
    // (cat_slug, idx) identity as everything else. Without this, any
    // such product is invisible to this function entirely and the whole
    // cart gets rejected as "Unknown product" the moment one is added.
    const { data: customProductRows } = await db
      .from("custom_products")
      .select("cat_slug, idx, price, sale_price, stock, weight, stock_quantity")
      .in("cat_slug", catSlugs);
    const { data: overrideRows } = await db
      .from("product_overrides")
      .select("product_key, price, sale_price, stock, weight, weight_variants, stock_quantity")
      .in("product_key", [...productKeys]);

    const base = new Map<string, ProductRow>();
    (productRows ?? []).forEach((r: ProductRow) => base.set(`${r.cat_slug}::${r.idx}`, r));
    (customProductRows ?? []).forEach((r: ProductRow) => {
      const key = `${r.cat_slug}::${r.idx}`;
      if (!base.has(key)) base.set(key, r);
    });
    const overrides = new Map<string, OverrideRow>();
    (overrideRows ?? []).forEach((r: OverrideRow) => overrides.set(r.product_key, r));

    function trusted(key: string): { price: number; salePrice: number | null; stock: string; weight: number; stockQuantity: number | null } | null {
      const b = base.get(key);
      if (!b) return null;
      const o = overrides.get(key);
      const price = o?.price ?? b.price;
      const salePrice = o && o.sale_price !== undefined ? o.sale_price : b.sale_price;
      const stock = o?.stock ?? b.stock ?? "in";
      const weight = (o?.weight ?? b.weight) ?? 0;
      // An override's stock_quantity (even if explicitly null) wins over
      // the base row's, same layering as every other field here — an
      // admin can only ever set this via product_overrides/
      // custom_products directly, never via the seeded `products` table.
      const stockQuantity = (o?.stock_quantity ?? b.stock_quantity) ?? null;
      return { price, salePrice, stock, weight, stockQuantity };
    }
    function effective(t: { price: number; salePrice: number | null }): number {
      return t.salePrice !== null && t.salePrice < t.price ? t.salePrice : t.price;
    }

    type PricedLine = { unitPrice: number; qty: number; weight: number; catSlug: string | null; productId: string; stockKey?: string };
    const lines: PricedLine[] = [];
    let rejection: string | null = null;
    // Only standalone product lines participate — a bundle/combo's own
    // components already silently drop anything out of stock (line ~412
    // above) rather than reject the whole cart, and layering quantity
    // limits on top of that would mean the same underlying product
    // needs its stock checked once per bundle it appears in as well as
    // once on its own, which isn't worth the complexity for something
    // curated and comparatively low-volume. Standalone lines are where
    // someone can actually order 50 of one thing, which is the real risk.
    const requestedQtyByKey = new Map<string, number>();

    for (const it of items) {
      const qty = typeof it.qty === "number" && Number.isFinite(it.qty) && it.qty > 0 ? Math.floor(it.qty) : 0;
      if (qty <= 0 || typeof it.id !== "string") { rejection = "Invalid cart item."; break; }

      // Checked before the generic product pattern below on purpose:
      // "bundle::0" and "combo::0" both also match [a-z0-9-]+::\d+ (a
      // catalogue slug is allowed to be any lowercase-and-hyphen string),
      // so checking product-shaped ids first would swallow every bundle
      // and combo line item as an "unknown product" and reject the whole
      // cart.
      const bundleMatch = it.id.match(/^bundle::(\d+)$/);
      const comboMatch = it.id.match(/^combo::(\d+)$/);
      const defs = bundleMatch ? BUNDLES : comboMatch ? COMBOS : null;
      const idx = bundleMatch ? Number(bundleMatch[1]) : comboMatch ? Number(comboMatch[1]) : -1;
      if (defs) {
        if (!defs[idx]) { rejection = `Unknown bundle/combo: ${it.id}`; break; }
        const def = defs[idx];
        let rawTotal = 0;
        let weight = 0;
        for (const ref of def.items) {
          const key = `${ref.catSlug}::${ref.idx}`;
          const t = trusted(key);
          if (!t || t.stock === "out") continue; // matches addBundleToCart: out-of-stock items are left out, not charged
          rawTotal += effective(t);
          weight += t.weight;
        }
        const unitPrice = round2(rawTotal * (1 - def.discountPercent / 100));
        lines.push({ unitPrice, qty, weight: weight * qty, catSlug: null, productId: it.id });
        continue;
      }

      const parsed = parseProductCartId(it.id);
      if (parsed) {
        const t = trusted(parsed.baseKey);
        if (!t) { rejection = `Unknown product: ${it.id}`; break; }
        // Bundle/combo components already skip an out-of-stock item rather
        // than charge for it (see the `t.stock === "out"` check a few
        // lines up) — a standalone product line never had the matching
        // check, so a cart edited directly in dev tools (or just a stale
        // page open in a tab while an admin marks something out of stock)
        // could pay for an item nobody can actually fulfil. The client
        // already disables "Add to basket" for an out-of-stock product,
        // but that's a UI nicety, not enforcement — this is the real gate.
        if (t.stock === "out") { rejection = "One of the items in your basket just went out of stock, please remove it and try again."; break; }
        // Only rejects, never reserves — a genuinely simultaneous
        // checkout on the last unit by two different people can still
        // both pass this check; decrement_stock (called once payment is
        // actually confirmed, see confirm-order) is what closes that
        // last, much narrower race, by refusing to go below zero.
        if (t.stockQuantity !== null) {
          const requestedSoFar = (requestedQtyByKey.get(parsed.baseKey) ?? 0) + qty;
          requestedQtyByKey.set(parsed.baseKey, requestedSoFar);
          if (requestedSoFar > t.stockQuantity) {
            rejection = t.stockQuantity <= 0
              ? "One of the items in your basket just sold out, please remove it and try again."
              : `Only ${t.stockQuantity} of one item in your basket ${t.stockQuantity === 1 ? 'is' : 'are'} left in stock, please reduce the quantity.`;
            break;
          }
        }
        let unitPrice: number;
        let weight: number;
        if (parsed.variantLabel !== null) {
          const variants = overrides.get(parsed.baseKey)?.weight_variants ?? [];
          const v = variants.find((vv) => vv.label === parsed.variantLabel);
          if (!v) { rejection = `Unknown product variant: ${it.id}`; break; }
          unitPrice = effectiveVariantPrice(v);
          weight = typeof v.weight === "number" ? v.weight : t.weight;
        } else {
          unitPrice = effective(t);
          weight = t.weight;
        }
        if (it.isSubscription === true) unitPrice = round2(unitPrice * (1 - SUBSCRIPTION_DISCOUNT_PCT / 100));
        lines.push({ unitPrice, qty, weight: weight * qty, catSlug: parsed.baseKey.split("::")[0], productId: it.id, stockKey: parsed.baseKey });
        continue;
      }

      rejection = `Unrecognised cart item: ${it.id}`;
      break;
    }

    if (rejection) return { ok: false as const, error: rejection };

    const subtotal = round2(lines.reduce((s, l) => s + l.unitPrice * l.qty, 0));
    const totalWeight = lines.reduce((s, l) => s + l.weight, 0);

    // ---- discount code ----
    let discountAmount = 0;
    let freeDelivery = false;
    let discountRow: { id: string; max_per_customer: number | null } | null = null;
    // Safe-to-expose shape of the matched code, for the client to keep
    // showing a live-updating discount amount as the cart changes without
    // a round trip on every quantity click — the real, final amount is
    // always recomputed here, server-side, at charge time regardless of
    // what this preview says.
    let discountDef: Record<string, unknown> | null = null;
    const discountCode = typeof discountCodeRaw === "string" ? discountCodeRaw.trim() : "";
    let discountError: string | null = null;
    if (discountCode) {
      const { data: d } = await db
        .from("discount_codes")
        .select("*")
        .ilike("code", discountCode)
        .maybeSingle();
      if (!d) discountError = "That code doesn't match any current discount.";
      else if (d.active === false) discountError = "That discount code is no longer active.";
      else {
        const today = new Date().toISOString().slice(0, 10);
        if (d.start_date && today < d.start_date) discountError = `That code isn't valid until ${d.start_date}.`;
        else if (d.end_date && today > d.end_date) discountError = "That discount code has expired.";
        else if (typeof d.min_order === "number" && subtotal < d.min_order) discountError = `This code needs a minimum order of £${d.min_order.toFixed(2)}.`;
        else {
          const qualifying = d.qualifying_scope === "category"
            ? lines.filter((l) => l.catSlug === d.qualifying_category)
            : d.qualifying_scope === "product"
            ? lines.filter((l) => l.productId.startsWith(d.qualifying_product_id ?? " "))
            : lines;
          if (qualifying.length === 0) discountError = "Your basket doesn't contain the items this code applies to.";
          else if (typeof d.max_per_customer === "number") {
            const { count } = await db
              .from("discount_redemptions")
              .select("id", { count: "exact", head: true })
              .eq("discount_id", d.id)
              .eq("user_id", userId);
            if ((count ?? 0) >= d.max_per_customer) discountError = "You've already used this code the maximum number of times.";
          }
          if (!discountError) {
            discountRow = { id: d.id, max_per_customer: d.max_per_customer };
            discountDef = {
              id: d.id, code: d.code, type: d.type, value: d.value,
              buyQty: d.buy_qty, getQty: d.get_qty,
              qualifyingScope: d.qualifying_scope, qualifyingCategory: d.qualifying_category, qualifyingProductId: d.qualifying_product_id,
            };
            const qualifyingSubtotal = round2(qualifying.reduce((s, l) => s + l.unitPrice * l.qty, 0));
            if (d.type === "percent") discountAmount = round2(qualifyingSubtotal * (d.value / 100));
            else if (d.type === "fixed") discountAmount = Math.min(d.value, qualifyingSubtotal);
            else if (d.type === "bogo") {
              const units: number[] = [];
              qualifying.forEach((l) => { for (let n = 0; n < l.qty; n++) units.push(l.unitPrice); });
              units.sort((a, b) => a - b);
              const groupSize = (d.buy_qty ?? 0) + (d.get_qty ?? 0);
              if (groupSize > 0) {
                units.forEach((price, i) => { if (i % groupSize >= (d.buy_qty ?? 0)) discountAmount += price; });
                discountAmount = round2(discountAmount);
              }
            } else if (d.type === "freeDelivery") {
              freeDelivery = true;
            }
          }
        }
      }
    }

    // ---- delivery ---- (mirrors the client's resolveDeliveryFee exactly,
    // same weight tiers + threshold rules, both loaded from the same
    // pricing_settings row so the two can't drift apart)
    const fulfilmentMethod = body.fulfilmentMethod === "pickup" ? "pickup" : "delivery";
    let delivery = 0;
    if (fulfilmentMethod === "delivery") {
      const tier = DELIVERY_WEIGHT_TIERS.find((t) => totalWeight <= t.maxWeight) ?? DELIVERY_WEIGHT_TIERS[DELIVERY_WEIGHT_TIERS.length - 1];
      delivery = tier.fee;
      const itemCount = lines.reduce((s, l) => s + l.qty, 0);
      for (const rule of DELIVERY_THRESHOLD_RULES) {
        const actual = rule.conditionType === "price" ? subtotal : rule.conditionType === "weight" ? totalWeight : rule.conditionType === "items" ? itemCount : null;
        if (actual === null) continue;
        const met = rule.operator === "gte" ? actual >= rule.value : actual <= rule.value;
        if (!met) continue;
        if (rule.effect === "free") delivery = 0;
        else if (rule.effect === "fixed" && typeof rule.feeOverride === "number") delivery = Math.min(delivery, rule.feeOverride);
      }
      if (freeDelivery) delivery = 0;
    }

    // ---- loyalty reward (only ever applies to a signed-in account, and
    // only the account's own real, unused reward — never client-claimed) ----
    let loyaltyDiscountAmount = 0;
    let loyaltyPct: number | null = null;
    if (userId) {
      const { data: reward } = await db
        .from("loyalty_rewards")
        .select("pct")
        .eq("user_id", userId)
        .eq("used", false)
        .limit(1)
        .maybeSingle();
      if (reward) {
        loyaltyPct = reward.pct;
        loyaltyDiscountAmount = Math.min(round2(subtotal * reward.pct / 100), round2(subtotal - discountAmount));
      }
    }

    const total = Math.max(0, round2(subtotal + delivery - discountAmount - loyaltyDiscountAmount));

    // Only standalone product lines carry a stockKey (see the comment by
    // requestedQtyByKey above) — collapsed here from possibly-multiple
    // lines for the same base product (different weight variants) into
    // one summed quantity per product, which is what decrement_stock
    // actually needs.
    const stockLinesByKey = new Map<string, number>();
    for (const l of lines) {
      if (!l.stockKey) continue;
      stockLinesByKey.set(l.stockKey, (stockLinesByKey.get(l.stockKey) ?? 0) + l.qty);
    }
    const stockLines = [...stockLinesByKey.entries()].map(([product_key, qty]) => ({ product_key, qty }));

    return {
      ok: true as const,
      subtotal, delivery, discountAmount, discountError, discountId: discountRow?.id ?? null, discountDef, freeDelivery,
      loyaltyDiscountAmount, loyaltyPct, total, totalWeight, stockLines,
    };
  }

  if (body.action === "validate-discount") {
    // Tighter than the general flood guard above, and specifically about
    // guessing: nothing stops a script from trying "SAVE5", "SAVE10",
    // "WELCOME10"... in sequence otherwise. A real customer trying a
    // code they mistyped, or trying two or three codes, never comes
    // close to this; a brute-force attempt does.
    if (!(await checkRateLimit(db, `validate-discount:${clientIp}`, 8, 60))) {
      return rateLimitedResponse(cors);
    }
    const items = Array.isArray(body.items) ? (body.items as CartLineIn[]) : [];
    const result = await priceCart(items, body.code);
    if (!result.ok) {
      return new Response(JSON.stringify({ ok: false, error: result.error }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (result.discountError) {
      return new Response(JSON.stringify({ ok: false, error: result.discountError }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, discount: result.discountDef }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // ---- the real charge ----
  const items = Array.isArray(body.items) ? (body.items as CartLineIn[]) : null;
  if (!items || items.length === 0) {
    return new Response(JSON.stringify({ error: "Your basket is empty." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const priced = await priceCart(items, body.discountCode);
  if (!priced.ok) {
    return new Response(JSON.stringify({ error: priced.error }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
  // A discount code that stopped qualifying between the client's own
  // check and this one (say, someone else just used up the last
  // redemption) fails the whole charge rather than silently charging
  // full price for a discount the customer thinks they're getting.
  if (priced.discountError) {
    return new Response(JSON.stringify({ error: priced.discountError }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const amount = Math.round(priced.total * 100);
  if (amount < 30) {
    return new Response(JSON.stringify({ error: "Order total is below the minimum payable amount." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // A signed-in user is required past this point in the real checkout
  // flow (index.html gates the delivery step on it) — this function
  // doesn't re-enforce that itself, but pending_checkouts.user_id is
  // NOT NULL, so a request with no authenticated caller simply can't
  // reach the webhook safety net below. Nothing about the actual charge
  // depends on this either way.
  const deliveryInfo = (body.deliveryInfo && typeof body.deliveryInfo === "object" ? body.deliveryInfo : {}) as Record<string, unknown>;
  // Recomputed rather than threaded out of priceCart's own local scope
  // — same one-liner, so it can't drift from what priceCart used to
  // decide the delivery fee above.
  const fulfilmentMethod = body.fulfilmentMethod === "pickup" ? "pickup" : "delivery";
  // Matches finishOrderAfterPayment()'s own `${di.address}, ${di.town}
  // ${di.postcode}` in index.html exactly, so an order built from this
  // fallback path looks identical to one the client created itself.
  const deliveryAddress = typeof deliveryInfo.address === "string"
    ? `${deliveryInfo.address}, ${deliveryInfo.town ?? ""} ${deliveryInfo.postcode ?? ""}`.trim()
    : null;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "gbp",
      automatic_payment_methods: { enabled: true },
      receipt_email: typeof body.customerEmail === "string" ? body.customerEmail : undefined,
      description: typeof body.orderDescription === "string" ? body.orderDescription.slice(0, 200) : "Yo7 Foods order",
      metadata: {
        yo7_user_id: userId ?? "",
        yo7_discount_id: priced.discountId ?? "",
      },
    });

    // Server-side safety net (see migration 33 + the stripe-webhook
    // function): if the customer's own browser never gets to actually
    // create the order after this payment succeeds — dropped
    // connection, killed tab, crashed app, right in that window — this
    // row is what lets the webhook reconstruct the real order later,
    // independently, using the SAME server-verified totals just
    // computed above rather than trusting anything the client claims
    // twice. Best-effort: a failure here never blocks the payment
    // itself (the PaymentIntent above already exists either way), it
    // only means that one order would rely solely on the client's own
    // fast path if this insert didn't happen.
    if (userId) {
      const { error: pendingError } = await db.from("pending_checkouts").insert({
        payment_intent_id: paymentIntent.id,
        user_id: userId,
        items: items,
        subtotal: priced.subtotal,
        delivery_fee: priced.delivery,
        discount: round2(priced.discountAmount + priced.loyaltyDiscountAmount),
        total: priced.total,
        fulfilment_method: fulfilmentMethod,
        delivery_name: typeof deliveryInfo.name === "string" ? deliveryInfo.name : null,
        delivery_address: deliveryAddress,
        delivery_phone: typeof deliveryInfo.phone === "string" ? deliveryInfo.phone : null,
        notes: typeof deliveryInfo.notes === "string" ? deliveryInfo.notes : null,
        discount_id: priced.discountId,
        discount_code: typeof body.discountCode === "string" ? body.discountCode : null,
        stock_lines: priced.stockLines,
        delivery_postcode: typeof deliveryInfo.postcode === "string" ? deliveryInfo.postcode : null,
      });
      if (pendingError) console.error("pending_checkouts insert failed (order still relies on client fast path):", pendingError.message);
    }

    return new Response(JSON.stringify({
      client_secret: paymentIntent.client_secret,
      verifiedTotal: {
        subtotal: priced.subtotal,
        delivery: priced.delivery,
        discountAmount: priced.discountAmount,
        loyaltyDiscountAmount: priced.loyaltyDiscountAmount,
        total: priced.total,
      },
    }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Stripe PaymentIntent creation failed:", err);
    const message = err instanceof Error ? err.message : "Payment could not be started.";
    return new Response(JSON.stringify({ error: message }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
