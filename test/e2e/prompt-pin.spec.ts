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
  { id: index * 2 + 1, kind: 'message', role: 'user', content, files: [], createdAt: '2026-01-01T00:00:00Z' },
  { id: index * 2 + 2, kind: 'message', role: 'assistant', content: longReply, files: [], createdAt: '2026-01-01T00:00:01Z' },
]);

function routes(page: import('playwright').Page) {
  page.route('**/api/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (route.request().method() === 'POST') return route.fulfill({ json: { ok: true } });
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
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
