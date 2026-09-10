// Yo7 Foods — Supabase Edge Function: verify-email-domain
//
// Rejects a signup email whose domain can't actually receive mail — a
// typo'd domain (gmial.com), a made-up one, or one with no mail server
// configured at all — before an account or confirmation email is even
// created. index.html's own isValidEmail() already rejects malformed
// input (missing @, no TLD, etc.); this catches the next class of
// mistake, where the address is syntactically fine but the domain
// itself couldn't receive mail if you tried.
//
// This is a DNS MX-record check, not full mailbox verification: it
// confirms the DOMAIN can receive mail, not that any specific mailbox at
// that domain (e.g. "bob@gmail.com") actually exists — that would need
// either SMTP probing (most real mail servers block or greylist this,
// making it unreliable) or a paid third-party verification service. An
// MX check catches the overwhelming majority of real mistakes at zero
// cost and with no new vendor dependency, which is the right tradeoff
// for this site's current size — Supabase's own confirmation-email step
// is still the real backstop for anything this doesn't catch.
//
// Uses Cloudflare's public DNS-over-HTTPS resolver (cloudflare-dns.com) —
// no API key, no meaningful rate-limit concerns at this site's volume.
//
// Fails OPEN on any lookup error (network hiccup, resolver down,
// timeout): this is a courtesy filter for obvious mistakes, not a
// security boundary, and a DNS blip should never be the reason a real
// signup gets rejected.
//
// Deploy with the Supabase CLI from the project root. --no-verify-jwt
// because this runs during signup itself, before any session exists:
//   supabase functions deploy verify-email-domain --no-verify-jwt
//
// No secrets needed — this function only ever talks to Cloudflare's
// public DNS resolver, nothing Supabase-specific to configure.

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

type DohAnswer = { name: string; type: number; TTL: number; data: string };
type DohResponse = { Status: number; Answer?: DohAnswer[] };

const MX_TYPE = 15;
const A_TYPE = 1;

async function lookup(domain: string, type: "MX" | "A"): Promise<DohResponse> {
  const resp = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
  });
  return await resp.json() as DohResponse;
}

async function domainCanReceiveMail(domain: string): Promise<boolean> {
  const mx = await lookup(domain, "MX");
  if (mx.Status === 0 && mx.Answer?.some((a) => a.type === MX_TYPE)) return true;

  // RFC 5321 fallback: a domain with no MX record can still receive mail
  // straight to its own A record — rare today but a real case, not a hack.
  const a = await lookup(domain, "A");
  return a.Status === 0 && !!a.Answer?.some((rec) => rec.type === A_TYPE);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const atIdx = email.lastIndexOf("@");
  if (atIdx < 1 || atIdx === email.length - 1) {
    // Malformed input shouldn't really reach this function — index.html's
    // own isValidEmail() runs first — but fail closed here specifically,
    // since there's no domain to even look up.
    return new Response(JSON.stringify({ valid: false, reason: "That email address doesn't look right." }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const domain = email.slice(atIdx + 1).toLowerCase();

  try {
    const canReceive = await domainCanReceiveMail(domain);
    if (!canReceive) {
      return new Response(JSON.stringify({
        valid: false,
        reason: `We couldn't find a mail server for "${domain}" — double-check your email address.`,
      }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Domain MX lookup failed, failing open:", err);
    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
