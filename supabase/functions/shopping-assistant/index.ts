// Yo7 Foods, Supabase Edge Function: shopping-assistant
//
// Backs the customer-facing chat widget: answers questions about African
// and Caribbean dishes, ingredients, and cooking, and recommends real,
// in-stock products to buy via the search_products tool below - never an
// invented name or price, always a live lookup against the same
// products/custom_products/product_overrides layering create-payment-intent
// trusts for an actual charge, so a recommended item's price/stock is never
// stale by the time someone clicks through to buy it. Also hands off to a
// real person on WhatsApp via the contact_human tool, for anything the
// assistant itself can't do (placing an order, an item it can't find).
//
// Runs Claude Haiku 5.5 (claude-haiku-5-5) - a cheap, fast model is the
// right fit for conversational food Q&A with occasional tool calls, not a
// task that benefits from a larger model's deeper reasoning.
//
// Deploy with the Supabase CLI from the project root:
//   supabase functions deploy shopping-assistant
//
// Secrets it needs - ANTHROPIC_API_KEY is the only one you set yourself:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by
// Supabase for every Edge Function, nothing to set for those. No anon-key
// client is needed here - this function never reads anything scoped to a
// signed-in caller, so there's nothing auth.getUser() would add.
//
// Every response uses HTTP status 200, with { error: "..." } when
// something's actually wrong - same reasoning as create-payment-intent's
// own comment on this: the Supabase JS client's functions.invoke() only
// hands the parsed body back as `data` on a 2xx status.

import Anthropic from "npm:@anthropic-ai/sdk@1.11.0";
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

// Real department slugs, so the tool's optional `category` argument (and the
// system prompt's own department list) names aisles that actually exist
// rather than something the model guesses at. Kept as a flat list here
// rather than imported from src/index.html's own CATEGORIES array, which
// this Deno function has no access to at build time - update both places
// together if a department is ever renamed or removed.
const KNOWN_CATEGORIES = [
  "rice", "beans", "garri-flours", "flour", "noodles", "oils", "condiments",
  "seasoning", "meat-poultry", "fish-seafood", "vegetables", "fruits-vegetables",
  "root-vegetables", "other-vegetables", "peppers-chillies", "tropical-foods",
  "drinks", "beverages", "herbal-teas", "dairy", "bakery", "breakfast-cereals",
  "baking-essentials", "snacks-confectionary", "household", "hair-products",
  "body-oral-products", "miscellaneous",
];

type ProductRow = { cat_slug: string; idx: number; name: string; price: number; sale_price: number | null; stock: string; unit: string };
type OverrideRow = { product_key: string; price: number | null; sale_price: number | null; stock: string | null };
type ProductMatch = { name: string; price: number; unit: string; url: string };

// Same WhatsApp number the rest of the site already links to (footer,
// floating order button, review links). Fixed here rather than something
// the model could ever paraphrase or mistype.
const WHATSAPP_CONTACT = {
  url: `https://wa.me/447398810052?text=${encodeURIComponent("Hi YO7 Foods! I have a question about an order or a product.")}`,
  label: "Chat with us on WhatsApp",
};

// Same price/stock layering create-payment-intent's own trusted() helper
// uses - an admin-set override always wins over the seeded/base row - so a
// recommended product's price and in-stock status are never a stale number
// a customer could click through to and be surprised by.
async function searchProducts(db: ReturnType<typeof createClient>, query: string | undefined, category: string | undefined): Promise<ProductMatch[]> {
  const cat = category && KNOWN_CATEGORIES.includes(category) ? category : undefined;
  const q = (query || "").trim();
  if (!q && !cat) return [];

  let baseQuery = db.from("products").select("cat_slug, idx, name, price, sale_price, stock, unit").limit(30);
  let customQuery = db.from("custom_products").select("cat_slug, idx, name, price, sale_price, stock, unit").limit(30);
  if (cat) { baseQuery = baseQuery.eq("cat_slug", cat); customQuery = customQuery.eq("cat_slug", cat); }
  if (q) { baseQuery = baseQuery.ilike("name", `%${q}%`); customQuery = customQuery.ilike("name", `%${q}%`); }

  const [baseRes, customRes] = await Promise.all([baseQuery, customQuery]);
  const rows = new Map<string, ProductRow>();
  (baseRes.data as ProductRow[] | null ?? []).forEach((r) => rows.set(`${r.cat_slug}::${r.idx}`, r));
  (customRes.data as ProductRow[] | null ?? []).forEach((r) => {
    const key = `${r.cat_slug}::${r.idx}`;
    if (!rows.has(key)) rows.set(key, r);
  });
  if (rows.size === 0) return [];

  const { data: overrideRows } = await db
    .from("product_overrides")
    .select("product_key, price, sale_price, stock")
    .in("product_key", [...rows.keys()]);
  const overrides = new Map<string, OverrideRow>();
  (overrideRows as OverrideRow[] | null ?? []).forEach((o) => overrides.set(o.product_key, o));

  const matches: ProductMatch[] = [];
  for (const [key, row] of rows) {
    const o = overrides.get(key);
    const stock = o?.stock ?? row.stock ?? "in";
    if (stock === "out") continue; // never recommend something nobody can actually buy
    const price = o?.price ?? row.price;
    const salePrice = o && o.sale_price !== undefined ? o.sale_price : row.sale_price;
    const effectivePrice = typeof salePrice === "number" && salePrice < price ? salePrice : price;
    const [catSlug, idxStr] = key.split("::");
    matches.push({ name: row.name, price: effectivePrice, unit: row.unit, url: `https://yo7foods.co.uk/#/product/${catSlug}/${idxStr}` });
    if (matches.length >= 5) break;
  }
  return matches;
}

const SYSTEM_PROMPT = `You are Yomi, the YO7 Foods shopping and cooking assistant, built into the yo7foods.co.uk website. YO7 Foods is an African and Caribbean grocery store (UK-wide delivery, pickup in Ipswich).

What you help with: African and Caribbean dishes, their ingredients, and how to cook them, and recommending real ingredients a customer can buy from YO7 Foods right now.

Rules:
- Always call search_products before naming a specific product or price. Never invent a product name, price, or claim something is in stock - the tool is the only source of truth for what YO7 Foods actually sells right now.
- If search_products finds nothing for an ingredient, say so plainly rather than suggesting a generic substitute as if it were something sold here. Never describe or quote a price for an item the tool didn't return.
- Real departments you can browse by category: ${KNOWN_CATEGORIES.join(", ")}.
- Keep answers short and mobile-friendly: this is a small chat widget, not an essay. A short paragraph or a tight numbered/bulleted list, not multiple sections.
- If asked something with nothing to do with African/Caribbean food, cooking, ingredients, or shopping at YO7 Foods, say briefly that's outside what you can help with and steer back to food/shopping questions.
- Never give food-safety-critical medical advice (allergies, pregnancy-safe foods, etc.) beyond general common knowledge - suggest checking with a doctor for anything serious.
- You can't place an order yourself. If a customer wants to place an order directly, asks whether something not found by search_products is available another way, or explicitly asks to speak to a real person, call contact_human and let them know the team can help on WhatsApp.`;

const SEARCH_PRODUCTS_TOOL: Anthropic.Tool = {
  name: "search_products",
  description: "Search the real YO7 Foods catalogue for in-stock products matching a search term and/or department, so you can recommend something a customer can actually buy right now. Returns up to 5 matches with their real name, price, and a link.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A product or ingredient name to search for, e.g. 'palm oil', 'scotch bonnet', 'basmati rice'." },
      category: { type: "string", description: `Optional: narrow to one department to browse a whole aisle instead of searching by name. One of: ${KNOWN_CATEGORIES.join(", ")}.` },
    },
  },
};

const CONTACT_HUMAN_TOOL: Anthropic.Tool = {
  name: "contact_human",
  description: "Call this to hand the customer off to a real person on WhatsApp: when they want to place an order directly, ask whether an item not found by search_products is available some other way, or explicitly ask to speak to a human. Returns the real WhatsApp contact link to show them, never invent one yourself.",
  input_schema: { type: "object", properties: {} },
};

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set, run: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...");
    return new Response(JSON.stringify({ error: "The assistant isn't configured on the server yet." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supabaseUrl, serviceRoleKey);

  // A real conversation is a handful of exchanges - generous enough that
  // nobody has a genuine chat cut short, tight enough that a scripted loop
  // can't run up a real API bill.
  const clientIp = getClientIp(req);
  if (!(await checkRateLimit(db, `shopping-assistant:${clientIp}`, 20, 60))) {
    return new Response(JSON.stringify({ error: "Too many messages, please wait a moment and try again." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json", "Retry-After": "30" },
    });
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  // Only the last 10 turns are sent on - bounds both the request size and
  // what a single conversation can cost, while still giving the model
  // enough back-and-forth to follow a real conversation. The client is
  // expected to keep the full history for display; this is just what gets
  // sent to the model.
  const history = rawMessages
    .filter((m): m is { role: string; content: string } =>
      m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof (m as { content: unknown }).content === "string")
    .slice(-10);
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    return new Response(JSON.stringify({ error: "No message to respond to." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const anthropic = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const productsUsed = new Map<string, ProductMatch>();
  let whatsappRequested = false;

  try {
    // A real conversation needs at most a couple of tool round-trips
    // (search, maybe refine, answer) - capped so a model that somehow got
    // stuck calling the tool repeatedly can't turn one chat message into an
    // unbounded number of paid API calls.
    for (let turn = 0; turn < 4; turn++) {
      const response = await anthropic.messages.create({
        model: "claude-haiku-5-5",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [SEARCH_PRODUCTS_TOOL, CONTACT_HUMAN_TOOL],
        output_config: { effort: "low" },
        messages,
      });

      if (response.stop_reason === "refusal") {
        return new Response(JSON.stringify({ reply: "I can't help with that one, but I'm happy to help with African or Caribbean dishes, ingredients, or cooking questions instead.", products: [] }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      if (response.stop_reason !== "tool_use") {
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
        return new Response(JSON.stringify({
          reply: textBlock?.text ?? "",
          products: [...productsUsed.values()],
          whatsapp: whatsappRequested ? WHATSAPP_CONTACT : undefined,
        }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        if (toolUse.name === "contact_human") {
          whatsappRequested = true;
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "WhatsApp contact shared with the customer." });
          continue;
        }
        const input = toolUse.input as { query?: string; category?: string };
        const matches = await searchProducts(db, input.query, input.category);
        matches.forEach((m) => productsUsed.set(m.url, m));
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: matches.length
            ? JSON.stringify(matches)
            : "No matching in-stock products found. Try a different search term, or tell the customer this isn't something YO7 Foods currently stocks.",
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    return new Response(JSON.stringify({
      reply: "Sorry, I'm having trouble finding an answer right now, please try asking again.",
      products: [...productsUsed.values()],
      whatsapp: whatsappRequested ? WHATSAPP_CONTACT : undefined,
    }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("shopping-assistant failed:", err);
    return new Response(JSON.stringify({ error: "Couldn't reach the assistant right now, please try again in a moment." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
