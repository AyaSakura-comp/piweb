import { expect, test } from 'playwright/test';

test('mobile host metrics, refresh preference persistence and unavailable sensors', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error);
  });
  const session = {
    jid: 'web:metrics',
    name: 'Host monitoring',
    kind: 'standard',
    deleted: false,
    model: '',
    provider: '',
    busy: false,
    lastReplyId: 0,
  };
  let metrics: object = {
    powerWatts: 43.2,
    powerSource: 'GPU',
    npuPowerWatts: 1.234,
    cpuTemperatureC: 55,
    gpuTemperatureC: 54,
    memoryUsedBytes: 92 * 2 ** 30,
    memoryTotalBytes: 123 * 2 ** 30,
    memoryPercent: 75,
    cpuPercent: 12,
    gpuPercent: 100,
  };
  let requests = 0;
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    (window as any).EventSource = class extends EventTarget {
      close() {}
    };
  });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/system-metrics') {
      requests++;
      return route.fulfill({ json: metrics });
    }
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: { session, events: [], busy: false, hasMoreOlder: false, hasMoreNewer: false },
      });
    if (path === '/api/subscriptions/openai-codex')
      return route.fulfill({ json: { connected: false } });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await page.locator('#btn-menu').click();
  const panel = page.locator('#host-metrics');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('43.2 W');
  await expect(panel).toContainText('NPU power1.23 W');
  await expect.poll(() => requests).toBeGreaterThan(1);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('01-host-metrics.png') });
  await page.locator('#btn-settings').click();
  const input = page.locator('#metrics-interval');
  await expect(input).toHaveValue('1');
  await input.scrollIntoViewIfNeeded();
  expect(
    await input.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.width >= 44 && r.height >= 44 && (hit === element || element.contains(hit));
    }),
  ).toBe(true);
  await input.fill('3');
  await input.press('Tab');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('piweb.metricsIntervalSeconds')))
    .toBe('3');
  await page.screenshot({ path: info.outputPath('02-monitor-settings.png') });
  await page.reload();
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await page.locator('#btn-menu').click();
  await page.locator('#btn-settings').click();
  await expect(input).toHaveValue('3');
  await input.fill('0');
  await input.press('Tab');
  await expect(input).toHaveValue('1');
  await page.locator('#btn-settings-close').click();
  await page.locator('#btn-menu').click();
  await expect(page.locator('#session-name')).toHaveText(session.name);
  metrics = {};
  await expect(panel).toBeHidden({ timeout: 6000 });
  await page.screenshot({ path: info.outputPath('03-unavailable-hidden.png') });
  metrics = { gpuPercent: 0, npuPowerWatts: 0 };
  await expect(panel).toBeVisible();
  await expect(panel).toHaveText('GPU0%NPU power0.00 W');
  const summaryBtn = panel.locator('.host-metrics-summary');
  await expect(summaryBtn).toHaveAttribute('aria-expanded', 'false');
  await summaryBtn.click();
  await expect(summaryBtn).toHaveAttribute('aria-expanded', 'true');
  await summaryBtn.click();
  await expect(summaryBtn).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: info.outputPath('04-recovered.png') });
  expect(errors).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  test(`the drawer's metrics show the disk under RAM (${theme})`, async ({ page }, info) => {
    const session = {
      jid: 'web:metrics-disk',
      name: 'Disk usage',
      kind: 'standard',
      deleted: false,
      model: '',
      provider: '',
      busy: false,
      lastReplyId: 0,
    };
    // This box: 128 GiB RAM, a 3.6 TiB disk (df: 1.4T used, 2.2T available).
    const metrics = {
      powerWatts: 54.1,
      powerSource: 'Package',
      npuPowerWatts: 0,
      cpuTemperatureC: 75,
      gpuTemperatureC: 42,
      memoryUsedBytes: 87 * 2 ** 30,
      memoryTotalBytes: 128 * 2 ** 30,
      memoryPercent: 68,
      diskTotalBytes: 961092611 * 4096,
      diskUsedBytes: 366543227 * 4096,
      diskFreeBytes: 589713414 * 4096,
      diskPercent: 38.33,
      cpuPercent: 5,
      gpuPercent: 100,
    };
    await page.addInitScript((value) => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem('piweb.theme', value);
      (window as any).EventSource = class extends EventTarget {
        close() {}
      };
    }, theme);
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/me') return route.fulfill({ json: { authed: true } });
      if (path === '/api/system-metrics') return route.fulfill({ json: metrics });
      if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
      if (path.endsWith('/events'))
        return route.fulfill({
          json: { session, events: [], busy: false, hasMoreOlder: false, hasMoreNewer: false },
        });
      if (path.startsWith('/api/subscriptions/'))
        return route.fulfill({ json: { connected: false } });
      return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
    });
    await page.goto('/');
    await expect(page.locator('#session-name')).toHaveText(session.name);
    await page.locator('#btn-menu').click();
    const panel = page.locator('#host-metrics');
    await expect(panel.locator('.host-metrics-primary')).toHaveText('GPU100%CPU5%Power54.1 W');
    await panel.locator('.host-metrics-summary').click();
    const details = panel.locator('.host-metrics-details-inner .host-metric');
    await expect(details).toHaveText([
      'NPU power0.00 W',
      'CPU temp75°C',
      'GPU temp42°C',
      'RAM87.0 / 128 GiB',
      'Disk1.4 / 3.6 TiB',
    ]);
    const disk = details.last();
    await expect(disk).toHaveAttribute('title', '38% used, 2.2 TiB free');
    // Disk sits in the left column under GPU temp, label and value on one line,
    // like RAM beside it.
    const box = await disk.evaluate((row) => {
      const r = row.getBoundingClientRect();
      const gpu = row.parentElement!.children[2].getBoundingClientRect();
      const ram = row.parentElement!.children[3].getBoundingClientRect();
      return {
        left: Math.round(r.left - gpu.left),
        below: r.top >= gpu.bottom,
        oneLine: Math.round(r.height) === Math.round(ram.height),
        fits: row.scrollWidth <= row.clientWidth,
      };
    });
    expect(box).toEqual({ left: 0, below: true, oneLine: true, fits: true });
    await page.waitForTimeout(300);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`disk-${theme}.png`) });
  });
}
