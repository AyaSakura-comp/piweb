import { expect, test, type Page, type Route } from 'playwright/test';

const PRIMARY = {
  jid: 'web:ordinary',
  name: 'Ordinary session',
  kind: 'standard',
  busy: false,
  lastActivity: '2026-08-29 00:00:00',
  lastReplyId: 0,
  model: 'openai-codex/gpt-5.6-sol',
  thinking: 'xhigh',
  badge: { label: 'SOL', kind: 'sol' },
};

const FALLBACK = {
  ...PRIMARY,
  jid: 'web:other',
  name: 'Other session',
  lastActivity: '2026-08-28 00:00:00',
};

const NOTIFICATION = {
  ...PRIMARY,
  jid: 'web:notification',
  name: 'Notification session',
};

async function installApi(page: Page) {
  let sessions = [PRIMARY, FALLBACK];
  let deleted: Array<{ jid: string; name: string; deletedAt: string; events: number }> = [];

  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path === '/api/push/key') return route.fulfill({ json: { key: '' } });
    if (path === '/api/sessions/deleted') {
      return route.fulfill({ json: { sessions: deleted } });
    }
    if (path === '/api/sessions' && request.method() === 'GET') {
      return route.fulfill({ json: { sessions } });
    }
    if (/^\/api\/sessions\/[^/]+$/.test(path) && request.method() === 'DELETE') {
      const jid = decodeURIComponent(path.split('/')[3]);
      const removed =
        sessions.find((session) => session.jid === jid) ??
        (jid === NOTIFICATION.jid ? NOTIFICATION : undefined);
      sessions = sessions.filter((session) => session.jid !== jid);
      if (removed) {
        deleted = [
          {
            jid: removed.jid,
            name: removed.name,
            deletedAt: '2026-08-29 00:00:00',
            events: 0,
          },
        ];
      }
      return route.fulfill({ json: { ok: true, permanent: false } });
    }
    if (path.endsWith('/events')) {
      const jid = decodeURIComponent(path.split('/')[3]);
      const session =
        sessions.find((candidate) => candidate.jid === jid) ??
        (jid === NOTIFICATION.jid ? NOTIFICATION : undefined);
      const trashed = deleted.find((candidate) => candidate.jid === jid);
      return route.fulfill({
        json: {
          events: [],
          busy: false,
          hasMore: false,
          hasMoreNewer: false,
          partial: null,
          session: {
            jid,
            name: session?.name ?? trashed?.name ?? jid,
            kind: 'standard',
            deleted: Boolean(trashed),
          },
        },
      });
    }
    if (path.endsWith('/stream')) {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: 'retry: 60000\n\n',
      });
    }
    if (path.endsWith('/media')) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ status: 404, json: { error: `Unhandled fixture route: ${path}` } });
  });
}

test('overflow Delete session moves the active session to Recently deleted', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const mutations: Array<{ method: string; pathname: string; search: string }> = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'DELETE' || url.pathname.endsWith('/clear')) {
      mutations.push({ method: request.method(), pathname: url.pathname, search: url.search });
    }
  });
  await installApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(PRIMARY.name);

  await page.locator('#btn-more').click();
  const deleteItem = page.getByRole('menuitem', { name: 'Delete session' });
  await expect(deleteItem).toBeVisible();
  const geometry = await deleteItem.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const width = window.visualViewport?.width ?? window.innerWidth;
    const height = window.visualViewport?.height ?? window.innerHeight;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      width: rect.width,
      height: rect.height,
      contained: rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height,
      reachable: hit === element || Boolean(hit && element.contains(hit)),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry).toMatchObject({ contained: true, reachable: true, overflow: 0 });
  expect(geometry.width).toBeGreaterThanOrEqual(44);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  await page.waitForTimeout(650);
  await page.screenshot({ path: testInfo.outputPath('00-delete-session-menu.png') });

  let confirmation = '';
  page.once('dialog', async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  const expectedPath = `/api/sessions/${encodeURIComponent(PRIMARY.jid)}`;
  const requestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === 'DELETE' && url.pathname === expectedPath && url.search === '';
  });
  await deleteItem.click();
  await requestPromise;
  await expect.poll(() => confirmation).toBe(`Move "${PRIMARY.name}" to Recently deleted?`);

  await expect(page.locator('#session-name')).toHaveText(FALLBACK.name);
  await page.locator('#btn-menu').click();
  await expect(page.getByRole('button', { name: 'Recently deleted 1' })).toBeVisible();
  await expect(page.getByText(PRIMARY.name, { exact: true })).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: testInfo.outputPath('01-session-deleted-fallback.png') });
  await page.waitForTimeout(650);

  expect(mutations).toEqual([{ method: 'DELETE', pathname: expectedPath, search: '' }]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('overflow deletion uses confirmed metadata for an active session absent from the list cache', async ({
  page,
}) => {
  await installApi(page);
  await page.goto('/');
  await page.evaluate((jid) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid } }),
    );
  }, NOTIFICATION.jid);
  await expect(page.locator('#session-name')).toHaveText(NOTIFICATION.name);

  let confirmation = '';
  page.once('dialog', async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  await page.locator('#btn-more').click();
  const expectedPath = `/api/sessions/${encodeURIComponent(NOTIFICATION.jid)}`;
  const deleteRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === 'DELETE' && url.pathname === expectedPath && url.search === '';
  });
  await page.getByRole('menuitem', { name: 'Delete session' }).click();
  await deleteRequest;

  await expect.poll(() => confirmation).toBe(
    `Move "${NOTIFICATION.name}" to Recently deleted?`,
  );
  await expect(page.locator('#session-name')).toHaveText(PRIMARY.name);
});
