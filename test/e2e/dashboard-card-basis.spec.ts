import { expect, test, type Page } from 'playwright/test';

// iPhone recordings 2026-10-27: after a pane hop (and with the keyboard up) the
// floating input card shrank to a ~20px sliver of its bottom edge. The pane's
// transcript flexed from `flex: 1`'s 0% basis; when iOS WebKit took the pane's
// height as indefinite in a relayout, 0% fell back to the content height (a
// long transcript) and the shrink, shared by basis, crushed the card. Setting
// flex-basis: auto in WebKit reproduces the same sliver. The bases are 0px now,
// which cannot fall back.
const sessions = ['Piweb', 'Hay'].map((name, i) => ({
  jid: `web:b${i}`,
  name,
  folder: `web_b${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 8,
  lastActivity: `2026-10-27 01:${30 - i}:00`,
}));
const events = Object.fromEntries(
  sessions.map((s) => [
    s.jid,
    Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      kind: 'message',
      role: i % 2 ? 'assistant' : 'user',
      content: `${s.name} ${i} ` + '一段很長的回覆，讓對話比窗格高很多。'.repeat(14),
      files: [],
      createdAt: '2026-10-27T01:00:00Z',
    })),
  ]),
);

test.use({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });

async function setup(page: Page) {
  await page.addInitScript((layout) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.dashboard', JSON.stringify(layout));
  }, {
    direction: 'row',
    updatedAt: Date.now(),
    // One column, two panes stacked, as on the phone.
    groups: [{ weight: 1, items: sessions.map((s) => ({ jid: s.jid, weight: 1 })) }],
  });
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [{ word: 'deploy', count: 9 }, { word: 'push', count: 8 }] } }),
  );
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => s.jid === path.split('/')[3]);
      return route.fulfill({ json: { events: events[session!.jid], busy: false, hasMore: false, session } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  await page.locator('#btn-topbar-dashboard').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(2);
}

test('the transcript flexes from a 0px basis, so the input card is never shared out by content', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  const bases = await page.locator('.dashboard-pane').first().evaluate((pane) =>
    ['.dashboard-pane-transcript', '.dashboard-pane-messages'].map(
      (sel) => getComputedStyle(pane.querySelector(sel)!).flexBasis,
    ),
  );
  expect(bases).toEqual(['0px', '0px']);

  // The card stays whole in whichever pane holds it, hop after hop.
  const card = async () =>
    page.locator('.dashboard-pane.composer-active .dashboard-pane-dock').evaluate((dock) => ({
      height: Math.round(dock.getBoundingClientRect().height),
      content: dock.scrollHeight,
    }));
  const tap = async (i: number) => {
    const box = await page.locator('.dashboard-pane').nth(i).locator('.dashboard-pane-messages').boundingBox();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForTimeout(500); // the hop is 380ms
  };
  for (const i of [1, 0, 0, 1, 1, 0]) {
    await tap(i);
    const { height, content } = await card();
    expect(height).toBeGreaterThan(100);
    expect(height).toBe(content);
  }
  await page.screenshot({ path: info.outputPath('stacked-card.png') });
  expect(errors).toEqual([]);
});
