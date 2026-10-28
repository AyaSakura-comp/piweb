import { expect, test, type Page } from 'playwright/test';

// iPhone, 2026-10-29: dragging the start handle up onto a collapsed Result card
// quoted the card's hidden output (its peek runs on past the ellipsis) and the
// bubble stretched off the right edge over the cards below.
const session = { jid: 'web:quotecards', name: 'Quote cards', folder: 'web_quotecards', kind: 'standard', deleted: false, model: 'test', busy: true, lastReplyId: 9 };
let id = 0;
const event = (kind: string, role: string, content: string) => ({ id: ++id, kind, role, content, files: [], createdAt: '2026-10-29T01:58:00Z' });
const events = [
  event('message', 'user', '找幾個今年的小模型'),
  event('tool', 'Bash', 'cd ~; for q in "Qwen3.5-0.8B-GGUF" "LFM2"; do hf search $q; done'),
  event('tool_result', '', '== Qwen3.5-0.8B-GGUF unsloth/Qwen3.5-0.8B-GGUF 2026-03-01\nmore lines'),
  event('tool', 'Bash', 'cd ~; for a in Qwen google LiquidAI; do hf list $a; done'),
  event('tool_result', '', '2026-10-27 LiquidAI/d1-Omni-2B-GGUF 2026-10-27 LiquidAI/d1-2B-GGUF 2026-10-27 LiquidAI/other\nhidden line'),
  event('message', 'assistant', '先說進度：我在 Hugging Face 找到幾個今年釋出的小模型，現在下載下來，用摘要容器的設定（CPU、4 執行緒）實測速度。'),
  event('tool', 'Bash', 'cd ~; for r in unsloth/Qwen3.5-0.8B-GGUF; do hf download $r; done'),
  event('tool_result', '', '== unsloth/Qwen3.5-0.8B-GGUF Qwen3.5-0.8B-Q4_K_M.gguf\nok'),
  event('tool', 'Bash', 'mkdir -p ~/models-work/small'),
];

async function dragHandle(page: Page, to: { x: number; y: number }, id: number) {
  const cdp = await page.context().newCDPSession(page);
  const from = (await page.locator('#sel-handle-start').boundingBox())!;
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id }] });
  for (let i = 1; i <= 12; i++) {
    const point = { x: start.x + ((to.x - start.x) * i) / 12, y: start.y + ((to.y - start.y) * i) / 12, id };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#sel-highlight-boxes')).toHaveAttribute('data-bubble', 'settled');
}

const quoted = (page: Page) => page.locator('#quote-preview-text').innerText();
const bubbleRight = (page: Page) =>
  page.evaluate(() => Math.max(...[...document.querySelectorAll('.sel-bubble')].map((el) => el.getBoundingClientRect().right)));

test('a handle dragged over collapsed tool cards quotes only the text on screen', async ({ page }, info) => {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/events')) return route.fulfill({ json: { events, busy: true, hasMore: false, session } });
    return route.fulfill({ json: { models: [], commands: [], sessions: [], items: [] } });
  });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto('/');
  const reply = page.locator('.msg-text').last();
  await expect(reply).toContainText('先說進度');

  // Long-press the end of the reply.
  const box = (await reply.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.85, y: box.y + box.height - 10, id: 1 }] });
  await expect(page.locator('#custom-selection-overlay')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#quote-preview')).toContainText('實測速度');

  // Up onto the collapsed Result card right above the reply, near its ellipsis.
  const card = (await page.locator('details.event.tool_result').nth(1).boundingBox())!;
  await dragHandle(page, { x: card.x + card.width - 40, y: card.y + card.height / 2 + 14 }, 2);
  const onCard = await quoted(page);
  expect(onCard).toContain('實測速度');
  expect(onCard).not.toContain('LiquidAI');
  expect(onCard).not.toContain('hidden line');
  expect(await bubbleRight(page)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('handle-on-card.png') });

  // On up into the user's message: both messages, none of the cards between.
  const ask = (await page.locator('.msg-text').first().boundingBox())!;
  await dragHandle(page, { x: ask.x + 20, y: ask.y + 24 }, 3);
  const across = await quoted(page);
  expect(across).toContain('幾個今年的小模型');
  expect(across).toContain('先說進度');
  expect(across).not.toMatch(/Bash|LiquidAI|hf search|unsloth/);
  expect(await bubbleRight(page)).toBeLessThanOrEqual(390);
  // The bubble leaves the cards between the two messages uncovered.
  const covered = await page.evaluate(() => {
    const path = document.querySelector('.sel-bubble path, path.sel-bubble') as SVGPathElement | null;
    const svg = path?.ownerSVGElement;
    if (!path || !svg) return null;
    const card = document.querySelectorAll('details.event.tool_result')[0].getBoundingClientRect();
    const origin = svg.getBoundingClientRect();
    const point = svg.createSVGPoint();
    point.x = card.left + card.width / 2 - origin.left;
    point.y = card.top + card.height / 2 - origin.top;
    return path.isPointInFill(point);
  });
  expect(covered).toBe(false);
  await page.screenshot({ path: info.outputPath('across-messages.png') });
});
