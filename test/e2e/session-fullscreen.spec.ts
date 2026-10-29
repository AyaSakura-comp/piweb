import { expect, test, type Page } from 'playwright/test';

// 2026-10-29: a wide reply ("Measured …") read on a phone left little room
// between the header, the pinned prompt, the chips and the composer; the user
// asked for one tap to read the whole session full screen.
const turns = Array.from({ length: 8 }, (_, i) => [
  { role: 'user', content: `Question ${i + 1}: how did run ${i + 1} go?` },
  {
    role: 'assistant',
    content: [
      `Reading line ${i + 1}: the run finished and every check passed, so the numbers below are the ones to keep for the comparison later on.`,
      '',
      `Second paragraph ${i + 1}: nothing else changed between the rounds, and the machine was otherwise idle while they ran.`,
    ].join('\n'),
  },
]).flat();
const extras = [
  { role: 'user', content: 'And the details?' },
  {
    role: 'assistant',
    content: [
      'See [the log](https://example.com/run-log) and run `npm test` again.',
      '',
      '| Voice | First sentence | Per sentence |',
      '| --- | --- | --- |',
      '| NPU | 1.11 s | 0.5–0.7 s |',
      '',
      'Last line of the newest reply: that is all for now.',
    ].join('\n'),
  },
];
const session = {
  jid: 'web:reading',
  name: 'Torch NPU',
  folder: 'web_reading',
  kind: 'standard',
  deleted: false,
  model: 'claude-code/opus',
  badge: { label: 'OPUS', kind: 'claude' },
  busy: false,
  lastReplyId: 99,
  lastActivity: '2026-10-29 06:40:00',
};
const events = [
  ...turns.map((e) => ({ kind: 'message', ...e })),
  { kind: 'tool', role: 'Bash', content: 'ls' },
  ...extras.map((e) => ({ kind: 'message', ...e })),
].map((e, i) => ({ id: i + 1, files: [], createdAt: '2026-10-29T06:40:00Z', ...e }));

const life = {
  jid: 'web:life',
  name: 'Life',
  kind: 'life',
  model: '',
  thinking: '',
  generation: 'life-generation-1',
};

async function setup(page: Page, theme: 'light' | 'dark' = 'dark', { inLife = false } = {}) {
  await page.addInitScript(
    ([value, mode]) => {
      localStorage.setItem('piweb.mode', mode);
      localStorage.setItem('piweb.theme', value);
    },
    [theme, inLife ? 'life' : 'sessions'],
  );
  await page.route('**/*', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (!path.startsWith('/api/')) {
      if (path.endsWith('hot-keywords.json'))
        return route.fulfill({ json: { items: [{ text: 'deploy' }, { text: 'push' }] } });
      return route.continue().catch(() => {});
    }
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/life-session') return route.fulfill({ json: { ...life, created: false } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path.endsWith('/events')) {
      const owner = path.includes(life.jid) ? { ...life, deleted: false } : session;
      return route.fulfill({ json: { events, busy: false, hasMore: false, session: owner } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto(inLife ? '/' : '/?session=' + encodeURIComponent(session.jid));
  await expect(page.locator('#messages')).toContainText('Last line of the newest reply');
  await expect(page.locator('#composer-wrap')).toBeVisible();
}

const app = (page: Page) => page.locator('#app');
const FULL = /\bsession-fullscreen\b/;

/** Sample positions every frame while `action` runs, until the motion is over. */
async function sampled(page: Page, action: () => Promise<void>, probe: string) {
  await page.evaluate((text) => {
    const w = window as any;
    w.__samples = [];
    const started = performance.now();
    const line = [...document.querySelectorAll('#messages p')].find((p) =>
      p.textContent!.includes(text),
    )!;
    const frame = () => {
      const pick = (s: string) => document.querySelector(s)?.getBoundingClientRect();
      w.__samples.push({
        probe: line.getBoundingClientRect().top,
        probeBottom: line.getBoundingClientRect().bottom,
        topbar: pick('.main > .topbar')?.bottom,
        composer: pick('#composer-wrap')?.top,
      });
      if (performance.now() - started < 700) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, probe);
  await action();
  await page.waitForTimeout(800);
  return page.evaluate(() => (window as any).__samples as Record<string, number>[]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`a tap on the transcript gives it the whole screen, another brings the chrome back; the words stay put (${theme})`, async ({
    page,
  }, info) => {
    await setup(page, theme);
    const messages = page.locator('#messages');
    // Read somewhere in the middle, not at the newest message.
    await messages.evaluate((n) => (n.scrollTop = 900));
    const line = page.getByText('Reading line 5:', { exact: false });
    await expect(line).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`chat-${theme}.png`) });
    const topbarBottom = (await page.locator('.main > .topbar').boundingBox())!.height;

    const entering = await sampled(page, () => line.tap(), 'Reading line 5:');
    await expect(app(page)).toHaveClass(FULL);
    await expect(page.locator('.main > .topbar')).toBeHidden();
    await expect(page.locator('#composer-wrap')).toBeHidden();
    // The transcript has the whole screen.
    const box = (await messages.boundingBox())!;
    expect(box.y).toBe(0);
    expect(box.y + box.height).toBe(844);
    // The words under the finger never moved, in any frame.
    const first = entering[0].probe;
    for (const sample of entering) expect(Math.abs(sample.probe - first)).toBeLessThanOrEqual(1);
    // The header slid away (seen between its rest and gone), not vanished.
    expect(entering.some((s) => s.topbar > 1 && s.topbar < topbarBottom - 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`full-screen-${theme}.png`) });

    const leaving = await sampled(page, () => line.tap(), 'Reading line 5:');
    await expect(app(page)).not.toHaveClass(FULL);
    await expect(page.locator('.main > .topbar')).toBeVisible();
    await expect(page.locator('#composer-wrap')).toBeVisible();
    await expect(page.locator('#input')).toBeVisible();
    for (const sample of leaving) expect(Math.abs(sample.probe - first)).toBeLessThanOrEqual(1);
    expect(leaving.some((s) => s.composer > 845 - 100 && s.composer < 843)).toBe(true);
  });
}

test('at the newest message the transcript stays at its newest message, riding with the composer', async ({
  page,
}) => {
  await setup(page);
  const messages = page.locator('#messages');
  const last = page.getByText('Last line of the newest reply');
  await expect(last).toBeInViewport();
  const gap = () => messages.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight);
  expect(await gap()).toBeLessThan(2);

  const entering = await sampled(page, () => last.tap(), 'Last line of the newest reply');
  await expect(app(page)).toHaveClass(FULL);
  expect(await gap()).toBeLessThan(2);
  // Never covered by the composer on its way down, and at the screen's foot at the end.
  for (const s of entering) expect(s.probeBottom).toBeLessThanOrEqual(s.composer + 1);
  expect(entering.at(-1)!.probeBottom).toBeGreaterThan(800);

  const leaving = await sampled(page, () => last.tap(), 'Last line of the newest reply');
  await expect(app(page)).not.toHaveClass(FULL);
  expect(await gap()).toBeLessThan(2);
  for (const s of leaving) expect(s.probeBottom).toBeLessThanOrEqual(s.composer + 1);
  await expect(page.locator('#jump-live')).not.toHaveClass(/visible/);
});

test('taps that belong to something else stay theirs: link, code, table, tool card, selection, mouse, keyboard', async ({
  page,
}) => {
  await setup(page);
  const settle = () => page.waitForTimeout(300);

  await page.getByRole('link', { name: 'the log' }).tap();
  await expect(page.locator('#toast-text')).toContainText('https://example.com/run-log');
  await page.getByText('npm test', { exact: true }).tap();
  await expect(page.locator('#toast-text')).toContainText('Copied code');
  await settle();
  await expect(app(page)).not.toHaveClass(FULL);

  await page.getByRole('cell', { name: 'NPU' }).tap();
  await expect(page.locator('#mermaid-modal')).toBeVisible();
  // Escape closes the table first, and only the table.
  await page.keyboard.press('Escape');
  await expect(page.locator('#mermaid-modal')).toBeHidden();
  await expect(app(page)).not.toHaveClass(FULL);

  const tool = page.locator('#messages details.event summary').last();
  await tool.tap();
  await expect(page.locator('#messages details.event').last()).toHaveAttribute('open', '');
  await settle();
  await expect(app(page)).not.toHaveClass(FULL);

  // A long press selects text for quoting; its lift is no tap.
  await page.locator('#toast').evaluate((n) => ((n as HTMLElement).hidden = true));
  const box = (await page.getByText('Second paragraph 8:').boundingBox())!;
  const point = { x: box.x + 40, y: box.y + box.height / 2, id: 1 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('toolbar')).toBeVisible();
  await settle();
  await expect(app(page)).not.toHaveClass(FULL);
  await page.locator('#sel-backdrop').tap();
  await expect(page.getByRole('toolbar')).toBeHidden();
  await settle();
  await expect(app(page)).not.toHaveClass(FULL);

  // A mouse click on the text selects or deselects; it is not a tap.
  const text = (await page.getByText('Reading line 8:').boundingBox())!;
  await page.mouse.click(text.x + 30, text.y + 5);
  await settle();
  await expect(app(page)).not.toHaveClass(FULL);

  // With the keyboard up, a tap on the transcript only puts it away.
  await page.locator('#input').focus();
  await page.getByText('Reading line 8:').tap();
  await settle();
  await expect(app(page)).not.toHaveClass(FULL);
});

test('Escape leaves full screen; reduced motion switches at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page);
  await page.getByText('Reading line 8:').tap();
  // No motion to wait for.
  await expect(app(page)).toHaveClass(FULL);
  expect((await page.locator('#messages').boundingBox())!.y).toBe(0);
  await page.keyboard.press('Escape');
  await expect(app(page)).not.toHaveClass(FULL);
  await expect(page.locator('#composer-wrap')).toBeVisible();
});

test('Life reads full screen too', async ({ page }, info) => {
  await setup(page, 'light', { inLife: true });
  await expect(app(page)).toHaveClass(/\blife-mode\b/);
  await page.getByText('Reading line 8:').tap();
  await expect(app(page)).toHaveClass(FULL);
  await page.waitForTimeout(300);
  await expect(page.locator('.main > .topbar')).toBeHidden();
  expect((await page.locator('#messages').boundingBox())!.y).toBe(0);
  await page.screenshot({ path: info.outputPath('life-full-screen-light.png') });
  await page.getByText('Reading line 8:').tap();
  await expect(app(page)).not.toHaveClass(FULL);
  await expect(page.locator('#composer-wrap')).toBeVisible();
});
