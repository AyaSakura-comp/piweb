import { expect, test } from 'playwright/test';
test('command list distinguishes running, output, continuation and lost tracking', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let phase = 0;
  const session = {
    jid: 'web:command-test',
    name: 'AGY command test',
    model: 'agy/test',
    provider: 'agy',
    kind: 'standard',
    deleted: false,
    busy: true,
    badge: { label: 'AGY', kind: 'other' },
  };
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: [], busy: true, session } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/commands-running'))
      return route.fulfill({
        json: {
          commands: [
            {
              id: 'test:1',
              command: 'npm test',
              state: phase === 0 ? 'running' : phase === 3 ? 'unknown' : 'succeeded',
              agent: phase === 2 ? 'continued' : phase === 1 ? 'output-received' : 'not-observed',
              nextAction: phase === 2 ? 'view_file' : undefined,
              output: phase ? '3 tests passed' : '',
              exitCode: phase === 1 || phase === 2 ? 0 : undefined,
              startedAt: Date.now() - 3000,
              updatedAt: Date.now(),
            },
          ],
        },
      });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('AGY command test');
  expect(errors).toEqual([]);
  await page.locator('#btn-more').click();
  const commandMenu = page.locator('#mi-commands-running');
  await expect(commandMenu).toHaveText('背景命令');
  await expect(commandMenu.locator('svg')).toBeVisible();
  await expect
    .poll(() => page.locator('#more-menu').evaluate((el) => getComputedStyle(el).opacity))
    .toBe('1');
  await page.screenshot({ path: info.outputPath('00-agy-menu-icon.png') });
  await commandMenu.click();
  const dialog = page.getByRole('dialog', { name: '背景命令' });
  await expect(dialog.locator('.command-spinner')).toBeVisible();
  expect(
    await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        radius: getComputedStyle(element).borderRadius,
      };
    }),
  ).toEqual({ x: 0, y: 0, width: 390, height: 844, radius: '0px' });
  await page.screenshot({ path: info.outputPath('01-running.png') });
  phase = 1;
  await expect(dialog).toContainText('Exit 0');
  await dialog.locator('summary').click();
  await expect(dialog).toContainText('3 tests passed');
  await expect(dialog.locator('.command-spinner')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('02-output.png') });
  phase = 2;
  await expect(dialog).toContainText('已觀察到 AGY 後續動作：view_file');
  await expect(dialog.locator('details')).toHaveAttribute('open', '');
  await page.screenshot({ path: info.outputPath('03-continued.png') });
  phase = 3;
  await expect(dialog).toContainText('狀態未知／追蹤中斷');
  await page.screenshot({ path: info.outputPath('04-unknown.png') });
  expect(
    await dialog.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    }),
  ).toBe(true);
  await dialog.getByRole('button', { name: '關閉背景命令' }).click();
  await expect(dialog).not.toBeVisible();
  session.model = 'openai-codex/test';
  await page.reload();
  await expect(page.locator('#input')).toBeVisible();
  await page.locator('#btn-more').click();
  await expect(page.locator('#mi-commands-running')).toBeHidden();
  await page.screenshot({ path: info.outputPath('05-non-agy-menu.png') });
  session.model = '';
  await page.reload();
  await expect(page.locator('#input')).toBeVisible();
  await page.locator('#btn-more').click();
  await expect(commandMenu).toBeVisible(); // Runtime provider when no explicit model is selected.
  session.provider = '';
  await page.reload();
  await expect(page.locator('#input')).toBeVisible();
  await page.locator('#btn-more').click();
  await expect(commandMenu).toBeHidden();
  expect(errors).toEqual([]);
});
