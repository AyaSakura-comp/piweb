import { expect, test } from 'playwright/test';

test('sidebar keeps spinning for child-only work and stops when children finish', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const session = {
    jid: 'web:spinner', name: 'Subagent work', kind: 'standard',
    busy: false, subagentsBusy: true, model: '', provider: '', lastReplyId: 0,
  };
  const other = { ...session, jid: 'web:other', name: 'Other child work' };
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session, other] } });
    if (path.endsWith('/events')) return route.fulfill({ json: { events: [], busy: session.busy, session } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: busy\ndata: {"busy":false}\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await page.locator('#btn-menu').click();
  const row = page.locator('.session-item').filter({ hasText: session.name });
  const otherRow = page.locator('.session-item').filter({ hasText: other.name });
  await expect(row.locator('.work-spinner')).toBeVisible();
  await expect(otherRow.locator('.work-spinner')).toBeVisible();
  await expect(page.locator('#btn-stop')).toBeHidden();
  await page.screenshot({ path: info.outputPath('01-child-only.png') });
  await expect.poll(() => row.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.left >= 0 && r.right <= innerWidth && !!hit && node.contains(hit);
  })).toBe(true);
  session.subagentsBusy = false;
  other.subagentsBusy = false;
  await expect(row.locator('.work-spinner')).toHaveCount(0, { timeout: 10000 });
  await expect(otherRow.locator('.work-spinner')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('02-completed.png') });
  session.busy = true;
  await expect(row.locator('.work-spinner')).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: info.outputPath('03-parent-only.png') });
  expect(errors).toEqual([]);
});
