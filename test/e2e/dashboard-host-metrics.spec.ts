import { expect, test, type Page } from 'playwright/test';

// 2026-10-31: the drawer's host readings, also in the Dashboard header's empty
// space between the title and the layout switcher, when there is room.
const sessions = ['Hay 回測', 'LFM', 'Qwen v.8', 'Piweb'].map((name, i) => ({
  jid: `web:h${i}`,
  name,
  folder: `web_h${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 0,
  lastActivity: `2026-10-31 05:${String(30 - i).padStart(2, '0')}:00`,
}));
const reading = {
  powerWatts: 39.1,
  powerSource: 'GPU',
  npuPowerWatts: 0,
  cpuTemperatureC: 53,
  gpuTemperatureC: 53,
  memoryUsedBytes: 96.8 * 2 ** 30,
  memoryTotalBytes: 122.8 * 2 ** 30,
  memoryPercent: 79,
  cpuPercent: 2,
  gpuPercent: 100,
};
let metrics: Record<string, unknown>;
test.beforeEach(() => {
  metrics = { ...reading };
});

async function setup(page: Page, { width, height, theme = 'dark' }: { width: number; height: number; theme?: string }) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width, height });
  await page.addInitScript(
    ([layout, t]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem('piweb.theme', t as string);
      localStorage.setItem('piweb.dashboard', JSON.stringify(layout));
    },
    [
      {
        direction: 'row',
        updatedAt: Date.now(),
        groups: [
          { weight: 1, items: [{ jid: sessions[0].jid, weight: 1 }, { jid: sessions[1].jid, weight: 1 }] },
          { weight: 1, items: [{ jid: sessions[2].jid, weight: 1 }, { jid: sessions[3].jid, weight: 1 }] },
        ],
      },
      theme,
    ] as const,
  );
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/system-metrics') return route.fulfill({ json: metrics });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => s.jid === path.split('/')[3]);
      return route.fulfill({ json: { events: [], busy: false, hasMore: false, session } });
    }
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  // The phone's way in is the topbar button; wider screens have the drawer entry.
  await page.locator(width < 768 ? '#btn-topbar-dashboard' : '#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(4);
  return errors;
}

const strip = (page: Page) => page.locator('#dashboard-host-metrics');
const shownLabels = (page: Page) =>
  strip(page).evaluate((n) => [...n.children].filter((c) => !(c as HTMLElement).hidden).map((c) => (c as HTMLElement).dataset.label));

/** Every shown reading lies wholly inside the strip, and the strip between the title and the switcher. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const s = document.getElementById('dashboard-host-metrics')!.getBoundingClientRect();
    const title = document.querySelector('.dashboard-toolbar-title')!.getBoundingClientRect();
    const presets = document.getElementById('dashboard-layout-presets')!.getBoundingClientRect();
    const toolbar = document.querySelector('.dashboard-toolbar')!.getBoundingClientRect();
    const items = [...document.querySelectorAll<HTMLElement>('#dashboard-host-metrics .dashboard-host-metric')]
      .filter((n) => !n.hidden)
      .map((n) => n.getBoundingClientRect());
    return {
      inside: items.every((r) => r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && r.top >= toolbar.top && r.bottom <= toolbar.bottom),
      afterTitle: s.left >= title.right - 0.5,
      beforeSwitcher: s.right <= presets.left + 0.5,
      // The switcher sits midway between the title and the right edge, as before.
      switcherOffset: presets.left - (title.right + (toolbar.right - title.right - presets.width) / 2),
      noPageScroll: document.documentElement.scrollWidth <= innerWidth,
    };
  });

test('iPad landscape: the readings sit between the title and the switcher, fitting the room', async ({ page }, info) => {
  const errors = await setup(page, { width: 1180, height: 820 });
  await expect(strip(page)).not.toHaveAttribute('data-shown', '0');
  const labels = await shownLabels(page);
  // The most important first, in the drawer's own wording.
  expect(labels.slice(0, 3)).toEqual(['GPU', 'CPU', 'Power']);
  await expect(strip(page).locator('[data-label="GPU"] strong')).toHaveText('100%');
  await expect(strip(page).locator('[data-label="Power"] strong')).toHaveText('39.1 W');
  const g = await geometry(page);
  expect(g).toMatchObject({ inside: true, afterTitle: true, beforeSwitcher: true, noPageScroll: true });
  expect(Math.abs(g.switcherOffset)).toBeLessThan(10);
  await page.locator('.dashboard-toolbar').screenshot({ path: info.outputPath('toolbar-1180.png') });
  await page.screenshot({ path: info.outputPath('ipad-landscape.png') });

  // A new sample repaints it, from the same request as the drawer.
  metrics = { ...reading, gpuPercent: 7, powerWatts: 12.5 };
  await expect(strip(page).locator('[data-label="GPU"] strong')).toHaveText('7%', { timeout: 4000 });
  await expect(strip(page).locator('[data-label="Power"] strong')).toHaveText('12.5 W');

  // More room with the drawer away: more readings, still inside.
  const before = labels.length;
  await page.locator('#btn-hide-drawer').click();
  await expect.poll(async () => (await shownLabels(page)).length).toBeGreaterThan(before);
  expect(await geometry(page)).toMatchObject({ inside: true, afterTitle: true, beforeSwitcher: true });
  await page.locator('.dashboard-toolbar').screenshot({ path: info.outputPath('toolbar-1180-no-drawer.png') });
  expect(errors).toEqual([]);
});

test('iPad portrait: fewer readings, dropped from the end, never cut off', async ({ page }, info) => {
  const errors = await setup(page, { width: 820, height: 1180 });
  const labels = await shownLabels(page);
  const all = await strip(page).evaluate((n) => [...n.children].map((c) => (c as HTMLElement).dataset.label));
  expect(labels).toEqual(all.slice(0, labels.length));
  expect(labels.length).toBeLessThan(all.length);
  expect(await geometry(page)).toMatchObject({ inside: true, afterTitle: true, beforeSwitcher: true, noPageScroll: true });
  await page.locator('.dashboard-toolbar').screenshot({ path: info.outputPath('toolbar-820.png') });
  expect(errors).toEqual([]);
});

test('no sensors, or no room: nothing shows, and the switcher keeps its place', async ({ page }) => {
  metrics = {};
  const errors = await setup(page, { width: 1180, height: 820 });
  await page.waitForTimeout(1500);
  await expect(strip(page)).toHaveAttribute('data-shown', '0');
  expect(await strip(page).evaluate((n) => n.children.length)).toBe(0);
  expect(Math.abs((await geometry(page)).switcherOffset)).toBeLessThan(10);
  // Then readings arrive.
  metrics = { ...reading };
  await expect(strip(page)).not.toHaveAttribute('data-shown', '0', { timeout: 4000 });
  expect(errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  test(`toolbar in the ${theme} theme`, async ({ page }, info) => {
    await setup(page, { width: 1180, height: 820, theme });
    await expect(strip(page)).not.toHaveAttribute('data-shown', '0');
    await page.locator('.dashboard-toolbar').screenshot({ path: info.outputPath(`toolbar-${theme}.png`) });
  });
}

test('a phone has no room for them: the strip is not shown, the drawer still has the readings', async ({ page }) => {
  const errors = await setup(page, { width: 390, height: 844 });
  await expect(strip(page)).toBeHidden();
  expect(await geometry(page)).toMatchObject({ noPageScroll: true });
  expect(errors).toEqual([]);
});
