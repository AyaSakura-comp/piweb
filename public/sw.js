/**
 * Service worker — receives Web Push, and keeps a launch that cannot reach
 * Piweb from ending on a blank screen.
 *
 * iOS will not deliver push to a page without one, and it must be served from
 * the root so its scope covers the whole app.
 *
 * Nothing is cached: caching the app shell would serve a stale UI after a
 * redeploy. Navigations still go to the network; the worker answers only when
 * the page itself cannot be fetched, with a small page that reconnects and
 * reloads. iOS reloads a Home Screen app whose page it dropped in the
 * background, often while the phone's Tailscale tunnel is still coming back
 * (piweb-ts logged the iPhone's tunnel restarting in the same minutes), and a
 * Home Screen app shows a failed load as a white screen with no error and no
 * retry: the app stayed white until it was force-quit (iPhone recording
 * 2026-10-31).
 */

/** A launch with no answer by then gets the reconnect page instead of white. */
const NAVIGATION_TIMEOUT_MS = 10_000;
/** After a slow launch, the reloads wait as long as they need: a slow link must not loop. */
const PATIENT_MS = 60_000;
let patientUntil = 0;

const RECONNECT_PAGE = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#1e1f22">
<title>piweb</title>
<script>
  try {
    if (localStorage.getItem('piweb.theme') === 'light') {
      document.documentElement.dataset.theme = 'light';
      document.querySelector('meta[name="theme-color"]').content = '#ffffff';
    }
  } catch {}
</script>
<style>
  :root { color-scheme: dark; --bg: #313338; --text-2: #b5bac1; }
  :root[data-theme='light'] { color-scheme: light; --bg: #ffffff; --text-2: #56534d; }
  html, body { height: 100%; margin: 0; background: var(--bg); }
  body {
    display: grid;
    place-items: center;
    padding: 0 16px;
    color: var(--text-2);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
</style>
</head>
<body>
<p role="status">Can't reach Piweb. Reconnecting…</p>
<script>
  // Any answer from the server means the link is back: load the app again.
  let trying = false;
  async function attempt() {
    if (trying || document.visibilityState === 'hidden') return;
    trying = true;
    try {
      await fetch(location.href, { cache: 'no-store', credentials: 'same-origin' });
      location.reload();
      return;
    } catch {}
    trying = false;
  }
  setInterval(attempt, 1500);
  addEventListener('online', attempt);
  document.addEventListener('visibilitychange', attempt);
  attempt();
</script>
</body>
</html>
`;

function reconnectPage() {
  return new Response(RECONNECT_PAGE, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function navigate(request) {
  const network = fetch(request);
  if (Date.now() < patientUntil) return network.catch(reconnectPage);
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([network, slow]);
    if (response) return response;
    patientUntil = Date.now() + PATIENT_MS;
    network.catch(() => {});
    return reconnectPage();
  } catch {
    return reconnectPage();
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.respondWith(navigate(event.request));
});

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
