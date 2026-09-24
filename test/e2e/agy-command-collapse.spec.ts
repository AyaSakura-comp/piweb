import { expect, test } from 'playwright/test';

test.use({ video: { mode: 'on', size: { width: 1024, height: 768 } } });

const session = {
  jid: 'web:agy-command-collapse',
  name: 'AGY command transcript',
  model: 'agy/gemini-3.1-pro-high',
  provider: 'agy',
  kind: 'standard',
  deleted: false,
  busy: false,
  badge: { label: 'AGY', kind: 'other' },
};
const events = [
  ...Array.from({ length: 9 }, (_, i) => ({
    id: i + 1,
    kind: 'system',
    role: 'agy-command',
    content: JSON.stringify({
      command: i ? `npm run build ${i}` : 'git status -s',
      state: i === 1 ? 'running' : 'returned',
      agent: i === 1 ? 'not-observed' : 'continued',
    }),
    createdAt: '2026-09-24T11:00:00Z',
  })),
  {
    id: 10,
    kind: 'system',
    role: 'pi status',
    content: 'Status remains visible',
    createdAt: '2026-09-24T11:00:00Z',
  },
  {
    id: 11,
    kind: 'error',
    role: 'error',
    content: 'Error remains visible',
    createdAt: '2026-09-24T11:00:00Z',
  },
  {
    id: 12,
    kind: 'system',
    role: 'agy-command',
    content: '{bad json',
    createdAt: '2026-09-24T11:00:00Z',
  },
];

test('AGY background command cards start collapsed, remain expandable, and leave ordinary notices open', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: { events, busy: false, session, hasMore: false, partial: null },
      });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  const cards = page
    .locator('#messages details.event.system')
    .filter({ has: page.locator('summary .label', { hasText: /agy-command|background command/ }) });
  await expect(cards).toHaveCount(10);
  await expect(cards.locator('summary .peek').first()).toContainText('git status -s');
  await expect(cards.nth(1).locator('summary .peek')).toContainText('running');
  expect(
    await cards.evaluateAll((nodes) => nodes.every((node) => !(node as HTMLDetailsElement).open)),
  ).toBe(true);
  await expect(
    page.locator('#messages details.event.system').filter({ hasText: 'Status remains visible' }),
  ).toHaveAttribute('open', '');
  await expect(page.locator('#messages details.event.error')).toHaveAttribute('open', '');
  await page.screenshot({ path: info.outputPath('01-ipad-collapsed.png') });
  await page.waitForTimeout(1000); // Keep the initial state legible in the video evidence.
  await cards.first().locator('summary').click();
  await expect(cards.first()).toHaveAttribute('open', '');
  await expect(cards.nth(1)).not.toHaveAttribute('open', '');
  await page.screenshot({ path: info.outputPath('02-ipad-expanded-on-demand.png') });
  await page.waitForTimeout(1000);
  await cards.first().locator('summary').click();
  await expect(cards.first()).not.toHaveAttribute('open', '');
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(cards).toHaveCount(10);
  expect(
    await cards.evaluateAll((nodes) => nodes.every((node) => !(node as HTMLDetailsElement).open)),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('03-phone-collapsed.png') });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
