import { readFileSync } from 'node:fs';
import { expect, test, type Page } from 'playwright/test';

// iPhone recording 2026-10-27: opening the app took ~10s, blank and then "no
// session", while every endpoint answered in <70ms on the server. Each request
// from the phone is a tailnet round trip (0.2-1s over a DERP relay), and boot
// awaited ~9 of them in a row: the page, three import levels, then /api/me,
// commands+models, sessions, trash and the session's events. The head now
// starts boot's GETs and modulepreloads the whole import graph, so after the
// page everything rides one round trip.
const RTT = 500;
const now = Date.now();
const ago = (minutes: number) =>
  new Date(now - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const sessions = ['Torch NPU', 'Piweb', 'Hay'].map((name, i) => ({
  jid: `web:p${i}`,
  name,
  folder: `web_p${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: ago(i * 10),
}));

interface Fixture {
  starts: { path: string; at: number }[];
  /** Bumped per events request, so a stale response is visible in the text. */
  served: Map<string, number>;
  authed: boolean;
}

async function setup(page: Page): Promise<Fixture> {
  const fx: Fixture = { starts: [], served: new Map(), authed: true };
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  // The context, not the page: once sw.js controls the page, the page itself is
  // fetched by the worker, which page.route never sees.
  await page.context().route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    fx.starts.push({ path: path + url.search, at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, RTT));
    if (!path.startsWith('/api/')) {
      if (path.endsWith('hot-keywords.json')) return route.fulfill({ json: { items: [] } });
      return route.continue().catch(() => {});
    }
    if (path === '/api/me') return route.fulfill({ json: { authed: fx.authed } });
    if (path === '/api/login') {
      fx.authed = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (!fx.authed) return route.fulfill({ status: 401, json: { error: 'Not authenticated' } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path.endsWith('/events')) {
      const jid = path.split('/')[3];
      const session = sessions.find((s) => s.jid === jid)!;
      const n = (fx.served.get(jid) ?? 0) + 1;
      fx.served.set(jid, n);
      const events = [
        { id: 1, kind: 'message', role: 'user', content: `${session.name} question`, files: [] },
        { id: 2, kind: 'message', role: 'assistant', content: `${session.name} answer #${n}`, files: [] },
      ].map((e) => ({ ...e, createdAt: '2026-10-27T08:00:00Z' }));
      return route.fulfill({ json: { events, busy: false, hasMore: false, session } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  return fx;
}

// The app script as index.html names it, `?v=` included.
const appScript = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8').match(
  /<script src="([^"]+)" type="module"><\/script>/,
)![1];

const bootPaths = [
  '/api/me',
  '/api/commands',
  '/api/models',
  '/api/sessions',
  '/api/sessions/deleted',
  '/api/sessions/web:p0/events?limit=50',
];

test('after the page, boot needs one round trip: scripts, modules and its API calls start together', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fx = await setup(page);
  // The first visit learns which session boot opens (piweb.bootJid).
  await page.goto('/');
  await expect(page.locator('#messages')).toContainText('Torch NPU answer');

  fx.starts.length = 0;
  const t0 = Date.now();
  await page.reload();
  await expect(page.locator('#messages')).toContainText('Torch NPU answer');
  const shown = Date.now() - t0;

  const page0 = fx.starts.find((s) => s.path === '/')!.at;
  const firstWave = page0 + RTT; // the page's response
  const startOf = (path: string) => fx.starts.find((s) => s.path === path)?.at;
  for (const path of [...bootPaths, appScript, '/selection-bubble.js']) {
    // Leaf modules and every boot request leave as soon as the page arrives.
    expect(startOf(path), path).toBeLessThan(firstWave + RTT / 2);
  }
  // Each boot GET went out once: the prefetch was taken, not repeated.
  for (const path of bootPaths) {
    expect(fx.starts.filter((s) => s.path === path), path).toHaveLength(1);
  }
  // Page + one wave (+ the scripts' run) — the old chain needed nine.
  expect(shown).toBeLessThan(4 * RTT);
  expect(errors).toEqual([]);
});

test('a prefetch boot did not take is dropped, never served later', async ({ page }) => {
  test.setTimeout(60_000);
  const fx = await setup(page);
  // Predict a session boot will not open: the head prefetches Hay's events.
  await page.addInitScript(() => localStorage.setItem('piweb.bootJid', 'web:p2'));
  await page.goto('/');
  await expect(page.locator('#messages')).toContainText('Torch NPU answer #1');
  await expect.poll(() => fx.served.get('web:p2')).toBe(1);

  await page.locator('#btn-menu').click();
  await page.locator('#session-list .session-item', { hasText: 'Hay' }).click();
  // Opening it later fetches afresh rather than taking boot's leftover.
  await expect(page.locator('#messages')).toContainText('Hay answer #2');
  expect(fx.served.get('web:p2')).toBe(2);
});

test('after the login gate, boot fetches afresh instead of reusing the 401s', async ({ page }) => {
  test.setTimeout(60_000);
  const fx = await setup(page);
  fx.authed = false;
  await page.goto('/');
  await expect(page.locator('#login')).toBeVisible();
  await page.locator('#login-token').fill('secret');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#messages')).toContainText('Torch NPU answer');
  await expect(page.locator('#login')).toBeHidden();
});
