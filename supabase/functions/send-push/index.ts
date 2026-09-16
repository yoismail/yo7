// Yo7 Foods — Supabase Edge Function: send-push
//
// THE PROBLEM THIS SOLVES: the in-app notifications inbox (migration 43)
// only ever shows up if the customer happens to have the site open in a
// tab. This is what turns those same notifications — order-status
// updates, admin announcements — into a real OS-level push, the way a
// native app would, even when nothing is open. Triggered automatically:
// the notifications_dispatch_push trigger (migration 44) calls this
// function once for every row inserted into notifications, regardless
// of whether that row came from an order-status change or an admin
// broadcast — this is the one place a push actually gets sent.
//
// WHY THIS IS HAND-ROLLED CRYPTO, NOT THE `web-push` NPM PACKAGE: real
// Web Push (RFC 8291/8292) needs a VAPID-signed request (ES256 JWT) and,
// for every current browser, the payload itself encrypted per-subscriber
// with AES-128-GCM (the aes128gcm content-coding from RFC 8188) — this
// is genuine asymmetric crypto, not just a bearer token in a header the
// way every Resend email call elsewhere in this project works. The
// popular `web-push` npm package does this well, but it sends the
// actual HTTP request via Node's `https` module internally, which is
// Node-compat surface Deno's edge runtime supports through a
// compatibility shim rather than natively — a real, if narrow, source of
// runtime risk for a function nothing else depends on. Everything below
// instead uses only the standard Web Crypto API (`crypto.subtle`) plus
// `fetch`, both first-class in Deno with no compatibility shim involved.
// It was verified correct before ever touching a real browser: the
// aes128gcm output was checked byte-for-byte against the same well-
// established `http_ece` library `web-push` itself uses internally
// (fixed keys/salt/plaintext in, identical ciphertext out), and the
// VAPID JWT's signature was independently verified with Node's own
// crypto.verify() in the raw IEEE-P1363 (r||s) form JWS ES256 requires
// (not the ASN.1 DER form most general-purpose ECDSA tooling defaults
// to — mixing the two up is a common, silent way to get this wrong).
//
// Deploy with the Supabase CLI from the project root. --no-verify-jwt is
// required — this is called by the notifications_dispatch_push trigger
// via pg_net, not by a logged-in customer's browser, so there's no
// Supabase session JWT to verify. The PUSH_DISPATCH_SECRET check below
// is what actually verifies a request is genuinely from that trigger —
// it is not optional, and without it this endpoint would let anyone who
// found its URL spam every subscribed customer's phone:
//   supabase functions deploy send-push --no-verify-jwt
//
// Secrets it needs:
//   supabase secrets set VAPID_PUBLIC_KEY=...
//   supabase secrets set VAPID_PRIVATE_KEY=...
//   supabase secrets set VAPID_SUBJECT=mailto:hello@yo7foods.co.uk
//   supabase secrets set PUSH_DISPATCH_SECRET=...
// (matching the same PUSH_DISPATCH_SECRET value that must also be
// stored in Supabase Vault under the name 'push_dispatch_secret' — see
// add_push_notifications.sql's own deploy steps for the exact commands
// and how these were generated.)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
// by Supabase for every Edge Function.

import { createClient } from "npm:@supabase/supabase-js@2";

// ---------------- base64url helpers ----------------
// Every key/secret in a push subscription (and VAPID keys) travels as
// base64url — the URL-safe variant with no padding, per RFC 8291/8292 —
// never plain base64.

function b64urlToBytes(s: string): Uint8Array {
  let padded = s.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4) padded += "=";
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ---------------- VAPID (RFC 8292) ----------------
// Proves to the push service that these messages come from the same
// application server that will keep being Yo7 Foods, not a one-off
// forged request — every major browser's push service requires it.

async function importVapidPrivateKey(priv32: Uint8Array, pub65: Uint8Array): Promise<CryptoKey> {
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(pub65.slice(1, 33)),
    y: bytesToB64url(pub65.slice(33, 65)),
    d: bytesToB64url(priv32),
    ext: true,
    key_ops: ["sign"],
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// Returns the full Authorization header value — 'vapid t=<jwt>, k=<public key>'.
async function buildVapidAuthHeader(
  endpoint: string,
  subject: string,
  vapidPublicB64: string,
  vapidPrivateB64: string,
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const nowSeconds = Math.floor(Date.now() / 1000);
  // 12 hours — comfortably inside every push service's max (typically
  // 24h), and short enough that a leaked JWT is worthless well before it
  // could matter.
  const payload = { aud: audience, exp: nowSeconds + 12 * 3600, sub: subject };
  const signingInput = strToB64url(JSON.stringify(header)) + "." + strToB64url(JSON.stringify(payload));

  const key = await importVapidPrivateKey(b64urlToBytes(vapidPrivateB64), b64urlToBytes(vapidPublicB64));
  // Web Crypto's ECDSA signatures are already the raw IEEE-P1363 (r||s)
  // form JWS/ES256 requires — unlike most general-purpose ECDSA APIs,
  // which default to ASN.1 DER. No re-encoding needed here; getting this
  // wrong is the single most common way a hand-rolled VAPID JWT silently
  // fails signature checks. Verified against Node's own crypto.verify()
  // with dsaEncoding: 'ieee-p1363' before this was ever deployed.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));

  const jwt = signingInput + "." + bytesToB64url(sig);
  return `vapid t=${jwt}, k=${vapidPublicB64}`;
}

// ---------------- Payload encryption (RFC 8188 aes128gcm / RFC 8291) ----------------

async function importEcPrivateKeyRaw(raw32: Uint8Array, rawPub65: Uint8Array): Promise<CryptoKey> {
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(rawPub65.slice(1, 33)),
    y: bytesToB64url(rawPub65.slice(33, 65)),
    d: bytesToB64url(raw32),
    ext: true,
    key_ops: ["deriveBits"],
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

async function importEcPublicKeyRaw(raw65: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw65, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

// Encrypts one push message body per RFC 8291 (which layers a WebPush-
// specific key derivation on top of RFC 8188's generic aes128gcm
// content-coding). Returns the exact bytes to POST to the subscriber's
// push endpoint — this function's own ephemeral keypair, a fresh random
// salt, and the ciphertext are all bundled into that one buffer per the
// aes128gcm wire format; nothing else needs to travel out-of-band.
async function encryptPayload(opts: {
  senderPriv32: Uint8Array;
  senderPub65: Uint8Array;
  receiverPub65: Uint8Array;
  authSecret16: Uint8Array;
  plaintext: Uint8Array;
}): Promise<Uint8Array> {
  const { senderPriv32, senderPub65, receiverPub65, authSecret16, plaintext } = opts;
  const salt16 = crypto.getRandomValues(new Uint8Array(16));

  const senderPrivKey = await importEcPrivateKeyRaw(senderPriv32, senderPub65);
  const receiverPubKey = await importEcPublicKeyRaw(receiverPub65);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receiverPubKey }, senderPrivKey, 256),
  );

  // Stage 1 (WebPush-specific, RFC 8291 §3.4): combine the ECDH secret
  // with both parties' public keys and the subscriber's own auth secret
  // into a single IKM for stage 2 — this is what stops the payload from
  // being decryptable by anyone who merely knows the subscriber's public
  // key (e.g. the push service itself), since auth_secret never leaves
  // the subscriber/application-server pair.
  const ecdhSecretKey = await crypto.subtle.importKey("raw", ecdhSecret, "HKDF", false, ["deriveBits"]);
  const keyInfo = concatBytes(new TextEncoder().encode("WebPush: info\0"), receiverPub65, senderPub65);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: authSecret16, info: keyInfo },
      ecdhSecretKey,
      256,
    ),
  );

  // Stage 2 (generic aes128gcm content-coding, RFC 8188 §2.1): derive
  // the actual content-encryption key and nonce from that IKM and this
  // message's own random salt.
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cek = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt16, info: new TextEncoder().encode("Content-Encoding: aes128gcm\0") },
      ikmKey,
      128,
    ),
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt16, info: new TextEncoder().encode("Content-Encoding: nonce\0") },
      ikmKey,
      96,
    ),
  );

  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 is the RFC 8188 "last (and only) record" delimiter — every push
  // message here fits in a single record, so no further padding needed.
  const padded = concatBytes(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, padded));

  // Wire format (RFC 8188 §2.1): salt(16) || record size(4, big-endian)
  // || key id length(1) || key id (our ephemeral public key, so the
  // subscriber's browser can redo the same ECDH on its end) || ciphertext.
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  const idLen = new Uint8Array([senderPub65.length]);
  return concatBytes(salt16, recordSize, idLen, senderPub65, ciphertext);
}

// ---------------- Sending ----------------

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth_key: string;
}

async function sendPush(
  sub: PushSubscriptionRow,
  payload: Record<string, unknown>,
  vapidPublicB64: string,
  vapidPrivateB64: string,
  vapidSubject: string,
): Promise<{ ok: boolean; status: number }> {
  const senderPub65 = b64urlToBytes(vapidPublicB64);
  const senderPriv32 = b64urlToBytes(vapidPrivateB64);
  const receiverPub65 = b64urlToBytes(sub.p256dh);
  const authSecret16 = b64urlToBytes(sub.auth_key);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const body = await encryptPayload({ senderPriv32, senderPub65, receiverPub65, authSecret16, plaintext });
  const authHeader = await buildVapidAuthHeader(sub.endpoint, vapidSubject, vapidPublicB64, vapidPrivateB64);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      // A day is plenty for an order-status update or announcement to
      // still be worth delivering late; the push service is free to
      // drop it sooner if the device has been offline longer than this.
      "TTL": "86400",
    },
    body,
  });
  // Body isn't needed either way, but it must be drained so Deno doesn't
  // warn about (or leak) an unconsumed response stream.
  await res.arrayBuffer().catch(() => {});
  return { ok: res.ok, status: res.status };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const dispatchSecret = Deno.env.get("PUSH_DISPATCH_SECRET");
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!dispatchSecret || authHeader !== `Bearer ${dispatchSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const vapidPublicB64 = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateB64 = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:hello@yo7foods.co.uk";
  if (!vapidPublicB64 || !vapidPrivateB64) {
    console.error("VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is not set — see this function's own header comment.");
    return new Response(JSON.stringify({ error: "Push isn't configured on the server yet." }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request." }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  const notificationId = typeof body.notification_id === "string" ? body.notification_id : "";
  if (!notificationId) {
    return new Response(JSON.stringify({ error: "Missing notification_id." }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supabaseUrl, serviceRoleKey);

  const { data: notif, error: notifError } = await db
    .from("notifications")
    .select("id, user_id, title, body, link")
    .eq("id", notificationId)
    .single();
  if (notifError || !notif) {
    console.error(`send-push: notification ${notificationId} not found:`, notifError?.message);
    return new Response(JSON.stringify({ ok: true, sent: 0, reason: "notification not found" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  // A real user_id targets just that one customer's device(s); NULL
  // (a broadcast) goes to every device anyone has ever opted in from —
  // same broadcast-vs-targeted split the notifications table itself
  // already uses.
  let subsQuery = db.from("push_subscriptions").select("endpoint, p256dh, auth_key");
  if (notif.user_id) subsQuery = subsQuery.eq("user_id", notif.user_id);
  const { data: subs, error: subsError } = await subsQuery;
  if (subsError || !subs || subs.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0, total: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  const payload = { title: notif.title, body: notif.body, link: notif.link || "#/notifications" };

  let sent = 0;
  const deadEndpoints: string[] = [];
  await Promise.all(
    subs.map(async (sub: PushSubscriptionRow) => {
      try {
        const { ok, status } = await sendPush(sub, payload, vapidPublicB64, vapidPrivateB64, vapidSubject);
        if (ok) {
          sent++;
        } else if (status === 404 || status === 410) {
          // The push service itself is telling us this subscription is
          // permanently gone (uninstalled, permission revoked, browser
          // data cleared) — nothing will ever make it work again, so
          // clean it up now rather than retrying it forever.
          deadEndpoints.push(sub.endpoint);
        } else {
          console.error(`send-push: ${sub.endpoint} responded ${status}`);
        }
      } catch (err) {
        console.error(`send-push: request failed for ${sub.endpoint}:`, err instanceof Error ? err.message : err);
      }
    }),
  );

  if (deadEndpoints.length > 0) {
    await db.from("push_subscriptions").delete().in("endpoint", deadEndpoints);
  }

  return new Response(
    JSON.stringify({ ok: true, sent, total: subs.length, cleaned: deadEndpoints.length }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
