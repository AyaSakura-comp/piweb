import { expect, test, type CDPSession, type Page } from 'playwright/test';

// 2026-11-03 "Session list scroll has no 120fps": a non-passive touchmove
// listener on the document (the edge drags') put every touch on the page,
// the drawer's list included, behind the main thread before it could scroll,
// and the 5s session poll rebuilt every row even when nothing had changed.
const now = Date.now();
const ago = (minutes: number) =>
  new Date(now - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const makeSessions = (busyJid = '') =>
  Array.from({ length: 40 }, (_, i) => ({
    jid: `web:s${i}`,
    name: `Session ${i}`,
    folder: `web_s${i}`,
    kind: 'standard',
    deleted: false,
    badge: { label: 'OPUS', kind: 'claude' },
    busy: `web:s${i}` === busyJid,
    lastReplyId: 2,
    lastActivity: ago(i * 7 + 1),
  }));

async function boot(page: Page, live: { sessions: ReturnType<typeof makeSessions> }) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem(
      'piweb.seen',
      JSON.stringify(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`web:s${i}`, 2]))),
    );
  });
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: live.sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') {
      return route.fulfill({ json: request.method() === 'GET' ? { layout: null } : { ok: true } });
    }
    if (path.endsWith('/events')) {
      const session = live.sessions.find((s) => s.jid === path.split('/')[3]);
      return route.fulfill({ json: { events: [], busy: false, session, hasMore: false } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Session 0');
  return errors;
}

async function touch(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: Math.round(from.x + ((to.x - from.x) * step) / 8),
          y: Math.round(from.y + ((to.y - from.y) * step) / 8),
        },
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const drawer = (page: Page) => page.locator('.drawer');

test('nothing on or above the session list can hold its scroll for script', async ({ page }) => {
  const errors = await boot(page, { sessions: makeSessions() });
  const cdp = await page.context().newCDPSession(page);
  const blocking: string[] = [];
  // The list, every ancestor, the document and the window.
  for (const expression of [
    "document.getElementById('session-list')",
    "document.getElementById('drawer')",
    "document.getElementById('app')",
    'document.body',
    'document.documentElement',
    'document',
    'window',
  ]) {
    const { result } = await cdp.send('Runtime.evaluate', { expression });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId!,
    });
    for (const l of listeners) {
      if (['touchstart', 'touchmove', 'wheel', 'mousewheel'].includes(l.type) && !l.passive) {
        blocking.push(`${expression}: ${l.type}`);
      }
    }
  }
  expect(blocking).toEqual([]);
  expect(errors).toEqual([]);
});

test('the list scrolls, a sideways drag on it closes the drawer, the left edge opens it', async ({
  page,
}, info) => {
  const errors = await boot(page, { sessions: makeSessions() });
  const cdp = await page.context().newCDPSession(page);

  // In from the left edge: still claimed and followed (main view's listener).
  await touch(cdp, { x: 4, y: 400 }, { x: 260, y: 405 });
  await expect(drawer(page)).toHaveClass(/open/);
  await page.waitForTimeout(250);

  // Up and down: the list scrolls.
  const list = page.locator('#session-list');
  await cdp.send('Input.synthesizeScrollGesture', {
    x: 140,
    y: 600,
    yDistance: -400,
    gestureSourceType: 'touch',
    speed: 1600,
  });
  await expect.poll(() => list.evaluate((n) => n.scrollTop)).toBeGreaterThan(100);
  await expect(drawer(page)).toHaveClass(/open/);
  await page.screenshot({ path: info.outputPath('list-scrolled.png') });

  // Sideways across the list: the drawer goes back, the list does not move.
  const settled = async () => {
    let last = -1;
    for (;;) {
      const now = await list.evaluate((n) => n.scrollTop);
      if (now === last) return now;
      last = now;
      await page.waitForTimeout(150);
    }
  };
  const top = await settled();
  await touch(cdp, { x: 240, y: 500 }, { x: 20, y: 506 });
  await expect(drawer(page)).not.toHaveClass(/open/);
  expect(Math.abs((await list.evaluate((n) => n.scrollTop)) - top)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test('the 5s poll leaves an unchanged list alone and redraws a changed one', async ({ page }) => {
  const live = { sessions: makeSessions() };
  const errors = await boot(page, live);
  await page.locator('#btn-menu').tap();
  await expect(drawer(page)).toHaveClass(/open/);
  await page.evaluate(() => {
    const w = window as unknown as { rowsReplaced: number };
    w.rowsReplaced = 0;
    new MutationObserver((records) => {
      for (const r of records) w.rowsReplaced += r.removedNodes.length;
    }).observe(document.getElementById('session-list')!, { childList: true });
  });
  const replaced = () =>
    page.evaluate(() => (window as unknown as { rowsReplaced: number }).rowsReplaced);

  // At least one poll with the same sessions: no row is touched.
  const polled = page.waitForResponse((r) => r.url().endsWith('/api/sessions'), { timeout: 8000 });
  await polled;
  await page.waitForTimeout(200);
  expect(await replaced()).toBe(0);

  // One session starts working: the next poll shows its spinner.
  live.sessions = makeSessions('web:s3');
  await expect(
    page.locator('.session-item[data-jid="web:s3"] .work-spinner'),
  ).toBeVisible({ timeout: 8000 });
  expect(await replaced()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
