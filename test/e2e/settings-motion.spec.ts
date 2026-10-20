import { expect, test, type Page } from 'playwright/test';

// Settings is a pushed page on a phone: in from the right, out to the right,
// and a finger-following right drag back to the chat (DESIGN.md "Settings motion").
const SESSION = {
  jid: 'web:settings-motion',
  name: 'Settings motion',
  kind: 'standard',
  busy: false,
  lastActivity: '2026-05-19 00:00:00',
  lastReplyId: 0,
  badge: { label: 'OPUS', kind: 'claude' },
};

async function installApi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.theme', 'dark');
  });
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true, via: 'token' } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [SESSION] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/subscriptions/openai-codex')
      return route.fulfill({ json: { provider: 'openai-codex', connected: false, job: null } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: { events: [], busy: false, hasMore: false, session: { ...SESSION, deleted: false } },
      });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
}

const offsetX = (page: Page) =>
  page.locator('#settings-dialog').evaluate((el) => {
    const t = getComputedStyle(el).transform;
    return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m41;
  });

async function openSettings(page: Page) {
  await page.locator('#btn-menu').click();
  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
}

test('settings slides in from the right and back out on close and Escape', async ({
  page,
}, info) => {
  await installApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(SESSION.name);
  const dialog = page.locator('#settings-dialog');

  // Freeze the entrance halfway to look at it.
  await page.locator('#btn-menu').click();
  await page.evaluate(() => {
    const dialogEl = document.getElementById('settings-dialog')!;
    new MutationObserver((_, observer) => {
      if (!dialogEl.open) return;
      observer.disconnect();
      for (const a of dialogEl.getAnimations({ subtree: false })) {
        a.pause();
        a.currentTime = 70;
      }
    }).observe(dialogEl, { attributes: true, attributeFilter: ['open'] });
  });
  await page.locator('#btn-settings').click();
  await expect(dialog).toHaveAttribute('data-motion', 'opening');
  const midEnter = await offsetX(page);
  expect(midEnter).toBeGreaterThan(20);
  expect(midEnter).toBeLessThan(390);
  await page.screenshot({ path: info.outputPath('01-enter-mid.png') });
  await page.evaluate(() =>
    document
      .getElementById('settings-dialog')!
      .getAnimations()
      .forEach((a) => a.play()),
  );
  await expect(dialog).not.toHaveAttribute('data-motion', /.+/);
  expect(await offsetX(page)).toBe(0);
  await page.screenshot({ path: info.outputPath('02-open.png') });

  // Close button: the page leaves to the right before the dialog closes.
  await page.locator('#btn-settings-close').click();
  await expect(dialog).toHaveAttribute('data-motion', 'closing');
  await expect(dialog).toBeHidden();
  expect(
    await page.evaluate(() => document.getElementById('settings-dialog')!.style.transform),
  ).toBe('');

  // Escape leaves the same way instead of vanishing.
  await openSettings(page);
  await expect(dialog).not.toHaveAttribute('data-motion', /.+/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveAttribute('data-motion', 'closing');
  await expect(dialog).toBeHidden();

  // Reopening works after an animated close.
  await openSettings(page);
  await expect(dialog).not.toHaveAttribute('data-motion', /.+/);
  expect(await offsetX(page)).toBe(0);
});

test('a right drag follows the finger and closes settings past 28%', async ({ page }, info) => {
  await installApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(SESSION.name);
  const dialog = page.locator('#settings-dialog');
  await openSettings(page);
  await expect(dialog).not.toHaveAttribute('data-motion', /.+/);

  const touch = await page.context().newCDPSession(page);
  const row = (await page.locator('#btn-theme').boundingBox())!;
  const y = row.y + row.height / 2;
  async function move(points: number[], end = true) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: points[0], y }],
    });
    for (const x of points.slice(1))
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    if (end) await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  // Held mid-drag: the page sits under the finger and the chat shows through.
  await move([40, 60, 90, 130, 170], false);
  await expect(dialog).toHaveAttribute('data-motion', 'dragging');
  expect(Math.round(await offsetX(page))).toBe(130);
  await page.screenshot({ path: info.outputPath('03-drag-held.png') });
  await page.waitForTimeout(300); // a slow release is not a flick
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(dialog).toBeHidden();
  await expect(dialog).not.toHaveAttribute('data-motion', /.+/);

  // A short drag settles back and keeps Settings open; tapping the row did not fire.
  await openSettings(page);
  await expect(dialog).not.toHaveAttribute('data-motion', /.+/);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  await move([40, 60, 80, 95]);
  await expect(dialog).not.toHaveAttribute('data-motion', /.+/);
  await expect(dialog).toBeVisible();
  expect(await offsetX(page)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.dataset.theme ?? '')).toBe(theme);

  // Vertical movement scrolls; it never moves the page sideways.
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 100, y }],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 104, y: y - 40 }],
  });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 130, y: y - 80 }],
  });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await offsetX(page)).toBe(0);
  await expect(dialog).toBeVisible();
});

test('reduced motion opens and closes settings without animating', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(SESSION.name);
  await openSettings(page);
  expect(
    await page.evaluate(() => document.getElementById('settings-dialog')!.getAnimations().length),
  ).toBe(0);
  await page.locator('#btn-settings-close').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
});

test('desktop settings card fades out instead of sliding', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await installApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(SESSION.name);
  if (!(await page.locator('#btn-settings').isVisible())) await page.locator('#btn-menu').click();
  await page.locator('#btn-settings').click();
  const dialog = page.locator('#settings-dialog');
  await expect(dialog).not.toHaveAttribute('data-motion', /.+/);
  await page.locator('#btn-settings-close').click();
  await expect(dialog).toHaveAttribute('data-motion', 'closing');
  expect(await offsetX(page)).toBe(0);
  await expect(dialog).toBeHidden();
});
