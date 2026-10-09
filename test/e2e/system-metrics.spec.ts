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
  await expect(panel).toHaveText('NPU power0.00 WGPU0%');
  await page.screenshot({ path: info.outputPath('04-recovered.png') });
  expect(errors).toEqual([]);
});
