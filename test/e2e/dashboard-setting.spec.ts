import { expect, test, type Page } from 'playwright/test';

// Settings → Dashboard (2026-10-27): turned off, every way into the Dashboard
// goes away (drawer entry, topbar button, row tile buttons, dragging a row in)
// and an open Dashboard gives way to the chat. The tiled layout is kept for
// when it is turned back on. Per browser.
const sessions = ['Torch NPU', 'Piweb', 'Hay'].map((name, i) => ({
  jid: `web:d${i}`,
  name,
  folder: `web_d${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: `2026-10-27 08:${String(50 - i * 10).padStart(2, '0')}:00`,
}));

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith('/api/')) {
      if (path.endsWith('hot-keywords.json')) return route.fulfill({ json: { items: [] } });
      return route.continue().catch(() => {});
    }
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => s.jid === path.split('/')[3])!;
      const events = [
        { id: 1, kind: 'message', role: 'user', content: `${session.name} question`, files: [] },
        { id: 2, kind: 'message', role: 'assistant', content: `${session.name} answer`, files: [] },
      ].map((e) => ({ ...e, createdAt: '2026-10-27T08:00:00Z' }));
      return route.fulfill({ json: { events, busy: false, hasMore: false, session } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
}

const row = (page: Page, name: string) => page.locator('#session-list .session-item', { hasText: name });

async function toggleDashboardSetting(page: Page) {
  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#btn-dashboard-enabled').click();
  await page.locator('#btn-settings-close').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('off hides every way in, leaves an open Dashboard, survives a reload, and on brings the layout back', async ({
    page,
  }, info) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await setup(page);
    await page.goto('/');
    await expect(page.locator('#messages')).toContainText('Torch NPU answer');

    const entry = page.locator('#btn-dashboard-home');
    const topbar = page.locator('#btn-topbar-dashboard');
    const tiles = page.locator('#session-list .session-tile-btn');
    await expect(entry).toBeVisible();
    await expect(topbar).toBeVisible();
    await expect(tiles).toHaveCount(3);
    await expect(tiles.first()).toBeVisible();
    await expect(page.locator('#btn-dashboard-enabled')).toHaveAttribute('aria-checked', 'true');

    // Tile two sessions, then turn the Dashboard off while it is open.
    await row(page, 'Piweb').locator('.session-tile-btn').click();
    await row(page, 'Hay').locator('.session-tile-btn').click();
    await expect(page.locator('#dashboard-view')).toBeVisible();
    await expect(page.locator('.dashboard-pane')).toHaveCount(2);

    await toggleDashboardSetting(page);
    await expect(page.locator('#btn-dashboard-enabled')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#btn-dashboard-enabled')).toHaveAttribute('aria-label', 'Dashboard，關閉');
    await expect(page.locator('#dashboard-view')).toBeHidden();
    await expect(page.locator('#messages')).toBeVisible();
    await expect(entry).toBeHidden();
    await expect(topbar).toBeHidden();
    for (const tile of await tiles.all()) await expect(tile).toBeHidden();
    await expect(page.locator('#session-list .session-item.in-dashboard')).toHaveCount(0);
    await expect(row(page, 'Piweb')).toHaveAttribute('draggable', 'false');
    await page.screenshot({ path: info.outputPath('off.png') });

    // A row tap opens the chat; dragging a row onto the chat tiles nothing.
    await row(page, 'Piweb').click();
    await expect(page.locator('#messages')).toContainText('Piweb answer');
    await row(page, 'Hay').dragTo(page.locator('#messages'));
    await expect(page.locator('#dashboard-view')).toBeHidden();

    // Per browser: still off after a reload.
    await page.reload();
    await expect(page.locator('#messages')).toContainText('answer');
    await expect(page.locator('#btn-dashboard-enabled')).toHaveAttribute('aria-checked', 'false');
    await expect(entry).toBeHidden();
    await expect(topbar).toBeHidden();
    await expect(row(page, 'Hay').locator('.session-tile-btn')).toBeHidden();

    // Back on: the ways in return and the tiled layout is where it was.
    await toggleDashboardSetting(page);
    await expect(page.locator('#btn-dashboard-enabled')).toHaveAttribute('aria-checked', 'true');
    await expect(entry).toBeVisible();
    await expect(topbar).toBeVisible();
    await expect(page.locator('#session-list .session-item.in-dashboard')).toHaveCount(2);
    await entry.click();
    await expect(page.locator('#dashboard-view')).toBeVisible();
    await expect(page.locator('.dashboard-pane')).toHaveCount(2);
    expect(errors).toEqual([]);
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  /** A finger sliding a drawer row sideways, which drags it into the Dashboard. */
  const swipeRow = (page: Page, name: string) =>
    row(page, name).evaluate((item) => {
      const r = item.getBoundingClientRect();
      const init = { pointerId: 41, pointerType: 'touch', button: 0, bubbles: true, cancelable: true };
      const sx = r.x + 40;
      const sy = r.y + r.height / 2;
      item.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: sx, clientY: sy }));
      for (let i = 1; i <= 8; i++) {
        window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: sx + i * 25, clientY: sy }));
      }
      // Mid-drag: the row's ghost follows the finger.
      const dragging = Boolean(document.querySelector('.dashboard-drag-ghost'));
      window.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: sx + 200, clientY: sy }));
      return dragging;
    });

  test('off, a sideways finger drag on a row no longer opens the Dashboard', async ({ page }) => {
    test.setTimeout(60_000);
    await setup(page);
    await page.goto('/');
    await expect(page.locator('#messages')).toContainText('Torch NPU answer');
    await page.locator('#btn-menu').click();
    await expect(row(page, 'Hay')).toBeVisible();

    // On (the default) the drag opens the Dashboard.
    expect(await swipeRow(page, 'Hay')).toBe(true);
    await expect(page.locator('#dashboard-view')).toBeVisible();
    await page.locator('#btn-dashboard-drawer').click();
    await expect(page.locator('#btn-dashboard-home')).toBeVisible();
    await page.locator('#btn-dashboard-home').click();
    await expect(page.locator('#dashboard-view')).toBeHidden();

    // The drawer is still open over the chat; Settings is at its foot.
    await toggleDashboardSetting(page);
    await expect(page.locator('#btn-dashboard-enabled')).toHaveAttribute('aria-checked', 'false');
    if (!(await row(page, 'Hay').isVisible())) await page.locator('#btn-menu').click();
    await expect(page.locator('#btn-dashboard-home')).toBeHidden();
    expect(await swipeRow(page, 'Hay')).toBe(false);
    await page.waitForTimeout(300);
    await expect(page.locator('#dashboard-view')).toBeHidden();
  });
});
