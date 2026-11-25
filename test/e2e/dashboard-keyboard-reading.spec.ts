import { expect, test, type Page } from 'playwright/test';

// iPhone screen recording, 2026-11-26 (「這個會亂跳」): Dashboard, one pane
// zoomed, reading a reply a little above the newest message. A tap on the
// input raised the keyboard and
//  - the input card rose past where the keyboard ends, up to the top of the
//    pane, then sank back: each keyboard step added the whole lift to a card
//    still sliding, so it overshot;
//  - the transcript jumped to the top of the loaded page: the pane switched
//    its overflow to let the card out (.kb-lifted), and iOS rebuilt the
//    transcript's scrolling layer at the top.
// The card now rises straight to just above the keyboard, a card inside its
// own pane leaves the pane's clipping alone, and when the pane must let a card
// out over the pane above, the transcript is held where the reader was.

const sessions = Array.from({ length: 4 }, (_, i) => ({
  jid: `web:k${i}`,
  name: i === 0 ? 'Hay chat' : `Pane ${i + 1}`,
  folder: `web_k${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 62,
  lastActivity: `2026-11-26 00:0${i}:00`,
}));
const jids = sessions.map((s) => s.jid);

function events(jid: string) {
  const out: any[] = [
    { id: 1, kind: 'message', role: 'user', content: '修正電腦版的bug', createdAt: '2026-11-25T15:00:00Z' },
  ];
  let id = 2;
  for (let i = 0; i < 30; i++) {
    out.push({ id: id++, kind: 'tool', role: 'Bash', content: `$ cd ~/wt-desktop-scroll && step ${i}`, createdAt: '2026-11-25T15:01:00Z' });
    out.push({ id: id++, kind: 'tool', role: 'Result', content: `${i} passed in 7.33s`, createdAt: '2026-11-25T15:01:00Z' });
  }
  out.push({
    id: id++,
    kind: 'message',
    role: 'assistant',
    content: `${jid} 修好了，也已經上線。\n\n${Array.from({ length: 14 }, (_, i) => `- 第 ${i + 1} 點：內容捲到底時側欄留在原位，底部沒有空白。`).join('\n')}\n\n部署：只換了前端，後端沒動。`,
    createdAt: '2026-11-25T15:30:00Z',
  });
  return out;
}

type Layout = { direction: string; groups: any[] };

async function setup(page: Page, { width, height, layout, composer }: { width: number; height: number; layout: Layout; composer: string }) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width, height });
  await page.addInitScript(
    ([saved, first, h]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('piweb.dashboard', JSON.stringify({ ...saved, updatedAt: Date.now() }));
        localStorage.setItem('piweb.dashboard.composer', first);
      }
      // iOS: the keyboard shortens the visual viewport and pans it down.
      let vh = h;
      let offsetTop = 0;
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => vh });
      Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, get: () => offsetTop });
      (window as any).__setVisibleHeight = (value: number) => {
        vh = value;
        offsetTop = h - value;
        window.visualViewport!.dispatchEvent(new Event('resize'));
      };
    },
    [layout, composer, height] as const,
  );
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [{ word: 'deploy', count: 9 }, { word: 'merge', count: 7 }, { word: 'push', count: 5 }] } }),
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
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  if (!(await page.locator('.dashboard-pane').first().isVisible())) await page.locator('#btn-topbar-dashboard').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(layout.groups.flatMap((g) => g.items).length);
  return errors;
}

const pane = (page: Page, jid: string) => page.locator(`.dashboard-pane[data-jid="${jid}"]`);

/** The transcript row at the top of the view and how far it sits from the edge. */
const reading = (page: Page, jid: string) =>
  page.evaluate((id) => {
    const scroller = document.querySelector<HTMLElement>(`.dashboard-pane[data-jid="${id}"] .dashboard-pane-messages`)!;
    const top = scroller.getBoundingClientRect().top;
    const first = [...scroller.querySelectorAll<HTMLElement>('[data-event-id]')].find(
      (n) => n.getBoundingClientRect().bottom > top + 1,
    )!;
    return { event: first.dataset.eventId, offset: Math.round(first.getBoundingClientRect().top - top) };
  }, jid);

/** Read a little above the newest message, as in the recording. */
async function readAboveTheEnd(page: Page, jid: string) {
  await pane(page, jid)
    .locator('.dashboard-pane-messages')
    .evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 260;
      el.dispatchEvent(new Event('scroll'));
    });
  await page.waitForTimeout(300);
  return reading(page, jid);
}

/** Each frame's lift and whether the pane lets its card out, from now on. */
async function traceLift(page: Page, jid: string) {
  await page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`.dashboard-pane[data-jid="${id}"]`)!;
    const dock = el.querySelector<HTMLElement>('.dashboard-pane-dock')!;
    const trace: Array<{ lift: number; out: boolean }> = [];
    (window as any).__liftTrace = trace;
    const tick = () => {
      trace.push({ lift: parseFloat(dock.style.getPropertyValue('--kb-lift')) || 0, out: el.classList.contains('kb-lifted') });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, jid);
  return () => page.evaluate(() => (window as any).__liftTrace as Array<{ lift: number; out: boolean }>);
}

/** The keyboard comes up the way iOS reports it: a few steps a frame or two apart. */
async function raiseKeyboard(page: Page, height: number, keyboard: number) {
  for (let step = 1; step <= 6; step++) {
    await page.evaluate((v) => (window as any).__setVisibleHeight(v), Math.round(height - (keyboard * step) / 6));
    await page.waitForTimeout(34);
  }
  await page.waitForTimeout(900);
}

async function lowerKeyboard(page: Page, height: number) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate((v) => (window as any).__setVisibleHeight(v), height);
  await page.waitForTimeout(900);
}

test('a zoomed pane: the card rises straight above the keyboard and the reader stays put', async ({ page }, info) => {
  const W = 669; // the recording's iPhone, in CSS px
  const H = 951;
  const errors = await setup(page, {
    width: W,
    height: H,
    layout: { direction: 'row', groups: [0, 1].map((c) => ({ weight: 1, items: [0, 1].map((r) => ({ jid: jids[c * 2 + r], weight: 1 })) })) },
    composer: jids[0],
  });
  const jid = jids[0];
  // 放大此視窗: a double click on the header's bare space (the button sits in ⋯ here).
  const at = await pane(page, jid).evaluate((el) => {
    const header = el.querySelector('.dashboard-pane-header')!.getBoundingClientRect();
    const actions = el.querySelector('.dashboard-pane-actions')!.getBoundingClientRect();
    const y = header.top + header.height / 2;
    for (let x = actions.left - 2; x > header.left; x -= 4) {
      const hit = document.elementFromPoint(x, y);
      if (hit && !hit.closest('button, input, .pane-session-name')) return { x, y };
    }
    throw new Error('no blank header space');
  });
  await page.mouse.dblclick(at.x, at.y);
  await expect(pane(page, jid)).toHaveClass(/pane-zoomed/);
  await page.waitForTimeout(700);
  const before = await readAboveTheEnd(page, jid);

  const trace = await traceLift(page, jid);
  await pane(page, jid).locator('.dashboard-pane-composer textarea').tap();
  await raiseKeyboard(page, H, 340);
  const frames = await trace();
  const final = frames[frames.length - 1].lift;
  // Just above the keyboard (6px gap) ...
  const dock = (await pane(page, jid).locator('.dashboard-pane-dock').boundingBox())!;
  const shellTop = await page.locator('.app').evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(dock.y + dock.height - shellTop - (H - 340 - 6))).toBeLessThan(2);
  // ... reached without ever going higher than that.
  expect(Math.max(...frames.map((f) => f.lift))).toBeLessThanOrEqual(final + 1);
  // The card never left its pane, so the pane kept clipping.
  expect(frames.some((f) => f.out)).toBe(false);
  expect(await reading(page, jid)).toEqual(before);
  await page.screenshot({ path: info.outputPath('zoomed-keyboard-up.png') });

  await lowerKeyboard(page, H);
  expect(await reading(page, jid)).toEqual(before);
  expect(errors).toEqual([]);
});

test('a card let out over the pane above: the transcript stays put even if iOS resets it', async ({ page }) => {
  const W = 390;
  const H = 844;
  // Four panes stacked; the bottom one holds the card, too low to clear the
  // keyboard inside its own pane.
  const errors = await setup(page, {
    width: W,
    height: H,
    layout: { direction: 'column', groups: jids.map((jid) => ({ weight: 1, items: [{ jid, weight: 1 }] })) },
    composer: jids[3],
  });
  const jid = jids[3];
  await expect(pane(page, jid)).toHaveClass(/composer-active/);
  await page.waitForTimeout(500);
  const before = await readAboveTheEnd(page, jid);
  // What the iPhone did: switching the pane's clipping rebuilt the
  // transcript's scrolling layer, which came back at the top.
  await pane(page, jid).evaluate((el) => {
    const scroller = el.querySelector<HTMLElement>('.dashboard-pane-messages')!;
    let had = el.classList.contains('kb-lifted');
    new MutationObserver(() => {
      const has = el.classList.contains('kb-lifted');
      if (has !== had) scroller.scrollTop = 0;
      had = has;
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });

  const trace = await traceLift(page, jid);
  await pane(page, jid).locator('.dashboard-pane-composer textarea').tap();
  await raiseKeyboard(page, H, 340);
  const frames = await trace();
  // The card had to go over the pane above.
  expect(frames.some((f) => f.out)).toBe(true);
  expect(Math.max(...frames.map((f) => f.lift))).toBeLessThanOrEqual(frames[frames.length - 1].lift + 1);
  expect(await reading(page, jid)).toEqual(before);

  await lowerKeyboard(page, H);
  await expect(pane(page, jid)).not.toHaveClass(/kb-lifted/);
  await page.waitForTimeout(300);
  expect(await reading(page, jid)).toEqual(before);
  expect(errors).toEqual([]);
});
