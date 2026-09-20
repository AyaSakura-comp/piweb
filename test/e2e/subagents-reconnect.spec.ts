import { expect, test } from 'playwright/test';
test('child reconnect fills more than one page without gaps or duplicate messages', async ({
  page,
}) => {
  let count = 100;
  const session = {
    jid: 'web:catchup',
    name: 'Catchup',
    kind: 'standard',
    deleted: false,
    model: '',
    thinking: '',
    badge: null,
    lastReplyId: 0,
  };
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: [], hasMore: false, busy: false, session } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/subagents')) {
      const after = url.searchParams.get('after');
      const start = after ? Number(after.slice(1)) : Math.max(0, count - 200);
      const end = Math.min(count, start + 200);
      return route.fulfill({
        json: {
          scope: 'parent',
          children: [
            { id: 'child', name: 'Luna catchup', model: 'Luna', state: 'Activity unconfirmed' },
          ],
          ...(url.searchParams.has('child')
            ? {
                events: Array.from({ length: end - start }, (_, j) => ({
                  id: 'e' + (start + j + 1),
                  rowid: start + j + 1,
                  kind: 'message',
                  role: 'assistant',
                  content: 'Message ' + (start + j + 1),
                  files: [],
                })),
                hasMore: start > 0,
                hasMoreNewer: end < count,
              }
            : {}),
        },
      });
    }
    return route.fulfill({ json: { sessions: [], commands: [], models: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Catchup');
  await expect(page.locator('#composer-wrap')).toBeVisible();
  await page.locator('#btn-more').click();
  await page.locator('#mi-subagents').click();
  const dialog = page.getByRole('dialog', { name: 'Subagents' });
  await dialog.getByRole('button', { name: /Luna catchup/ }).click();
  await expect(dialog.locator('.msg')).toHaveCount(100);
  count = 450;
  await expect(dialog.locator('.msg')).toHaveCount(450);
  await expect(dialog.locator('.msg').nth(100)).toHaveText('Message 101');
  await expect(dialog.locator('.msg').last()).toHaveText('Message 450');
});
