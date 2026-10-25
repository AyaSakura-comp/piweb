import { expect, test, type Page } from 'playwright/test';

// In the Dashboard a session-list tap tiles that session and flashes its pane;
// the pane's expand button (or a double click on its header) zooms it to the
// whole stage and back on a spring, without leaving the Dashboard.
const names = ['Notes', 'Piweb', 'Hay layout', 'Browser', 'Extra'];
const sessions = names.map((name, i) => ({
  jid: `web:z${i}`,
  name,
  folder: `web_z${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: `2026-10-21 01:${String(30 - i).padStart(2, '0')}:00`,
}));
const [NOTES, PIWEB, HAY, BROWSER, EXTRA] = sessions.map((s) => s.jid);
const events = Object.fromEntries(
  sessions.map((s) => [
    s.jid,
    Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      kind: 'message',
      role: i % 2 ? 'assistant' : 'user',
      content: `${s.name} message ${i + 1}: ${'lorem ipsum dolor sit amet '.repeat(3)}`,
      files: [],
      createdAt: '2026-10-21T01:00:00Z',
    })),
  ]),
);

// Wide enough that a pane shows its own expand button (it folds into ⋯ below 460px).
test.use({ viewport: { width: 1920, height: 1000 }, isMobile: false, hasTouch: false });

async function setup(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ([layout]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('piweb.dashboard', JSON.stringify(layout));
      }
    },
    [
      {
        direction: 'row',
        updatedAt: Date.now(),
        groups: [
          { weight: 1, items: [{ jid: NOTES, weight: 1 }] },
          { weight: 1, items: [{ jid: PIWEB, weight: 1 }] },
          {
            weight: 1,
            items: [
              { jid: HAY, weight: 1 },
              { jid: BROWSER, weight: 1 },
            ],
          },
        ],
      },
    ],
  );
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => s.jid === path.split('/')[3]);
      return route.fulfill({
        json: { events: events[session!.jid] ?? [], busy: false, hasMore: false, session },
      });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  await page.locator('#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(4);
  return errors;
}

const pane = (page: Page, jid: string) => page.locator(`.dashboard-pane[data-jid="${jid}"]`);
const row = (page: Page, jid: string) =>
  page.locator(`#session-list .session-item[data-jid="${jid}"]`);
const rect = (page: Page, jid: string) =>
  pane(page, jid).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
const gridRect = (page: Page) =>
  page.locator('.dashboard-grid').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
const transformOf = (page: Page, jid: string) =>
  pane(page, jid).evaluate((el) => getComputedStyle(el).transform);

/** A point on the header's bare space: not the name, not a button. */
async function headerBlank(page: Page, jid: string) {
  return pane(page, jid).evaluate((el) => {
    const header = el.querySelector('.dashboard-pane-header')!.getBoundingClientRect();
    const actions = el.querySelector('.dashboard-pane-actions')!.getBoundingClientRect();
    const y = header.top + header.height / 2;
    for (let x = actions.left - 2; x > header.left; x -= 4) {
      const hit = document.elementFromPoint(x, y);
      if (hit && !hit.closest('button, input, .pane-session-name')) return { x, y };
    }
    throw new Error('no blank header space');
  });
}

test('a session-list tap tiles the session and flashes its pane, staying in the Dashboard', async ({
  page,
}, info) => {
  const errors = await setup(page);

  await row(page, EXTRA).click();
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await expect(page.locator('.dashboard-pane')).toHaveCount(5);
  await expect(pane(page, EXTRA)).toHaveClass(/composer-active/);
  await expect(pane(page, EXTRA)).toHaveClass(/pane-locating/);
  await page.waitForTimeout(150);
  await page.screenshot({ path: info.outputPath('locate-new.png') });
  await expect(pane(page, EXTRA)).not.toHaveClass(/pane-locating/, { timeout: 2000 });

  // Already tiled: no new pane, the card moves there and the pane flashes.
  await row(page, HAY).click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(5);
  await expect(pane(page, HAY)).toHaveClass(/composer-active/);
  await expect(pane(page, HAY)).toHaveClass(/pane-locating/);
  await page.waitForTimeout(120);
  await page.screenshot({ path: info.outputPath('locate-existing.png') });
  await expect(page.locator('#dashboard-view')).toBeVisible();
  expect(errors).toEqual([]);
});

test('expand zooms a pane to the stage on a spring and back, without leaving the Dashboard', async ({
  page,
}, info) => {
  const errors = await setup(page);
  const tile = await rect(page, PIWEB);
  const stage = await gridRect(page);

  await pane(page, PIWEB).locator('.pane-expand-btn').click();
  await page.waitForTimeout(90);
  expect(await transformOf(page, PIWEB)).not.toBe('none'); // still growing
  await page.screenshot({ path: info.outputPath('zoom-in-mid.png') });
  await page.waitForTimeout(700);
  expect(await transformOf(page, PIWEB)).toBe('matrix(1, 0, 0, 1, 0, 0)');

  await expect(page.locator('#dashboard-view')).toBeVisible();
  await expect(pane(page, PIWEB)).toHaveClass(/pane-zoomed/);
  for (const other of [NOTES, HAY, BROWSER]) await expect(pane(page, other)).toBeHidden();
  const zoomed = await rect(page, PIWEB);
  expect(Math.abs(zoomed.width - stage.width)).toBeLessThan(2);
  expect(Math.abs(zoomed.height - stage.height)).toBeLessThan(2);
  await expect(pane(page, PIWEB).locator('.pane-expand-btn')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({ path: info.outputPath('zoomed.png') });

  // Shrinking back is animated too, and every pane returns to its tile.
  await pane(page, PIWEB).locator('.pane-expand-btn').click();
  await page.waitForTimeout(90);
  expect(await transformOf(page, PIWEB)).not.toBe('none');
  await page.screenshot({ path: info.outputPath('zoom-out-mid.png') });
  await page.waitForTimeout(700);
  for (const other of [NOTES, HAY, BROWSER]) await expect(pane(page, other)).toBeVisible();
  const back = await rect(page, PIWEB);
  expect(Math.abs(back.left - tile.left)).toBeLessThan(2);
  expect(Math.abs(back.width - tile.width)).toBeLessThan(2);
  await expect(page.locator('.dashboard-grid')).not.toHaveClass(/zoom-moving|has-zoom/);
  expect(errors).toEqual([]);
});

test('a double click on the pane header zooms and restores it', async ({ page }) => {
  const errors = await setup(page);
  const tile = await rect(page, HAY);
  const at = await headerBlank(page, HAY);

  await page.mouse.dblclick(at.x, at.y);
  await expect(pane(page, HAY)).toHaveClass(/pane-zoomed/);
  await expect(pane(page, NOTES)).toBeHidden();
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await page.waitForTimeout(700);

  const again = await headerBlank(page, HAY);
  await page.mouse.dblclick(again.x, again.y);
  await expect(pane(page, HAY)).not.toHaveClass(/pane-zoomed/);
  await page.waitForTimeout(700);
  const back = await rect(page, HAY);
  expect(Math.abs(back.top - tile.top)).toBeLessThan(2);
  expect(Math.abs(back.height - tile.height)).toBeLessThan(2);

  // Zoomed, picking another session from the list shows the tiles again.
  const third = await headerBlank(page, HAY);
  await page.mouse.dblclick(third.x, third.y);
  await expect(pane(page, HAY)).toHaveClass(/pane-zoomed/);
  await row(page, NOTES).click();
  await expect(pane(page, NOTES)).toBeVisible();
  await expect(pane(page, HAY)).not.toHaveClass(/pane-zoomed/);
  expect(errors).toEqual([]);
});

test.describe('two-finger pane drag (touch)', () => {
  test.use({ hasTouch: true });

  test('two fingers on a pane drag it onto another pane and swap them', async ({ page }, info) => {
    const errors = await setup(page);
    const client = await page.context().newCDPSession(page);
    const from = await rect(page, NOTES);
    const to = await rect(page, BROWSER);
    const touch = (type: string, x: number, y: number) =>
      client.send('Input.dispatchTouchEvent', {
        type,
        touchPoints:
          type === 'touchEnd'
            ? []
            : [
                { x: x - 30, y, id: 1 },
                { x: x + 30, y, id: 2 },
              ],
      });

    const sx = from.left + from.width / 2;
    const sy = from.top + from.height / 2;
    const ex = to.left + to.width / 2;
    const ey = to.top + to.height / 2;
    await touch('touchStart', sx, sy);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', sx + ((ex - sx) * i) / 12, sy + ((ey - sy) * i) / 12);
    }
    await expect(page.locator('.dashboard-drag-ghost')).toBeVisible();
    await expect(page.locator('.dashboard-drop-preview')).toBeVisible();
    await page.screenshot({ path: info.outputPath('two-finger-drag.png') });
    await touch('touchEnd', ex, ey);
    await page.waitForTimeout(700);

    await expect(page.locator('.dashboard-drag-ghost')).toHaveCount(0);
    const notesNow = await rect(page, NOTES);
    const browserNow = await rect(page, BROWSER);
    expect(Math.abs(notesNow.left - to.left)).toBeLessThan(2);
    expect(Math.abs(notesNow.top - to.top)).toBeLessThan(2);
    expect(Math.abs(browserNow.left - from.left)).toBeLessThan(2);
    expect(
      await page.evaluate(() => document.body.classList.contains('dashboard-pointer-dragging')),
    ).toBe(false);
    expect(errors).toEqual([]);
  });
});
