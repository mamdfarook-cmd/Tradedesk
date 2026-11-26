/* TradeDesk notification service worker v1.0 */
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

/* Background alerts sent by the TradeDesk server (Web Push) - shown even when no TradeDesk tab is open. */
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: 'TradeDesk', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'TradeDesk', {
    body: d.body || '', tag: d.tag || 'tradedesk', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' }
  }));
});

/* The browser can replace a push subscription (expiry, key rotation). Sign the new one up with the server at once - before
   27 Nov 2026 alerts stopped until TradeDesk was opened again. */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const k = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
      if (!k || !k.publicKey) return;
      const pad = '='.repeat((4 - k.publicKey.length % 4) % 4), raw = atob((k.publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(raw, c => c.charCodeAt(0));
      const sub = event.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    } catch (e) {}
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        try {
          await client.focus();
          if ('navigate' in client) await client.navigate(targetUrl);
          return;
        } catch (e) {}
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
