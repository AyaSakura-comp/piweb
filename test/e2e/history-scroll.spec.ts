import { expect, test, type Page, type Route } from 'playwright/test';

const SESSION_ID = 'web:history-fixture';
const PAGE_SIZE = 15;

function event(id: number) {
  return {
    id,
    kind: 'message',
    role: id % 4 === 0 ? 'user' : 'assistant',
    content: `History message ${id}\n\nA deterministic second paragraph keeps every row tall enough to exercise mobile paging.`,
    files: [],
    createdAt: '2026-08-24 12:00:00',
  };
}

function events(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => event(from + index));
}

async function installHistoryApi(page: Page) {
  let olderRequests = 0;
  const pendingReleases: Array<() => void> = [];

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/sessions') {
      return route.fulfill({
        json: {
          sessions: [
            {
              jid: SESSION_ID,
              name: 'History continuity',
              busy: false,
              lastActivity: '2026-08-24 12:00:00',
              lastReplyId: 150,
              model: '',
              thinking: '',
              badge: null,
            },
          ],
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
      const before = Number(url.searchParams.get('before') || 0);
      if (!before) {
        return route.fulfill({
          json: { events: events(121, 150), busy: false, hasMore: true, partial: null },
        });
      }

      olderRequests += 1;
      await new Promise<void>((resolve) => pendingReleases.push(resolve));
      const pageEnd = before - 1;
      const pageStart = Math.max(1, pageEnd - PAGE_SIZE + 1);
      return route.fulfill({
        json: {
          events: events(pageStart, pageEnd),
          busy: false,
          hasMore: pageStart > 1,
          partial: null,
        },
      });
    }

    return route.fulfill({ status: 404, json: { error: `Unhandled fixture route: ${path}` } });
  });

  return {
    requestCount: () => olderRequests,
    releaseNext: () => {
      const release = pendingReleases.shift();
      if (!release) throw new Error('No older-history request is waiting');
      release();
    },
  };
}

async function firstVisibleMessage(page: Page) {
  return page.locator('#messages').evaluate((messages) => {
    const viewport = messages.getBoundingClientRect();
    const rows = Array.from(
      messages.querySelectorAll<HTMLElement>(':scope > .msg, :scope > .event'),
    );
    const row = rows.find(
      (candidate) => candidate.getBoundingClientRect().bottom > viewport.top + 1,
    );
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { text: row.textContent || '', top: rect.top - viewport.top };
  });
}

async function stableVisibleAnchor(page: Page) {
  return page.locator('#messages').evaluate((messages) => {
    const viewport = messages.getBoundingClientRect();
    const rows = Array.from(
      messages.querySelectorAll<HTMLElement>(':scope > .msg, :scope > .event'),
    );
    const row = rows.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= viewport.top + 60 && rect.bottom <= viewport.bottom - 60;
    });
    if (!row) return null;
    return { text: row.textContent || '', top: row.getBoundingClientRect().top - viewport.top };
  });
}

async function messageTop(page: Page, text: string) {
  return page.locator('#messages').evaluate((messages, expectedText) => {
    const viewport = messages.getBoundingClientRect();
    const rows = Array.from(
      messages.querySelectorAll<HTMLElement>(':scope > .msg, :scope > .event'),
    );
    const row = rows.find((candidate) => candidate.textContent === expectedText);
    return row ? row.getBoundingClientRect().top - viewport.top : null;
  }, text);
}

async function stopTouchMomentum(page: Page): Promise<void> {
  const box = await page.locator('#messages').boundingBox();
  expect(box).not.toBeNull();
  const session = await page.context().newCDPSession(page);
  const point = {
    x: Math.round(box!.x + box!.width / 2),
    y: Math.round(box!.y + box!.height / 2),
  };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await page.locator('#messages').evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function swipeTowardOlderHistory(page: Page): Promise<void> {
  const box = await page.locator('#messages').boundingBox();
  expect(box).not.toBeNull();
  const session = await page.context().newCDPSession(page);
  const x = Math.round(box!.x + box!.width / 2);
  const startY = Math.round(box!.y + box!.height * 0.28);
  const endY = Math.round(box!.y + box!.height * 0.82);

  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: startY }],
  });
  for (let step = 1; step <= 8; step += 1) {
    const y = Math.round(startY + ((endY - startY) * step) / 8);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y }],
    });
    await page.waitForTimeout(18);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

test('continuous upward history reading prefetches and keeps the visible passage anchored', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const historyApi = await installHistoryApi(page);
  await page.goto('/');
  const messages = page.locator('#messages');
  await expect(messages.getByText('History message 150', { exact: false })).toBeVisible();

  await swipeTowardOlderHistory(page);
  await swipeTowardOlderHistory(page);
  await expect.poll(historyApi.requestCount).toBe(1);
  await stopTouchMomentum(page);

  const anchorBefore = await stableVisibleAnchor(page);
  expect(anchorBefore).not.toBeNull();
  historyApi.releaseNext();
  await expect(messages.getByText('History message 106', { exact: false })).toBeAttached();

  const anchorAfterTop = await messageTop(page, anchorBefore!.text);
  expect(anchorAfterTop).not.toBeNull();
  expect(Math.abs((anchorAfterTop ?? 0) - anchorBefore!.top)).toBeLessThanOrEqual(2);

  const geometry = await messages.evaluate((scroller) => {
    const rect = scroller.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(390);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(844);
  expect(geometry.scrollTop).toBeGreaterThan(0);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.documentOverflow).toBe(0);

  await page.screenshot({
    path: testInfo.outputPath('01-history-page-prefetched.png'),
    animations: 'disabled',
  });

  for (let swipe = 0; swipe < 3 && historyApi.requestCount() < 2; swipe += 1) {
    await swipeTowardOlderHistory(page);
  }
  await expect.poll(historyApi.requestCount).toBe(2);
  const movingAnchorBefore = await stableVisibleAnchor(page);
  expect(movingAnchorBefore).not.toBeNull();
  historyApi.releaseNext();
  await expect(messages.getByText('History message 91', { exact: false })).toBeAttached();
  const movingAnchorAfterTop = await messageTop(page, movingAnchorBefore!.text);
  expect(movingAnchorAfterTop).not.toBeNull();
  expect(Math.abs((movingAnchorAfterTop ?? 0) - movingAnchorBefore!.top)).toBeLessThan(
    geometry.clientHeight / 2,
  );
  await stopTouchMomentum(page);
  await page.screenshot({
    path: testInfo.outputPath('02-continuous-reading.png'),
    animations: 'disabled',
  });

  await messages.evaluate((scroller) => {
    const row = Array.from(scroller.children).find((candidate) =>
      candidate.textContent?.includes('History message 112'),
    );
    if (!(row instanceof HTMLElement)) throw new Error('Reviewed history anchor is missing');
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += row.getBoundingClientRect().top - viewport.top;
  });
  await expect
    .poll(async () => firstVisibleMessage(page).then((visible) => visible?.text || ''))
    .toContain('History message 112');
  await page.screenshot({
    path: testInfo.outputPath('03-reviewed-history-baseline.png'),
    animations: 'disabled',
  });
  await expect(messages).toHaveScreenshot('history-scroll-continuity-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.001,
  });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
