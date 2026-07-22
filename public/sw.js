/**
 * Service worker — exists solely to receive Web Push.
 *
 * iOS will not deliver push to a page without one, and it must be served from
 * the root so its scope covers the whole app.
 *
 * Deliberately no fetch handler: caching the app shell would serve a stale UI
 * after a redeploy, and this is a personal tool on a fast local network where
 * offline support buys nothing.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'piweb', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'piweb';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/piweb/icon-192.png',
      badge: '/icons/piweb/icon-192.png',
      // Collapse per session: ten replies in one session should not stack ten
      // notifications, but a different session must still be its own.
      tag: data.jid || 'piweb',
      renotify: true,
      data: { jid: data.jid || '' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const jid = event.notification.data && event.notification.data.jid;
  const url = jid ? `/?session=${encodeURIComponent(jid)}` : '/';

  // Focus an existing window rather than opening a second copy of the app.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          if (jid && 'postMessage' in client) client.postMessage({ type: 'open-session', jid });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
