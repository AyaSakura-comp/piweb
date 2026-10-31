import { expect, test, type Page } from 'playwright/test';

// 2026-10-29: a reply's wide table was cut off at the phone's edge ("Per
// senter…"); a tap now opens it full screen with every column in view.
const reply = [
  'Measured (3 interleaved rounds):',
  '',
  '| Voice | Send → first sentence heard (median) | Per sentence after that | Notes on the run |',
  '| --- | --- | --- | --- |',
  '| NPU | 1.11 s | 0.5–0.7 s | [log](https://example.com/npu-log) |',
  '| GPU | 1.05 s | 0.5–0.7 s | shared with the image job |',
  '| CPU | 2.08 s | 1.4–1.7 s | E2B on 16 threads |',
].join('\n');
const session = {
  jid: 'web:table',
  name: 'Torch NPU',
  folder: 'web_table',
  kind: 'standard',
  deleted: false,
  model: 'claude-code/opus',
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 2,
  lastActivity: '2026-10-29 06:40:00',
};
const events = [
  { id: 1, kind: 'message', role: 'user', content: 'How fast is each voice?' },
  { id: 2, kind: 'message', role: 'assistant', content: reply },
].map((e) => ({ files: [], createdAt: '2026-10-29T06:40:00Z', ...e }));

async function setup(page: Page, theme: 'light' | 'dark' = 'dark') {
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
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events, busy: false, hasMore: false, session } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/?session=' + encodeURIComponent(session.jid));
  await expect(page.locator('#messages .table-wrap table')).toBeVisible();
}

const viewer = (page: Page) => page.locator('#mermaid-modal');
/** Open and at rest: the copy flies out of the reply's table first (DESIGN.md "Viewer motion"). */
async function opened(page: Page) {
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page)).not.toHaveAttribute('data-motion', /./);
  await expect(viewer(page).locator('.mm-modal-stage')).not.toHaveAttribute('data-motion', /./);
}

for (const theme of ['light', 'dark'] as const) {
  test(`a tap on a reply's table opens it full screen with every column in view (${theme})`, async ({
    page,
  }, info) => {
    await setup(page, theme);
    const wrap = page.locator('#messages .table-wrap');
    // In the transcript the last column is past the phone's edge.
    expect(await wrap.evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`table-in-transcript-${theme}.png`) });

    await page.getByRole('cell', { name: 'GPU' }).tap();
    await opened(page);
    await expect(viewer(page)).toHaveAttribute('data-kind', 'table');
    await expect(viewer(page).locator('.mm-modal-title')).toHaveText('Table');
    const copy = viewer(page).locator('table');
    await expect(copy).toContainText('Notes on the run');
    // Every column fits inside the viewer, and the copy reads at least half size.
    const fit = await page.evaluate(() => {
      const body = document.querySelector('#mermaid-modal .mm-modal-body')!.getBoundingClientRect();
      const table = document.querySelector('#mermaid-modal table')!.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>('#mermaid-modal .mm-modal-stage')!;
      return {
        inside: table.left >= body.left - 0.5 && table.right <= body.right + 0.5 && table.top >= body.top - 0.5,
        scale: new DOMMatrix(getComputedStyle(stage).transform).a,
      };
    });
    expect(fit.inside).toBe(true);
    // Wrapping its cells between words is enough here: full size, not shrunk.
    expect(fit.scale).toBe(1);
    // The viewer follows the appearance (Mermaid's stays dark).
    const background = await viewer(page)
      .locator('.mm-modal-content')
      .evaluate((n) => getComputedStyle(n).backgroundColor);
    const [r, g, b] = background.match(/\d+/g)!.map(Number);
    expect((r + g + b) / 3 > 128).toBe(theme === 'light');
    for (const button of await viewer(page).locator('.mm-modal-tools button').all()) {
      const box = (await button.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(32);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`table-full-screen-${theme}.png`) });

    await viewer(page).getByRole('button', { name: 'Close' }).tap();
    await expect(viewer(page)).toBeHidden();
  });
}

test('zoom and Reset return to the first fitted view; Escape closes', async ({ page }) => {
  await setup(page);
  await page.getByRole('cell', { name: 'CPU' }).tap();
  await opened(page);
  const stage = viewer(page).locator('.mm-modal-stage');
  const matrix = () => stage.evaluate((n) => new DOMMatrix(getComputedStyle(n).transform).toString());
  const first = await matrix();
  await viewer(page).getByRole('button', { name: 'Zoom in' }).tap();
  await expect.poll(matrix).not.toBe(first);
  await viewer(page).getByRole('button', { name: 'Reset zoom' }).tap();
  await expect.poll(matrix).toBe(first);
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toBeHidden();
});

test('a link in a cell keeps its own tap and opens no viewer; selected text is no tap', async ({
  page,
}) => {
  await setup(page);
  // A link keeps its own tap (copy, with an Open action) and opens no viewer.
  await page.getByRole('link', { name: 'log' }).tap();
  await expect(page.locator('#toast-text')).toContainText('https://example.com/npu-log');
  await page.waitForTimeout(200);
  await expect(viewer(page)).toBeHidden();

  // A long press on a cell selects text for quoting; its lift is no tap.
  await page.locator('#toast').evaluate((n) => ((n as HTMLElement).hidden = true));
  const box = (await page.getByRole('cell', { name: 'shared with the image job' }).boundingBox())!;
  const point = { x: box.x + 30, y: box.y + box.height / 2, id: 1 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('toolbar')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(viewer(page)).toBeHidden();
});

test('a table too wide even with wrapped cells is shrunk to fit, never below half size', async ({
  page,
}) => {
  const columns = Array.from({ length: 12 }, (_, i) => `Column_${i + 1}_heading`);
  events[1] = {
    ...events[1],
    content: [
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      `| ${columns.map((_, i) => `value_${i + 1}`).join(' | ')} |`,
    ].join('\n'),
  };
  try {
    await setup(page);
    await page.getByRole('cell', { name: 'value_3' }).tap();
    await opened(page);
    const view = await page.evaluate(() => {
      const body = document.querySelector('#mermaid-modal .mm-modal-body')!.getBoundingClientRect();
      const table = document.querySelector('#mermaid-modal table')!.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>('#mermaid-modal .mm-modal-stage')!;
      return {
        leftInView: table.left >= body.left - 0.5,
        scale: new DOMMatrix(getComputedStyle(stage).transform).a,
      };
    });
    expect(view.leftInView).toBe(true);
    expect(view.scale).toBe(0.5);
  } finally {
    events[1] = { ...events[1], content: reply };
  }
});

