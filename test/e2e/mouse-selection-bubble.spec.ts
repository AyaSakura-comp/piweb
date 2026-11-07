import { expect, test, type Page } from 'playwright/test';

// A mouse selects transcript text with the browser's own selection (drag,
// double-click, shift-click, ⌘C), and it looks like the long press on a phone:
// one bubble around the text, following the pointer, not per-line boxes.
// (Mac, 2026-11-07: 「引用的功能在電腦版滑鼠那邊沒有特效出來」.)

const LONG =
  'The web server code, including the disk usage reading and the New Life session fix, ' +
  'also matches HEAD, and the public URL returns 200. The worker did not need a restart, ' +
  'because none of these changes is in the code the worker runs.';
const SECOND =
  'Push: the remote fast-forwarded with four commits, and the frontend files in the ' +
  'container are identical to HEAD, so reload the app on your phone to get it.';

const sessions = ['Notes', 'Piweb'].map((name, i) => ({
  jid: `web:m${i}`,
  name,
  folder: `web_m${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: `2026-11-07 01:${String(30 - i).padStart(2, '0')}:00`,
}));
const [NOTES, PIWEB] = sessions.map((s) => s.jid);
const events = (name: string) => [
  {
    id: 1,
    kind: 'message',
    role: 'user',
    content: `問 ${name}`,
    files: [],
    createdAt: '2026-11-07T01:05:00Z',
  },
  {
    id: 2,
    kind: 'message',
    role: 'assistant',
    content: `${LONG}\n\n${SECOND}`,
    files: [],
    createdAt: '2026-11-07T01:05:10Z',
  },
];

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

async function setup(page: Page, { theme = 'dark', dashboard = false } = {}) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ([layout, t, open]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem('piweb.theme', t);
      if (open) localStorage.setItem('piweb.dashboard', JSON.stringify(layout));
    },
    [
      {
        direction: 'row',
        updatedAt: Date.now(),
        groups: sessions.map((s) => ({ weight: 1, items: [{ jid: s.jid, weight: 1 }] })),
      },
      theme,
      dashboard,
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
    const session = sessions.find((s) => s.jid === path.split('/')[3]);
    if (session && path.endsWith('/events')) {
      const after = Number(url.searchParams.get('after') ?? 0);
      return route.fulfill({
        json: {
          events: events(session.name).filter((e) => e.id > after),
          busy: false,
          hasMore: false,
          session,
        },
      });
    }
    if (session && path.endsWith('/stream')) {
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: busy\ndata: {"busy":false}\n\nretry: 60000\n\n',
      });
    }
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  return errors;
}

/** The bubble's outline and what the selection covers, in viewport px. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const path = document.querySelector(
      '#sel-highlight-boxes path.sel-bubble',
    ) as SVGPathElement | null;
    const selection = getSelection();
    const range =
      selection && selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null;
    const box = (r: DOMRect | undefined | null) =>
      r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    const lines = range ? [...range.getClientRects()].filter((r) => r.width > 1) : [];
    return {
      bubble: box(path?.getBoundingClientRect()),
      selected: range
        ? {
            left: Math.min(...lines.map((r) => r.left)),
            top: Math.min(...lines.map((r) => r.top)),
            right: Math.max(...lines.map((r) => r.right)),
            bottom: Math.max(...lines.map((r) => r.bottom)),
          }
        : null,
      lineCount: new Set(lines.map((r) => Math.round(r.top))).size,
      text: selection?.toString() ?? '',
      layers: document.querySelectorAll('#sel-highlight-boxes .sel-bubble-layer').length,
    };
  });

for (const theme of ['dark', 'light'] as const) {
  test(`a mouse drag in a Dashboard pane is drawn as the bubble (${theme})`, async ({
    page,
  }, info) => {
    const errors = await setup(page, { theme, dashboard: true });
    await page.locator('#btn-dashboard-home').click();
    await expect(page.locator('.dashboard-pane')).toHaveCount(2);
    const reply = page.locator(`.dashboard-pane[data-jid="${PIWEB}"] .msg-text p`);
    const text = reply.filter({ hasText: 'The web server code' });
    await expect(text).toHaveCount(1);
    const first = (await text.boundingBox())!;
    const second = (await reply.filter({ hasText: 'Push: the remote' }).boundingBox())!;

    // The selection's own tint is gone from transcript text: the bubble is it.
    expect(await text.evaluate((el) => getComputedStyle(el, '::selection').backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );

    await page.mouse.move(first.x + 40, first.y + 6);
    await page.mouse.down();
    await page.mouse.move(first.x + first.width * 0.6, first.y + 6, { steps: 4 });
    // Mid-drag: already a bubble, on the one line selected so far.
    await expect.poll(async () => (await geometry(page)).layers).toBe(1);
    const early = await geometry(page);
    expect(early.lineCount).toBe(1);
    await page.mouse.move(second.x + second.width * 0.5, second.y + second.height - 6, {
      steps: 8,
    });
    await page.mouse.up();

    await expect(page.locator('#sel-highlight-boxes')).toHaveAttribute('data-bubble', 'settled');
    const done = await geometry(page);
    expect(done.text).toContain('disk usage reading');
    expect(done.lineCount).toBeGreaterThan(3);
    expect(done.layers).toBe(1);
    // It grew with the pointer and now wraps every selected line.
    expect(done.bubble!.bottom).toBeGreaterThan(early.bubble!.bottom + 40);
    for (const side of ['left', 'top'] as const)
      expect(done.bubble![side]).toBeLessThanOrEqual(done.selected![side] + 1);
    for (const side of ['right', 'bottom'] as const)
      expect(done.bubble![side]).toBeGreaterThanOrEqual(done.selected![side] - 1);
    // The native selection is kept: the pill is up and quoted it.
    await expect(page.locator('#selection-actions')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`pane-${theme}.png`) });

    // A click elsewhere ends it, and the bubble goes.
    await page.mouse.click(first.x + 40, first.y - 30);
    await expect(page.locator('#sel-highlight-boxes')).toHaveAttribute('data-bubble', 'gone');
    expect((await geometry(page)).layers).toBe(0);
    expect(errors).toEqual([]);
  });
}

test('the chat: a double-click word is drawn as the bubble, kept inside the transcript as it scrolls', async ({
  page,
}, info) => {
  const errors = await setup(page);
  await expect(page.locator('#session-name')).toHaveText('Notes');
  const text = page.locator('#messages .msg-text p').filter({ hasText: 'The web server code' });
  await expect(text).toHaveCount(1);
  const word = await text.evaluate((el) => {
    const node = el.firstChild!;
    const range = document.createRange();
    const at = node.textContent!.indexOf('server');
    range.setStart(node, at);
    range.setEnd(node, at + 6);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.dblclick(word.x, word.y);
  await expect(page.locator('#sel-highlight-boxes')).toHaveAttribute('data-bubble', 'settled');
  const g = await geometry(page);
  expect(g.text.trim()).toBe('server');
  expect(g.lineCount).toBe(1);
  expect(g.bubble!.left).toBeLessThanOrEqual(g.selected!.left);
  expect(g.bubble!.right).toBeGreaterThanOrEqual(g.selected!.right);
  await page.screenshot({ path: info.outputPath('chat-word.png') });

  // The layer covers the window, clipped to the transcript: text scrolled
  // under the header is not drawn over it.
  const clip = await page.evaluate(() => {
    const layer = document.querySelector('#sel-highlight-boxes .sel-bubble-layer') as SVGElement;
    const box = document.getElementById('messages')!.getBoundingClientRect();
    return {
      inset: (layer.style.clipPath.match(/^inset\((.*)\)$/)?.[1] ?? '').split(' ').map(parseFloat),
      expected: [box.top, innerWidth - box.right, innerHeight - box.bottom, box.left],
    };
  });
  expect(clip.inset).toHaveLength(4);
  clip.inset.forEach((value, i) => expect(value).toBeCloseTo(clip.expected[i], 1));
  expect(clip.expected[0]).toBeGreaterThan(0); // the header is clipped off
  expect(errors).toEqual([]);
});
