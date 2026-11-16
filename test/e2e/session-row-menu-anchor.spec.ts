import { expect, test, type Page } from 'playwright/test';

// iPad, 2026-11-17: 「有時候 session ui 有 bug」. Holding a drawer row sometimes
// opened Rename / Delete in the top-left corner, its title under the status
// bar, instead of under the row. The menu was placed against the row node the
// hold started on; when the 5 s poll or a busy change re-rendered the list
// during the hold, that node was detached and its box was all zeros.

const sessions = ['Piweb', '遇到這種都會卡死', 'Qwen 3.8', 'Hay 潮汐', '喵享家', 'ts net不能連'].map((name, i) => ({
  jid: `web:a${i}`,
  name,
  folder: `web_a${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: i === 4 ? 'AGY' : 'OPUS', kind: i === 4 ? 'agy' : 'claude' },
  busy: i === 0,
  lastReplyId: 2,
  lastActivity: '2026-11-16 17:00:00',
}));

async function open(page: Page, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width > 600 ? 820 : 844 });
  await page.addInitScript((value) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.theme', value);
    localStorage.setItem('piweb.seen', JSON.stringify(Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`web:a${i}`, 2]),
    )));
  }, theme);
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => s.jid === path.split('/')[3]);
      return route.fulfill({ json: { events: [], busy: false, session, hasMore: false } });
    }
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [], layout: null } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Piweb');
  // A phone opens the drawer; wider screens keep it as a sidebar. (A closed
  // drawer is only slid off-screen, so its rows still count as "visible".)
  if (width < 700) {
    await page.locator('#btn-menu').click();
    await expect(page.locator('.drawer')).toHaveClass(/open/);
  }
  await page.waitForTimeout(350);
  const first = (await page.locator('#session-list .session-item').first().boundingBox())!;
  expect(first.x).toBeGreaterThanOrEqual(0);
}

/** Holds a row; `rerender` swaps the row for a fresh node mid-hold, as a list render does. */
async function hold(page: Page, index: number, rerender: boolean) {
  const row = page.locator('#session-list .session-item').nth(index);
  const box = (await row.boundingBox())!;
  const point = { pointerId: 7, isPrimary: true, button: 0, pointerType: 'touch', clientX: box.x + 60, clientY: box.y + box.height / 2 };
  await row.dispatchEvent('pointerdown', point);
  if (rerender) {
    await page.evaluate((i) => {
      const items = document.querySelectorAll('#session-list .session-item');
      const held = items[i];
      held.replaceWith(held.cloneNode(true));
    }, index);
  }
  await page.waitForTimeout(700);
  return { box, point };
}

for (const [width, theme] of [[390, 'dark'], [390, 'light'], [1024, 'light']] as const) {
  test(`a row re-rendered during the hold still gets its menu beside it (${width}px, ${theme})`, async ({ page }, info) => {
    await open(page, width, theme);
    const { box } = await hold(page, 1, true);
    const menu = page.locator('#session-row-menu');
    await expect(menu).toBeVisible();
    await expect(page.locator('#session-row-menu-title')).toHaveText('遇到這種都會卡死');
    const menuBox = (await menu.boundingBox())!;
    const list = (await page.locator('#session-list').boundingBox())!;
    // Under the held row, inside the drawer: not in the top-left corner.
    expect(menuBox.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(menuBox.y).toBeLessThan(box.y + box.height + 12);
    expect(menuBox.y).toBeGreaterThanOrEqual(list.y);
    expect(menuBox.x).toBeGreaterThanOrEqual(box.x);
    await expect(page.locator('#session-list .session-item').nth(1)).toHaveClass(/menu-open/);
    await page.screenshot({ path: info.outputPath(`row-menu-${width}-${theme}.png`) });
  });
}

test('the menu closes instead of floating when its row is gone', async ({ page }) => {
  await open(page, 390, 'dark');
  await hold(page, 2, false);
  const menu = page.locator('#session-row-menu');
  await expect(menu).toBeVisible();
  // A re-render without the row (deleted elsewhere) has nothing to anchor to.
  sessions.splice(2, 1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(async () => menu.isVisible(), { timeout: 8000 }).toBe(false);
});
