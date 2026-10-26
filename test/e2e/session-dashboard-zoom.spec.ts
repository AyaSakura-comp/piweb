import { expect, test, type Page } from 'playwright/test';

// In the Dashboard a session-list tap tiles that session and flashes its pane;
// the pane's expand button (or a double click on its header) zooms it to the
// whole stage and back on a spring, without leaving the Dashboard.
const names = ['Notes', 'Piweb', 'Hay layout', 'Browser', 'Extra'];
const sessions = names.map((name, i) => ({
  jid: `web:z${i}`,
  name,
  folder: `web_z${i}`,
  kind: 'standard',
  deleted: false,
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: `2026-10-21 01:${String(30 - i).padStart(2, '0')}:00`,
}));
const [NOTES, PIWEB, HAY, BROWSER, EXTRA] = sessions.map((s) => s.jid);
const events = Object.fromEntries(
  sessions.map((s) => [
    s.jid,
    Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      kind: 'message',
      role: i % 2 ? 'assistant' : 'user',
      // Piweb's run long enough to scroll, so a reader can be part way up.
      content: `${s.name} message ${i + 1}: ${'lorem ipsum dolor sit amet '.repeat(s.name === 'Piweb' ? 14 : 3)}`,
      files: [],
      createdAt: '2026-10-21T01:00:00Z',
    })),
  ]),
);

// Wide enough that a pane shows its own expand button (it folds into ⋯ below 460px).
test.use({ viewport: { width: 1920, height: 1000 }, isMobile: false, hasTouch: false });

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
          {
            weight: 1,
            items: [
              { jid: HAY, weight: 1 },
              { jid: BROWSER, weight: 1 },
            ],
          },
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
      return route.fulfill({
        json: { events: events[session!.jid] ?? [], busy: false, hasMore: false, session },
      });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  await page.locator('#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(4);
  return errors;
}

const pane = (page: Page, jid: string) => page.locator(`.dashboard-pane[data-jid="${jid}"]`);
const row = (page: Page, jid: string) =>
  page.locator(`#session-list .session-item[data-jid="${jid}"]`);
const rect = (page: Page, jid: string) =>
  pane(page, jid).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
const gridRect = (page: Page) =>
  page.locator('.dashboard-grid').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
const transformOf = (page: Page, jid: string) =>
  pane(page, jid).evaluate((el) => getComputedStyle(el).transform);

/** A point on the header's bare space: not the name, not a button. */
async function headerBlank(page: Page, jid: string) {
  return pane(page, jid).evaluate((el) => {
    const header = el.querySelector('.dashboard-pane-header')!.getBoundingClientRect();
    const actions = el.querySelector('.dashboard-pane-actions')!.getBoundingClientRect();
    const y = header.top + header.height / 2;
    for (let x = actions.left - 2; x > header.left; x -= 4) {
      const hit = document.elementFromPoint(x, y);
      if (hit && !hit.closest('button, input, .pane-session-name')) return { x, y };
    }
    throw new Error('no blank header space');
  });
}

test('a session-list tap tiles the session and flashes its pane, staying in the Dashboard', async ({
  page,
}, info) => {
  const errors = await setup(page);

  await row(page, EXTRA).click();
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await expect(page.locator('.dashboard-pane')).toHaveCount(5);
  await expect(pane(page, EXTRA)).toHaveClass(/composer-active/);
  await expect(pane(page, EXTRA)).toHaveClass(/pane-locating/);
  await page.waitForTimeout(150);
  await page.screenshot({ path: info.outputPath('locate-new.png') });
  await expect(pane(page, EXTRA)).not.toHaveClass(/pane-locating/, { timeout: 2000 });

  // Already tiled: no new pane, the card moves there and the pane flashes.
  await row(page, HAY).click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(5);
  await expect(pane(page, HAY)).toHaveClass(/composer-active/);
  await expect(pane(page, HAY)).toHaveClass(/pane-locating/);
  await page.waitForTimeout(120);
  await page.screenshot({ path: info.outputPath('locate-existing.png') });
  await expect(page.locator('#dashboard-view')).toBeVisible();
  expect(errors).toEqual([]);
});

test('expand zooms a pane to the stage on a spring and back, without leaving the Dashboard', async ({
  page,
}, info) => {
  const errors = await setup(page);
  const tile = await rect(page, PIWEB);
  const stage = await gridRect(page);

  await pane(page, PIWEB).locator('.pane-expand-btn').click();
  await page.waitForTimeout(90);
  expect(await transformOf(page, PIWEB)).not.toBe('none'); // still growing
  await page.screenshot({ path: info.outputPath('zoom-in-mid.png') });
  await page.waitForTimeout(700);
  expect(await transformOf(page, PIWEB)).toBe('matrix(1, 0, 0, 1, 0, 0)');

  await expect(page.locator('#dashboard-view')).toBeVisible();
  await expect(pane(page, PIWEB)).toHaveClass(/pane-zoomed/);
  for (const other of [NOTES, HAY, BROWSER]) await expect(pane(page, other)).toBeHidden();
  const zoomed = await rect(page, PIWEB);
  expect(Math.abs(zoomed.width - stage.width)).toBeLessThan(2);
  expect(Math.abs(zoomed.height - stage.height)).toBeLessThan(2);
  await expect(pane(page, PIWEB).locator('.pane-expand-btn')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({ path: info.outputPath('zoomed.png') });

  // Shrinking back is animated too, and every pane returns to its tile.
  await pane(page, PIWEB).locator('.pane-expand-btn').click();
  await page.waitForTimeout(90);
  expect(await transformOf(page, PIWEB)).not.toBe('none');
  await page.screenshot({ path: info.outputPath('zoom-out-mid.png') });
  await page.waitForTimeout(700);
  for (const other of [NOTES, HAY, BROWSER]) await expect(pane(page, other)).toBeVisible();
  const back = await rect(page, PIWEB);
  expect(Math.abs(back.left - tile.left)).toBeLessThan(2);
  expect(Math.abs(back.width - tile.width)).toBeLessThan(2);
  await expect(page.locator('.dashboard-grid')).not.toHaveClass(/zoom-moving|has-zoom/);
  expect(errors).toEqual([]);
});

test('a double click on the pane header zooms and restores it', async ({ page }) => {
  const errors = await setup(page);
  const tile = await rect(page, HAY);
  const at = await headerBlank(page, HAY);

  await page.mouse.dblclick(at.x, at.y);
  await expect(pane(page, HAY)).toHaveClass(/pane-zoomed/);
  await expect(pane(page, NOTES)).toBeHidden();
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await page.waitForTimeout(700);

  const again = await headerBlank(page, HAY);
  await page.mouse.dblclick(again.x, again.y);
  await expect(pane(page, HAY)).not.toHaveClass(/pane-zoomed/);
  await page.waitForTimeout(700);
  const back = await rect(page, HAY);
  expect(Math.abs(back.top - tile.top)).toBeLessThan(2);
  expect(Math.abs(back.height - tile.height)).toBeLessThan(2);

  // Zoomed, picking another session from the list shows the tiles again.
  const third = await headerBlank(page, HAY);
  await page.mouse.dblclick(third.x, third.y);
  await expect(pane(page, HAY)).toHaveClass(/pane-zoomed/);
  await row(page, NOTES).click();
  await expect(pane(page, NOTES)).toBeVisible();
  await expect(pane(page, HAY)).not.toHaveClass(/pane-zoomed/);
  expect(errors).toEqual([]);
});

test('a side-to-side splitter drag keeps each transcript at its width, then flows the text into the new one', async ({
  page,
}) => {
  const errors = await setup(page);
  const messages = pane(page, NOTES).locator('.dashboard-pane-messages');
  const widthBefore = await messages.evaluate((el) => el.offsetWidth);
  const box = (await page.locator('#dashboard-grid > .dashboard-splitter').first().boundingBox())!;
  const y = box.y + box.height / 2;

  // The pane that grows has been scrolled up; the line at the top of its view
  // is where the reader is.
  const grower = pane(page, PIWEB).locator('.dashboard-pane-messages');
  // Where the reader is: the message, and the character, at the top line of
  // its view.
  const readingAt = () =>
    grower.evaluate((scroller) => {
      const box = scroller.getBoundingClientRect();
      let caret: Range | null = null;
      for (let dy = 4; dy < 120; dy += 4) {
        caret = document.caretRangeFromPoint(box.left + 40, box.top + dy);
        if (caret?.startContainer.nodeType === Node.TEXT_NODE) {
          if (caret.startContainer.parentElement!.closest('.msg-text')) break;
        }
      }
      const msg = caret!.startContainer.parentElement!.closest('.msg')!;
      const range = document.createRange();
      range.setStart(msg, 0);
      range.setEnd(caret.startContainer, caret.startOffset);
      return { text: msg.textContent!.slice(0, 40), at: range.toString().length };
    });
  await grower.evaluate((el) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
  });
  expect(await grower.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
  const before = await readingAt();

  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, y, { steps: 12 });
  // Mid-drag the pane is narrower, its transcript is not rewrapped, and a
  // cover over the grid keeps taps and selection off the panes.
  expect((await rect(page, NOTES)).width).toBeLessThan(widthBefore - 60);
  expect(await messages.evaluate((el) => el.offsetWidth)).toBe(widthBefore);
  expect(
    await page.locator('.dashboard-grid').evaluate((el) => getComputedStyle(el, '::after').content),
  ).not.toBe('none');
  // Released, the text flows into its new width over a few frames.
  await messages.evaluate((el) => {
    const w = window as unknown as { __widths?: number[]; __widthsDone?: boolean };
    w.__widths = [];
    window.addEventListener(
      'pointerup',
      () => {
        const end = performance.now() + 700;
        const tick = () => {
          w.__widths!.push(el.offsetWidth);
          if (performance.now() < end) requestAnimationFrame(tick);
          else w.__widthsDone = true;
        };
        requestAnimationFrame(tick);
      },
      { once: true, capture: true },
    );
  });
  await page.mouse.up();
  await page.waitForFunction(() => (window as unknown as { __widthsDone?: boolean }).__widthsDone);
  const seen = await page.evaluate(() => (window as unknown as { __widths: number[] }).__widths);
  await expect.poll(() => messages.evaluate((el) => el.style.width), { timeout: 2000 }).toBe('');
  const settled = await rect(page, NOTES);
  const final = await messages.evaluate((el) => el.offsetWidth);
  expect(Math.abs(final - settled.width)).toBeLessThan(2);
  const between = new Set(seen.filter((w) => w < widthBefore - 2 && w > final + 2));
  expect(between.size).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);

  // The grown pane rewrapped to fewer lines, and its reader is on the same line.
  const after = await readingAt();
  expect(after.text).toBe(before.text);
  expect(Math.abs(after.at - before.at)).toBeLessThan(60);
  expect(errors).toEqual([]);
});

test('hiding and showing the docked session list slides it, the panes follow, then the text rewraps', async ({
  page,
}) => {
  const errors = await setup(page);
  const notes = pane(page, NOTES);
  const messages = notes.locator('.dashboard-pane-messages');
  const startWidth = (await rect(page, NOTES)).width;
  const startText = await messages.evaluate((el) => el.offsetWidth);

  // Per frame from the tap: the drawer's offset, the pane's width and its
  // transcript's width.
  const sample = (trigger: string) =>
    page.evaluate(
      (id) =>
        new Promise<{ margin: number; pane: number; text: number }[]>((done) => {
          const drawer = document.getElementById('drawer')!;
          const paneEl = document.querySelector('.dashboard-pane')!;
          const text = paneEl.querySelector<HTMLElement>('.dashboard-pane-messages')!;
          const seen: { margin: number; pane: number; text: number }[] = [];
          const end = performance.now() + 1000;
          const tick = () => {
            seen.push({
              margin: parseFloat(getComputedStyle(drawer).marginLeft) || 0,
              pane: paneEl.getBoundingClientRect().width,
              text: text.offsetWidth,
            });
            if (performance.now() < end) requestAnimationFrame(tick);
            else done(seen);
          };
          document.getElementById(id)!.click();
          requestAnimationFrame(tick);
        }),
      trigger,
    );

  const hiding = await sample('btn-hide-drawer');
  await expect(page.locator('#app')).toHaveClass(/drawer-collapsed/);
  const wide = (await rect(page, NOTES)).width;
  expect(wide).toBeGreaterThan(startWidth + 60);
  // The drawer slid out and the pane grew over several frames, its text
  // held at the old width meanwhile, then eased out to the new one.
  expect(
    new Set(hiding.map((f) => Math.round(f.margin)).filter((m) => m < -5 && m > -255)).size,
  ).toBeGreaterThanOrEqual(3);
  const growing = hiding.filter((f) => f.pane > startWidth + 5 && f.pane < wide - 5);
  expect(growing.length).toBeGreaterThanOrEqual(3);
  for (const f of growing) expect(f.text).toBe(startText);
  expect(
    new Set(hiding.map((f) => f.text).filter((w) => w > startText + 2 && w < wide - 10)).size,
  ).toBeGreaterThanOrEqual(3);
  await expect.poll(() => messages.evaluate((el) => el.style.width)).toBe('');
  expect(Math.abs((await messages.evaluate((el) => el.offsetWidth)) - wide)).toBeLessThan(2);

  // The Dashboard's own button brings it back the same way.
  await expect(page.locator('#btn-dashboard-drawer')).toBeVisible();
  const showing = await sample('btn-dashboard-drawer');
  await expect(page.locator('#app')).not.toHaveClass(/drawer-collapsed/);
  expect(
    new Set(showing.map((f) => Math.round(f.margin)).filter((m) => m < -5 && m > -255)).size,
  ).toBeGreaterThanOrEqual(3);
  expect(
    showing.filter((f) => f.pane < wide - 5 && f.pane > startWidth + 5).length,
  ).toBeGreaterThanOrEqual(3);
  await expect.poll(() => messages.evaluate((el) => el.style.width)).toBe('');
  expect(Math.abs((await rect(page, NOTES)).width - startWidth)).toBeLessThan(2);
  expect(Math.abs((await messages.evaluate((el) => el.offsetWidth)) - startText)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test.describe('two-finger pane drag (touch)', () => {
  test.use({ hasTouch: true });

  test('two fingers on a pane drag it onto another pane and swap them', async ({ page }, info) => {
    const errors = await setup(page);
    const client = await page.context().newCDPSession(page);
    const from = await rect(page, NOTES);
    const to = await rect(page, BROWSER);
    const touch = (type: string, x: number, y: number) =>
      client.send('Input.dispatchTouchEvent', {
        type,
        touchPoints:
          type === 'touchEnd'
            ? []
            : [
                { x: x - 30, y, id: 1 },
                { x: x + 30, y, id: 2 },
              ],
      });

    const sx = from.left + from.width / 2;
    const sy = from.top + from.height / 2;
    const ex = to.left + to.width / 2;
    const ey = to.top + to.height / 2;
    await touch('touchStart', sx, sy);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', sx + ((ex - sx) * i) / 12, sy + ((ey - sy) * i) / 12);
    }
    await expect(page.locator('.dashboard-drag-ghost')).toBeVisible();
    await expect(page.locator('.dashboard-drop-preview')).toBeVisible();
    await page.screenshot({ path: info.outputPath('two-finger-drag.png') });
    await touch('touchEnd', ex, ey);
    await page.waitForTimeout(700);

    await expect(page.locator('.dashboard-drag-ghost')).toHaveCount(0);
    const notesNow = await rect(page, NOTES);
    const browserNow = await rect(page, BROWSER);
    expect(Math.abs(notesNow.left - to.left)).toBeLessThan(2);
    expect(Math.abs(notesNow.top - to.top)).toBeLessThan(2);
    expect(Math.abs(browserNow.left - from.left)).toBeLessThan(2);
    expect(
      await page.evaluate(() => document.body.classList.contains('dashboard-pointer-dragging')),
    ).toBe(false);
    expect(errors).toEqual([]);
  });

  /** Two fingers on one horizontal line around (x, y), `gap` px apart, moved
   *  from `from` to `to` apart in steps; `hold` runs before the fingers lift. */
  async function pinch(
    page: Page,
    x: number,
    y: number,
    from: number,
    to: number,
    hold?: (gap: number) => Promise<void>,
  ) {
    const client = await page.context().newCDPSession(page);
    const points = (gap: number) => [
      { x: x - gap / 2, y, id: 1 },
      { x: x + gap / 2, y, id: 2 },
    ];
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: points(from),
    });
    for (let i = 1; i <= 10; i++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: points(from + ((to - from) * i) / 10),
      });
    }
    await hold?.(to);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(750);
    await client.detach();
  }
  const center = (r: { left: number; top: number; width: number; height: number }) => ({
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
  });

  test('spreading two fingers makes a pane a little bigger, then fills the stage, and pinching steps back', async ({
    page,
  }, info) => {
    const errors = await setup(page);
    const tile = await rect(page, NOTES);
    const stage = await gridRect(page);
    const label = page.locator('#dashboard-drop-label');

    // Stage one: a little bigger, still tiled with its neighbours.
    let c = center(tile);
    await pinch(page, c.x, c.y, 100, 135, async () => {
      await expect(page.locator('.dashboard-drop-preview.pinch-target')).toBeVisible();
      await expect(label).toHaveText('放大一點');
      expect(await transformOf(page, NOTES)).not.toBe('none');
      await page.screenshot({ path: info.outputPath('pinch-grow.png') });
    });
    await expect(page.locator('.dashboard-drop-preview')).toBeHidden();
    const bigger = await rect(page, NOTES);
    expect(bigger.width).toBeGreaterThan(tile.width * 1.4);
    expect(bigger.width).toBeLessThan(stage.width * 0.7);
    await expect(pane(page, NOTES)).not.toHaveClass(/pane-zoomed/);
    for (const other of [PIWEB, HAY, BROWSER]) await expect(pane(page, other)).toBeVisible();
    await page.screenshot({ path: info.outputPath('pinch-bigger.png') });

    // Spreading again gives it the whole stage.
    c = center(bigger);
    await pinch(page, c.x, c.y, 100, 135, async () => {
      await expect(label).toHaveText('放到最大');
    });
    await expect(pane(page, NOTES)).toHaveClass(/pane-zoomed/);
    const zoomed = await rect(page, NOTES);
    expect(Math.abs(zoomed.width - stage.width)).toBeLessThan(2);
    for (const other of [PIWEB, HAY, BROWSER]) await expect(pane(page, other)).toBeHidden();

    // Pinching steps back: first to the bigger tile, then to the old one.
    c = center(zoomed);
    await pinch(page, c.x, c.y, 200, 150, async () => {
      await expect(label).toHaveText('縮回並排');
    });
    await expect(pane(page, NOTES)).not.toHaveClass(/pane-zoomed/);
    const back = await rect(page, NOTES);
    expect(Math.abs(back.width - bigger.width)).toBeLessThan(2);

    c = center(back);
    await pinch(page, c.x, c.y, 200, 150, async () => {
      await expect(label).toHaveText('縮回原本大小');
    });
    const original = await rect(page, NOTES);
    expect(Math.abs(original.width - tile.width)).toBeLessThan(2);
    expect(Math.abs(original.left - tile.left)).toBeLessThan(2);
    await expect(page.locator('.dashboard-grid')).not.toHaveClass(/zoom-moving|has-zoom/);
    expect(errors).toEqual([]);
  });

  test('one wide spread goes straight to the whole stage; a small one springs back', async ({
    page,
  }) => {
    const errors = await setup(page);
    const tile = await rect(page, PIWEB);
    const c = center(tile);

    await pinch(page, c.x, c.y, 100, 108);
    const same = await rect(page, PIWEB);
    expect(Math.abs(same.width - tile.width)).toBeLessThan(2);
    expect(await transformOf(page, PIWEB)).toBe('matrix(1, 0, 0, 1, 0, 0)');

    // Nearly twice the spread is still stage one; so is a spread from fingers
    // set down close together, which counts from 100px.
    for (const [from, to] of [
      [100, 190],
      [50, 90],
    ]) {
      await pinch(page, c.x, c.y, from, to, async () => {
        await expect(page.locator('#dashboard-drop-label')).toHaveText('放大一點');
      });
      await expect(pane(page, PIWEB)).not.toHaveClass(/pane-zoomed/);
      expect((await rect(page, PIWEB)).width).toBeGreaterThan(tile.width * 1.2);
      // Back to the old tile for the next try.
      await pinch(page, c.x, c.y, 200, 150);
      await expect.poll(async () => Math.abs((await rect(page, PIWEB)).width - tile.width)).toBeLessThan(2);
    }

    await pinch(page, c.x, c.y, 100, 230, async () => {
      await expect(page.locator('#dashboard-drop-label')).toHaveText('放到最大');
    });
    await expect(pane(page, PIWEB)).toHaveClass(/pane-zoomed/);
    // The fingers lifting on the header are not a double tap.
    await page.waitForTimeout(400);
    await expect(pane(page, PIWEB)).toHaveClass(/pane-zoomed/);
    expect(errors).toEqual([]);
  });
});
