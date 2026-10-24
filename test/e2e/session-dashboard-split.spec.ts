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

async function setup(page: Page, events: Record<string, unknown[]> = {}) {
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
      return route.fulfill({ json: { events: events[session!.jid] ?? [], busy: false, hasMore: false, session } });
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

test('the outer band of the dashboard drops beside everything', async ({ page }, info) => {
  const errors = await setup(page);
  const grid = (await page.locator('#dashboard-grid').boundingBox())!;
  const header = page.locator(`.dashboard-pane[data-jid="${NOTES}"] .dashboard-pane-header`);
  const h = (await header.boundingBox())!;

  // Far right, over the stacked Hay layout / Browser column: a full-height
  // column of its own instead of a split of either pane.
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(grid.x + grid.width - 60, grid.y + grid.height / 2, { steps: 15 });
  await page.mouse.move(grid.x + grid.width - 10, grid.y + grid.height / 2, { steps: 5 });
  const preview = page.locator('#dashboard-drop-preview');
  await expect(preview).toContainText('最右側');
  await page.waitForTimeout(350); // the preview box glides to its new rect
  await page.screenshot({ path: info.outputPath('10-edge-right-hover.png') });
  const p = (await preview.boundingBox())!;
  expect(p.height).toBeGreaterThan(grid.height - 20);
  expect(p.x + p.width).toBeGreaterThan(grid.x + grid.width - 12);
  await page.mouse.up();
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath('11-edge-right-after.png') });
  expect(shape(await savedGroups(page))).toEqual([[PIWEB], [HAY, BROWSER], [NOTES]]);
  const notes = await box(page, NOTES);
  expect(notes.height).toBeGreaterThan(grid.height - 4);
  expect(notes.x + notes.width).toBeGreaterThan(grid.x + grid.width - 4);
  expect(Math.abs(notes.width - grid.width / 3)).toBeLessThan(24);

  // Bottom edge: a full-width row under the whole layout.
  const h2 = (await page
    .locator(`.dashboard-pane[data-jid="${PIWEB}"] .dashboard-pane-header`)
    .boundingBox())!;
  await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
  await page.mouse.down();
  await page.mouse.move(grid.x + grid.width / 2, grid.y + grid.height - 60, { steps: 15 });
  await page.mouse.move(grid.x + grid.width / 2, grid.y + grid.height - 6, { steps: 5 });
  await expect(preview).toContainText('最下方');
  await page.mouse.up();
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath('12-edge-bottom-after.png') });
  const piweb = await box(page, PIWEB);
  expect(piweb.width).toBeGreaterThan(grid.width - 4);
  expect(piweb.y + piweb.height).toBeGreaterThan(grid.y + grid.height - 4);
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('piweb.dashboard')!));
  expect(saved.direction).toBe('column');
  expect(shape(saved.groups)).toEqual([[[HAY, BROWSER], NOTES], [PIWEB]]);

  // A drag that starts on a header and stays there does not trip the top band.
  const h3 = (await page
    .locator(`.dashboard-pane[data-jid="${HAY}"] .dashboard-pane-header`)
    .boundingBox())!;
  await page.mouse.move(h3.x + 40, h3.y + h3.height / 2);
  await page.mouse.down();
  await page.mouse.move(h3.x + 80, h3.y + h3.height / 2, { steps: 8 });
  await expect(preview).not.toContainText('最上方');
  await page.mouse.up();
  expect(errors).toEqual([]);
});

test('thirds of the pane under the pointer pick the split, no edge band needed', async ({ page }, info) => {
  const errors = await setup(page);
  const header = page.locator(`.dashboard-pane[data-jid="${NOTES}"] .dashboard-pane-header`);
  const h = (await header.boundingBox())!;
  const t = await box(page, PIWEB);
  const label = page.locator('#dashboard-drop-label');
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  // Most of these used to sit in the 20%..80% swap box; only the middle third swaps now,
  // and the top/bottom thirds win the corners.
  for (const [relX, relY, text] of [
    [0.5, 0.5, '交換'],
    [0.5, 0.62, '交換'],
    [0.5, 0.7, '下方'],
    [0.5, 0.3, '上方'],
    [0.72, 0.55, '右側'],
    [0.28, 0.45, '左側'],
    [0.15, 0.25, '上方'],
    [0.85, 0.8, '下方'],
  ] as const) {
    await page.mouse.move(t.x + t.width * relX, t.y + t.height * relY, { steps: 6 });
    await expect(label).toContainText(text);
  }
  await page.mouse.move(t.x + t.width * 0.5, t.y + t.height * 0.7, { steps: 6 });
  await expect(label).toContainText('下方');
  await page.screenshot({ path: info.outputPath('20-bottom-from-center.png') });
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect(shape(await savedGroups(page))).toEqual([[PIWEB, NOTES], [HAY, BROWSER]]);
  expect(errors).toEqual([]);
});

test('a mouse selection in a pane offers 引用, which quotes it into that pane', async ({ page }, info) => {
  const lines = Array.from({ length: 40 }, (_, i) => `Log line ${i + 1}: selectable text`).join('\n\n');
  const errors = await setup(page, {
    [BROWSER]: [{ id: 1, kind: 'message', role: 'assistant', content: lines, files: [], createdAt: '2026-10-21T01:00:00Z' }],
  });
  const pane = page.locator(`.dashboard-pane[data-jid="${BROWSER}"]`);
  const scroller = pane.locator('.dashboard-pane-messages');
  await expect(pane.locator('.msg-text p').first()).toBeVisible();
  await page.waitForTimeout(800);
  const line = await pane.evaluate((p) => {
    const sc = p.querySelector('.dashboard-pane-messages')!.getBoundingClientRect();
    for (const el of p.querySelectorAll('.dashboard-pane-messages .msg-text p')) {
      const r = el.getBoundingClientRect();
      if (r.top >= sc.top + 80 && r.bottom <= sc.bottom - 4) return { x: r.left, y: r.top + r.height / 2, text: el.textContent! };
    }
    throw new Error('no visible line');
  });
  const top = await scroller.evaluate((e) => e.scrollTop);
  await page.mouse.move(line.x + 2, line.y);
  await page.mouse.down();
  await page.mouse.move(line.x + 80, line.y, { steps: 8 });
  await page.mouse.up();
  const actions = page.locator('#selection-actions');
  await expect(actions).toBeVisible();
  // The click ending the drag does not bring the card, which would scroll the
  // selection away; the pill sits just under the selected line.
  await page.waitForTimeout(500);
  expect(await scroller.evaluate((e) => e.scrollTop)).toBe(top);
  const pill = (await actions.boundingBox())!;
  expect(pill.y).toBeGreaterThan(line.y);
  expect(pill.y).toBeLessThan(line.y + 60);
  expect(await pane.locator('.pane-quote-preview').isVisible()).toBe(false);
  await page.screenshot({ path: info.outputPath('30-pane-selection.png') });
  await page.locator('#selection-quote').click();
  await expect(pane.locator('.pane-quote-preview')).toBeVisible();
  await expect(pane.locator('.pane-quote-preview .quote-preview-text')).toContainText(line.text.slice(0, 4));
  await expect(pane.locator('textarea')).toBeFocused();
  expect(errors).toEqual([]);
});

test('a pane too narrow for its icons keeps ⋯, whose menu carries what dropped out', async ({ page }, info) => {
  const errors = await setup(page);
  const notes = page.locator(`.dashboard-pane[data-jid="${NOTES}"]`);
  // Wide: the icons are in the header, so the menu does not repeat them.
  await notes.locator('.pane-more-btn').click();
  for (const action of ['model', 'thinking', 'close'])
    await expect(notes.locator(`.pane-more-menu [data-action="${action}"]`)).toBeHidden();
  await notes.locator('.pane-more-btn').click();
  await expect(notes.locator('.pane-more-menu')).toBeHidden();

  for (const width of [700, 480]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(300);
    for (const jid of [NOTES, PIWEB, HAY]) {
      const pane = page.locator(`.dashboard-pane[data-jid="${jid}"]`);
      const header = (await pane.locator('.dashboard-pane-header').boundingBox())!;
      const more = (await pane.locator('.pane-more-btn').boundingBox())!;
      // One row, ⋯ fully inside it (it once wrapped under the header's clip).
      expect(header.height).toBeLessThanOrEqual(45);
      expect(more.x + more.width).toBeLessThanOrEqual(header.x + header.width + 0.5);
      expect(more.y + more.height).toBeLessThanOrEqual(header.y + header.height + 0.5);
      expect((await pane.locator('.pane-session-name').boundingBox())!.width).toBeGreaterThan(20);
    }
    await page.screenshot({ path: info.outputPath(`narrow-${width}.png`) });
  }
  await notes.locator('.pane-more-btn').click();
  for (const action of ['model', 'thinking', 'close'])
    await expect(notes.locator(`.pane-more-menu [data-action="${action}"]`)).toBeVisible();
  await page.waitForTimeout(250); // menu-in
  const menu = (await notes.locator('.pane-more-menu').boundingBox())!;
  const paneBox = (await notes.boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(paneBox.x);
  expect(menu.x + menu.width).toBeLessThanOrEqual(paneBox.x + paneBox.width);
  await page.screenshot({ path: info.outputPath('narrow-menu.png') });
  await notes.locator('.pane-more-menu [data-action="close"]').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(3);
  await expect(page.locator(`.dashboard-pane[data-jid="${NOTES}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});
