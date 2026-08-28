import { expect, test, type Page, type Route } from 'playwright/test';

const SESSION_ID = 'web:history-fixture';
const TOTAL_EVENTS = 500;
const PAGE_SIZE = 50;
const INITIAL_OLDEST = TOTAL_EVENTS - PAGE_SIZE + 1;
const OLDER_PAGE_COUNT = (INITIAL_OLDEST - 1) / PAGE_SIZE;

function event(id: number) {
  return {
    id,
    kind: 'message',
    role: id % 5 === 0 ? 'user' : 'assistant',
    content: `History message ${id}\n\nThis is one of ${TOTAL_EVENTS} deterministic rows used to stress continuous mobile history paging.`,
    files: [],
    createdAt: '2026-08-24 12:00:00',
  };
}

function events(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => event(from + index));
}

async function installHistoryApi(page: Page, responseDelayMs?: number) {
  let olderRequests = 0;
  const olderRequestQueries: Array<{ before: number; limit: number }> = [];
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
              name: '500-message history stress',
              busy: false,
              lastActivity: '2026-08-24 12:00:00',
              lastReplyId: TOTAL_EVENTS,
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
          json: {
            events: events(INITIAL_OLDEST, TOTAL_EVENTS),
            busy: false,
            hasMore: true,
            partial: null,
            session: {
              jid: SESSION_ID,
              name: '500-message history stress',
              kind: 'standard',
              deleted: false,
            },
          },
        });
      }

      olderRequests += 1;
      olderRequestQueries.push({
        before,
        limit: Number(url.searchParams.get('limit') || 0),
      });
      if (responseDelayMs == null) {
        await new Promise<void>((resolve) => pendingReleases.push(resolve));
      } else {
        await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
      }
      const pageEnd = before - 1;
      const pageStart = Math.max(1, pageEnd - PAGE_SIZE + 1);
      return route.fulfill({
        json: {
          events: events(pageStart, pageEnd),
          busy: false,
          hasMore: pageStart > 1,
          partial: null,
          session: {
            jid: SESSION_ID,
            name: '500-message history stress',
            kind: 'standard',
            deleted: false,
          },
        },
      });
    }

    return route.fulfill({ status: 404, json: { error: `Unhandled fixture route: ${path}` } });
  });

  return {
    requestCount: () => olderRequests,
    requestQueries: () => olderRequestQueries,
    releaseNext: () => {
      const release = pendingReleases.shift();
      if (!release) throw new Error('No older-history request is waiting');
      release();
    },
  };
}

async function stableVisibleAnchor(page: Page) {
  return page.locator('#messages').evaluate((messages) => {
    const viewport = messages.getBoundingClientRect();
    const rows = Array.from(messages.querySelectorAll<HTMLElement>(':scope > .msg'));
    const row = rows.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= viewport.top + 60 && rect.bottom <= viewport.bottom - 60;
    });
    if (!row) return null;
    return { text: row.textContent || '', top: row.getBoundingClientRect().top - viewport.top };
  });
}

async function armPrependAnchorProbe(page: Page, text: string) {
  await page.locator('#messages').evaluate((messages, expectedText) => {
    const row = Array.from(messages.querySelectorAll<HTMLElement>(':scope > .msg')).find(
      (candidate) => candidate.textContent === expectedText,
    );
    if (!row) throw new Error('Prepend anchor row is missing');
    const viewport = messages.getBoundingClientRect();
    const topBefore = row.getBoundingClientRect().top - viewport.top;
    const host = window as Window & { __prependAnchorProbe?: Promise<number> };
    host.__prependAnchorProbe = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const topAfter = row.getBoundingClientRect().top - messages.getBoundingClientRect().top;
            resolve(Math.abs(topAfter - topBefore));
          });
        });
      });
      observer.observe(messages, { childList: true });
    });
  }, text);
}

async function armMovingPrependAnchorProbe(page: Page) {
  return page.locator('#messages').evaluate(async (messages) => {
    const scrollTopBefore = messages.scrollTop;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const scrollDelta = messages.scrollTop - scrollTopBefore;
    const viewport = messages.getBoundingClientRect();
    const row = Array.from(messages.querySelectorAll<HTMLElement>(':scope > .msg')).find(
      (candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.top >= viewport.top + 60 && rect.bottom <= viewport.bottom - 60;
      },
    );
    if (!row) throw new Error('Moving prepend anchor row is missing');
    const topBefore = row.getBoundingClientRect().top - viewport.top;
    const host = window as Window & { __prependAnchorProbe?: Promise<number> };
    host.__prependAnchorProbe = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const topAfter = row.getBoundingClientRect().top - messages.getBoundingClientRect().top;
            resolve(Math.abs(topAfter - topBefore));
          });
        });
      });
      observer.observe(messages, { childList: true });
    });
    return { text: row.textContent || '', top: topBefore, scrollDelta };
  });
}

async function armPartialLoadProbe(page: Page, text: string) {
  await page.locator('#messages').evaluate((messages, expectedText) => {
    const row = Array.from(messages.querySelectorAll<HTMLElement>(':scope > .msg')).find(
      (candidate) => candidate.textContent === expectedText,
    );
    if (!row) throw new Error('Partial-load anchor row is missing');
    const topBefore = row.getBoundingClientRect().top - messages.getBoundingClientRect().top;
    let touchActive = false;
    const onTouchStart = () => {
      touchActive = true;
    };
    const onTouchEnd = () => {
      touchActive = false;
    };
    messages.addEventListener('touchstart', onTouchStart);
    messages.addEventListener('touchend', onTouchEnd);
    const host = window as Window & {
      __partialLoadProbe?: Promise<{ drift: number; touchActiveAtMutation: boolean }>;
    };
    host.__partialLoadProbe = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        const touchActiveAtMutation = touchActive;
        messages.removeEventListener('touchstart', onTouchStart);
        messages.removeEventListener('touchend', onTouchEnd);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const topAfter = row.getBoundingClientRect().top - messages.getBoundingClientRect().top;
            resolve({ drift: Math.abs(topAfter - topBefore), touchActiveAtMutation });
          });
        });
      });
      observer.observe(messages, { childList: true });
    });
  }, text);
}

async function partialLoadProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (
      window as Window & {
        __partialLoadProbe?: Promise<{ drift: number; touchActiveAtMutation: boolean }>;
      }
    ).__partialLoadProbe;
    if (!probe) throw new Error('Partial-load probe was not armed');
    return probe;
  });
}

async function prependAnchorDrift(page: Page) {
  return page.evaluate(() => {
    const probe = (window as Window & { __prependAnchorProbe?: Promise<number> })
      .__prependAnchorProbe;
    if (!probe) throw new Error('Prepend anchor probe was not armed');
    return probe;
  });
}

async function touchPoint(page: Page) {
  const box = await page.locator('#messages').boundingBox();
  expect(box).not.toBeNull();
  return {
    x: Math.round(box!.x + box!.width / 2),
    top: Math.round(box!.y + box!.height * 0.28),
    bottom: Math.round(box!.y + box!.height * 0.82),
  };
}

async function stopTouchMomentum(page: Page): Promise<void> {
  const point = await touchPoint(page);
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: (point.top + point.bottom) / 2 }],
  });
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
  const point = await touchPoint(page);
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.top }],
  });
  for (let step = 1; step <= 8; step += 1) {
    const y = Math.round(point.top + ((point.bottom - point.top) * step) / 8);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x, y }],
    });
    await page.waitForTimeout(16);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

async function slowSwipeDuringLoad(page: Page, durationMs = 1_800): Promise<void> {
  const point = await touchPoint(page);
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.top }],
  });
  const steps = 36;
  for (let step = 1; step <= steps; step += 1) {
    const y = Math.round(point.top + ((point.bottom - point.top) * step) / steps);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x, y }],
    });
    await page.waitForTimeout(durationMs / steps);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

async function elementIsInsideTranscript(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = document.getElementById('messages')?.getBoundingClientRect();
    return Boolean(viewport && rect.top >= viewport.top && rect.bottom <= viewport.bottom);
  });
}

async function swipeUntilRequest(page: Page, requestCount: () => number, target: number) {
  let swipes = 0;
  while (requestCount() < target && swipes < 12) {
    await swipeTowardOlderHistory(page);
    swipes += 1;
  }
  await expect.poll(requestCount).toBe(target);
  return swipes;
}

test('500-message touch history remains continuous across every older page', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const historyApi = await installHistoryApi(page);
  await page.goto('/');
  const messages = page.locator('#messages');
  await expect(
    messages.getByText(`History message ${TOTAL_EVENTS}`, { exact: true }),
  ).toBeVisible();

  const geometry = await messages.evaluate((scroller) => {
    const rect = scroller.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      clientHeight: scroller.clientHeight,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(390);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(844);
  expect(geometry.documentOverflow).toBe(0);

  let totalSwipes = 0;
  for (let pageNumber = 1; pageNumber <= OLDER_PAGE_COUNT; pageNumber += 1) {
    totalSwipes += await swipeUntilRequest(page, historyApi.requestCount, pageNumber);
    const activeMomentumBoundary = pageNumber === 4;
    if (activeMomentumBoundary) {
      const movingAnchor = await armMovingPrependAnchorProbe(page);
      expect(Math.abs(movingAnchor.scrollDelta), 'page 4 momentum was not active').toBeGreaterThan(
        1,
      );
    } else {
      await stopTouchMomentum(page);
      const anchorBefore = await stableVisibleAnchor(page);
      expect(anchorBefore, `missing visible anchor before page ${pageNumber}`).not.toBeNull();
      await armPrependAnchorProbe(page, anchorBefore!.text);
    }

    historyApi.releaseNext();
    const expectedOldest = INITIAL_OLDEST - pageNumber * PAGE_SIZE;
    await expect(
      messages.getByText(`History message ${expectedOldest}`, { exact: true }),
    ).toBeAttached();

    expect(
      await prependAnchorDrift(page),
      `page ${pageNumber} moved the visible anchor during prepend`,
    ).toBeLessThanOrEqual(activeMomentumBoundary ? geometry.clientHeight / 3 : 2);

    if ([1, 5, 9].includes(pageNumber)) {
      await stopTouchMomentum(page);
      await page.screenshot({
        path: testInfo.outputPath(`${String(pageNumber).padStart(2, '0')}-page-loaded.png`),
        animations: 'disabled',
      });
    }
  }

  expect(historyApi.requestCount()).toBe(OLDER_PAGE_COUNT);
  expect(historyApi.requestQueries()).toEqual(
    Array.from({ length: OLDER_PAGE_COUNT }, (_, index) => ({
      before: INITIAL_OLDEST - index * PAGE_SIZE,
      limit: PAGE_SIZE,
    })),
  );
  expect(totalSwipes).toBeGreaterThan(20);
  await expect(messages.getByText('History message 1', { exact: true })).toBeAttached();
  const renderedIds = await messages
    .locator(':scope > .msg')
    .evaluateAll((rows) =>
      rows.map((row) => Number(row.querySelector('.msg-text p')?.textContent?.match(/\d+/)?.[0])),
    );
  expect(renderedIds).toEqual(Array.from({ length: TOTAL_EVENTS }, (_, index) => index + 1));

  for (
    let swipe = 0;
    swipe < 30 && !(await elementIsInsideTranscript(page, '#top-sentinel'));
    swipe += 1
  ) {
    await swipeTowardOlderHistory(page);
  }
  await stopTouchMomentum(page);
  expect(await elementIsInsideTranscript(page, '#top-sentinel')).toBe(true);
  expect(
    await messages.getByText('History message 1', { exact: true }).evaluate((element) => {
      const row = element.closest('.msg');
      const viewport = document.getElementById('messages')?.getBoundingClientRect();
      const rect = row?.getBoundingClientRect();
      return Boolean(
        viewport && rect && rect.top >= viewport.top && rect.bottom <= viewport.bottom,
      );
    }),
  ).toBe(true);
  await expect(page.locator('#top-sentinel')).toHaveText('Beginning of this session');
  await page.screenshot({
    path: testInfo.outputPath('10-beginning-of-history.png'),
    animations: 'disabled',
  });

  await messages.evaluate((scroller) => {
    const row = Array.from(scroller.children).find((candidate) =>
      candidate.textContent?.includes('History message 25'),
    );
    if (!(row instanceof HTMLElement)) throw new Error('Reviewed history anchor is missing');
    const viewport = scroller.getBoundingClientRect();
    scroller.scrollTop += row.getBoundingClientRect().top - viewport.top;
  });
  await expect(messages.getByText('History message 25', { exact: true })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('11-reviewed-history-baseline.png'),
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

test('history keeps loading partially while the user is still pulling upward', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const historyApi = await installHistoryApi(page, 4_000);
  await page.goto('/');
  const messages = page.locator('#messages');
  await expect(
    messages.getByText(`History message ${TOTAL_EVENTS}`, { exact: true }),
  ).toBeVisible();

  let ordinarySwipes = 0;
  for (let pageNumber = 1; pageNumber <= OLDER_PAGE_COUNT; pageNumber += 1) {
    ordinarySwipes += await swipeUntilRequest(page, historyApi.requestCount, pageNumber);

    // The response is deliberately still in flight: only the pages completed
    // before this request may exist, and the next oldest row must not exist yet.
    await expect(page.locator('#top-sentinel')).toHaveText('Loading older messages…');
    await expect(messages.locator(':scope > .msg')).toHaveCount(PAGE_SIZE * pageNumber);
    const expectedOldest = INITIAL_OLDEST - pageNumber * PAGE_SIZE;
    await expect(
      messages.getByText(`History message ${expectedOldest}`, { exact: true }),
    ).toHaveCount(0);

    // Keep pulling while only the already-completed pages exist. These swipes
    // drive the viewport to the loading boundary before the delayed JSON lands.
    for (let pendingSwipe = 0; pendingSwipe < 3; pendingSwipe += 1) {
      await swipeTowardOlderHistory(page);
    }
    await expect(page.locator('#top-sentinel')).toHaveText('Loading older messages…');
    await expect(page.locator('#top-sentinel')).toBeInViewport();
    await expect(messages.locator(':scope > .msg')).toHaveCount(PAGE_SIZE * pageNumber);

    const anchor = await stableVisibleAnchor(page);
    expect(anchor, `missing in-flight anchor before page ${pageNumber}`).not.toBeNull();
    await armPartialLoadProbe(page, anchor!.text);

    // Keep one real touch gesture down across the delayed response. The
    // MutationObserver below proves the 50-row prepend happened before touchEnd.
    const inFlightSwipe = slowSwipeDuringLoad(page, 4_500);
    await page.waitForTimeout(250);
    await expect(page.locator('#top-sentinel')).toHaveText('Loading older messages…');
    expect(await messages.locator(':scope > .msg').count()).toBe(PAGE_SIZE * pageNumber);
    if ([1, 5, 9].includes(pageNumber)) {
      await page.screenshot({
        path: testInfo.outputPath(
          `${String(pageNumber).padStart(2, '0')}-partial-page-loading.png`,
        ),
        animations: 'disabled',
      });
    }

    await inFlightSwipe;
    await expect(
      messages.getByText(`History message ${expectedOldest}`, { exact: true }),
    ).toBeAttached();
    const probe = await partialLoadProbe(page);
    expect(probe.touchActiveAtMutation, `page ${pageNumber} completed after touchEnd`).toBe(true);
    expect(probe.drift, `page ${pageNumber} snapped by a fetched page`).toBeLessThan(
      (await messages.evaluate((node) => node.clientHeight)) / 3,
    );
    await expect(messages.locator(':scope > .msg')).toHaveCount(PAGE_SIZE * (pageNumber + 1));
  }

  expect(historyApi.requestCount()).toBe(OLDER_PAGE_COUNT);
  expect(historyApi.requestQueries()).toEqual(
    Array.from({ length: OLDER_PAGE_COUNT }, (_, index) => ({
      before: INITIAL_OLDEST - index * PAGE_SIZE,
      limit: PAGE_SIZE,
    })),
  );
  expect(ordinarySwipes + OLDER_PAGE_COUNT * 3).toBeGreaterThan(35);
  const renderedIds = await messages
    .locator(':scope > .msg')
    .evaluateAll((rows) =>
      rows.map((row) => Number(row.querySelector('.msg-text p')?.textContent?.match(/\d+/)?.[0])),
    );
  expect(renderedIds).toEqual(Array.from({ length: TOTAL_EVENTS }, (_, index) => index + 1));
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
