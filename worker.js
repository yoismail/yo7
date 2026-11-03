// Fronts the Supabase Storage "product-photos" bucket at /cdn-img/<path>
// so Cloudflare's own edge cache absorbs repeat image requests across
// every visitor, not just repeat visits from the same browser (the
// Cache-Control header the upload code already sets only helps that
// second case). Every other request is untouched: real static assets
// still get served directly by Cloudflare's asset layer without ever
// reaching this script (see the project README/wrangler.jsonc comment),
// and anything else falls through to env.ASSETS.fetch(), the exact
// single-page-application fallback this site already relied on before
// this script existed.
//
// See src/index.html's cdnImageUrl()/PRODUCT_PHOTOS_PUBLIC_PREFIX for
// the client-side half: every freshly admin-uploaded photo's URL gets
// rewritten to this same /cdn-img/ form before it's ever stored, so
// every render site that already just prints out whatever URL is in the
// database needs no changes of its own.
const PROXY_PREFIX = '/cdn-img/';
const SUPABASE_STORAGE_ORIGIN = 'https://mcxfzfvhdtcjfyjmnamr.supabase.co';
const BUCKET_PATH = '/storage/v1/object/public/product-photos/';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname.startsWith(PROXY_PREFIX)) {
            return handleCdnImage(request, url, ctx);
        }
        return env.ASSETS.fetch(request);
    },
};

async function handleCdnImage(request, url, ctx) {
    const objectPath = url.pathname.slice(PROXY_PREFIX.length);
    // Every object path this proxy ever mints itself looks like
    // "adverts/172…jpg" or "category-rice-172….webp" - no leading slash,
    // no "..", nothing that would need to escape the fixed bucket this
    // request is always forwarded into. A path that doesn't fit that
    // shape isn't a legitimate proxied object (stale bookmark, a typo,
    // a scanner probing the route), so there's nothing real to serve.
    if (!objectPath || objectPath.includes('..') || objectPath.startsWith('/')) {
        return new Response('Not found', { status: 404 });
    }

    // Cloudflare's own HTTP cache, keyed by this request's full URL -
    // shared across every visitor hitting this same object, which is
    // the entire point: a second visitor's request never reaches
    // Supabase at all once the first has warmed this entry.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const upstreamUrl = SUPABASE_STORAGE_ORIGIN + BUCKET_PATH + objectPath;
    const upstreamResponse = await fetch(upstreamUrl, {
        cf: { cacheTtl: 31536000, cacheEverything: true },
    });
    if (!upstreamResponse.ok) {
        // Not cached - a missing object is either stale data (already
        // corrected at the source next time it's re-uploaded) or a
        // genuine miss, neither worth pinning in the edge cache.
        return new Response('Not found', { status: upstreamResponse.status });
    }

    const headers = new Headers(upstreamResponse.headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.delete('Set-Cookie');
    const response = new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
}
