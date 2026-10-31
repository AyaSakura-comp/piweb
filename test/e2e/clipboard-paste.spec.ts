import { expect, test, type Page } from 'playwright/test';

// 2026-11-01, iPad: a link copied with Safari's share sheet (拷貝) is only a
// URL (text/uri-list). The 貼上 button read the clipboard twice, read() for
// media and then readText() for text/plain, and said the clipboard was empty.
// The clipboard here behaves like iOS Safari's for that link.
test.use({ viewport: { width: 1376, height: 1032 }, isMobile: false, hasTouch: true });

const LINK = 'https://arxiv.org/abs/2510.00001';

async function setup(page: Page) {
  const sessions = [
    { jid: 'web:pa', name: 'Left', kind: 'standard', deleted: false, busy: false },
    { jid: 'web:pb', name: 'Right', kind: 'standard', deleted: false, busy: false },
  ];
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: [], busy: false, hasMore: false, session: sessions.find((s) => s.jid === path.split('/')[3]) } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [], layout: null } });
  });
  await page.addInitScript((link) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem(
      'piweb.dashboard',
      JSON.stringify({
        direction: 'row',
        updatedAt: Date.now(),
        groups: [
          { weight: 1, items: [{ jid: 'web:pa', weight: 1 }] },
          { weight: 1, items: [{ jid: 'web:pb', weight: 1 }] },
        ],
      }),
    );
    localStorage.setItem('piweb.dashboard.composer', 'web:pb');
    const calls = ((window as any).__clipboardCalls = { read: 0, readText: 0 });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: async () => {
          calls.read++;
          return [{ types: ['text/uri-list'], getType: async () => new Blob([`${link}\r\n`], { type: 'text/uri-list' }) }];
        },
        // iOS: no text/plain here (and a second read would ask again).
        readText: async () => {
          calls.readText++;
          return '';
        },
      },
    });
  }, LINK);
  await page.goto('/');
}

test('a link copied with Safari\'s share sheet pastes, in the chat and in a Dashboard pane', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  await expect(page.locator('#session-name')).toHaveText('Left');
  await page.locator('#btn-paste').click();
  await expect(page.locator('#input')).toHaveValue(LINK);
  await expect(page.locator('#toast-text')).toHaveText('已貼上文字');
  expect(await page.evaluate(() => (window as any).__clipboardCalls)).toEqual({ read: 1, readText: 0 });

  await page.locator('#btn-dashboard-home').click();
  const pane = page.locator('.dashboard-pane[data-jid="web:pb"]');
  await expect(pane).toHaveClass(/composer-active/);
  await pane.locator('.pane-paste-btn').click();
  await expect(pane.locator('.dashboard-pane-input')).toHaveValue(LINK);
  expect(await page.evaluate(() => (window as any).__clipboardCalls)).toEqual({ read: 2, readText: 0 });
  await page.screenshot({ path: info.outputPath('pane-pasted.png') });
  expect(errors).toEqual([]);
});
