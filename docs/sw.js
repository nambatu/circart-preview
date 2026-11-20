/* ============================================================
   CIRCArt service worker

   Goal: the app shell and card data work offline, and artwork
   images accumulate in the cache as you play — so a second
   session works on a plane without a 59 MB up-front download.

   Bump CACHE_VERSION on every release. build_deploy.py does it
   for you, so you normally never touch this file.
   ============================================================ */

const CACHE_VERSION = 'preview-20261120-221704';

const SHELL_CACHE  = `circart-shell-${CACHE_VERSION}`;
const IMAGE_CACHE  = `circart-images-${CACHE_VERSION}`;
const ALL_CACHES   = [SHELL_CACHE, IMAGE_CACHE];

const SHELL_ASSETS = [
    './shell.css',
    './shell.js',
    './strings.js',
    './strings-de.js',
    './game.js',
    './dealer.js',
    './collection.js',
    './styles.js',
    './streak.js',
    './onboarding.js',
    './onboarding.css',
    './packs.js',
    './price-deck.json',
    './online.js',
    './preview.js',
    './privacy-en.html',
    './privacy-de.html',
    './impressum.html',
    './changes.html',
    './vendor/fonts.css',
    './vendor/fonts/inter-latin-300-normal.woff2',
    './vendor/fonts/inter-latin-400-normal.woff2',
    './vendor/fonts/inter-latin-500-normal.woff2',
    './vendor/fonts/inter-latin-600-normal.woff2',
    './vendor/fonts/playfair-display-latin-400-italic.woff2',
    './vendor/fonts/playfair-display-latin-400-normal.woff2',
    './vendor/fonts/playfair-display-latin-600-normal.woff2',
    './vendor/supabase.js',
    './',
    './index.html',
    './style.css',
    './pwa.js',
    './artline.json',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

// ---------------------------------------------------------------- install
// Assets are added one at a time: cache.addAll() rejects the whole
// batch if a single file 404s, which would leave the worker unable to
// install at all over one stray filename.
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        await Promise.all(SHELL_ASSETS.map(async (url) => {
            try {
                await cache.add(new Request(url, { cache: 'reload' }));
            } catch (e) {
                console.warn('[sw] could not pre-cache', url, e);
            }
        }));
        await self.skipWaiting();
    })());
});

// --------------------------------------------------------------- activate
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names
                .filter((n) => n.startsWith('circart-') && !ALL_CACHES.includes(n))
                .map((n) => caches.delete(n))
        );
        await self.clients.claim();
    })());
});

// ------------------------------------------------------------------ fetch
async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
    } catch (e) {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        throw e;
    }
}

async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    const fresh = await fetch(request);
    // Opaque responses (cross-origin, no CORS) have status 0 but are
    // still usable from cache, so they are worth keeping.
    if (fresh && (fresh.ok || fresh.type === 'opaque')) {
        cache.put(request, fresh.clone());
    }
    return fresh;
}

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const sameOrigin = url.origin === self.location.origin;

    // Navigations: try the network so a new build is picked up promptly,
    // fall back to the cached shell when offline.
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            const cache = await caches.open(SHELL_CACHE);
            try {
                const fresh = await fetch(request);
                if (fresh && fresh.ok) cache.put(request, fresh.clone());
                return fresh;
            } catch (e) {
                return (await cache.match(request, { ignoreSearch: true })) ||
                       (await cache.match('./index.html')) ||
                       Response.error();
            }
        })());
        return;
    }

    if (sameOrigin) {
        // Card data: app.js requests this with cache:'no-cache' so a data
        // fix reaches players immediately. Network-first preserves that
        // while still allowing offline play from the cached copy.
        if (url.pathname.endsWith('artline.json')) {
            event.respondWith(networkFirst(request, SHELL_CACHE));
            return;
        }

        // Artwork: cache-first, accumulating as you play.
        if ((url.pathname.includes('/images/') || url.pathname.includes('/art/'))) {
            event.respondWith(cacheFirst(request, IMAGE_CACHE));
            return;
        }

        event.respondWith(networkFirst(request, SHELL_CACHE));
        return;
    }

});

// ─── CIRCArt push notifications (appended to sw.js by the build) ─────────────
// The server sends { title, body, url, tag }. Tapping opens (or focuses) the
// app at that game: url ends in ?game=<id>.
self.addEventListener('push', event => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data && event.data.text() }; }
    event.waitUntil(self.registration.showNotification(d.title || 'CIRCArt', {
        body: d.body || '',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: d.tag || 'circart',
        renotify: true,
        data: { url: d.url || './' },
    }));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    let url = new URL(event.notification.data && event.notification.data.url || './', self.registration.scope).href;
    if (!url.startsWith(self.registration.scope)) url = self.registration.scope;   // only ever open our own app
    event.waitUntil((async () => {
        const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const w of wins) {
            if (w.url.startsWith(self.registration.scope) && 'focus' in w) {
                await w.focus();
                w.postMessage({ type: 'circart:open', url });
                return;
            }
        }
        await clients.openWindow(url);
    })());
});
