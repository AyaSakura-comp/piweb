import { expect, test } from 'playwright/test';

const session = {
  jid: 'web:pin-test',
  name: 'Pin test',
  folder: 'web_pin_test',
  kind: 'standard',
  deleted: false,
  model: 'openai-codex/gpt-5.4',
  thinking: 'high',
  busy: false,
  lastReplyId: 6,
};
const longReply = Array.from({ length: 40 }, (_, i) => `Reply paragraph ${i + 1}.`).join('\n\n');
const prompts = [
  'First question about the build',
  'Second question: why is the cache cold?\nIt should hit after the first turn.\nThird line of detail.',
];
const events = prompts.flatMap((content, index) => [
  { id: index * 3 + 1, kind: 'message', role: 'user', content, files: [], createdAt: '2026-01-01T00:00:00Z' },
  // A header button's command echo is a user message, but not the turn's prompt.
  { id: index * 3 + 2, kind: 'message', role: 'user', content: '/claude-usage', files: [], createdAt: '2026-01-01T00:00:01Z' },
  { id: index * 3 + 3, kind: 'message', role: 'assistant', content: longReply, files: [], createdAt: '2026-01-01T00:00:01Z' },
]);

function routes(page: import('playwright').Page) {
  page.route('**/api/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (route.request().method() === 'POST') return route.fulfill({ json: { ok: true } });
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/commands')
      return route.fulfill({ json: { commands: [{ name: 'claude-usage' }, { name: 'pi model' }] } });
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events, busy: false, hasMore: false, session } });
    return route.fulfill({ json: {} });
  });
}

async function scrollTo(page: import('playwright').Page, fraction: number) {
  await page.locator('#messages').evaluate((node, f) => {
    node.scrollTop = (node.scrollHeight - node.clientHeight) * f;
  }, fraction);
}

test('the prompt of the turn being read pins one line under the header and expands on tap', async ({
  page,
}, info) => {
  routes(page);
  await page.goto('/');
  await expect(page.getByText('First question about the build')).toBeVisible();
  const pin = page.locator('#prompt-pin');
  await scrollTo(page, 0);
  await expect(pin).toBeHidden();

  // Inside the second turn's reply: its prompt is pinned, folded to one line.
  await scrollTo(page, 0.9);
  await expect(pin).toBeVisible();
  await expect(pin).toHaveText('Second question: why is the cache cold?');
  const messages = (await page.locator('#messages').boundingBox())!;
  const folded = (await pin.boundingBox())!;
  expect(Math.abs(folded.y - messages.y)).toBeLessThan(1);
  expect(folded.height).toBeLessThanOrEqual(46);
  await page.screenshot({ path: info.outputPath('prompt-pin-folded.png') });

  // Held down, the bar stays opaque: the tint sits over --bg, not instead of it.
  const pinBox = (await pin.boundingBox())!;
  await page.mouse.move(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2);
  await page.mouse.down();
  const pressed = await pin.evaluate((node) => {
    const style = getComputedStyle(node);
    return { color: style.backgroundColor, image: style.backgroundImage, active: node.matches(':active') };
  });
  await page.screenshot({ path: info.outputPath('prompt-pin-pressed.png'), clip: { x: 0, y: 0, width: 390, height: 160 } });
  await page.mouse.up();
  expect(pressed.active).toBe(true);
  expect(pressed.color).toMatch(/^rgb\(/);
  expect(pressed.image).toContain('gradient');
  await expect(pin).toHaveAttribute('aria-expanded', 'true');
  await pin.tap();
  await expect(pin).toHaveAttribute('aria-expanded', 'false');
  await pin.tap();
  await expect(pin).toHaveAttribute('aria-expanded', 'true');
  const opened = (await pin.boundingBox())!;
  expect(opened.height).toBeGreaterThan(folded.height + 30);
  const lines = await pin.locator('.prompt-pin-text').evaluate((node) => node.innerText);
  expect(lines).toBe(prompts[1]);
  await page.screenshot({ path: info.outputPath('prompt-pin-expanded.png') });
  await pin.tap();
  await expect(pin).toHaveAttribute('aria-expanded', 'false');
  await expect(pin).toHaveText('Second question: why is the cache cold?');

  // Inside the first turn's reply: the pin follows to the first prompt.
  await scrollTo(page, 0.3);
  await expect(pin).toContainText('First question about the build');
  await expect(pin).not.toContainText('Second question');
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
});

test('a prompt on an older, unloaded page is fetched once and pinned', async ({ page }) => {
  const tools = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i,
    kind: 'message',
    role: 'assistant',
    content: `Tool loop step ${i + 1}\n\n${longReply.slice(0, 200)}`,
    files: [],
    createdAt: '2026-01-01T00:00:02Z',
  }));
  const older = [
    { id: 10, kind: 'message', role: 'user', content: 'Old prompt\nsecond line', files: [], createdAt: '2026-01-01T00:00:00Z' },
    { id: 11, kind: 'message', role: 'assistant', content: 'early reply', files: [], createdAt: '2026-01-01T00:00:01Z' },
    { id: 12, kind: 'message', role: 'user', content: 'Long tool loop prompt\nwith detail', files: [], createdAt: '2026-01-01T00:00:01Z' },
    { id: 13, kind: 'message', role: 'user', content: '/pi model openai-codex/gpt-6-luna', files: [], createdAt: '2026-01-01T00:00:02Z' },
  ];
  const befores: string[] = [];
  routes(page);
  await page.route('**/api/sessions/*/events**', async (route) => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get('before');
    if (before) {
      befores.push(before);
      return route.fulfill({ json: { events: Number(before) <= 100 ? older : [], hasMore: false, session } });
    }
    return route.fulfill({ json: { events: tools, busy: false, hasMore: true, session } });
  });
  await page.goto('/');
  await expect(page.getByText('Tool loop step 30')).toBeVisible();
  await page.locator('#messages').evaluate((node) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - 300;
  });
  const pin = page.locator('#prompt-pin');
  await expect(pin).toHaveText('Long tool loop prompt');
  await pin.tap();
  await expect(pin.locator('.prompt-pin-text')).toHaveText('Long tool loop prompt\nwith detail');
  await page.locator('#messages').evaluate((node) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - 600;
  });
  await page.waitForTimeout(300);
  expect(befores.filter((value) => value === '100')).toHaveLength(1);
});

test('the next prompt pushes the pin out like a sticky header, and scrolling up pushes the previous one back in', async ({
  page,
}, info) => {
  routes(page);
  await page.goto('/');
  await expect(page.getByText('First question about the build')).toBeVisible();
  const pin = page.locator('#prompt-pin');
  const messages = page.locator('#messages');
  // Put the second prompt's row `gap` px below the transcript's top edge.
  const place = async (gap: number) => {
    await messages.evaluate((node, g) => {
      const rows = [...node.querySelectorAll('.msg.msg-user')].filter((row) => !row.textContent?.includes('/claude-usage'));
      const second = rows[1] as HTMLElement;
      node.scrollTop += second.getBoundingClientRect().top - node.getBoundingClientRect().top - g;
    }, gap);
    await page.waitForTimeout(80);
    const top = (await messages.boundingBox())!.y;
    const second = (await page.locator('.msg.msg-user', { hasText: 'Second question' }).boundingBox())!;
    const bar = (await pin.boundingBox())!;
    return { top, rowTop: second.y, barTop: bar.y, barBottom: bar.y + bar.height, text: await pin.locator('.prompt-pin-text').innerText() };
  };

  // Far below: the first prompt is pinned, untouched.
  let at = await place(200);
  expect(at.text).toBe('First question about the build');
  expect(Math.abs(at.barTop - at.top)).toBeLessThan(1);

  // Within the bar's height: the second prompt's row pushes the bar up; the
  // bar's bottom edge rides on the row's top edge.
  for (const gap of [30, 15, 4]) {
    at = await place(gap);
    expect(at.text).toBe('First question about the build');
    expect(Math.abs(at.barBottom - at.rowTop)).toBeLessThan(1.5);
    expect(at.barTop).toBeLessThan(at.top);
    if (gap === 15) await page.screenshot({ path: info.outputPath('prompt-pin-pushed.png'), clip: { x: 0, y: 0, width: 390, height: 200 } });
  }

  // Past the edge: the second prompt is pinned.
  at = await place(-40);
  expect(at.text).toBe('Second question: why is the cache cold?');
  expect(Math.abs(at.barTop - at.top)).toBeLessThan(1);

  // Back up again: the second prompt's row settles into its place and the
  // first prompt is pushed back down into the pin.
  at = await place(25);
  expect(at.text).toBe('First question about the build');
  expect(Math.abs(at.barBottom - at.rowTop)).toBeLessThan(1.5);
  at = await place(120);
  expect(Math.abs(at.barTop - at.top)).toBeLessThan(1);
});

test('the pin follows rows that move without a scroll (layout changes)', async ({ page }) => {
  routes(page);
  await page.goto('/');
  await expect(page.getByText('First question about the build')).toBeVisible();
  const pin = page.locator('#prompt-pin');
  const messages = page.locator('#messages');
  // Second prompt 150px below the top edge: the first prompt is pinned.
  await messages.evaluate((node) => {
    node.style.overflowAnchor = 'none';
    const second = [...node.querySelectorAll('.msg.msg-user')].find((row) => row.textContent?.includes('Second question'))!;
    node.scrollTop += second.getBoundingClientRect().top - node.getBoundingClientRect().top - 150;
  });
  await expect(pin).toHaveText('First question about the build');
  // Content inside the reply above grows with no scroll event (a reply still
  // rendering, an image arriving): the second prompt's row moves down, away
  // from the top, and back up when it shrinks again.
  await page.waitForTimeout(300);
  await messages.evaluate((node) => {
    const second = [...node.querySelectorAll('.msg.msg-user')].find((row) => row.textContent?.includes('Second question'))!;
    node.scrollTop += second.getBoundingClientRect().top - node.getBoundingClientRect().top + 60;
  });
  await expect(pin).toHaveText('Second question: why is the cache cold?');
  await page.waitForTimeout(300);
  await messages.evaluate((node) => {
    const replies = [...node.querySelectorAll('.msg:not(.msg-user) .msg-text')];
    const first = replies[0];
    const spacer = document.createElement('div');
    spacer.className = 'test-spacer';
    spacer.style.height = '200px';
    first.append(spacer);
  });
  await expect(pin).toHaveText('First question about the build');
});
