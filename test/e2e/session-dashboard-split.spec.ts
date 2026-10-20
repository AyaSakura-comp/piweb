import { expect, test, type Page } from 'playwright/test';

// Dropping a pane on the right half of another pane must split THAT pane
// (two panes side by side where it was), not move the dragged pane to a new
// column beside the whole column. Reported from a desktop screen recording:
// Piweb dropped on "Hay layout" (stacked over "Browser") jumped to its own column.
const names = ['Notes', 'Piweb', 'Hay layout', 'Browser'];
const sessions = names.map((name, i) => ({
  jid: `web:p${i}`,
  name,
  folder: `web_p${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: `2026-10-21 01:${String(30 - i).padStart(2, '0')}:00`,
}));
const [NOTES, PIWEB, HAY, BROWSER] = sessions.map((s) => s.jid);

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

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
      return route.fulfill({ json: { events: [], busy: false, hasMore: false, session } });
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

const box = async (page: Page, jid: string) =>
  (await page.locator(`.dashboard-pane[data-jid="${jid}"]`).boundingBox())!;

async function dropOn(page: Page, dragged: string, target: string, relX: number, relY: number) {
  const t = await box(page, target);
  await page
    .locator(`.dashboard-pane[data-jid="${dragged}"] .dashboard-pane-header`)
    .dragTo(page.locator(`.dashboard-pane[data-jid="${target}"]`), {
      targetPosition: { x: t.width * relX, y: t.height * relY },
    });
  await page.waitForTimeout(600); // layout spring settles
}

const savedGroups = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('piweb.dashboard')!).groups);
const shape = (groups: any[]): unknown => groups.map((g) => (g.jid ? g.jid : shape(g.items)));

test('an edge drop splits the target pane, not its whole column', async ({ page }, info) => {
  const errors = await setup(page);
  await page.screenshot({ path: info.outputPath('00-before.png') });

  // Right half of Hay layout: Hay | Piweb side by side, Browser still below both.
  await dropOn(page, PIWEB, HAY, 0.85, 0.5);
  await page.screenshot({ path: info.outputPath('01-split-right.png') });
  const hay = await box(page, HAY);
  const piweb = await box(page, PIWEB);
  const browser = await box(page, BROWSER);
  expect(Math.abs(piweb.y - hay.y)).toBeLessThan(2);
  expect(piweb.x).toBeGreaterThan(hay.x + hay.width - 2);
  expect(browser.y).toBeGreaterThan(hay.y + hay.height - 2);
  // Browser spans the width the two now share.
  expect(Math.abs(browser.x - hay.x)).toBeLessThan(2);
  expect(Math.abs(browser.x + browser.width - (piweb.x + piweb.width))).toBeLessThan(2);
  expect(shape(await savedGroups(page))).toEqual([[NOTES], [[HAY, PIWEB], BROWSER]]);

  // The splitter between the two halves resizes just that pair.
  const splitter = page.locator(`.dashboard-pane[data-jid="${HAY}"] + .dashboard-splitter`);
  await expect(splitter).toBeVisible();
  const s = (await splitter.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 60, s.y + s.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const hayAfter = await box(page, HAY);
  expect(hayAfter.width).toBeGreaterThan(hay.width + 30);
  expect((await box(page, BROWSER)).width).toBeCloseTo(browser.width, 0);

  // The nested split survives a reload.
  await page.reload();
  await page.locator('#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(4);
  const hayReload = await box(page, HAY);
  const piwebReload = await box(page, PIWEB);
  expect(Math.abs(piwebReload.y - hayReload.y)).toBeLessThan(2);
  expect(piwebReload.x).toBeGreaterThan(hayReload.x);

  // Left half works the same way, on the other side.
  await dropOn(page, NOTES, BROWSER, 0.1, 0.5);
  await page.screenshot({ path: info.outputPath('02-split-left.png') });
  expect(shape(await savedGroups(page))).toEqual([
    [
      [HAY, PIWEB],
      [NOTES, BROWSER],
    ],
  ]);
  const notes = await box(page, NOTES);
  const browser2 = await box(page, BROWSER);
  expect(Math.abs(notes.y - browser2.y)).toBeLessThan(2);
  expect(notes.x).toBeLessThan(browser2.x);

  // Top/bottom inside a side-by-side pair split that one pane vertically.
  await dropOn(page, NOTES, PIWEB, 0.5, 0.9);
  await page.screenshot({ path: info.outputPath('03-split-bottom.png') });
  expect(shape(await savedGroups(page))).toEqual([[[HAY, [PIWEB, NOTES]], BROWSER]]);

  // Pulling a pane out collapses the split it leaves behind.
  await dropOn(page, PIWEB, BROWSER, 0.5, 0.92);
  expect(shape(await savedGroups(page))).toEqual([[[HAY, NOTES], BROWSER, PIWEB]]);
  expect(errors).toEqual([]);
});

test('right edge of a full-height column still makes a new column beside it', async ({ page }) => {
  await setup(page);
  const before = await box(page, NOTES);
  await dropOn(page, HAY, NOTES, 0.9, 0.5);
  expect(shape(await savedGroups(page))).toEqual([[NOTES], [HAY], [PIWEB], [BROWSER]]);
  // The two halves share the dropped-on column's space.
  const notes = await box(page, NOTES);
  const hay = await box(page, HAY);
  expect(notes.width + hay.width).toBeLessThan(before.width + 20);
  expect(Math.abs(hay.height - notes.height)).toBeLessThan(2);

  // A top-level column splitter still resizes its two columns.
  const bar = page.getByRole('separator', { name: 'Resize columns 1 and 2' });
  const b = (await bar.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 50, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  expect((await box(page, NOTES)).width).toBeGreaterThan(notes.width + 30);
  const saved = await savedGroups(page);
  expect(saved[0].weight).toBeGreaterThan(saved[1].weight);
});
