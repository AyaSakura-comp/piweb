import { expect, test } from 'playwright/test';

// A busy session shows the stop button too; on a 390px phone that used to
// leave the name one letter wide with the provider badge sliding under stop.
test('busy phone topbar keeps the session name readable and the badge clear of stop', async ({
  page,
}, info) => {
  const session = {
    jid: 'web:topbar',
    name: 'Video record and check',
    kind: 'standard',
    deleted: false,
    busy: true,
    model: 'claude-code/opus',
    provider: 'claude-code',
    badge: { label: 'OPUS', kind: 'claude' },
  };
  const received: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: [], busy: true, session, hasMore: false } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/commands') && route.request().method() === 'POST') {
      received.push(route.request().postDataJSON().command);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });

  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await expect(page.locator('#btn-stop')).toBeVisible();
  await expect(page.locator('#header-badge')).toHaveText('OPUS');
  await expect(page.locator('#btn-status')).toBeHidden();
  await expect(page.locator('#btn-gpt-usage')).toBeHidden();

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const badge = rect('#header-badge');
    const stop = rect('#btn-stop');
    const more = rect('#btn-more');
    return {
      nameWidth: rect('#session-name').width,
      badgeClearsStop: badge.right <= stop.left,
      moreFits: more.right <= document.documentElement.clientWidth,
    };
  });
  expect(geometry.nameWidth).toBeGreaterThanOrEqual(80);
  expect(geometry.badgeClearsStop).toBe(true);
  expect(geometry.moreFits).toBe(true);
  await page.locator('.topbar').screenshot({ path: info.outputPath('topbar-busy-390.png') });

  await page.locator('#btn-more').click();
  await expect(page.locator('#mi-status')).toBeVisible();
  await expect(page.locator('#mi-usage')).toBeVisible();
  await page.screenshot({ path: info.outputPath('more-menu-390.png') });
  await page.locator('#mi-status').click();
  await expect.poll(() => received.at(-1)).toBe('pi status');
  expect(errors).toEqual([]);
});
