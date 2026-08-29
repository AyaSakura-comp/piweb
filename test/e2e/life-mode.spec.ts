import { expect, test, type Page, type Route } from 'playwright/test';

const STANDARD_SESSION = {
  jid: 'web:ordinary',
  name: 'Ordinary session',
  kind: 'standard',
  busy: false,
  lastActivity: '2026-08-28 00:00:00',
  lastReplyId: 0,
  model: 'openai-codex/gpt-5.6-sol',
  thinking: 'xhigh',
  badge: { label: 'SOL', kind: 'sol' },
};

const OTHER_STANDARD_SESSION = {
  ...STANDARD_SESSION,
  jid: 'web:other',
  name: 'Other session',
  lastActivity: '2026-08-27 00:00:00',
};

const DELETED_SESSION = {
  jid: 'web:deleted',
  name: 'Deleted session',
  deletedAt: '2026-08-28 00:00:00',
  events: 3,
};

const LIFE_SESSION = {
  jid: 'web:life',
  name: 'Life',
  kind: 'life',
  model: '',
  thinking: '',
};

async function installLifeApi(
  page: Page,
  options: {
    failLife?: boolean;
    failLifeEvents?: boolean;
    failLifeNewAfterArchive?: boolean;
    delayLife?: boolean;
    delaySecondLife?: boolean;
    delayLifeEvents?: boolean;
    delayStandardEvents?: boolean;
    delayLifeMedia?: boolean;
    lifeMediaItem?: boolean;
    unknownReplyEvent?: boolean;
    delayRestore?: boolean;
    delayDelete?: boolean;
    delayCreate?: boolean;
    delayClear?: boolean;
    delayTrashLoad?: boolean;
    delayCommand?: boolean;
    delayMessage?: boolean;
    messageSessionTitle?: string;
    corruptLifeMetadata?: boolean;
    corruptLifeEndpoint?: boolean;
    corruptDeletedMetadata?: boolean;
    oldStreamEventDuringPending?: boolean;
    delayUnknownEvents?: boolean;
    omitOrdinaryMetadata?: boolean;
    omitOrdinaryDeletedState?: boolean;
    unknownMetadataName?: string;
    delayBoot?: boolean;
    commandCatalog?: Array<{ name: string }>;
    standardSessions?: (typeof STANDARD_SESSION)[];
    deletedSessions?: (typeof DELETED_SESSION)[];
    lifeEventState?: boolean;
    lifeEventCount?: number;
    lifeSearchResult?: boolean;
    standardEventCount?: number;
  } = {},
) {
  let lifeRequests = 0;
  let lifeGeneration = 'life-generation-1';
  let archivedLifeCount = 0;
  let deletedRequests = 0;
  let ordinaryStreamRequests = 0;
  let standardSessions = options.standardSessions ?? [STANDARD_SESSION];
  let deletedSessions = options.deletedSessions ?? [];
  let failUnknownEvents = false;
  let unknownDeleted = false;
  let releaseLifeResponse: (() => void) | undefined;
  const lifeResponseGate = options.delayLife
    ? new Promise<void>((resolve) => {
        releaseLifeResponse = resolve;
      })
    : null;
  let releaseSecondLife: (() => void) | undefined;
  const secondLifeGate = options.delaySecondLife
    ? new Promise<void>((resolve) => {
        releaseSecondLife = resolve;
      })
    : null;
  let releaseLifeEvents: (() => void) | undefined;
  const lifeEventsGate = options.delayLifeEvents
    ? new Promise<void>((resolve) => {
        releaseLifeEvents = resolve;
      })
    : null;
  let releaseStandardEvents: (() => void) | undefined;
  const standardEventsGate = options.delayStandardEvents
    ? new Promise<void>((resolve) => {
        releaseStandardEvents = resolve;
      })
    : null;
  let releaseLifeMedia: (() => void) | undefined;
  const lifeMediaGate = options.delayLifeMedia
    ? new Promise<void>((resolve) => {
        releaseLifeMedia = resolve;
      })
    : null;
  let releaseRestore: (() => void) | undefined;
  const restoreGate = options.delayRestore
    ? new Promise<void>((resolve) => {
        releaseRestore = resolve;
      })
    : null;
  let releaseDelete: (() => void) | undefined;
  const deleteGate = options.delayDelete
    ? new Promise<void>((resolve) => {
        releaseDelete = resolve;
      })
    : null;
  let releaseCreate: (() => void) | undefined;
  const createGate = options.delayCreate
    ? new Promise<void>((resolve) => {
        releaseCreate = resolve;
      })
    : null;
  let releaseClear: (() => void) | undefined;
  const clearGate = options.delayClear
    ? new Promise<void>((resolve) => {
        releaseClear = resolve;
      })
    : null;
  let releaseTrashLoad: (() => void) | undefined;
  const trashLoadGate = options.delayTrashLoad
    ? new Promise<void>((resolve) => {
        releaseTrashLoad = resolve;
      })
    : null;
  let releaseCommand: (() => void) | undefined;
  const commandGate = options.delayCommand
    ? new Promise<void>((resolve) => {
        releaseCommand = resolve;
      })
    : null;
  let releaseUnknownEvents: (() => void) | undefined;
  const unknownEventsGate = options.delayUnknownEvents
    ? new Promise<void>((resolve) => {
        releaseUnknownEvents = resolve;
      })
    : null;
  let releaseBoot: (() => void) | undefined;
  const bootGate = options.delayBoot
    ? new Promise<void>((resolve) => {
        releaseBoot = resolve;
      })
    : null;
  let releaseMessage: (() => void) | undefined;
  const messageGate = options.delayMessage
    ? new Promise<void>((resolve) => {
        releaseMessage = resolve;
      })
    : null;
  const messagePaths: string[] = [];
  const messageBodies: unknown[] = [];
  const lifeReadUrls: string[] = [];

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    const path = requestUrl.pathname;

    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/commands') {
      if (bootGate) await bootGate;
      return route.fulfill({ json: { commands: options.commandCatalog ?? [] } });
    }
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path === '/api/push/key') return route.fulfill({ json: { key: '' } });
    if (path === '/api/sessions/deleted') {
      deletedRequests += 1;
      if (trashLoadGate && deletedRequests > 1) await trashLoadGate;
      return route.fulfill({ json: { sessions: deletedSessions } });
    }
    if (path === '/api/sessions' && request.method() === 'GET') {
      return route.fulfill({
        json: { sessions: standardSessions },
      });
    }
    if (path === '/api/sessions' && request.method() === 'POST') {
      if (createGate) await createGate;
      const created = {
        ...STANDARD_SESSION,
        jid: 'web:created',
        name: 'New session',
        lastActivity: '2026-08-29 00:00:00',
      };
      standardSessions = [created, ...standardSessions];
      return route.fulfill({ json: { jid: created.jid, name: created.name } });
    }
    if (path === '/api/life-session/new' && request.method() === 'POST') {
      if (request.postDataJSON()?.generation !== lifeGeneration) {
        return route.fulfill({ status: 409, json: { error: 'Life generation changed' } });
      }
      archivedLifeCount += 1;
      const archived = {
        ...STANDARD_SESSION,
        jid: `web:life-archive-${archivedLifeCount}`,
        name: 'Life',
        lastActivity: '2026-08-29 00:00:00',
      };
      standardSessions = [archived, ...standardSessions];
      lifeGeneration = `life-generation-${archivedLifeCount + 1}`;
      if (options.failLifeNewAfterArchive) {
        return route.fulfill({ status: 503, json: { error: 'Response lost after archive' } });
      }
      return route.fulfill({
        json: {
          archived: { jid: archived.jid, name: archived.name, kind: 'standard' },
          life: { ...LIFE_SESSION, generation: lifeGeneration, created: true },
        },
      });
    }
    if (path === '/api/life-session' && request.method() === 'POST') {
      lifeRequests += 1;
      if (options.failLife) {
        return route.fulfill({ status: 503, json: { error: 'Life unavailable' } });
      }
      if (lifeResponseGate) await lifeResponseGate;
      if (secondLifeGate && lifeRequests > 1) await secondLifeGate;
      return route.fulfill({
        json: options.corruptLifeEndpoint
          ? { ...STANDARD_SESSION, created: false }
          : {
              ...LIFE_SESSION,
              generation: lifeGeneration,
              created: lifeRequests === 1,
            },
      });
    }
    if (path.endsWith('/clear') && request.method() === 'POST') {
      if (clearGate) await clearGate;
      return route.fulfill({ json: { ok: true, removed: 1 } });
    }
    if (path.endsWith('/restore') && request.method() === 'POST') {
      if (restoreGate) await restoreGate;
      const jid = decodeURIComponent(path.split('/')[3]);
      const restored = deletedSessions.find((session) => session.jid === jid);
      deletedSessions = deletedSessions.filter((session) => session.jid !== jid);
      if (restored) {
        standardSessions = [
          ...standardSessions,
          { ...STANDARD_SESSION, jid: restored.jid, name: restored.name },
        ];
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (/^\/api\/sessions\/[^/]+$/.test(path) && request.method() === 'DELETE') {
      if (deleteGate) await deleteGate;
      const jid = decodeURIComponent(path.split('/')[3]);
      const removed = standardSessions.find((session) => session.jid === jid);
      standardSessions = standardSessions.filter((session) => session.jid !== jid);
      if (removed) {
        deletedSessions = [
          ...deletedSessions,
          { ...DELETED_SESSION, jid: removed.jid, name: removed.name },
        ];
      }
      return route.fulfill({ json: { ok: true, permanent: false } });
    }
    if (path.endsWith('/media')) {
      const requestedJid = decodeURIComponent(path.split('/')[3]);
      const isLifeMedia = requestedJid === LIFE_SESSION.jid;
      if (isLifeMedia) {
        lifeReadUrls.push(request.url());
        if (requestUrl.searchParams.get('generation') !== lifeGeneration) {
          return route.fulfill({ status: 409, json: { error: 'Life generation changed' } });
        }
      }
      if (isLifeMedia && lifeMediaGate) await lifeMediaGate;
      if (options.delayLifeMedia || (isLifeMedia && options.lifeMediaItem)) {
        const name = isLifeMedia ? 'Life image' : 'Standard image';
        return route.fulfill({
          json: { items: [{ type: 'image', name, url: `/${name.replace(' ', '-').toLowerCase()}.png` }] },
        });
      }
      return route.fulfill({ json: { items: [] } });
    }
    if (path.endsWith('/events')) {
      const requestedJid = decodeURIComponent(path.split('/')[3]);
      const isLifeEvents = requestedJid === LIFE_SESSION.jid;
      if (isLifeEvents) {
        lifeReadUrls.push(request.url());
        if (requestUrl.searchParams.get('generation') !== lifeGeneration) {
          return route.fulfill({ status: 409, json: { error: 'Life generation changed' } });
        }
      }
      const standardMetadata = standardSessions.find((session) => session.jid === requestedJid);
      const deletedMetadata = deletedSessions.find((session) => session.jid === requestedJid);
      const isUnknownEvents = !isLifeEvents && !standardMetadata && !deletedMetadata;
      const unknownReplyEvent = options.unknownReplyEvent && isUnknownEvents;
      if (isUnknownEvents && unknownEventsGate) await unknownEventsGate;
      if (failUnknownEvents && isUnknownEvents) {
        return route.fulfill({ status: 404, json: { error: 'Session not found' } });
      }
      if (isLifeEvents && lifeEventsGate) await lifeEventsGate;
      if (!isLifeEvents && standardMetadata && standardEventsGate) {
        await standardEventsGate;
      }
      if (options.failLifeEvents && isLifeEvents) {
        return route.fulfill({ status: 503, json: { error: 'Life events unavailable' } });
      }
      const lifeEventState = isLifeEvents && archivedLifeCount === 0 && options.lifeEventState;
      const lifeEvents =
        isLifeEvents && archivedLifeCount === 0 && options.lifeEventCount
          ? Array.from({ length: options.lifeEventCount }, (_, index) => ({
              id: index + 1,
              kind: 'message',
              role: index % 2 === 0 ? 'user' : 'assistant',
              content: `Scrollable Life message ${index + 1} ${'content '.repeat(12)}`,
              createdAt: '2026-08-29T00:00:00.000Z',
              files: [],
            }))
          : [];
      const standardEvents =
        standardMetadata && options.standardEventCount
          ? Array.from({ length: options.standardEventCount }, (_, index) => ({
              id: index + 1,
              kind: 'message',
              role: index % 2 === 0 ? 'user' : 'assistant',
              content: `Scrollable message ${index + 1} ${'content '.repeat(12)}`,
              createdAt: '2026-08-29T00:00:00.000Z',
              files: [],
            }))
          : [];
      return route.fulfill({
        json: {
          events: unknownReplyEvent
            ? [
                {
                  id: 77,
                  kind: 'message',
                  role: 'assistant',
                  content: 'Notification target reply',
                },
              ]
            : lifeEvents.length > 0
              ? lifeEvents
              : isLifeEvents && (options.delayLifeEvents || lifeEventState)
                ? [
                    {
                      id: 101,
                      kind: 'message',
                      role: 'assistant',
                      content: lifeEventState ? 'Life-only history' : 'late Life transcript',
                    },
                  ]
                : standardEvents,
          busy: lifeEventState,
          hasMore: false,
          hasMoreNewer:
            isLifeEvents && options.lifeSearchResult && request.url().includes('around='),
          partial: lifeEventState ? { content: 'unfinished Life response' } : null,
          session:
            options.omitOrdinaryMetadata && requestedJid === STANDARD_SESSION.jid
              ? undefined
              : {
                  jid:
                    (isLifeEvents && options.corruptLifeMetadata) ||
                    (deletedMetadata && options.corruptDeletedMetadata)
                      ? 'web:wrong-target'
                      : requestedJid,
                  name: isLifeEvents
                    ? LIFE_SESSION.name
                    : standardMetadata?.name ||
                      deletedMetadata?.name ||
                      options.unknownMetadataName ||
                      requestedJid,
                  kind:
                    (isLifeEvents && options.corruptLifeMetadata) ||
                    (deletedMetadata && options.corruptDeletedMetadata)
                      ? 'life'
                      : isLifeEvents
                        ? 'life'
                        : 'standard',
                  ...(isLifeEvents ? { generation: lifeGeneration } : {}),
                  deleted:
                    options.omitOrdinaryDeletedState && requestedJid === STANDARD_SESSION.jid
                      ? undefined
                      : deletedMetadata && options.corruptDeletedMetadata
                        ? false
                        : Boolean(deletedMetadata) || (isUnknownEvents && unknownDeleted),
                },
        },
      });
    }
    if (path.endsWith('/search')) {
      const requestedJid = decodeURIComponent(path.split('/')[3]);
      if (requestedJid === LIFE_SESSION.jid) {
        lifeReadUrls.push(request.url());
        if (requestUrl.searchParams.get('generation') !== lifeGeneration) {
          return route.fulfill({ status: 409, json: { error: 'Life generation changed' } });
        }
      }
      return route.fulfill({
        json: {
          hits: options.lifeSearchResult
            ? [
                {
                  id: 1,
                  kind: 'message',
                  role: 'assistant',
                  snippet: 'searchable Life result',
                  createdAt: '2026-08-29T00:00:00.000Z',
                },
              ]
            : [],
        },
      });
    }
    if (path.endsWith('/stream')) {
      const requestedJid = decodeURIComponent(path.split('/')[3]);
      if (requestedJid === LIFE_SESSION.jid) {
        lifeReadUrls.push(request.url());
        if (requestUrl.searchParams.get('generation') !== lifeGeneration) {
          return route.fulfill({ status: 409, json: { error: 'Life generation changed' } });
        }
      }
      if (requestedJid === STANDARD_SESSION.jid) ordinaryStreamRequests += 1;
      const oldEvent =
        options.oldStreamEventDuringPending &&
        requestedJid === STANDARD_SESSION.jid &&
        ordinaryStreamRequests > 1
          ? 'id: 909\nevent: event\ndata: {"id":909,"kind":"message","role":"assistant","content":"old pending stream event","files":[]}\n\n'
          : '';
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-store' },
        body: `${oldEvent}retry: 60000\n\n`,
      });
    }
    if (path.endsWith('/commands') && request.method() === 'POST') {
      const requestedJid = decodeURIComponent(path.split('/')[3]);
      const body = request.postDataJSON();
      if (requestedJid === LIFE_SESSION.jid && body.lifeGeneration !== lifeGeneration) {
        return route.fulfill({ status: 409, json: { error: 'Life generation changed' } });
      }
      if (commandGate) await commandGate;
      return route.fulfill({ status: 200, json: { ok: true } });
    }
    if (path.endsWith('/messages') && request.method() === 'POST') {
      const requestedJid = decodeURIComponent(path.split('/')[3]);
      const body = request.postDataJSON();
      if (requestedJid === LIFE_SESSION.jid && body.lifeGeneration !== lifeGeneration) {
        return route.fulfill({ status: 409, json: { error: 'Life generation changed' } });
      }
      messagePaths.push(path);
      messageBodies.push(body);
      if (messageGate) await messageGate;
      return route.fulfill({
        status: 200,
        json: { ok: true, ...(options.messageSessionTitle ? { sessionTitle: options.messageSessionTitle } : {}) },
      });
    }

    return route.fulfill({ status: 404, json: { error: `Unhandled fixture route: ${path}` } });
  });

  return {
    lifeRequests: () => lifeRequests,
    archivedLifeCount: () => archivedLifeCount,
    standardSessions: () => standardSessions,
    lifeReadUrls: () => [...lifeReadUrls],
    releaseLifeResponse: () => releaseLifeResponse?.(),
    releaseSecondLife: () => releaseSecondLife?.(),
    releaseLifeEvents: () => releaseLifeEvents?.(),
    releaseStandardEvents: () => releaseStandardEvents?.(),
    releaseLifeMedia: () => releaseLifeMedia?.(),
    releaseRestore: () => releaseRestore?.(),
    releaseDelete: () => releaseDelete?.(),
    releaseCreate: () => releaseCreate?.(),
    releaseClear: () => releaseClear?.(),
    releaseTrashLoad: () => releaseTrashLoad?.(),
    releaseCommand: () => releaseCommand?.(),
    releaseMessage: () => releaseMessage?.(),
    releaseUnknownEvents: () => releaseUnknownEvents?.(),
    releaseBoot: () => releaseBoot?.(),
    setStandardSessions: (sessions: (typeof STANDARD_SESSION)[]) => {
      standardSessions = sessions;
    },
    failUnknownEvents: () => {
      failUnknownEvents = true;
    },
    markUnknownDeleted: () => {
      unknownDeleted = true;
    },
    messagePaths,
    messageBodies,
  };
}

async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { hold?: boolean; stepDelayMs?: number } = {},
) {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [from],
  });
  const steps = 6;
  for (let step = 1; step <= steps; step += 1) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: Math.round(from.x + ((to.x - from.x) * step) / steps),
          y: Math.round(from.y + ((to.y - from.y) * step) / steps),
        },
      ],
    });
    if (options.stepDelayMs) await page.waitForTimeout(options.stepDelayMs);
  }
  if (options.hold) return session;
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

test('right-edge swipe enters persistent default-model Life mode', async ({ page }, testInfo) => {
  const api = await installLifeApi(page);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  const edgeHint = page.locator('#life-edge-hint');
  await expect(edgeHint).toBeVisible();
  const edgeHintBox = (await edgeHint.boundingBox())!;
  expect(edgeHintBox.width).toBeGreaterThanOrEqual(48);
  expect(edgeHintBox.height).toBeGreaterThanOrEqual(64);
  expect(edgeHintBox.x).toBeGreaterThanOrEqual(0);
  expect(edgeHintBox.x + edgeHintBox.width).toBeLessThanOrEqual(390);
  expect(await edgeHint.locator('.life-edge-drop').count()).toBe(1);
  expect(await edgeHint.evaluate((element) => element.parentElement?.classList.contains('main'))).toBe(
    true,
  );
  expect(
    await edgeHint.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || Boolean(hit && element.contains(hit));
    }),
  ).toBe(true);
  const edgeTouch = {
    x: Math.round(edgeHintBox.x + edgeHintBox.width / 2),
    y: Math.round(edgeHintBox.y + edgeHintBox.height / 2),
  };
  const edgeTouchNearBoundary = {
    x: Math.round(edgeHintBox.x + edgeHintBox.width - 2),
    y: edgeTouch.y,
  };
  await page.screenshot({ path: testInfo.outputPath('00-life-edge-hint.png') });

  // A foreground sheet owns edge gestures until it closes.
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: 'Media' }).click();
  await expect(page.locator('#media-sheet')).toBeVisible();
  await touchDrag(
    page,
    edgeTouchNearBoundary,
    { x: edgeTouchNearBoundary.x - 218, y: edgeTouchNearBoundary.y + 2 },
  );
  expect(api.lifeRequests()).toBe(0);
  await page.locator('#btn-media-close').click();

  // A vertical gesture starting on the button remains an ordinary scroll gesture.
  await touchDrag(
    page,
    edgeTouchNearBoundary,
    { x: edgeTouchNearBoundary.x - 8, y: edgeTouchNearBoundary.y + 210 },
  );
  expect(api.lifeRequests()).toBe(0);

  // A slow shallow horizontal drag snaps back instead of opening Life.
  await touchDrag(
    page,
    edgeTouchNearBoundary,
    { x: edgeTouchNearBoundary.x - 53, y: edgeTouchNearBoundary.y + 2 },
    { stepDelayMs: 60 },
  );
  expect(api.lifeRequests()).toBe(0);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();

  // Hold a partial drag long enough to inspect the panel following the finger,
  // then let the stale velocity expire so this preview returns to Sessions.
  const touch = await touchDrag(
    page,
    edgeTouchNearBoundary,
    { x: edgeTouchNearBoundary.x - 55, y: edgeTouchNearBoundary.y + 2 },
    { hold: true },
  );
  const preview = page.locator('#life-swipe-preview');
  await expect(preview).toBeVisible();
  const previewRect = await preview.boundingBox();
  expect(previewRect).not.toBeNull();
  expect(previewRect!.x).toBe(0);
  const draggedMain = await page.locator('.main').boundingBox();
  const draggedHint = await edgeHint.boundingBox();
  expect(draggedMain!.x).toBeLessThan(-40);
  expect(draggedMain!.x).toBeGreaterThan(-70);
  expect(draggedHint!.x).toBeLessThan(edgeHintBox.x - 40);
  expect(
    Math.abs(draggedHint!.x + draggedHint!.width - (draggedMain!.x + draggedMain!.width)),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('01-life-swipe-progress.png') });
  await page.waitForTimeout(110);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect(preview).toBeHidden();
  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  expect(api.lifeRequests()).toBe(0);

  // The actual entry starts inside the button and is still a short flick.
  // preventDefault suppresses its compatibility click, so exactly one entry owns it.
  await touchDrag(
    page,
    edgeTouch,
    { x: edgeTouch.x - 55, y: edgeTouch.y + 1 },
  );
  expect(api.lifeRequests()).toBe(0);
  await expect(preview).toBeVisible();
  const releasePageX = (await page.locator('.main').boundingBox())!.x;
  await page.waitForTimeout(60);
  expect((await page.locator('.main').boundingBox())!.x).toBeLessThan(releasePageX);
  await page.screenshot({ path: testInfo.outputPath('02-life-swipe-inertia.png') });
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(preview).toBeHidden();

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText('Life');
  await expect(page.locator('#header-badge')).toHaveText('DEFAULT');
  await expect(page.getByRole('button', { name: 'Return to sessions' })).toBeVisible();
  for (const selector of [
    '#btn-menu',
    '#btn-status',
    '#btn-gpt-usage',
    '#btn-model',
    '#btn-thinking',
  ]) {
    await expect(page.locator(selector)).toBeHidden();
  }
  const lifeNewSession = page.getByRole('button', { name: 'New Life session' });
  await expect(lifeNewSession).toBeVisible();
  const lifeHeaderGeometry = await page.evaluate(() => {
    const title = document.querySelector('.topbar-title').getBoundingClientRect();
    const action = document.querySelector('#btn-life-new-session').getBoundingClientRect();
    const more = document.querySelector('#btn-more').getBoundingClientRect();
    return {
      directTopbarChild:
        document.querySelector('#btn-life-new-session').parentElement?.classList.contains('topbar'),
      clearsCenteredTitle: action.left >= title.right,
      precedesOverflow: action.right <= more.left,
    };
  });
  expect(lifeHeaderGeometry).toEqual({
    directTopbarChild: true,
    clearsCenteredTitle: true,
    precedesOverflow: true,
  });
  const newLifeSessionResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/life-session/new') && response.request().method() === 'POST',
  );
  await lifeNewSession.click();
  const newLifeResponse = await newLifeSessionResponse;
  expect(newLifeResponse.request().postDataJSON()).toEqual({
    generation: 'life-generation-1',
  });
  expect(await newLifeResponse.json()).toMatchObject({
    archived: { jid: 'web:life-archive-1', name: 'Life', kind: 'standard' },
    life: { ...LIFE_SESSION, generation: 'life-generation-2' },
  });
  await expect.poll(api.archivedLifeCount).toBe(1);
  await expect
    .poll(() => api.standardSessions().map((session) => session.jid))
    .toContain('web:life-archive-1');
  await expect(page.locator('#messages .msg')).toHaveCount(0);
  await page.locator('#btn-more').click();
  await expect(page.getByRole('menuitem', { name: 'Search' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Media' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'New pi session' })).toBeHidden();
  await expect(page.locator('#mi-sessions')).toBeHidden();
  await expect(page.locator('#mi-clean')).toBeHidden();
  await expect(page.locator('#mi-management-separator')).toBeHidden();
  await page.getByRole('menuitem', { name: 'Search' }).click();
  await expect(page.locator('#search-panel')).toBeVisible();
  await page.locator('#btn-search-close').click();
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: 'Media' }).click();
  await expect(page.locator('#media-sheet')).toBeVisible();
  await page.locator('#btn-media-close').click();
  await expect(page.locator('#composer-wrap')).toBeVisible();
  const lifeTitleCenterDelta = await page.locator('.topbar-title').evaluate((title) => {
    const rect = title.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    return Math.abs(rect.left + rect.width / 2 - viewportWidth / 2);
  });
  expect(lifeTitleCenterDelta).toBeLessThanOrEqual(8);
  expect(await page.evaluate(() => localStorage.getItem('piweb.mode'))).toBe('life');
  await page.screenshot({ path: testInfo.outputPath('03-life-mode.png') });

  await page.locator('#input').fill('Life mode hello');
  await page.locator('#btn-send').click();
  await expect.poll(() => api.messagePaths.length).toBe(1);
  expect(api.messagePaths[0]).toBe(
    `/api/sessions/${encodeURIComponent(LIFE_SESSION.jid)}/messages`,
  );
  expect(api.messageBodies[0]).toMatchObject({ lifeGeneration: 'life-generation-2' });

  await page.reload();
  await expect.poll(api.lifeRequests).toBe(2);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText('Life');
  await expect(page.getByRole('button', { name: 'New Life session' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('04-life-mode-reloaded.png') });

  const backSwipe = await touchDrag(
    page,
    { x: 2, y: 430 },
    { x: 150, y: 432 },
    { hold: true },
  );
  expect((await page.locator('.main').boundingBox())!.x).toBeGreaterThan(80);
  await page.screenshot({ path: testInfo.outputPath('05-life-back-swipe-progress.png') });
  await backSwipe.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await backSwipe.detach();
  await page.waitForTimeout(60);
  await page.screenshot({ path: testInfo.outputPath('06-life-back-settle.png') });
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText('Life');
  expect(await page.evaluate(() => localStorage.getItem('piweb.mode'))).toBe('sessions');
  await expect(page.locator('#life-edge-hint')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Life session' })).toBeHidden();
  await expect(preview).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('07-returned-to-sessions.png') });

  // The water-drop affordance is also a real 48px touch target. Tapping it
  // auto-settles the page with the same protected transition as a flick.
  await page.getByRole('button', { name: 'Open Life' }).click();
  expect(api.lifeRequests()).toBe(2);
  await expect(preview).toBeVisible();
  await page.waitForTimeout(60);
  expect((await page.locator('.main').boundingBox())!.x).toBeLessThan(0);
  await page.screenshot({ path: testInfo.outputPath('08-edge-button-auto-settle.png') });
  await expect.poll(api.lifeRequests).toBe(3);
  await expect(preview).toBeHidden();
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await page.screenshot({ path: testInfo.outputPath('09-life-opened-by-button.png') });
  await page.getByRole('button', { name: 'Return to sessions' }).click();
  await page.waitForTimeout(60);
  await page.screenshot({ path: testInfo.outputPath('10-sessions-button-settle.png') });
  await expect(page.locator('#session-name')).toHaveText('Life');
  await expect(page.locator('#btn-status')).toBeVisible();
  await expect(page.locator('#header-badge')).toBeVisible();
  await expect(preview).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('11-button-returned-to-sessions.png') });

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('a failed New response reconciles to the fresh Life generation', async ({ page }) => {
  const api = await installLifeApi(page, {
    lifeEventCount: 2,
    failLifeNewAfterArchive: true,
  });
  page.on('dialog', (dialog) => void dialog.dismiss());
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');

  await expect(page.locator('#messages .msg')).toHaveCount(2);
  await page.getByRole('button', { name: 'New Life session' }).click();

  await expect.poll(api.archivedLifeCount).toBe(1);
  await expect.poll(api.lifeRequests).toBe(2);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#messages .msg')).toHaveCount(0);
  await expect(page.locator('#session-name')).toHaveText('Life');
});

test('busy Life header keeps every action clear at 320px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await installLifeApi(page, { lifeEventState: true });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#btn-stop')).toBeVisible();
  await expect(page.locator('#btn-life-new-session')).toBeVisible();
  await expect(page.locator('#btn-more')).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const back = rect('#btn-life-back');
    const title = rect('.topbar-title');
    const stop = rect('#btn-stop');
    const newSession = rect('#btn-life-new-session');
    const more = rect('#btn-more');
    return {
      backClearsTitle: back.right <= title.left,
      titleClearsStop: title.right <= stop.left,
      stopClearsNewSession: stop.right <= newSession.left,
      newSessionClearsMore: newSession.right <= more.left,
      viewportWidth: document.documentElement.clientWidth,
      headerRight: more.right,
    };
  });
  expect(geometry).toMatchObject({
    backClearsTitle: true,
    titleClearsStop: true,
    stopClearsNewSession: true,
    newSessionClearsMore: true,
    viewportWidth: 320,
  });
  expect(geometry.headerRight).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('busy-life-header-320.png') });
});

test('a rightward left-edge back swipe exits Life mode', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 }, { hold: true });
  expect((await page.locator('.main').boundingBox())!.x).toBeGreaterThan(80);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();

  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('piweb.mode'))).toBe('sessions');
  expect(api.lifeRequests()).toBe(1);
});

test('a shallow left-edge back drag returns to Life', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 60, y: 432 }, { hold: true });
  expect((await page.locator('.main').boundingBox())!.x).toBeGreaterThan(40);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  expect(api.lifeRequests()).toBe(1);
});

test('a leftward reversal cancels a Life back swipe', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 2, y: 430 }],
  });
  for (const x of [170, 112]) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 432 }],
    });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  expect(api.lifeRequests()).toBe(1);
});

test('a cancelled Life back touch never exits', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 }, { hold: true });
  expect((await page.locator('.main').boundingBox())!.x).toBeGreaterThan(80);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await touch.detach();

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  expect(api.lifeRequests()).toBe(1);
});

test('Life foreground menu, sheet, and lightbox own the left-edge back gesture', async ({ page }) => {
  const api = await installLifeApi(page, { lifeMediaItem: true });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await page.locator('#btn-more').click();
  await expect(page.locator('#more-menu')).toBeVisible();

  await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 });

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#more-menu')).toBeVisible();
  expect((await page.locator('.main').boundingBox())!.x).toBe(0);

  await page.getByRole('menuitem', { name: 'Media' }).click();
  await expect(page.locator('#media-sheet')).toBeVisible();
  await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 });
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  expect((await page.locator('.main').boundingBox())!.x).toBe(0);

  await page.getByRole('button', { name: 'image: Life image' }).click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 });
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  expect((await page.locator('.main').boundingBox())!.x).toBe(0);
  expect(api.lifeRequests()).toBe(1);
});

test('a vertical left-edge drag keeps scrolling the Life transcript', async ({ page }) => {
  const api = await installLifeApi(page, { lifeEventCount: 40 });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  const before = await page.locator('#messages').evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);

  await touchDrag(page, { x: 2, y: 300 }, { x: 5, y: 650 }, { stepDelayMs: 12 });

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect.poll(() => page.locator('#messages').evaluate((element) => element.scrollTop)).toBeLessThan(before);
  expect((await page.locator('.main').boundingBox())!.x).toBe(0);
  expect(api.lifeRequests()).toBe(1);
});

test('a final leftward release movement cancels a Life back swipe', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  await page.evaluate(() => {
    const target = document.body;
    const touch = (identifier: number, clientX: number) =>
      new Touch({
        identifier,
        target,
        clientX,
        clientY: 430,
        pageX: clientX,
        pageY: 430,
        screenX: clientX,
        screenY: 430,
      });
    const start = touch(41, 2);
    document.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [start],
        targetTouches: [start],
        changedTouches: [start],
      }),
    );
    const moved = touch(41, 150);
    document.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [moved],
        targetTouches: [moved],
        changedTouches: [moved],
      }),
    );
    const released = touch(41, 112);
    document.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [released],
      }),
    );
  });

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  expect(api.lifeRequests()).toBe(1);
});

test('an unrelated touch release cannot commit a held Life back swipe', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  await page.evaluate(() => {
    const target = document.body;
    const touch = (identifier: number, clientX: number, clientY: number) =>
      new Touch({
        identifier,
        target,
        clientX,
        clientY,
        pageX: clientX,
        pageY: clientY,
        screenX: clientX,
        screenY: clientY,
      });
    const primaryStart = touch(51, 2, 430);
    document.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [primaryStart],
        targetTouches: [primaryStart],
        changedTouches: [primaryStart],
      }),
    );
    const primaryMoved = touch(51, 150, 432);
    document.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [primaryMoved],
        targetTouches: [primaryMoved],
        changedTouches: [primaryMoved],
      }),
    );
    const secondary = touch(52, 300, 500);
    document.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [primaryMoved, secondary],
        targetTouches: [primaryMoved, secondary],
        changedTouches: [secondary],
      }),
    );
    document.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [primaryMoved],
        targetTouches: [primaryMoved],
        changedTouches: [secondary],
      }),
    );
    document.dispatchEvent(
      new TouchEvent('touchcancel', {
        bubbles: true,
        cancelable: false,
        touches: [],
        targetTouches: [],
        changedTouches: [primaryMoved],
      }),
    );
  });

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  expect(api.lifeRequests()).toBe(1);
});

test('failed Life history rollback cancels a held back drag', async ({ page }) => {
  const api = await installLifeApi(page, { delayLifeEvents: true, failLifeEvents: true });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 }, { hold: true });
  expect((await page.locator('.main').boundingBox())!.x).toBeGreaterThan(80);
  api.releaseLifeEvents();

  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('reopening the Life tail cancels a held back drag', async ({ page }) => {
  const api = await installLifeApi(page, { lifeSearchResult: true });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: 'Search' }).click();
  await page.locator('#search-input').fill('searchable');
  await expect(page.locator('.search-hit')).toBeVisible();
  await page.locator('.search-hit').click();
  await expect(page.locator('#jump-live')).toHaveClass(/visible/);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 }, { hold: true });
  expect((await page.locator('.main').boundingBox())!.x).toBeGreaterThan(80);
  await page.locator('#jump-live').evaluate((button: HTMLElement) => button.click());

  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  expect(api.lifeRequests()).toBe(1);
});

test('newer standard navigation cancels a held Life back drag', async ({ page }) => {
  const api = await installLifeApi(page, {
    standardSessions: [STANDARD_SESSION, OTHER_STANDARD_SESSION],
  });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 }, { hold: true });
  expect((await page.locator('.main').boundingBox())!.x).toBeGreaterThan(80);
  await page.evaluate((jid) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid } }),
    );
  }, OTHER_STANDARD_SESSION.jid);

  await expect(page.locator('#session-name')).toHaveText(OTHER_STANDARD_SESSION.name);
  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await page.waitForTimeout(50);

  await expect(page.locator('#session-name')).toHaveText(OTHER_STANDARD_SESSION.name);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  expect(api.lifeRequests()).toBe(1);
});

test('newer standard navigation cancels a held drawer drag without leaving its scrim', async ({ page }) => {
  await installLifeApi(page, {
    standardSessions: [STANDARD_SESSION, OTHER_STANDARD_SESSION],
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 100, y: 432 }, { hold: true });
  await expect(page.locator('#scrim')).toBeVisible();
  await page.evaluate((jid) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid } }),
    );
  }, OTHER_STANDARD_SESSION.jid);

  await expect(page.locator('#session-name')).toHaveText(OTHER_STANDARD_SESSION.name);
  await expect(page.locator('#scrim')).toBeHidden();
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await page.waitForTimeout(50);
  await expect(page.locator('#session-name')).toHaveText(OTHER_STANDARD_SESSION.name);
});

test('desktop breakpoint cancels a held Life back drag', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 }, { hold: true });
  expect((await page.locator('.main').boundingBox())!.x).toBeGreaterThan(80);
  await page.setViewportSize({ width: 800, height: 844 });

  await expect.poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  expect(api.lifeRequests()).toBe(1);
});

test('desktop breakpoint cancels a standard drawer drag without reviving its scrim', async ({ page }) => {
  await installLifeApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 100, y: 432 }, { hold: true });
  await expect(page.locator('#scrim')).toBeVisible();
  await page.setViewportSize({ width: 800, height: 844 });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.locator('#scrim')).toBeHidden();
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
});

test('tapping the right-edge leaf auto-settles into Life', async ({ page }) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const edgeHint = page.getByRole('button', { name: 'Open Life' });
  const edgeHintBox = (await edgeHint.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      {
        x: Math.round(edgeHintBox.x + edgeHintBox.width / 2),
        y: Math.round(edgeHintBox.y + edgeHintBox.height / 2),
      },
    ],
  });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await page.waitForTimeout(120);
  expect(api.lifeRequests()).toBe(0);
  const preview = page.locator('#life-swipe-preview');
  await expect(preview).toBeVisible();
  expect(
    await page.locator('#life-edge-hint').evaluate((element) => ({
      inert: element.inert,
      activeId: document.activeElement?.id,
    })),
  ).toEqual({ inert: true, activeId: 'life-swipe-cancel' });
  const startedPageX = (await page.locator('.main').boundingBox())!.x;
  await page.waitForTimeout(60);
  expect((await page.locator('.main').boundingBox())!.x).toBeLessThan(startedPageX);
  await expect.poll(api.lifeRequests).toBe(1);

  api.releaseLifeResponse();
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(preview).toBeHidden();
});

test('edge-button entry keeps an old-page sliver visible during its settle', async ({ page }) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.getByRole('button', { name: 'Open Life' }).click();
  await page.waitForTimeout(80);

  expect(api.lifeRequests()).toBe(0);
  const pageX = (await page.locator('.main').boundingBox())!.x;
  expect(pageX).toBeLessThan(-20);
  expect(pageX).toBeGreaterThan(-280);
  await expect.poll(api.lifeRequests).toBe(1);
  api.releaseLifeResponse();
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
});

test('fast Life readiness cannot replace the visible source during entry travel', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.getByRole('button', { name: 'Open Life' }).click();
  await page.waitForTimeout(80);

  expect(api.lifeRequests()).toBe(0);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  const pageX = (await page.locator('.main').boundingBox())!.x;
  expect(pageX).toBeLessThan(-20);
  expect(pageX).toBeGreaterThan(-280);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
});

test('ready Life content crossfades through the entry underlay', async ({ page }, testInfo) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.getByRole('button', { name: 'Open Life' }).click();
  await expect.poll(api.lifeRequests).toBe(1);
  await page.waitForTimeout(360);
  api.releaseLifeResponse();

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect
    .poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x))
    .toBe(0);
  const preview = page.locator('#life-swipe-preview');
  await expect(preview).toBeVisible();
  await page.waitForTimeout(60);
  const opacity = Number(await preview.evaluate((element) => getComputedStyle(element).opacity));
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('life-entry-crossfade.png') });
  await expect(preview).toBeHidden();
});

test('committed Life back swipe settles offscreen before switching pages', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 150, y: 432 }, { hold: true });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await page.waitForTimeout(60);

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  const pageX = (await page.locator('.main').boundingBox())!.x;
  expect(pageX).toBeGreaterThan(150);
  expect(pageX).toBeLessThan(390);
  await expect(page.locator('#life-swipe-preview')).toBeVisible();
  await expect(page.locator('#life-swipe-preview')).toHaveAttribute(
    'data-destination',
    'sessions',
  );

  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  await expect
    .poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x))
    .toBe(0);
  expect(api.lifeRequests()).toBe(1);
});

test('Sessions button uses the same smooth Life exit transition', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  await page.getByRole('button', { name: 'Return to sessions' }).click();
  await page.waitForTimeout(60);

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  const pageX = (await page.locator('.main').boundingBox())!.x;
  expect(pageX).toBeGreaterThan(0);
  expect(pageX).toBeLessThan(360);
  await expect(page.locator('#life-swipe-preview')).toHaveAttribute(
    'data-destination',
    'sessions',
  );

  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  expect(api.lifeRequests()).toBe(1);
});

test('Cancel Life exit returns to the settled Life page', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  await page.getByRole('button', { name: 'Return to sessions' }).click();
  const cancel = page.getByRole('button', { name: 'Cancel Life exit' });
  await expect(cancel).toBeVisible();
  await cancel.click();

  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  await expect
    .poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x))
    .toBe(0);
  await expect(page.getByRole('button', { name: 'Return to sessions' })).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('piweb.mode'))).toBe('life');
  expect(api.lifeRequests()).toBe(1);
});

test('Cancel Life exit re-enters Life after standard selection has started', async ({ page }) => {
  const api = await installLifeApi(page, { delayStandardEvents: true });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const standardEvents = page.waitForRequest((request) =>
    request.url().includes(`/api/sessions/${encodeURIComponent(STANDARD_SESSION.jid)}/events`),
  );
  await page.getByRole('button', { name: 'Return to sessions' }).click();
  await standardEvents;
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  const cancel = page.getByRole('button', { name: 'Cancel Life exit' });
  await expect(cancel).toBeVisible();
  await cancel.click();

  await expect.poll(api.lifeRequests).toBe(2);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Return to sessions' })).toBeFocused();
  api.releaseStandardEvents();
  await page.waitForTimeout(100);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
});

test('desktop breakpoint re-enters Life after standard selection has started', async ({ page }) => {
  const api = await installLifeApi(page, {
    delayStandardEvents: true,
    delaySecondLife: true,
  });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const standardEvents = page.waitForRequest((request) =>
    request.url().includes(`/api/sessions/${encodeURIComponent(STANDARD_SESSION.jid)}/events`),
  );
  await page.getByRole('button', { name: 'Return to sessions' }).click();
  await standardEvents;
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await page.setViewportSize({ width: 800, height: 844 });

  await expect.poll(api.lifeRequests).toBe(2);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  expect(await page.locator('.main').evaluate((element) => element.inert)).toBe(false);
  expect(
    await page.locator('.main').evaluate((element: HTMLElement) => ({
      transform: element.style.transform,
      transition: element.style.transition,
    })),
  ).toEqual({ transform: '', transition: '' });
  api.releaseSecondLife();
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  api.releaseStandardEvents();
  await page.waitForTimeout(100);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
});

test('reduced motion finishes Life entry and exit without stale transition state', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Life' }).click();

  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  expect(await page.locator('.main').evaluate((element) => element.inert)).toBe(false);

  await page.getByRole('button', { name: 'Return to sessions' }).click();
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  await expect
    .poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x))
    .toBe(0);
});

test('newer navigation cancels a committed Life back settlement', async ({ page }) => {
  const api = await installLifeApi(page, {
    standardSessions: [STANDARD_SESSION, OTHER_STANDARD_SESSION],
  });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  await page.getByRole('button', { name: 'Return to sessions' }).click();
  await page.waitForTimeout(60);
  expect((await page.locator('.main').boundingBox())!.x).toBeGreaterThan(0);
  await page.evaluate((jid) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid } }),
    );
  }, OTHER_STANDARD_SESSION.jid);

  await expect(page.locator('#session-name')).toHaveText(OTHER_STANDARD_SESSION.name);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  await expect
    .poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x))
    .toBe(0);
  await page.waitForTimeout(400);
  await expect(page.locator('#session-name')).toHaveText(OTHER_STANDARD_SESSION.name);
  expect(api.lifeRequests()).toBe(1);
});

test('shallow Life back swipe eases home instead of snapping', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);

  const touch = await touchDrag(page, { x: 2, y: 430 }, { x: 60, y: 432 }, { hold: true });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await page.waitForTimeout(35);

  const settlingX = (await page.locator('.main').boundingBox())!.x;
  expect(settlingX).toBeGreaterThan(0);
  expect(settlingX).toBeLessThan(58);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect
    .poll(() => page.locator('.main').evaluate((element) => element.getBoundingClientRect().x))
    .toBe(0);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  expect(api.lifeRequests()).toBe(1);
});

test('a vertical drag on the edge button scrolls the underlying transcript', async ({ page }) => {
  const api = await installLifeApi(page, { standardEventCount: 40 });
  await page.goto('/');
  await expect(page.locator('#messages')).toContainText('Scrollable message 40');
  const messages = page.locator('#messages');
  const scrollMetrics = await messages.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  await messages.evaluate((element) => {
    element.scrollTop = 0;
  });

  const edgeBox = (await page.getByRole('button', { name: 'Open Life' }).boundingBox())!;
  const center = {
    x: Math.round(edgeBox.x + edgeBox.width / 2),
    y: Math.round(edgeBox.y + edgeBox.height / 2),
  };
  await touchDrag(page, center, { x: center.x, y: center.y - 180 });

  expect(await messages.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(api.lifeRequests()).toBe(0);
});

test('a short flick from the wider right edge settles into Life with inertia', async ({ page }) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  // Start 50px from the edge and move only 55px: distance alone is not enough,
  // but a quick release should project the panel forward using flick velocity.
  await touchDrag(page, { x: 340, y: 430 }, { x: 285, y: 431 });
  expect(api.lifeRequests()).toBe(0);

  const preview = page.locator('#life-swipe-preview');
  await expect(preview).toBeVisible();
  const releasePageX = (await page.locator('.main').boundingBox())!.x;
  await page.waitForTimeout(60);
  const settlingPageX = (await page.locator('.main').boundingBox())!.x;
  expect(settlingPageX).toBeLessThan(releasePageX);
  expect(settlingPageX).toBeGreaterThanOrEqual(-390);
  await expect.poll(api.lifeRequests).toBe(1);

  api.releaseLifeResponse();
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(preview).toBeHidden();
});

test('a flick reversing right before release does not inherit leftward momentum', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 340, y: 430 }],
  });
  for (const x of [310, 270, 285]) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 431 }],
    });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();

  expect(api.lifeRequests()).toBe(0);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('a rightward reversal followed by tiny left jitter does not revive old momentum', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 340, y: 430 }],
  });
  for (const x of [270, 300, 285]) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 431 }],
    });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();

  expect(api.lifeRequests()).toBe(0);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('a rightward release cancels even after crossing the distance threshold', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 388, y: 430 }],
  });
  for (const x of [260, 200, 250]) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: 431 }],
    });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();

  expect(api.lifeRequests()).toBe(0);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('a pending Life swipe can be cancelled before its endpoint returns', async ({ page }) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel Life entry' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel Life entry' }).click();

  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await expect(page.locator('#life-edge-hint')).toBeFocused();
  api.releaseLifeResponse();
  await page.waitForTimeout(50);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('desktop breakpoint cancels a held drag before touch release', async ({ page }) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const touch = await touchDrag(
    page,
    { x: 388, y: 430 },
    { x: 170, y: 432 },
    { hold: true },
  );
  await expect(page.locator('#life-swipe-preview')).toBeVisible();
  await page.setViewportSize({ width: 800, height: 844 });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();

  expect(api.lifeRequests()).toBe(0);
  expect(await page.locator('.main').evaluate((element) => element.inert)).toBe(false);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('desktop breakpoint cancels delayed settlement before hiding its controls', async ({ page }) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel Life entry' })).toBeVisible();
  expect(await page.locator('.main').evaluate((element) => element.inert)).toBe(true);

  await page.setViewportSize({ width: 800, height: 844 });
  await expect.poll(() => page.locator('.main').evaluate((element) => element.inert)).toBe(false);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  expect(await page.evaluate(() => localStorage.getItem('piweb.mode'))).toBe('sessions');

  api.releaseLifeResponse();
  await page.waitForTimeout(50);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
});

test('settling Life blocks an underlying drawer edge drag', async ({ page }) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.locator('#life-swipe-preview')).toBeVisible();

  await touchDrag(page, { x: 2, y: 430 }, { x: 220, y: 432 });
  await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  await expect(page.locator('#life-swipe-preview')).toBeVisible();

  api.releaseLifeResponse();
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
});

test('settling Life owns input until delayed entry finishes', async ({ page }) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await page.locator('#input').fill('standard draft must not send');
  await page.locator('#input').focus();

  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.locator('#life-swipe-preview')).toBeVisible();

  const ownership = await page.evaluate(() => {
    const preview = document.querySelector('#life-swipe-preview');
    const main = document.querySelector('.main');
    const drawer = document.querySelector('#drawer');
    const edgeHint = document.querySelector('#life-edge-hint');
    const hit = document.elementFromPoint(window.innerWidth - 28, window.innerHeight - 34);
    return {
      mainInert: main?.inert,
      drawerInert: drawer?.inert,
      edgeHintInert: edgeHint?.inert,
      activeId: document.activeElement?.id,
      pointerEvents: preview ? getComputedStyle(preview).pointerEvents : null,
      hitId: hit?.id,
    };
  });
  expect(ownership).toEqual({
    mainInert: true,
    drawerInert: true,
    edgeHintInert: true,
    activeId: 'life-swipe-cancel',
    pointerEvents: 'auto',
    hitId: 'life-swipe-preview',
  });
  await page.keyboard.type('x');
  await page.waitForTimeout(50);
  expect(api.messagePaths).toEqual([]);

  api.releaseLifeResponse();
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();
  expect(await page.locator('.main').evaluate((element) => element.inert)).toBe(false);
});

test('a right-edge tap below the axis lock never flashes the Life preview', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await touchDrag(page, { x: 388, y: 430 }, { x: 388, y: 430 });

  expect(await page.locator('#life-swipe-preview').isHidden()).toBe(true);
  expect(api.lifeRequests()).toBe(0);
});

test('an open overflow menu owns the right-edge gesture', async ({ page }) => {
  const api = await installLifeApi(page);
  await page.goto('/');
  await page.locator('#btn-more').click();
  await expect(page.locator('#more-menu')).toBeVisible();

  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });

  expect(api.lifeRequests()).toBe(0);
  await expect(page.locator('#more-menu')).toBeVisible();
});

test('newer standard navigation cancels a delayed swipe settlement', async ({ page }) => {
  const api = await installLifeApi(page, {
    delayLife: true,
    standardSessions: [STANDARD_SESSION, OTHER_STANDARD_SESSION],
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.locator('#life-swipe-preview')).toBeVisible();

  await page.evaluate((jid) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid } }),
    );
  }, OTHER_STANDARD_SESSION.jid);
  await expect(page.locator('#session-name')).toHaveText(OTHER_STANDARD_SESSION.name);
  await expect(page.locator('#life-swipe-preview')).toBeHidden();

  api.releaseLifeResponse();
  await page.waitForTimeout(50);
  await expect(page.locator('#session-name')).toHaveText(OTHER_STANDARD_SESSION.name);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('a trash preview started after Life entry keeps navigation ownership', async ({ page }) => {
  const api = await installLifeApi(page, {
    delayLife: true,
    deletedSessions: [DELETED_SESSION],
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect.poll(api.lifeRequests).toBe(1);

  await page.locator('#btn-menu').click();
  await page.getByRole('button', { name: 'Recently deleted' }).click();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('#session-name')).toHaveText(DELETED_SESSION.name);
  await expect(page.locator('#deleted-banner')).toBeVisible();

  const lifeResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/life-session'),
  );
  api.releaseLifeResponse();
  await lifeResponse;
  await page.waitForTimeout(50);

  await expect(page.locator('#session-name')).toHaveText(DELETED_SESSION.name);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('a trash restore started after Life entry wins even when its API finishes later', async ({
  page,
}) => {
  const api = await installLifeApi(page, {
    delayLife: true,
    delayRestore: true,
    deletedSessions: [DELETED_SESSION],
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect.poll(api.lifeRequests).toBe(1);

  await page.locator('#btn-menu').click();
  await page.getByRole('button', { name: 'Recently deleted' }).click();
  const restoreRequest = page.waitForRequest((request) => request.url().endsWith('/restore'));
  await page.getByRole('button', { name: 'Restore' }).click();
  await restoreRequest;

  const lifeResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/life-session'),
  );
  api.releaseLifeResponse();
  await lifeResponse;
  const restoreResponse = page.waitForResponse((response) => response.url().endsWith('/restore'));
  api.releaseRestore();
  await restoreResponse;

  await expect(page.locator('#session-name')).toHaveText(DELETED_SESSION.name);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('a session delete started after Life entry owns the eventual fallback selection', async ({
  page,
}) => {
  const api = await installLifeApi(page, {
    delayLife: true,
    delayDelete: true,
    standardSessions: [STANDARD_SESSION, OTHER_STANDARD_SESSION],
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect.poll(api.lifeRequests).toBe(1);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#btn-menu').click();
  const deleteRequest = page.waitForRequest(
    (request) =>
      request.method() === 'DELETE' && request.url().includes(encodeURIComponent(STANDARD_SESSION.jid)),
  );
  await page.getByRole('button', { name: `Delete ${STANDARD_SESSION.name}` }).click();
  await deleteRequest;

  const lifeResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/life-session'),
  );
  api.releaseLifeResponse();
  await lifeResponse;
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes(encodeURIComponent(STANDARD_SESSION.jid)),
  );
  api.releaseDelete();
  await deleteResponse;

  await expect(page.locator('#session-name')).toHaveText(OTHER_STANDARD_SESSION.name);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('a delayed new-session response cannot override newer Life navigation', async ({ page }) => {
  const api = await installLifeApi(page, { delayCreate: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.locator('#btn-menu').click();
  const createRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/sessions') && request.method() === 'POST',
  );
  await page.locator('#btn-new-session').click();
  await createRequest;

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);

  const createResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/sessions') && response.request().method() === 'POST',
  );
  api.releaseCreate();
  await createResponse;
  await page.waitForTimeout(50);

  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
});

test('a delayed clean response cannot clear a newer Life transcript', async ({ page }) => {
  const api = await installLifeApi(page, { delayClear: true, lifeEventState: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#btn-more').click();
  const clearRequest = page.waitForRequest((request) => request.url().endsWith('/clear'));
  await page.getByRole('menuitem', { name: 'Clean session' }).click();
  await clearRequest;

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect(page.locator('#messages')).toContainText('Life-only history');

  const clearResponse = page.waitForResponse((response) => response.url().endsWith('/clear'));
  api.releaseClear();
  await clearResponse;
  await page.waitForTimeout(50);

  await expect(page.locator('#messages')).toContainText('Life-only history');
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
});

test('a delayed trash load is closed and ignored after Life navigation', async ({ page }) => {
  const api = await installLifeApi(page, {
    delayTrashLoad: true,
    deletedSessions: [DELETED_SESSION],
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.locator('#btn-menu').click();
  const trashRequest = page.waitForRequest((request) =>
    request.url().endsWith('/api/sessions/deleted'),
  );
  await page.getByRole('button', { name: 'Recently deleted' }).click();
  await trashRequest;
  await expect(page.locator('#trash-note')).toHaveText('Loading…');

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);

  const trashResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/sessions/deleted'),
  );
  api.releaseTrashLoad();
  await trashResponse;
  await page.waitForTimeout(50);

  await expect(page.locator('#trash-sheet')).toBeHidden();
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
});

test('a pending unvalidated destination blocks all prior-session interactions', async ({ page }) => {
  const api = await installLifeApi(page, {
    delayUnknownEvents: true,
    oldStreamEventDuringPending: true,
  });
  api.markUnknownDeleted();
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const pendingEvents = page.waitForRequest((request) =>
    request.url().includes(encodeURIComponent('web:newly-restored')),
  );
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });
  await pendingEvents;
  await expect(page.locator('#composer-wrap')).toBeHidden();
  await page.locator('#input').evaluate((textarea: HTMLTextAreaElement) => {
    textarea.value = 'must not reach an unvalidated target';
  });
  await page.locator('#composer').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await page.waitForTimeout(50);
  expect(api.messagePaths).toEqual([]);

  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: 'Search' }).click();
  await expect(page.locator('#search-panel')).toBeHidden();
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: 'Media' }).click();
  await expect(page.locator('#media-sheet')).toBeHidden();
  await page.locator('#session-name').click();
  await expect(page.locator('#session-name-input')).toBeHidden();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(100);
  await expect(page.locator('#messages')).not.toContainText('old pending stream event');

  api.releaseUnknownEvents();
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
});

test('a newer Life navigation invalidates a pending standard selection before commit', async ({
  page,
}) => {
  const api = await installLifeApi(page, { delayUnknownEvents: true, delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const pendingEvents = page.waitForRequest((request) =>
    request.url().includes(encodeURIComponent('web:newly-restored')),
  );
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });
  await pendingEvents;

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect.poll(api.lifeRequests).toBe(1);
  api.releaseUnknownEvents();
  await page.waitForTimeout(100);
  await expect(page.locator('#composer-wrap')).toBeHidden();

  api.releaseLifeResponse();
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
});

test('validated metadata name wins over a stale poll during pending selection', async ({ page }) => {
  const api = await installLifeApi(page, {
    delayUnknownEvents: true,
    unknownMetadataName: 'Confirmed notification target',
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  const pendingEvents = page.waitForRequest((request) =>
    request.url().includes(encodeURIComponent('web:newly-restored')),
  );
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });
  await pendingEvents;
  api.setStandardSessions([{ ...STANDARD_SESSION, name: 'Stale old-session title' }]);
  await page.waitForTimeout(5_200);
  api.releaseUnknownEvents();

  await expect(page.locator('#session-name')).toHaveText('Confirmed notification target');
});

test('pending selection cancels an existing drawer rename and disables deletion', async ({
  page,
}) => {
  const api = await installLifeApi(page, { delayUnknownEvents: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await page.locator('#btn-menu').click();
  const listName = page.locator('#session-list .session-name-edit, #session-list .name').first();
  await listName.dispatchEvent('pointerdown', {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 100,
    clientY: 100,
  });
  await page.waitForTimeout(600);
  await expect(page.locator('#session-list .session-name-edit')).toBeVisible();

  const pendingEvents = page.waitForRequest((request) =>
    request.url().includes(encodeURIComponent('web:newly-restored')),
  );
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });
  await pendingEvents;

  await expect(page.locator('#session-list .session-name-edit')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: `Delete ${STANDARD_SESSION.name}` }),
  ).toBeDisabled();
  api.releaseUnknownEvents();
});

test('a delayed immediate title cannot overwrite pending destination chrome', async ({ page }) => {
  const api = await installLifeApi(page, {
    delayMessage: true,
    messageSessionTitle: 'Old session generated title',
    delayUnknownEvents: true,
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await page.locator('#input').fill('title the old session');
  const messageRequest = page.waitForRequest((request) => request.url().endsWith('/messages'));
  await page.locator('#btn-send').click();
  await messageRequest;

  const pendingEvents = page.waitForRequest((request) =>
    request.url().includes(encodeURIComponent('web:newly-restored')),
  );
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });
  await pendingEvents;
  await expect(page.locator('#session-name')).toHaveText('web:newly-restored');

  const messageResponse = page.waitForResponse((response) => response.url().endsWith('/messages'));
  api.releaseMessage();
  await messageResponse;
  await page.waitForTimeout(50);
  await expect(page.locator('#session-name')).toHaveText('web:newly-restored');

  api.releaseUnknownEvents();
  await expect(page.locator('#session-name')).toHaveText('web:newly-restored');
});

test('malformed live deletion state fails closed', async ({ page }) => {
  await installLifeApi(page, { omitOrdinaryDeletedState: true });
  const eventsResponse = page.waitForResponse(
    (response) =>
      response.url().includes(encodeURIComponent(STANDARD_SESSION.jid)) &&
      response.url().includes('/events'),
  );
  await page.goto('/');
  await eventsResponse;
  await page.waitForTimeout(50);

  await expect(page.locator('#session-name')).toHaveText('no session');
});

test('missing metadata cannot be bypassed by a cached standard-session row', async ({ page }) => {
  await installLifeApi(page, { omitOrdinaryMetadata: true });
  const eventsResponse = page.waitForResponse(
    (response) =>
      response.url().includes(encodeURIComponent(STANDARD_SESSION.jid)) &&
      response.url().includes('/events'),
  );
  await page.goto('/');
  await eventsResponse;
  await page.waitForTimeout(50);

  await expect(page.locator('#session-name')).toHaveText('no session');
  await expect(page.locator('#messages')).toBeEmpty();
});

test('boot routing cannot override a newer trash preview', async ({ page }) => {
  const api = await installLifeApi(page, {
    delayBoot: true,
    deletedSessions: [DELETED_SESSION],
  });
  await page.goto(`/?session=${encodeURIComponent('web:newly-restored')}`);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page).toHaveURL('/');

  await page.locator('#btn-menu').click();
  await page.getByRole('button', { name: 'Recently deleted' }).click();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('#session-name')).toHaveText(DELETED_SESSION.name);

  const commandsResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/commands'),
  );
  api.releaseBoot();
  await commandsResponse;
  await page.waitForTimeout(100);

  await expect(page.locator('#session-name')).toHaveText(DELETED_SESSION.name);
  await expect(page.locator('#deleted-banner')).toBeVisible();
});

test('attachment conversion snapshots the original draft and cannot consume a later Life paste', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = FileReader.prototype.readAsDataURL;
    const pending: Array<() => void> = [];
    let autoRelease = false;
    FileReader.prototype.readAsDataURL = function delayedRead(blob: Blob) {
      if (autoRelease) return original.call(this, blob);
      pending.push(() => original.call(this, blob));
    };
    (window as any).__pendingFileReaders = () => pending.length;
    (window as any).__releaseFileReaders = () => {
      autoRelease = true;
      for (const release of pending.splice(0)) release();
    };
  });
  const api = await installLifeApi(page);
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({
    name: 'first.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('first attachment'),
  });
  await page.locator('#input').fill('standard destination');
  await page.locator('#btn-send').click();
  await expect.poll(() => page.evaluate(() => (window as any).__pendingFileReaders())).toBe(1);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['second attachment'], 'second.txt', { type: 'text/plain' }));
    document.querySelector('#input')!.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
    );
  });
  await expect(page.getByRole('button', { name: 'Remove second.txt' })).toBeVisible();

  await page.evaluate(() => (window as any).__releaseFileReaders());
  await expect.poll(() => api.messageBodies.length).toBe(1);
  const sent = api.messageBodies[0] as { attachments: Array<{ name: string }> };
  expect(sent.attachments.map((attachment) => attachment.name)).toEqual(['first.txt']);
  expect(api.messagePaths[0]).toBe(
    `/api/sessions/${encodeURIComponent(STANDARD_SESSION.jid)}/messages`,
  );
  await expect(page.getByRole('button', { name: 'Remove second.txt' })).toBeVisible();
});

test('an attachment converting across New cannot spill into fresh Life', async ({ page }) => {
  await page.addInitScript(() => {
    const original = FileReader.prototype.readAsDataURL;
    const pending: Array<() => void> = [];
    FileReader.prototype.readAsDataURL = function delayedRead(blob: Blob) {
      pending.push(() => original.call(this, blob));
    };
    (window as any).__pendingFileReaders = () => pending.length;
    (window as any).__releaseFileReaders = () => {
      for (const release of pending.splice(0)) release();
    };
    localStorage.setItem('piweb.mode', 'life');
  });
  const api = await installLifeApi(page);
  page.on('dialog', (dialog) => void dialog.dismiss());
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({
    name: 'old-life.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('old Life attachment'),
  });
  await page.locator('#input').fill('old Life draft');
  await page.locator('#btn-send').click();
  await expect.poll(() => page.evaluate(() => (window as any).__pendingFileReaders())).toBe(1);

  await page.getByRole('button', { name: 'New Life session' }).click();
  await expect.poll(api.archivedLifeCount).toBe(1);
  await expect(page.locator('#messages .msg')).toHaveCount(0);

  const staleMessage = page.waitForResponse(
    (response) =>
      response.url().includes('/messages') && response.request().method() === 'POST',
  );
  await page.evaluate(() => (window as any).__releaseFileReaders());
  const response = await staleMessage;
  expect(response.status()).toBe(409);
  expect(response.request().postDataJSON()).toMatchObject({
    lifeGeneration: 'life-generation-1',
  });
  expect(api.messagePaths).toEqual([]);
  await expect(page.locator('#messages .msg')).toHaveCount(0);
});

test('a delayed slash command cannot clear a newer Life draft', async ({ page }) => {
  const api = await installLifeApi(page, {
    delayCommand: true,
    commandCatalog: [{ name: 'pi stop' }],
  });
  await page.goto('/');
  await page.locator('#input').fill('/pi stop');
  const commandRequest = page.waitForRequest((request) => request.url().endsWith('/commands'));
  await page.locator('#btn-send').click();
  await commandRequest;

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
  await expect(page.locator('#input')).toHaveValue('');
  await page.locator('#input').fill('Life draft must survive');

  const commandResponse = page.waitForResponse((response) => response.url().endsWith('/commands'));
  api.releaseCommand();
  await commandResponse;
  await page.waitForTimeout(50);

  await expect(page.locator('#input')).toHaveValue('Life draft must survive');
});

test('a Life endpoint response cannot substitute a standard-session JID', async ({ page }) => {
  const api = await installLifeApi(page, { corruptLifeEndpoint: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect.poll(api.lifeRequests).toBe(1);
  await page.waitForTimeout(100);

  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#header-badge')).not.toHaveText('DEFAULT');
});

test('corrupt Life event metadata fails back to the standard destination', async ({ page }) => {
  const api = await installLifeApi(page, { corruptLifeMetadata: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  const lifeEventsResponse = page.waitForResponse(
    (response) =>
      response.url().includes(encodeURIComponent(LIFE_SESSION.jid)) &&
      response.url().includes('/events'),
  );
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect.poll(api.lifeRequests).toBe(1);
  const lifeEvents = await lifeEventsResponse;
  expect((await lifeEvents.json()).session).toMatchObject({
    jid: 'web:wrong-target',
    kind: 'life',
  });
  await page.waitForTimeout(500);

  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('corrupt deleted-preview metadata falls back without enabling the trash target', async ({
  page,
}) => {
  await installLifeApi(page, {
    corruptDeletedMetadata: true,
    deletedSessions: [DELETED_SESSION],
  });
  await page.goto('/');
  await page.locator('#btn-menu').click();
  await page.getByRole('button', { name: 'Recently deleted' }).click();
  await page.getByRole('button', { name: 'Preview' }).click();

  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await expect(page.locator('#deleted-banner')).toBeHidden();
});

test('a delayed Life media response cannot overwrite a standard session gallery', async ({
  page,
}) => {
  const api = await installLifeApi(page, { delayLifeMedia: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: 'Media' }).click();
  await expect(page.locator('#media-note')).toHaveText('Loading…');
  await page.locator('#btn-media-close').click();

  await page.getByRole('button', { name: 'Return to sessions' }).click();
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: 'Media' }).click();
  await expect(page.getByRole('button', { name: 'image: Standard image' })).toBeVisible();

  api.releaseLifeMedia();
  await expect(page.getByRole('button', { name: 'image: Standard image' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'image: Life image' })).toHaveCount(0);
  await expect(page.locator('#media-note')).toHaveText('1 item');
});

test('a live standard notification opens its JID when the session cache is stale', async ({
  page,
}) => {
  await installLifeApi(page, { unknownReplyEvent: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });

  await expect(page.locator('#session-name')).toHaveText('web:newly-restored');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('piweb.seen') || '{}')['web:newly-restored']),
    )
    .toBe(77);
});

test('a stale-cache standard notification remains the Life return target', async ({ page }) => {
  await installLifeApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText('web:newly-restored');

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
  await page.getByRole('button', { name: 'Return to sessions' }).click();

  await expect(page.locator('#session-name')).toHaveText('web:newly-restored');
});

test('a failed remembered notification target falls back to the newest standard session', async ({
  page,
}) => {
  const api = await installLifeApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText('web:newly-restored');
  api.failUnknownEvents();

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
  await page.getByRole('button', { name: 'Return to sessions' }).click();

  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
});

test('a failed remembered notification target clears to empty when no standard exists', async ({
  page,
}) => {
  const api = await installLifeApi(page, { standardSessions: [] });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('no session');

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText('web:newly-restored');
  api.failUnknownEvents();

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText(LIFE_SESSION.name);
  await page.getByRole('button', { name: 'Return to sessions' }).click();

  await expect(page.locator('#session-name')).toHaveText('no session');
  await expect(page.locator('#messages')).toBeEmpty();
});

test('a deleted absent-list notification target falls back instead of enabling its composer', async ({
  page,
}) => {
  const api = await installLifeApi(page);
  api.markUnknownDeleted();
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'open-session', jid: 'web:newly-restored' },
      }),
    );
  });

  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await page.locator('#input').fill('must stay on the live session');
  await page.locator('#btn-send').click();
  await expect.poll(() => api.messagePaths.length).toBe(1);
  expect(api.messagePaths[0]).toBe(
    `/api/sessions/${encodeURIComponent(STANDARD_SESSION.jid)}/messages`,
  );
});

test('a boot standard notification opens its JID when the session cache is stale', async ({
  page,
}) => {
  await installLifeApi(page);
  await page.goto(`/?session=${encodeURIComponent('web:newly-restored')}`);

  await expect(page.locator('#session-name')).toHaveText('web:newly-restored');
  await expect(page).toHaveURL('/');
});

test('Life notification navigation enters the singleton in existing and new windows', async ({
  page,
}) => {
  const api = await installLifeApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText('Life');

  // Re-opening the already active Life destination must re-run the endpoint and
  // event selection; a same-page logout/login has the same retained JS state.
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:life' } }),
    );
  });
  await expect.poll(api.lifeRequests).toBe(2);

  await page.evaluate(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto(`/?session=${encodeURIComponent(LIFE_SESSION.jid)}`);
  await expect.poll(api.lifeRequests).toBe(3);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText('Life');
  await expect(page).toHaveURL(/\/$/);

  // The notification target is one-shot: leaving Life and reloading must not
  // replay the stale query parameter.
  await page.locator('#btn-life-back').click();
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await page.reload();
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  // An explicit standard-session notification wins over a persisted Life mode.
  await page.evaluate(() => localStorage.setItem('piweb.mode', 'life'));
  await page.goto(`/?session=${encodeURIComponent(STANDARD_SESSION.jid)}`);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
});

test('a late Life endpoint response cannot override newer standard navigation', async ({
  page,
}) => {
  const api = await installLifeApi(page, { delayLife: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });
  await expect.poll(api.lifeRequests).toBe(1);
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent('message', { data: { type: 'open-session', jid: 'web:ordinary' } }),
    );
  });
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  api.releaseLifeResponse();
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
});

test('a late Life event response cannot overwrite a cancelled swipe', async ({ page }) => {
  const api = await installLifeApi(page, { delayLifeEvents: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await page.getByRole('button', { name: 'Cancel Life entry' }).click();
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  api.releaseLifeEvents();
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await expect(page.locator('#messages')).not.toContainText('late Life transcript');
});

test('a Life event-load failure after a successful endpoint restores the standard session', async ({
  page,
}) => {
  const api = await installLifeApi(page, { failLifeEvents: true });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);

  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('piweb.mode'))).toBe('sessions');
});

test('leaving Life with no standard sessions clears Life ownership and renders an empty standard state', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const stats = { opened: 0, closed: 0 };
    (window as any).__lifeStreamStats = stats;
    (window as any).EventSource = class {
      constructor() {
        stats.opened += 1;
      }
      addEventListener() {}
      close() {
        stats.closed += 1;
      }
    };
  });
  const api = await installLifeApi(page, { standardSessions: [], lifeEventState: true });

  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('no session');
  await touchDrag(page, { x: 388, y: 430 }, { x: 170, y: 432 });
  await expect(page.locator('#app')).toHaveClass(/life-mode/);
  await expect(page.locator('#messages')).toContainText('Life-only history');
  await expect(page.locator('#partial-msg')).toContainText('unfinished Life response');
  await expect(page.locator('#typing')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__lifeStreamStats.opened)).toBe(1);

  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: 'Search' }).click();
  await expect(page.locator('#search-panel')).toBeVisible();
  await page.locator('#btn-life-back').click();

  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText('no session');
  await expect(page.locator('#messages')).toBeEmpty();
  await expect(page.locator('#partial-msg')).toHaveCount(0);
  await expect(page.locator('#typing')).toBeHidden();
  await expect(page.locator('#btn-stop')).toBeHidden();
  await expect(page.locator('#header-badge')).toBeHidden();
  await expect(page.locator('#search-panel')).toBeHidden();
  await expect(page.locator('#composer-wrap')).toBeVisible();
  await expect(page.locator('#btn-model')).toBeVisible();
  await expect(page.locator('#btn-more')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__lifeStreamStats.closed)).toBe(1);

  let alertMessage = '';
  page.once('dialog', async (dialog) => {
    alertMessage = dialog.message();
    await dialog.dismiss();
  });
  await page.locator('#input').fill('must not go to Life');
  await page.locator('#btn-send').click();
  await expect.poll(() => alertMessage).toBe('Create or pick a session first.');
  expect(api.messagePaths).toEqual([]);
});

test('a failed Life history load with no standard sessions clears the selected Life channel', async ({
  page,
}) => {
  const api = await installLifeApi(page, {
    failLifeEvents: true,
    standardSessions: [],
  });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));

  await page.goto('/');
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText('no session');
  await expect(page.locator('#messages')).toBeEmpty();
  await expect(page.locator('#typing')).toBeHidden();
  await expect(page.locator('#header-badge')).toBeHidden();
  await expect(page.locator('#btn-model')).toBeVisible();
  await expect(page.locator('#composer-wrap')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('piweb.mode'))).toBe('sessions');

  let alertMessage = '';
  page.once('dialog', async (dialog) => {
    alertMessage = dialog.message();
    await dialog.dismiss();
  });
  await page.locator('#input').fill('must still not go to Life');
  await page.locator('#btn-send').click();
  await expect.poll(() => alertMessage).toBe('Create or pick a session first.');
  expect(api.messagePaths).toEqual([]);
});

test('Life edge affordance and gesture are disabled with the permanent desktop drawer', async ({
  page,
}) => {
  const api = await installLifeApi(page);
  await page.setViewportSize({ width: 800, height: 844 });
  await page.goto('/');

  await expect(page.locator('#life-edge-hint')).toBeHidden();
  await touchDrag(page, { x: 798, y: 430 }, { x: 500, y: 432 });
  expect(api.lifeRequests()).toBe(0);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
});

test('a failed persisted Life entry falls back to the most recent standard session', async ({
  page,
}) => {
  const api = await installLifeApi(page, { failLife: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'life'));

  await page.goto('/');
  await expect.poll(api.lifeRequests).toBe(1);
  await expect(page.locator('#app')).not.toHaveClass(/life-mode/);
  await expect(page.locator('#session-name')).toHaveText(STANDARD_SESSION.name);
  expect(await page.evaluate(() => localStorage.getItem('piweb.mode'))).toBe('sessions');
  expect(pageErrors).toEqual([]);
});
