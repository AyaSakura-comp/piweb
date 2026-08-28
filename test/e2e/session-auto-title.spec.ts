import { expect, test, type Locator, type Page, type Route } from 'playwright/test';

const EXISTING_SESSION = {
  jid: 'web:existing',
  name: 'Existing session',
  busy: false,
  lastActivity: '2026-08-26 12:00:00',
  lastReplyId: 1,
  model: '',
  thinking: '',
  badge: null,
};

const NEW_SESSION = {
  ...EXISTING_SESSION,
  jid: 'web:auto-title',
  name: 'New session',
  lastActivity: null,
  lastReplyId: 0,
};

async function expectPointerReachable(locator: Locator) {
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      reachable: target === element || Boolean(target && element.contains(target)),
      blocker:
        target instanceof HTMLElement
          ? target.getAttribute('aria-label') || target.id || target.tagName
          : null,
    };
  });
  expect(hit, `pointer blocker: ${hit.blocker}`).toMatchObject({ reachable: true });
}

async function installSessionApi(page: Page) {
  let created = false;
  let messageSent = false;
  let generatedTitle = false;
  const requests: Array<{ method: string; path: string; body: string | null }> = [];

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    requests.push({ method: request.method(), path, body: request.postData() });

    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });

    if (path === '/api/sessions' && request.method() === 'POST') {
      created = true;
      return route.fulfill({ json: { jid: NEW_SESSION.jid, name: NEW_SESSION.name } });
    }
    if (path === '/api/sessions') {
      return route.fulfill({
        json: {
          sessions: created
            ? [
                { ...NEW_SESSION, name: generatedTitle ? '台南兩日遊' : NEW_SESSION.name },
                EXISTING_SESSION,
              ]
            : [EXISTING_SESSION],
        },
      });
    }
    if (path.endsWith('/stream')) {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-store' },
        body: 'retry: 60000\n\n',
      });
    }
    if (path.endsWith('/events')) {
      const isNew = path.includes(encodeURIComponent(NEW_SESSION.jid));
      return route.fulfill({
        json: {
          events:
            isNew && messageSent
              ? [
                  {
                    id: 2,
                    kind: 'message',
                    role: 'user',
                    content: '幫我規劃台南兩日旅行',
                    files: [],
                    createdAt: '2026-08-27 12:00:00',
                  },
                ]
              : [],
          busy: false,
          hasMore: false,
          partial: null,
        },
      });
    }
    if (path === `/api/sessions/${encodeURIComponent(NEW_SESSION.jid)}/messages`) {
      const body = request.postDataJSON() as { text?: string };
      if (body.text !== '幫我規劃台南兩日旅行') {
        return route.fulfill({ status: 400, json: { error: 'Unexpected first prompt' } });
      }
      messageSent = true;
      generatedTitle = true;
      return route.fulfill({ json: { ok: true, sessionTitle: '台南兩日遊' } });
    }

    return route.fulfill({ status: 404, json: { error: `Unhandled fixture route: ${path}` } });
  });

  return { requests };
}

test('new session opens without naming dialog and adopts a one-shot first-prompt title', async ({
  page,
}, testInfo) => {
  const api = await installSessionApi(page);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let unexpectedDialog: string | null = null;
  const targetSizes: Array<{ name: string; width: number; height: number; minimum: number }> = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => failedRequests.push(request.url()));
  page.on('dialog', async (dialog) => {
    unexpectedDialog = dialog.type();
    await dialog.dismiss();
  });

  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(EXISTING_SESSION.name);
  await page.screenshot({ path: testInfo.outputPath('00-existing-session.png') });

  const openSessions = page.getByRole('button', { name: 'Open sessions' });
  await expectPointerReachable(openSessions);
  const openSessionsBox = await openSessions.boundingBox();
  if (openSessionsBox) targetSizes.push({ name: 'Open sessions', minimum: 34, ...openSessionsBox });
  await openSessions.click();
  const drawer = page.getByRole('complementary', { name: 'Sessions' });
  await expect(drawer).toBeVisible();
  // Visibility becomes true before the 180ms slide transition reaches x=0;
  // wait on the actual geometry rather than sleeping or measuring mid-motion.
  await expect
    .poll(() => drawer.evaluate((element) => element.getBoundingClientRect().left))
    .toBe(0);
  const drawerContained = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    return rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height;
  });
  expect(drawerContained).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('01-session-drawer.png') });

  const newSession = page.getByRole('button', { name: 'New session' });
  await expectPointerReachable(newSession);
  const newSessionBox = await newSession.boundingBox();
  if (newSessionBox) targetSizes.push({ name: 'New session', minimum: 38, ...newSessionBox });
  await newSession.click();
  await expect(page.locator('#session-name')).toHaveText('New session');
  // createSession closes the drawer with the same 180ms transition; milestone
  // screenshots must show its settled endpoint, not a half-covered composer.
  await expect
    .poll(() => drawer.evaluate((element) => element.getBoundingClientRect().right))
    .toBe(0);
  expect(unexpectedDialog).toBeNull();
  expect(
    api.requests.some(
      ({ method, path, body }) => method === 'POST' && path === '/api/sessions' && body === null,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('02-created-immediately.png') });

  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill('幫我規劃台南兩日旅行');
  await page.screenshot({ path: testInfo.outputPath('03-first-prompt.png') });
  const send = page.getByRole('button', { name: 'Send' });
  await expectPointerReachable(send);
  const sendBox = await send.boundingBox();
  if (sendBox) targetSizes.push({ name: 'Send', minimum: 38, ...sendBox });
  await send.click();

  // The message response carries the committed in-process title; do not wait
  // for the 5s cross-tab and crash-recovery fallback poll.
  await expect(page.locator('#session-name')).toHaveText('台南兩日遊', { timeout: 1_000 });
  await page.screenshot({ path: testInfo.outputPath('04-auto-title.png') });

  // Reload proves the generated name and first prompt are durable server state,
  // not a client-only optimistic label.
  await page.reload();
  await expect(page.locator('#session-name')).toHaveText('台南兩日遊');
  await expect(page.getByText('幫我規劃台南兩日旅行')).toBeVisible();
  await expect(page).toHaveScreenshot('session-auto-title-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
  });
  await page.screenshot({ path: testInfo.outputPath('05-reloaded-durable-title.png') });

  const titleLength = await page
    .locator('#session-name')
    .evaluate(
      (element) =>
        [
          ...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(
            element.textContent ?? '',
          ),
        ].length,
    );
  expect(titleLength).toBeLessThanOrEqual(10);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);

  expect(targetSizes.map(({ name }) => name)).toEqual(['Open sessions', 'New session', 'Send']);
  for (const target of targetSizes) {
    // The topbar's documented <=420px exception is 34px so six controls and
    // the session title fit; drawer/composer controls keep the standard 38px.
    expect(target.width, `${target.name} width`).toBeGreaterThanOrEqual(target.minimum);
    expect(target.height, `${target.name} height`).toBeGreaterThanOrEqual(target.minimum);
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
