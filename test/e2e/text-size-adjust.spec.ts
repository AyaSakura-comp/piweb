import { expect, test } from 'playwright/test';

// iPhone screenshot, 2026-11-26 (Dashboard, the phone turned sideways, six
// panes: three narrow on the left, two wide in the middle, one on the right):
// 「字體沒有統一」「我是說字體大小」. Every pane is 13px here, but sideways Safari
// enlarges text in wide blocks only (text autosizing): the two wide panes read
// ~17px. The page opts out, so every pane shows the size its CSS sets.

const W = 951; // the iPhone sideways, in CSS px
const H = 669;
const sessions = Array.from({ length: 6 }, (_, i) => ({
  jid: `web:t${i}`,
  name: `Pane ${i + 1}`,
  folder: `web_t${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: `2026-11-26 01:0${i}:00`,
}));
const jids = sessions.map((s) => s.jid);
const events = (jid: string) => [
  { id: 1, kind: 'message', role: 'user', content: 'push', createdAt: '2026-11-26T01:00:00Z' },
  {
    id: 2,
    kind: 'message',
    role: 'assistant',
    content: `${jid}：推之前通知了另一個 session，因為其中一個 commit 是它的；它確認沒有別的 commit，也沒有同時在推。現在本機 main、GitHub、線上版本都是 287aeb753。`,
    createdAt: '2026-11-26T01:01:00Z',
  },
];

test('sideways on a phone, every Dashboard pane shows the same text size', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: W, height: H });
  const layout = {
    direction: 'row',
    updatedAt: Date.now(),
    groups: [
      { weight: 0.6, items: jids.slice(0, 3).map((jid) => ({ jid, weight: 1 })) },
      { weight: 3, items: jids.slice(3, 5).map((jid) => ({ jid, weight: 1 })) },
      { weight: 0.6, items: [{ jid: jids[5], weight: 1 }] },
    ],
  };
  await page.addInitScript(
    ([saved, first]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('piweb.dashboard', JSON.stringify(saved));
        localStorage.setItem('piweb.dashboard.composer', first);
      }
    },
    [layout, jids[4]] as const,
  );
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => route.fulfill({ json: { items: [] } }));
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
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  if (!(await page.locator('.dashboard-pane').first().isVisible())) await page.locator('#btn-topbar-dashboard').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(6);
  await expect(page.locator('.dashboard-pane .msg-text').first()).toBeVisible();
  await page.waitForTimeout(500);

  // Safari's text autosizing is off: the size set here is the size shown.
  const adjust = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return [s.getPropertyValue('-webkit-text-size-adjust'), s.getPropertyValue('text-size-adjust')];
  });
  expect(adjust).toEqual(['100%', '100%']);

  // Narrow and wide panes alike.
  const panes = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.dashboard-pane')].map((pane) => ({
      width: Math.round(pane.offsetWidth),
      size: getComputedStyle(pane.querySelector('.msg:not(.msg-user) .msg-text')!).fontSize,
    })),
  );
  const widths = panes.map((p) => p.width);
  expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths) * 3);
  expect(new Set(panes.map((p) => p.size))).toEqual(new Set(['13px']));
  await page.screenshot({ path: info.outputPath('sideways-six-panes.png') });
  expect(errors).toEqual([]);
});
