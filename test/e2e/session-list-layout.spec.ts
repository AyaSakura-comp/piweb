import { expect, test } from 'playwright/test';

// The drawer row used to carry #, name, badge, spinner, a filled dashboard
// square and a ✕, so on a phone most names were cut to a few characters.
const now = Date.now();
const ago = (minutes: number) =>
  new Date(now - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const definitions = [
  ['Browser', 'OPUS', 'claude', true, 1],
  ['Piweb', 'OPUS', 'claude', false, 4],
  ['dahsboard', 'OPUS', 'claude', false, 12],
  ['Hay layout', 'OPUS', 'claude', false, 45],
  ['Hey', 'OPUS', 'claude', false, 90],
  ['HayDenug', 'SOL', 'sol', false, 300],
  ['週末台南有什麼好玩的地方', 'LOCAL', 'local', false, 1500],
  ['語音輸入法', 'AGY', 'gem', false, 3000],
  ['e4b e2b可選', 'AGY', 'gem', false, 9000],
  ['EmbeddedGemma benchmark', 'SOL', 'sol', false, 20000],
] as const;
const sessions = definitions.map(([name, label, kind, busy, minutes], i) => ({
  jid: `web:l${i}`,
  name,
  folder: `web_l${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label, kind },
  busy,
  lastReplyId: i === 7 ? 9 : 2,
  lastActivity: ago(minutes),
}));

test('phone session list gives names a full line and keeps actions behind a hold', async ({
  page,
}, info) => {
  const errors: string[] = [];
  const deleted: string[] = [];
  const renamed: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.seen', JSON.stringify(Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`web:l${i}`, 2]),
    )));
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
    if (/^\/api\/sessions\/[^/]+$/.test(path) && request.method() === 'DELETE') {
      deleted.push(path.split('/')[3]);
      return route.fulfill({ json: { ok: true } });
    }
    if (/^\/api\/sessions\/[^/]+$/.test(path) && request.method() === 'PATCH') {
      renamed.push(request.postDataJSON().name);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });

  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Browser');
  await page.locator('#btn-menu').click();
  await expect(page.locator('.drawer')).toHaveClass(/open/);
  await page.waitForTimeout(300);
  await expect(page.locator('#session-list .session-item').first()).toHaveClass(/active/);
  await page.screenshot({ path: info.outputPath('00-standard-mode.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('00-standard-mode-light.png') });
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#scrim').click({ position: { x: 360, y: 400 } });
  // Tile three sessions so the list shows the in-dashboard state.
  for (const index of [0, 3, 4]) {
    if (await page.locator('#btn-dashboard-drawer').isVisible()) {
      await page.locator('#btn-dashboard-drawer').click();
    } else {
      await page.locator('#btn-menu').click();
    }
    await page.locator('#session-list .session-item').nth(index).locator('.session-tile-btn').click();
  }
  await page.locator('#btn-dashboard-drawer').click();
  await expect(page.locator('.drawer')).toHaveClass(/open/);
  await page.waitForTimeout(300);

  const rows = page.locator('#session-list .session-item');
  await expect(rows).toHaveCount(10);
  await expect(page.locator('#session-list .del')).toHaveCount(0);
  await expect(rows.nth(0).locator('.work-spinner')).toBeVisible();
  await expect(rows.nth(0).locator('.session-state')).toHaveText('working');
  await expect(rows.nth(7)).toHaveClass(/unread/);
  await expect(rows.nth(7).locator('.unread-dot')).toBeVisible();
  await expect(rows.nth(1).locator('.session-time')).toHaveText('4m');
  await expect(rows.nth(3)).toHaveClass(/in-dashboard/);

  const geometry = await rows.evaluateAll((items) =>
    items.map((item) => {
      const name = item.querySelector('.name') as HTMLElement;
      const tile = item.querySelector('.session-tile-btn')!.getBoundingClientRect();
      const r = item.getBoundingClientRect();
      return {
        height: r.height,
        nameWidth: name.getBoundingClientRect().width,
        truncated: name.scrollWidth > name.clientWidth,
        tileInside: tile.right <= r.right + 0.5 && tile.width >= 40 && tile.height >= 44,
      };
    }),
  );
  for (const row of geometry) {
    expect(row.height).toBeLessThanOrEqual(62);
    expect(row.nameWidth).toBeGreaterThanOrEqual(170);
    expect(row.tileInside).toBe(true);
  }
  // "週末台南有什麼好玩的地方" (12 CJK chars) now fits where it used to be cut at 4.
  expect(geometry[6].truncated).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('01-session-list.png') });

  // Hold a row: Rename / Delete appear anchored to it, nothing navigates.
  const target = rows.nth(2);
  const box = (await target.boundingBox())!;
  await target.dispatchEvent('pointerdown', {
    pointerId: 7, isPrimary: true, button: 0, pointerType: 'touch',
    clientX: box.x + 60, clientY: box.y + box.height / 2,
  });
  await page.waitForTimeout(650);
  await target.dispatchEvent('pointerup', {
    pointerId: 7, isPrimary: true, button: 0, pointerType: 'touch',
    clientX: box.x + 60, clientY: box.y + box.height / 2,
  });
  const menu = page.locator('#session-row-menu');
  await expect(menu).toBeVisible();
  await expect(page.locator('#session-row-menu-title')).toHaveText('dahsboard');
  await expect(target).toHaveClass(/menu-open/);
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.y).toBeGreaterThanOrEqual(box.y + box.height);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('02-row-menu.png') });

  await page.locator('#srm-rename').click();
  await expect(menu).toBeHidden();
  const input = page.locator('#session-list .session-name-edit');
  await expect(input).toBeFocused();
  await input.fill('dashboard');
  await input.press('Enter');
  await expect.poll(() => renamed).toEqual(['dashboard']);

  await rows.nth(5).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete HayDenug' }).click();
  await expect.poll(() => deleted).toEqual(['web:l5']);
  expect(errors).toEqual([]);
});
