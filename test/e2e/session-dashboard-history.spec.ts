import { expect, test, type Page } from 'playwright/test';

// A Dashboard pane opens on the newest page of its session and pages older
// history in as the reader scrolls up, like the single-session view, keeping
// the text under the reader's eyes still while a page lands above it.
const TOTAL = 180;
const PAGE = 50;
const sessions = ['Long history', 'Neighbour'].map((name, i) => ({
  jid: `web:h${i}`,
  name,
  folder: `web_h${i}`,
  kind: 'standard',
  deleted: false,
  busy: false,
  lastReplyId: TOTAL,
  lastActivity: `2026-10-26 11:${String(50 - i).padStart(2, '0')}:00`,
}));
const [LONG, NEIGHBOUR] = sessions.map((s) => s.jid);
const event = (jid: string, id: number) => ({
  id,
  kind: 'message',
  role: id % 4 === 0 ? 'user' : 'assistant',
  content: `${jid} history ${id}: ${'lorem ipsum dolor sit amet '.repeat(14)}`,
  files: [],
  createdAt: '2026-10-26T03:00:00Z',
});

test.use({ viewport: { width: 1376, height: 1032 }, isMobile: false, hasTouch: false });

async function setup(page: Page) {
  const errors: string[] = [];
  const olderRequests: Array<{ jid: string; before: number }> = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((layout) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.dashboard', JSON.stringify(layout));
  }, {
    direction: 'row',
    updatedAt: Date.now(),
    groups: [
      { weight: 1, items: [{ jid: LONG, weight: 1 }] },
      { weight: 1, items: [{ jid: NEIGHBOUR, weight: 1 }] },
    ],
  });
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => s.jid === path.split('/')[3])!;
      const total = session.jid === LONG ? TOTAL : 20;
      const before = Number(url.searchParams.get('before') || 0) || total + 1;
      // limit=200 is the prompt pin looking for the prompt above the page.
      if (url.searchParams.get('before') && url.searchParams.get('limit') === String(PAGE)) {
        olderRequests.push({ jid: session.jid, before });
        await new Promise((r) => setTimeout(r, 150));
      }
      const from = Math.max(1, before - PAGE);
      const rows = Array.from({ length: before - from }, (_, i) => event(session.jid, from + i));
      return route.fulfill({
        json: { events: rows, busy: false, hasMore: from > 1, session },
      });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  await page.locator('#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(2);
  return { errors, olderRequests };
}

const messagesOf = (page: Page, jid: string) =>
  page.locator(`.dashboard-pane[data-jid="${jid}"] .dashboard-pane-messages`);

/** The first event row whose bottom is below the transcript's top edge, and where it sits. */
const readingRow = (page: Page, jid: string) =>
  messagesOf(page, jid).evaluate((m) => {
    const top = m.getBoundingClientRect().top;
    const row = [...m.querySelectorAll<HTMLElement>(':scope > [data-event-id]')].find(
      (n) => n.getBoundingClientRect().bottom > top + 1,
    )!;
    return { id: row.dataset.eventId, offset: row.getBoundingClientRect().top - top };
  });

test('a Dashboard pane pages older history in as the reader scrolls up', async ({ page }, info) => {
  const { errors, olderRequests } = await setup(page);
  const messages = messagesOf(page, LONG);
  const rows = messages.locator(':scope > [data-event-id]');
  await expect(rows).toHaveCount(PAGE);
  await expect(rows.first()).toHaveAttribute('data-event-id', String(TOTAL - PAGE + 1));
  await expect(messages.locator('.top-sentinel')).toHaveText('Load older messages');

  // Part way up, still more than two screens from the top: nothing loads yet.
  await messages.evaluate((m) => {
    m.scrollTop = m.scrollHeight - m.clientHeight - 200;
  });
  await page.waitForTimeout(300);
  expect(olderRequests).toEqual([]);

  // Near the top: the next page loads and the row being read stays put.
  await messages.evaluate((m) => {
    m.scrollTop = 40;
  });
  const before = await readingRow(page, LONG);
  await expect(rows).toHaveCount(PAGE * 2);
  expect(olderRequests[0]).toEqual({ jid: LONG, before: TOTAL - PAGE + 1 });
  const after = await readingRow(page, LONG);
  // The prepend lands above the reader, who stays on the same row.
  expect(await messages.evaluate((m, id) => {
    const top = m.getBoundingClientRect().top;
    return m.querySelector<HTMLElement>(`[data-event-id="${id}"]`)!.getBoundingClientRect().top - top;
  }, before.id)).toBeCloseTo(before.offset, 0);
  expect(Number(after.id)).toBeGreaterThan(TOTAL - PAGE * 2);
  await page.screenshot({ path: info.outputPath('pane-older-loaded.png') });

  // All the way to the start: every event once, in order, then the start row.
  for (let i = 0; i < 6; i++) {
    await messages.evaluate((m) => {
      m.scrollTop = 0;
    });
    await page.waitForTimeout(250);
  }
  await expect(rows).toHaveCount(TOTAL);
  await expect(messages.locator('.top-sentinel')).toHaveText('Beginning of this session');
  const ids = await rows.evaluateAll((nodes) => nodes.map((n) => Number((n as HTMLElement).dataset.eventId)));
  expect(ids).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
  expect(olderRequests.map((r) => r.before)).toEqual([131, 81, 31]);

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, colorScheme);
    await page.waitForTimeout(100);
    await page.screenshot({ path: info.outputPath(`pane-history-start-${colorScheme}.png`) });
  }

  // The neighbour pane fits on one page and never asks for more.
  await expect(messagesOf(page, NEIGHBOUR).locator('.top-sentinel')).toHaveText(
    'Beginning of this session',
  );
  expect(olderRequests.some((r) => r.jid === NEIGHBOUR)).toBe(false);
  expect(errors).toEqual([]);
});
