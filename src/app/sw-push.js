
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
    const url = new URL(event.notification.data && event.notification.data.url || './', self.registration.scope).href;
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
