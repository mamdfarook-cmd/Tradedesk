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
