import { expect, test, type Page } from 'playwright/test';

// Android gesture navigation owns the left-edge swipe as Back, so on Android
// the session drawer's edge drag rarely reached the page and Back left piweb.
// Back now stays in the app (public/android-back.js): closes what is on top,
// else opens or closes the sessions. These drive the real app in Chromium with
// an Android user agent; history.back() is what the system gesture does.
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const now = Date.now();
const ago = (minutes: number) =>
  new Date(now - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const sessions = ['Browser', 'Piweb', '週末台南'].map((name, i) => ({
  jid: `web:b${i}`,
  name,
  folder: `web_b${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: ago(i * 10 + 1),
}));

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem(
      'piweb.seen',
      JSON.stringify({ 'web:b0': 2, 'web:b1': 2, 'web:b2': 2 }),
    );
  });
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') {
      return route.fulfill({ json: request.method() === 'GET' ? { layout: null } : { ok: true } });
    }
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => s.jid === path.split('/')[3]);
      return route.fulfill({ json: { events: [], busy: false, session, hasMore: false } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Browser');
  return errors;
}

const drawer = (page: Page) => page.locator('.drawer');
const back = (page: Page) => page.evaluate(() => history.back());

test.describe('Android', () => {
  test.use({ userAgent: ANDROID_UA });

  test('Back opens the sessions, Back closes them, and never leaves piweb', async ({
    page,
  }, info) => {
    const errors = await boot(page);
    const url = page.url();
    const lengthBefore = await page.evaluate(() => history.length);

    // Nothing is added before the user has touched the page.
    expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
    await page.locator('#input').tap();
    await page.locator('#input').blur();
    expect(await page.evaluate(() => history.length)).toBe(lengthBefore + 1);

    await back(page);
    await expect(drawer(page)).toHaveClass(/open/);
    await page.waitForTimeout(350);
    await page.screenshot({ path: info.outputPath('01-back-opens-sessions.png') });

    await back(page);
    await expect(drawer(page)).not.toHaveClass(/open/);
    await back(page);
    await expect(drawer(page)).toHaveClass(/open/);

    // Picking a session closes the drawer; the next Back shows them again.
    await page.locator('#session-list .session-item').nth(1).tap();
    await expect(page.locator('#session-name')).toHaveText('Piweb');
    await expect(drawer(page)).not.toHaveClass(/open/);
    await back(page);
    await expect(drawer(page)).toHaveClass(/open/);
    await back(page);
    await expect(drawer(page)).not.toHaveClass(/open/);

    expect(page.url()).toBe(url);
    // One guard entry at most, however many Backs.
    expect(await page.evaluate(() => history.length)).toBe(lengthBefore + 1);
    expect(errors).toEqual([]);
  });

  test('Back closes the ⋯ menu first, without opening the sessions', async ({ page }, info) => {
    const errors = await boot(page);
    await page.locator('#btn-more').tap();
    await expect(page.locator('#more-menu')).toBeVisible();
    await page.screenshot({ path: info.outputPath('02-menu-open.png') });
    await back(page);
    await expect(page.locator('#more-menu')).toBeHidden();
    await expect(drawer(page)).not.toHaveClass(/open/);
    await back(page);
    await expect(drawer(page)).toHaveClass(/open/);
    expect(errors).toEqual([]);
  });

  // On a phone Chrome closes a modal <dialog> on Back itself; history.back()
  // skips that, so this covers the page's own fallback (requestClose).
  test('a modal dialog is closed by Back, not left under the sessions', async ({ page }) => {
    const errors = await boot(page);
    await page.locator('#btn-menu').tap();
    await page.locator('#btn-settings').tap();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await expect(drawer(page)).not.toHaveClass(/open/);
    await back(page);
    await expect(page.locator('#settings-dialog')).toBeHidden();
    await expect(drawer(page)).not.toHaveClass(/open/);
    expect(errors).toEqual([]);
  });
});

test.describe('iPhone', () => {
  test.use({ userAgent: IPHONE_UA });

  test('Back keeps its usual meaning: no entry is added', async ({ page }) => {
    const errors = await boot(page);
    const lengthBefore = await page.evaluate(() => history.length);
    await page.locator('#input').tap();
    await page.locator('#btn-menu').tap();
    expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
    expect(errors).toEqual([]);
  });
});
