import { expect, test, type CDPSession, type Page } from 'playwright/test';

// The full-screen table viewer's motion (DESIGN.md "Viewer motion"). 2026-10-31
// iPhone recording: it cut to the viewer and back with no motion, and a dragged
// table stopped dead where the finger left it, even out in the empty sheet.
const narrow = ['| Service | State |', '| --- | --- |', '| komorebi-realtime | up |', '| omnivoice-tts | down |'].join('\n');
const columns = Array.from({ length: 12 }, (_, i) => `Column_${i + 1}_heading`);
const wide = [
  `| ${columns.join(' | ')} |`,
  `| ${columns.map(() => '---').join(' | ')} |`,
  ...[1, 2, 3, 4, 5, 6].map((r) => `| ${columns.map((_, i) => `r${r}_value_${i + 1}`).join(' | ')} |`),
].join('\n');
const session = {
  jid: 'web:motion',
  name: 'Viewer motion',
  folder: 'web_motion',
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 3,
  lastActivity: '2026-10-31 06:00:00',
};
const events = [
  { id: 1, kind: 'message', role: 'user', content: 'Status?' },
  { id: 2, kind: 'message', role: 'assistant', content: `Services:\n\n${narrow}` },
  { id: 3, kind: 'message', role: 'assistant', content: `Wide:\n\n${wide}` },
].map((e) => ({ files: [], createdAt: '2026-10-31T06:00:00Z', ...e }));

async function setup(page: Page, theme: 'light' | 'dark' = 'dark') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((value) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.theme', value);
  }, theme);
  await page.route('**/*', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (!path.startsWith('/api/')) {
      if (path.endsWith('hot-keywords.json')) return route.fulfill({ json: { items: [] } });
      return route.continue().catch(() => {});
    }
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path.endsWith('/events')) return route.fulfill({ json: { events, busy: false, hasMore: false, session } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/?session=' + encodeURIComponent(session.jid));
  await expect(page.locator('#messages .table-wrap table').nth(1)).toBeVisible();
  return errors;
}

const viewer = (page: Page) => page.locator('#mermaid-modal');
const atRest = async (page: Page) => {
  await expect(viewer(page)).not.toHaveAttribute('data-motion', /./);
  await expect(viewer(page).locator('.mm-modal-stage')).not.toHaveAttribute('data-motion', /./, { timeout: 8000 });
};

type Sample = { t: number; x: number; y: number; s: number; k: number; cx: number; cy: number; op: number; tl?: number; tt?: number; shown: boolean };

/** Every frame from now: the stage and card transforms and the table copy's top left. */
async function record(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __rec: unknown[]; __recStop: boolean };
    w.__rec = [];
    w.__recStop = false;
    const tick = (t: number) => {
      const modal = document.getElementById('mermaid-modal');
      const shown = Boolean(modal && !modal.hidden);
      if (shown) {
        const stage = new DOMMatrix(getComputedStyle(modal!.querySelector('.mm-modal-stage')!).transform);
        const cardEl = modal!.querySelector<HTMLElement>('.mm-modal-content')!;
        const card = new DOMMatrix(getComputedStyle(cardEl).transform);
        const copy = modal!.querySelector('table')?.getBoundingClientRect();
        w.__rec.push({ t, shown, x: stage.e, y: stage.f, s: stage.a, k: card.a, cx: card.e, cy: card.f, op: Number(getComputedStyle(cardEl).opacity), tl: copy?.left, tt: copy?.top });
      } else w.__rec.push({ t, shown });
      if (!w.__recStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
async function stopRecording(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __rec: Sample[]; __recStop: boolean };
    w.__recStop = true;
    return w.__rec;
  });
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
}

/** A finger drag in `steps` moves of (dx, dy), `stepMs` apart; held `holdMs` before lifting. */
async function drag(page: Page, cdp: CDPSession, x: number, y: number, dx: number, dy: number, steps: number, stepMs: number, { holdMs = 0, lift = true } = {}) {
  await touch(cdp, 'touchStart', x, y);
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(stepMs);
    await touch(cdp, 'touchMove', x + dx * i, y + dy * i);
  }
  if (holdMs) await page.waitForTimeout(holdMs);
  if (lift) await touch(cdp, 'touchEnd');
}

const stageView = (page: Page) =>
  viewer(page)
    .locator('.mm-modal-stage')
    .evaluate((n) => {
      const m = new DOMMatrix(getComputedStyle(n).transform);
      return { x: m.e, y: m.f, s: m.a };
    });

/** The table copy against the viewer body's inner box. */
const placement = (page: Page) =>
  page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('#mermaid-modal .mm-modal-body')!;
    const pad = parseFloat(getComputedStyle(body).paddingLeft);
    const b = body.getBoundingClientRect();
    const t = document.querySelector('#mermaid-modal table')!.getBoundingClientRect();
    return { left: t.left - (b.left + pad), right: t.right - (b.right - pad), top: t.top - (b.top + pad), width: t.width, room: b.width - 2 * pad };
  });

test('opening grows the table out of its place in the reply, on a spring, then rests', async ({ page }, info) => {
  const errors = await setup(page);
  const cell = page.getByRole('cell', { name: 'komorebi-realtime' });
  const source = (await page.locator('#messages .table-wrap table').first().boundingBox())!;
  await record(page);
  await cell.tap();
  await expect(viewer(page)).toHaveAttribute('data-motion', 'opening');
  // Played by the browser as keyframes on transform and opacity only.
  const props = await viewer(page)
    .locator('.mm-modal-content')
    .evaluate((n) => n.getAnimations().flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap(Object.keys)));
  expect(new Set(props.filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)))).toEqual(
    new Set(['transform', 'opacity']),
  );
  await atRest(page);
  const frames = (await stopRecording(page)).filter((f) => f.shown);
  // It moved through many frames, not a cut.
  expect(frames.length).toBeGreaterThan(12);
  const first = frames[0];
  expect(first.k).toBeLessThan(0.97);
  // The copy starts over the table it came from...
  expect(Math.abs(first.tl! - source.x)).toBeLessThan(40);
  expect(Math.abs(first.tt! - source.y)).toBeLessThan(40);
  // ...grows with a slight overshoot at most, and rests at full size.
  expect(Math.max(...frames.map((f) => f.k))).toBeLessThan(1.03);
  expect(frames.at(-1)!.k).toBe(1);
  expect(frames.at(-1)!.op).toBe(1);
  // No frame jumps: each step is a small part of the whole growth.
  const steps = frames.slice(1).map((f, i) => Math.abs(f.k - frames[i].k));
  expect(Math.max(...steps)).toBeLessThan((1 - first.k) * 0.45);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('opened.png') });
});

test('a fling glides on and slows to a stop inside the table; an edge springs back', async ({ page }, info) => {
  const errors = await setup(page);
  await page.getByRole('cell', { name: 'r3_value_2' }).tap();
  await atRest(page);
  // Zoomed in, the table is wider than the viewer and pans.
  for (let i = 0; i < 3; i++) await viewer(page).getByRole('button', { name: 'Zoom in' }).tap();
  await atRest(page);
  const start = await placement(page);
  expect(start.width).toBeGreaterThan(start.room * 1.5);
  const cdp = await page.context().newCDPSession(page);
  const before = await stageView(page);

  // Fast to the left, lifted while moving.
  await record(page);
  await drag(page, cdp, 300, 420, -36, 0, 6, 16);
  const atLift = await stageView(page);
  await expect(viewer(page).locator('.mm-modal-stage')).toHaveAttribute('data-motion', 'moving');
  const keys = await viewer(page)
    .locator('.mm-modal-stage')
    .evaluate((n) => {
      const [a] = n.getAnimations();
      const frames = (a.effect as KeyframeEffect).getKeyframes();
      return { n: n.getAnimations().length, props: [...new Set(frames.flatMap(Object.keys))], frames: frames.length, duration: Number(a.effect!.getTiming().duration) };
    });
  expect(keys.n).toBe(1);
  expect(keys.props.filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p))).toEqual(['transform']);
  // One keyframe per 120Hz frame.
  expect(keys.frames).toBeGreaterThanOrEqual(Math.floor(keys.duration / (1000 / 120)));
  await atRest(page);
  const glide = (await stopRecording(page)).filter((f) => f.shown && f.x <= atLift.x - 0.5);
  const end = await stageView(page);
  // It went on well past where the finger let go, slowing as it went.
  expect(atLift.x - end.x).toBeGreaterThan(60);
  const speeds = glide.slice(1).map((f, i) => (glide[i].x - f.x) / (f.t - glide[i].t));
  const third = Math.max(1, Math.floor(speeds.length / 3));
  const early = speeds.slice(0, third).reduce((a, b) => a + b, 0) / third;
  const late = speeds.slice(-third).reduce((a, b) => a + b, 0) / third;
  expect(early).toBeGreaterThan(late);
  // ...and stopped with the table still covering the viewer.
  const after = await placement(page);
  expect(after.left).toBeLessThanOrEqual(0.5);
  expect(after.right).toBeGreaterThanOrEqual(-0.5);
  expect(before.x).not.toBe(end.x);

  // Reset puts it back at its left edge (wider than the viewer even at half
  // size). Pulled 200px past that edge and held, it gives way like a rubber
  // band, much less than the finger moved...
  await viewer(page).getByRole('button', { name: 'Reset zoom' }).tap();
  await atRest(page);
  const edge = await stageView(page);
  expect((await placement(page)).left).toBeCloseTo(0, 0);
  await drag(page, cdp, 80, 420, 20, 0, 10, 24, { holdMs: 160, lift: false });
  const pulled = (await stageView(page)).x - edge.x;
  expect(pulled).toBeGreaterThan(30);
  expect(pulled).toBeLessThan(120);
  await page.screenshot({ path: info.outputPath('rubber-band.png') });
  // ...and on release springs back onto the edge.
  await touch(cdp, 'touchEnd');
  await atRest(page);
  expect((await stageView(page)).x).toBeCloseTo(edge.x, 1);
  expect(errors).toEqual([]);
});

test('a table that fits has one place to rest: dragged down, it springs back to the top', async ({ page }) => {
  const errors = await setup(page);
  await page.getByRole('cell', { name: 'komorebi-realtime' }).tap();
  await atRest(page);
  const rest = await stageView(page);
  expect((await placement(page)).top).toBeCloseTo(0, 0);
  const cdp = await page.context().newCDPSession(page);
  await drag(page, cdp, 200, 300, 0, 15, 10, 24, { holdMs: 160, lift: false });
  const down = (await stageView(page)).y - rest.y;
  expect(down).toBeGreaterThan(20);
  expect(down).toBeLessThan(150);
  // A fling while past the edge still ends on the rest place.
  await drag(page, cdp, 200, 450, 0, 30, 3, 16, { lift: false });
  await touch(cdp, 'touchEnd');
  await atRest(page);
  const back = await stageView(page);
  expect(back.y).toBeCloseTo(rest.y, 1);
  expect(back.x).toBeCloseTo(rest.x, 1);
  expect(errors).toEqual([]);
});

test('closing shrinks it back into the table in the reply, then the viewer is gone', async ({ page }) => {
  const errors = await setup(page);
  const source = (await page.locator('#messages .table-wrap table').first().boundingBox())!;
  await page.getByRole('cell', { name: 'komorebi-realtime' }).tap();
  await atRest(page);
  await record(page);
  await viewer(page).getByRole('button', { name: 'Close' }).tap();
  await expect(viewer(page)).toBeHidden();
  const frames = (await stopRecording(page)).filter((f) => f.shown && f.k < 0.999);
  expect(frames.length).toBeGreaterThan(6);
  // Smaller every frame, heading for the table's place, fading as it lands.
  for (let i = 1; i < frames.length; i++) expect(frames[i].k).toBeLessThanOrEqual(frames[i - 1].k + 1e-6);
  const last = frames.at(-1)!;
  expect(Math.abs(last.tl! - source.x)).toBeLessThan(30);
  expect(Math.abs(last.tt! - source.y)).toBeLessThan(30);
  expect(last.op).toBeLessThan(0.5);
  // It opens again cleanly after.
  await page.getByRole('cell', { name: 'omnivoice-tts' }).tap();
  await atRest(page);
  expect(await viewer(page).locator('.mm-modal-content').evaluate((n) => getComputedStyle(n).transform)).toBe('none');
  expect(errors).toEqual([]);
});

test('reduced motion: it opens and closes at once, and a fling does not glide', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = await setup(page);
  await page.getByRole('cell', { name: 'r3_value_2' }).tap();
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page)).not.toHaveAttribute('data-motion', /./);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  for (let i = 0; i < 3; i++) await viewer(page).getByRole('button', { name: 'Zoom in' }).tap();
  const cdp = await page.context().newCDPSession(page);
  await drag(page, cdp, 300, 420, -36, 0, 6, 16);
  const atLift = await stageView(page);
  await page.waitForTimeout(300);
  expect((await stageView(page)).x).toBeCloseTo(atLift.x, 3);
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toBeHidden();
  expect(errors).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  test(`mid-opening frame (${theme})`, async ({ page }, info) => {
    await setup(page, theme);
    await page.getByRole('cell', { name: 'komorebi-realtime' }).tap();
    // Freeze it 70ms in and look.
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = 70;
      }
    });
    await page.screenshot({ path: info.outputPath(`opening-70ms-${theme}.png`) });
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.play();
    });
    await atRest(page);
    await page.screenshot({ path: info.outputPath(`opened-${theme}.png`) });
  });
}

test('a finger catches a glide where it is, without a jump', async ({ page }) => {
  const errors = await setup(page);
  await page.getByRole('cell', { name: 'r3_value_2' }).tap();
  await atRest(page);
  for (let i = 0; i < 3; i++) await viewer(page).getByRole('button', { name: 'Zoom in' }).tap();
  await atRest(page);
  const cdp = await page.context().newCDPSession(page);
  await drag(page, cdp, 300, 420, -36, 0, 6, 16);
  await page.waitForTimeout(120);
  // Where it is drawn right now, then a finger lands.
  const shown = await stageView(page);
  await touch(cdp, 'touchStart', 200, 420);
  const caught = await stageView(page);
  await expect(viewer(page).locator('.mm-modal-stage')).not.toHaveAttribute('data-motion', /./);
  // Within a frame or two of motion of where it was drawn (it was still moving).
  expect(Math.abs(caught.x - shown.x)).toBeLessThan(40);
  await page.waitForTimeout(200);
  expect((await stageView(page)).x).toBe(caught.x);
  await touch(cdp, 'touchEnd');
  expect(errors).toEqual([]);
});

test('a pinch past the largest zoom gives way, then springs back to it', async ({ page }) => {
  const errors = await setup(page);
  await page.getByRole('cell', { name: 'komorebi-realtime' }).tap();
  await atRest(page);
  const cdp = await page.context().newCDPSession(page);
  const pinch = async (type: 'touchStart' | 'touchMove', half: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: [
        { x: 195 - half, y: 400, id: 1 },
        { x: 195 + half, y: 400, id: 2 },
      ],
    });
  await pinch('touchStart', 10);
  for (let half = 20; half <= 180; half += 20) {
    await page.waitForTimeout(16);
    await pinch('touchMove', half);
  }
  // 18× the finger spread, but only a little past 6×.
  const stretched = (await stageView(page)).s;
  expect(stretched).toBeGreaterThan(6);
  expect(stretched).toBeLessThan(10);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await atRest(page);
  expect((await stageView(page)).s).toBeCloseTo(6, 6);
  expect(errors).toEqual([]);
});
