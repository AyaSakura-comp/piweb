import { expect, test, type Page } from 'playwright/test';

// Tapping a pane to give it the input card grows it to reading size: an
// 80-column reply line and at least 160px of transcript above the card. The
// next pane tapped gets the room instead, and the first goes back to its size.
const sessions = Array.from({ length: 9 }, (_, i) => ({
  jid: `web:r${i}`,
  name: `Pane ${i + 1}`,
  folder: `web_r${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 4,
  lastActivity: `2026-11-12 01:${String(30 - i).padStart(2, '0')}:00`,
}));
const jids = sessions.map((s) => s.jid);
const events = (jid: string) =>
  Array.from({ length: 4 }, (_, i) => ({
    id: i + 1,
    kind: 'message',
    role: i % 2 ? 'assistant' : 'user',
    content: `${jid} message ${i + 1}: ${'words '.repeat(30)}`,
    files: [],
    createdAt: '2026-11-12T01:00:00Z',
  }));

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

async function setup(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const layout = {
    direction: 'row',
    updatedAt: Date.now(),
    groups: [0, 1, 2].map((c) => ({
      weight: 1,
      items: [0, 1, 2].map((r) => ({ jid: jids[c * 3 + r], weight: 1 })),
    })),
  };
  await page.addInitScript(
    ([saved, first]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('piweb.dashboard', JSON.stringify(saved));
        localStorage.setItem('piweb.dashboard.composer', first);
      }
    },
    [layout, jids[0]] as const,
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
        json: { events: events(session!.jid), busy: false, hasMore: false, session },
      });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  await page.locator('#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(9);
  return errors;
}

const pane = (page: Page, jid: string) => page.locator(`.dashboard-pane[data-jid="${jid}"]`);

/** A pane's reply width against 80ch in the reply font, its transcript height
 *  and its size, once no pane is animating. */
const measure = (page: Page, jid: string) =>
  page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`.dashboard-pane[data-jid="${id}"]`)!;
    if (document.querySelector('.dashboard-pane')?.getAnimations().length) return null;
    if (el.getAnimations().length) return null;
    const text = [...el.querySelectorAll<HTMLElement>('.msg:not(.msg-user) .msg-text')][0];
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:80ch;height:1px';
    text.append(probe);
    const ch80 = probe.offsetWidth;
    probe.remove();
    return {
      textWidth: text.clientWidth,
      ch80,
      transcript: el.querySelector<HTMLElement>('.dashboard-pane-messages')!.clientHeight,
      width: el.offsetWidth,
      height: el.offsetHeight,
    };
  }, jid);

const settled = async (page: Page, jid: string) => {
  await expect.poll(() => measure(page, jid), { timeout: 5000 }).not.toBeNull();
  await page.waitForTimeout(150);
  return (await measure(page, jid))!;
};

test('a tapped pane grows to an 80-column line and 160px of transcript', async ({ page }, info) => {
  const errors = await setup(page);
  const target = jids[4]; // the middle of the 3×3 grid
  await expect(pane(page, target).locator('.msg-text').first()).toBeVisible();
  const before = await settled(page, target);
  // The tile is too small to begin with, or this test proves nothing.
  expect(before.textWidth).toBeLessThan(before.ch80);

  await pane(page, target).locator('.dashboard-pane-transcript').click();
  await expect(pane(page, target)).toHaveClass(/composer-active/);
  const grown = await settled(page, target);
  expect(grown.textWidth).toBeGreaterThanOrEqual(grown.ch80 - 1);
  expect(grown.transcript).toBeGreaterThanOrEqual(159);
  // Every other pane keeps at least its minimum size.
  const others = await Promise.all(jids.filter((j) => j !== target).map((j) => settled(page, j)));
  for (const o of others) {
    expect(o.width).toBeGreaterThanOrEqual(139);
    expect(o.height).toBeGreaterThanOrEqual(94);
  }
  await page.screenshot({ path: info.outputPath('reading-fit-grown.png') });

  // Another pane takes the room; the first goes back to its tile.
  const next = jids[0];
  await pane(page, next).locator('.dashboard-pane-transcript').click();
  await expect(pane(page, next)).toHaveClass(/composer-active/);
  const nextGrown = await settled(page, next);
  expect(nextGrown.textWidth).toBeGreaterThanOrEqual(nextGrown.ch80 - 1);
  expect(nextGrown.transcript).toBeGreaterThanOrEqual(159);
  // The first pane's growth was undone before the next one took its room:
  // its rows are even again, and its column gave up as much as the right one.
  const back = await settled(page, target);
  const rightTwin = await settled(page, jids[7]);
  expect(Math.abs(back.height - before.height)).toBeLessThan(3);
  expect(Math.abs(back.width - rightTwin.width)).toBeLessThan(3);
  await page.screenshot({ path: info.outputPath('reading-fit-moved.png') });

  expect(errors).toEqual([]);
});

test('a pane already big enough keeps the layout as it is', async ({ page }) => {
  const errors = await setup(page);
  // Equalize, then zoom out to two columns' worth by closing panes: simpler to
  // check that a tap on a roomy pane does not touch the saved layout.
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('piweb.dashboard')!);
    saved.groups = [saved.groups[0]];
    saved.groups[0].items = saved.groups[0].items.slice(0, 2);
    saved.updatedAt = Date.now() + 1000;
    localStorage.setItem('piweb.dashboard', JSON.stringify(saved));
  });
  await page.reload();
  await page.locator('#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(2);
  const layoutBefore = await page.evaluate(() => localStorage.getItem('piweb.dashboard'));
  const [, second] = jids;
  await expect(pane(page, second).locator('.msg-text').first()).toBeVisible();
  await pane(page, second).locator('.dashboard-pane-transcript').click();
  await expect(pane(page, second)).toHaveClass(/composer-active/);
  await page.waitForTimeout(600);
  const layoutAfter = await page.evaluate(() => localStorage.getItem('piweb.dashboard'));
  expect(JSON.parse(layoutAfter!).groups).toEqual(JSON.parse(layoutBefore!).groups);
  expect(errors).toEqual([]);
});
