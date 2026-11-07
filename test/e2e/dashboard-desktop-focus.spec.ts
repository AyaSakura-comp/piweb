import { expect, test, type Page } from 'playwright/test';

// On a computer (mouse, no touch) picking a session while the Dashboard is
// open puts the cursor in that pane's input, so you can type at once — from
// the session list, and by clicking the pane itself.
const names = ['Notes', 'Piweb', 'Hay layout'];
const sessions = names.map((name, i) => ({
  jid: `web:f${i}`,
  name,
  folder: `web_f${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: `2026-10-21 01:${String(30 - i).padStart(2, '0')}:00`,
}));
const [NOTES, PIWEB, HAY] = sessions.map((s) => s.jid);
const events = (jid: string) =>
  Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    kind: 'message',
    role: i % 2 ? 'assistant' : 'user',
    content: `${jid} message ${i + 1}: ${'words '.repeat(12)}`,
    files: [],
    createdAt: '2026-10-21T01:00:00Z',
  }));

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

async function setup(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ([layout]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('piweb.dashboard', JSON.stringify(layout));
      }
    },
    [
      {
        direction: 'row',
        updatedAt: Date.now(),
        groups: [
          { weight: 1, items: [{ jid: NOTES, weight: 1 }] },
          { weight: 1, items: [{ jid: PIWEB, weight: 1 }] },
        ],
      },
    ],
  );
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => s.jid === path.split('/')[3]);
      return route.fulfill({ json: { events: events(session!.jid), busy: false, hasMore: false, session } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  await page.locator('#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(2);
  return errors;
}

const focusedPane = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName,
      cls: el?.className,
      pane: el?.closest<HTMLElement>('.dashboard-pane')?.dataset.jid ?? null,
    };
  });

const pane = (page: Page, jid: string) => page.locator(`.dashboard-pane[data-jid="${jid}"]`);
const input = { tag: 'TEXTAREA', cls: 'dashboard-pane-input' };

test('a session-list click puts the cursor in that pane, tiled already or not', async ({ page }) => {
  const errors = await setup(page);
  const row = (jid: string) => page.locator(`#session-list .session-item[data-jid="${jid}"]`);
  await row(PIWEB).click();
  await expect.poll(() => focusedPane(page)).toEqual({ ...input, pane: PIWEB });
  await row(HAY).click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(3);
  await expect.poll(() => focusedPane(page)).toEqual({ ...input, pane: HAY });
  expect(errors).toEqual([]);
});

test('a mouse click on a pane puts the cursor in its input at once', async ({ page }, info) => {
  const errors = await setup(page);
  await expect(pane(page, PIWEB).locator('.msg-text p').first()).toBeVisible();
  await pane(page, PIWEB).locator('.dashboard-pane-transcript').click();
  await expect(pane(page, PIWEB)).toHaveClass(/composer-active/);
  await expect.poll(() => focusedPane(page)).toEqual({ ...input, pane: PIWEB });
  await page.keyboard.type('typed straight away');
  await expect(pane(page, PIWEB).locator('textarea')).toHaveValue('typed straight away');

  // Another pane: the card and the cursor move together; a second click keeps it.
  await pane(page, NOTES).locator('.dashboard-pane-transcript').click();
  await expect.poll(() => focusedPane(page)).toEqual({ ...input, pane: NOTES });
  await pane(page, NOTES).locator('.dashboard-pane-transcript').click();
  await expect.poll(() => focusedPane(page)).toEqual({ ...input, pane: NOTES });
  await page.screenshot({ path: info.outputPath('pane-click-focus.png') });

  expect(errors).toEqual([]);
});
