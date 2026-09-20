import { expect, test, type Locator } from 'playwright/test';
async function reachable(target: Locator) {
  expect(
    await target.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.width >= 44 && r.height >= 44 && (hit === e || (!!hit && e.contains(hit)));
    }),
  ).toBe(true);
}
test('Subagents uses normal chat rendering, preserves expanded tools, and isolates navigation', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  let completed = false;
  let listRequests = 0;
  const sessions = ['parent', 'other'].map((name) => ({
    jid: 'web:' + name,
    name,
    kind: 'standard',
    deleted: false,
    model: '',
    thinking: '',
    badge: null,
    busy: false,
    lastReplyId: 0,
  }));
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events: [],
          busy: false,
          hasMore: false,
          session: sessions.find((s) => path.includes(s.jid)),
        },
      });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/subagents') && !url.searchParams.has('child')) {
      listRequests++;
      if (url.searchParams.has('scope'))
        return route.fulfill({ status: 409, json: { error: 'Parent session changed' } });
    }
    if (path.endsWith('/subagents'))
      return route.fulfill({
        json: {
          scope: 'scope',
          children: path.includes('web:other')
            ? []
            : [
                {
                  id: 'child',
                  name: 'Luna worker',
                  model: 'openai-codex/gpt-5.6-luna',
                  state: completed ? 'complete' : 'in progress',
                  eventCount: 3,
                },
              ],
          ...(url.searchParams.has('child')
            ? {
                events: [
                  { rowid: 1, kind: 'tool', role: 'read', content: 'fixture.txt', files: [] },
                  {
                    rowid: 2,
                    kind: 'tool_result',
                    role: 'read',
                    content: 'Safe <script>window.XSS=1</script>',
                    files: [],
                  },
                  ...(completed
                    ? [
                        {
                          rowid: 3,
                          kind: 'message',
                          role: 'assistant',
                          content:
                            '## Luna result\n\n**Verified**\n\n```js\nconst result = 42;\n```',
                          files: [],
                        },
                      ]
                    : []),
                ],
                hasMore: false,
              }
            : {}),
        },
      });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('parent');
  await page.locator('#btn-more').click();
  await reachable(page.locator('#mi-subagents'));
  await page.locator('#mi-subagents').click();
  const dialog = page.getByRole('dialog', { name: 'Subagents' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => listRequests).toBeGreaterThan(1);
  await expect(dialog).not.toContainText('Parent session changed');
  await page.screenshot({ path: info.outputPath('01-list.png') });
  const child = dialog.getByRole('button', { name: /Luna worker/ });
  await reachable(child);
  await child.click();
  await expect(dialog.locator('.event.tool')).toHaveCount(1);
  await dialog.locator('.event.tool summary').click();
  completed = true;
  await expect(dialog.locator('.msg h2')).toHaveText('Luna result');
  await expect(dialog.locator('.event.tool')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => (window as any).XSS)).toBeUndefined();
  await expect(dialog.locator('pre code')).toContainText('const result');
  expect(
    await dialog.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('02-transcript.png') });
  await reachable(dialog.getByRole('button', { name: 'Back to subagents' }));
  await dialog.getByRole('button', { name: 'Back to subagents' }).click();
  await expect(child).toBeVisible();
  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  await page.locator('#btn-more').click();
  await page.locator('#mi-sessions').click();
  await page.locator('.session-item').filter({ hasText: 'other' }).click();
  await page.locator('#btn-more').click();
  await page.locator('#mi-subagents').click();
  await expect(dialog).toContainText('No subagents');
  await expect(dialog).not.toContainText('Luna worker');
  await page.screenshot({ path: info.outputPath('03-isolation.png') });
  expect(errors).toEqual([]);
});
