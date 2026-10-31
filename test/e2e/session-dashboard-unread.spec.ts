import { expect, test, type Page } from 'playwright/test';

// A pane shows the session list's three states: spinner (working), green dot
// (finished, not looked at yet), neither (idle and read). Only the pane holding
// the input card counts as read when a reply lands; the others keep the dot
// until they are tapped or scrolled, across a reload too.
const names = ['Notes', 'Piweb', 'Hay layout'];
const sessions = names.map((name, i) => ({
  jid: `web:u${i}`,
  name,
  folder: `web_u${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: `2026-10-31 01:${String(30 - i).padStart(2, '0')}:00`,
}));
const [NOTES, PIWEB, HAY] = sessions.map((s) => s.jid);

const turn = (id: number, role: string, content: string) => ({
  id,
  kind: 'message',
  role,
  content,
  files: [],
  createdAt: '2026-10-31T01:05:00Z',
});

let events: Record<string, any[]>;

test.beforeEach(() => {
  for (const s of sessions) {
    s.busy = false;
    s.lastReplyId = 2;
  }
  events = Object.fromEntries(
    sessions.map((s) => [s.jid, [turn(1, 'user', `問 ${s.name}`), turn(2, 'assistant', `${s.name} 的回答`)]]),
  );
});

/** Like the worker: the reply goes into the history the stream and the poll read. */
function reply(jid: string, id: number, content: string) {
  events[jid].push(turn(id, 'assistant', content));
  sessions.find((s) => s.jid === jid)!.lastReplyId = id;
}
function busy(jid: string, on: boolean) {
  sessions.find((s) => s.jid === jid)!.busy = on;
}

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

async function setup(page: Page, { theme = 'dark' } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ([layout, seen, composer, t]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem('piweb.theme', t);
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('piweb.dashboard', JSON.stringify(layout));
        localStorage.setItem('piweb.seen', JSON.stringify(seen));
        localStorage.setItem('piweb.dashboard.composer', composer);
      }
    },
    [
      {
        direction: 'row',
        updatedAt: Date.now(),
        groups: sessions.map((s) => ({ weight: 1, items: [{ jid: s.jid, weight: 1 }] })),
      },
      Object.fromEntries(sessions.map((s) => [s.jid, 2])),
      NOTES,
      theme,
    ] as const,
  );
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    const jid = path.split('/')[3];
    const session = sessions.find((s) => s.jid === jid);
    if (session && path.endsWith('/events')) {
      const after = Number(url.searchParams.get('after') ?? 0);
      return route.fulfill({
        json: {
          events: events[jid].filter((e) => e.id > after),
          busy: session.busy,
          hasMore: false,
          session,
        },
      });
    }
    if (session && path.endsWith('/stream')) {
      // Like the server: the busy state, then every event after the cursor.
      // The stream then ends and the pane reconnects (2 s later) for more.
      const after = Number(url.searchParams.get('after') ?? 0);
      const body =
        `event: busy\ndata: ${JSON.stringify({ busy: session.busy })}\n\n` +
        events[jid]
          .filter((e) => e.id > after)
          .map((e) => `event: event\ndata: ${JSON.stringify(e)}\n\n`)
          .join('') +
        'retry: 60000\n\n';
      return route.fulfill({ contentType: 'text/event-stream', body });
    }
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  await openDashboard(page);
  return errors;
}

async function openDashboard(page: Page) {
  await page.locator('#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(3);
}

const pane = (page: Page, jid: string) => page.locator(`.dashboard-pane[data-jid="${jid}"]`);
const row = (page: Page, jid: string) => page.locator(`.session-item[data-jid="${jid}"]`);
const seen = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('piweb.seen') || '{}') as Record<string, number>);

test('a reply in a pane you are not using keeps a dot until you look at it', async ({ page }, info) => {
  const errors = await setup(page);
  await expect(pane(page, NOTES)).toHaveClass(/composer-active/);
  for (const jid of [NOTES, PIWEB, HAY]) await expect(pane(page, jid).locator('.unread-dot')).toBeHidden();

  // Running: the spinner, never the dot.
  busy(PIWEB, true);
  await expect(pane(page, PIWEB).locator('.work-spinner')).toBeVisible({ timeout: 8000 });
  await expect(pane(page, PIWEB).locator('.unread-dot')).toBeHidden();

  // Finished while the card is in Notes: the dot, in the spinner's place.
  busy(PIWEB, false);
  reply(PIWEB, 3, 'Piweb 新的回答');
  // And a reply in the pane being used is read as it lands, like the open chat.
  reply(NOTES, 3, 'Notes 新的回答');
  const dot = pane(page, PIWEB).locator('.unread-dot');
  await expect(dot).toBeVisible({ timeout: 8000 });
  await expect(pane(page, PIWEB)).toHaveClass(/pane-unread/);
  await expect(pane(page, PIWEB).locator('.work-spinner')).toBeHidden();
  await expect(pane(page, NOTES).locator('.msg-text').last()).toContainText('Notes 新的回答', { timeout: 8000 });
  await expect(pane(page, NOTES).locator('.unread-dot')).toBeHidden();
  expect(await seen(page)).toMatchObject({ [NOTES]: 3, [PIWEB]: 2 });
  // The dot sits before the name, so an ellipsized title cannot hide it.
  const d = (await dot.boundingBox())!;
  const n = (await pane(page, PIWEB).locator('.pane-session-name').boundingBox())!;
  expect(d.width).toBe(9);
  expect(d.x + d.width).toBeLessThan(n.x);
  // The session list agrees (its row reads the same marks).
  await expect(row(page, PIWEB).locator('.unread-dot')).toBeVisible({ timeout: 8000 });
  await expect(row(page, NOTES).locator('.unread-dot')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('01-unread.png') });

  // A reload does not count as looking at it.
  await page.reload();
  await openDashboard(page);
  await expect(pane(page, PIWEB).locator('.unread-dot')).toBeVisible();
  await expect(pane(page, NOTES).locator('.unread-dot')).toBeHidden();

  // A tap on the pane: the card comes, the dot goes, here and in the list.
  await pane(page, PIWEB).locator('.dashboard-pane-messages').click({ position: { x: 40, y: 20 } });
  await expect(pane(page, PIWEB)).toHaveClass(/composer-active/);
  await expect(pane(page, PIWEB).locator('.unread-dot')).toBeHidden();
  await expect(pane(page, PIWEB)).not.toHaveClass(/pane-unread/);
  await expect(row(page, PIWEB).locator('.unread-dot')).toHaveCount(0);
  expect((await seen(page))[PIWEB]).toBe(3);
  expect(errors).toEqual([]);
});

test('scrolling a pane reads it, also when only the session poll knew of the reply', async ({ page }) => {
  const errors = await setup(page);
  // Only the 5 s session poll knows (a pane whose stream is reconnecting).
  sessions.find((s) => s.jid === HAY)!.lastReplyId = 4;
  await expect(pane(page, HAY).locator('.unread-dot')).toBeVisible({ timeout: 8000 });
  await expect(pane(page, HAY)).not.toHaveClass(/composer-active/);

  const box = (await pane(page, HAY).locator('.dashboard-pane-messages').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -120);
  await expect(pane(page, HAY).locator('.unread-dot')).toBeHidden();
  // Reading did not move the card.
  await expect(pane(page, HAY)).not.toHaveClass(/composer-active/);
  expect((await seen(page))[HAY]).toBe(4);
  expect(errors).toEqual([]);
});

for (const theme of ['dark', 'light']) {
  test(`the three states side by side (${theme})`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    busy(HAY, true);
    reply(PIWEB, 3, 'Piweb 新的回答');
    const errors = await setup(page, { theme });
    await expect(pane(page, HAY).locator('.work-spinner')).toBeVisible();
    await expect(pane(page, PIWEB).locator('.unread-dot')).toBeVisible();
    await expect(pane(page, NOTES).locator('.work-spinner')).toBeHidden();
    await expect(pane(page, NOTES).locator('.unread-dot')).toBeHidden();
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath(`states-${theme}.png`) });
    for (const jid of [NOTES, PIWEB, HAY]) {
      await pane(page, jid)
        .locator('.dashboard-pane-header')
        .screenshot({ path: info.outputPath(`header-${theme}-${jid.slice(4)}.png`) });
    }
    expect(errors).toEqual([]);
  });
}
