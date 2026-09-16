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

// Real OS-level push, phase 2 of the in-app notifications inbox — the
// send-push Edge Function (see supabase/functions/send-push) sends a
// small JSON payload {title, body, link}, encrypted so only this one
// subscribed device can read it; this is where it actually gets turned
// into something the customer sees. Never assume event.data exists (a
// push service is technically allowed to deliver an empty ping), and
// wrap the whole thing in event.waitUntil() for the same reason cache
// writes above are — without it the browser can suspend this worker
// before showNotification() finishes.
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (err) { /* not JSON — show a generic fallback below */ }
    const title = data.title || 'Yo7 Foods';
    const body = data.body || 'You have a new update.';
    const link = data.link || '#/notifications';
    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon: '/favicon-192x192.png',
            badge: '/favicon-192x192.png',
            data: { link },
        })
    );
});

// Tapping the notification should behave like tapping the bell in the
// app itself: reuse an already-open tab if there is one (just navigating
// it, not opening a duplicate) and only open a brand new window if
// nothing was open at all.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const link = (event.notification.data && event.notification.data.link) || '#/notifications';
    const targetUrl = new URL(link, self.registration.scope).href;
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    if ('navigate' in client) client.navigate(targetUrl).catch(() => {});
                    return client.focus();
                }
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        })
    );
});
