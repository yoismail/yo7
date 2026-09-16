// Yo7 Foods — minimal service worker, added purely for PWA installability
// ("Add to Home Screen") plus a basic offline fallback. Deliberately
// conservative: this site is a single actively-edited HTML file
// (BUILD_VERSION bumped by hand on every change, and the product/* pages
// regenerate on every push plus hourly via CI), so an online visitor must
// never be served something cached and stale. Every navigation always
// tries the network first — the cache here only ever supplies a fallback
// when there's genuinely no connection at all.
//
// SW_CACHE_VERSION is bumped by hand whenever this file itself changes
// (separate concern from index.html's own BUILD_VERSION) — activate()
// below deletes every other cache name, so a bump here is what clears out
// anything an earlier version of this service worker had cached.
const SW_CACHE_VERSION = 'yo7-shell-v1';

// Small and deliberately safe to fail on: install() proceeds even if one
// of these can't be fetched right now (a fresh deploy, a flaky network),
// rather than leaving the service worker permanently stuck failing to
// install over one missing file.
const PRECACHE_URLS = ['/', '/favicon.ico', '/favicon-192x192.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SW_CACHE_VERSION)
            .then((cache) => Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== SW_CACHE_VERSION).map((key) => caches.delete(key)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    // Never touch anything but a plain same-origin GET — checkout,
    // admin writes, and every Supabase/Stripe/CDN call must always go
    // straight to the network untouched, both because caching a POST
    // makes no sense and because intercepting a cross-origin payment or
    // auth request here is exactly the kind of thing that turns a
    // convenience feature into a hard-to-diagnose bug.
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    if (req.mode === 'navigate') {
        // Network-first for every page load: an online visitor always
        // gets whatever's actually live right now. The cache is updated
        // on every successful load purely so there's something to fall
        // back to — matching this exact URL if it was visited before,
        // else the app shell itself — the one time that matters: no
        // connection at all. event.waitUntil() on the cache write (not
        // just calling caches.open().then(...) and letting it dangle) is
        // deliberate — without it, nothing stops the browser from
        // suspending this worker's extended lifetime the instant
        // respondWith's own promise resolves, which can kill the write
        // before it actually finishes and leave the cache never
        // populated at all.
        event.respondWith(
            fetch(req)
                .then((res) => {
                    // Only ever cache a genuine success — an unmatched
                    // path (a stale/renamed URL, or a real 404) would
                    // otherwise get cached as if it were the real page,
                    // and then keep being served for that URL forever,
                    // including once it's fixed and actually resolves.
                    if (res.ok) {
                        const copy = res.clone();
                        event.waitUntil(caches.open(SW_CACHE_VERSION).then((cache) => cache.put(req, copy)));
                    }
                    return res;
                })
                .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
        );
        return;
    }

    // Same-origin static assets (icons, images) — cache-first for speed,
    // refreshing the cache in the background so next time is current.
    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req)
                .then((res) => {
                    if (res.ok) {
                        const copy = res.clone();
                        event.waitUntil(caches.open(SW_CACHE_VERSION).then((cache) => cache.put(req, copy)));
                    }
                    return res;
                })
                .catch(() => cached);
            return cached || network;
        })
    );
});
