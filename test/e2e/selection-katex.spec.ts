import { expect, test, type Page } from 'playwright/test';

// iPhone, 2026-11-15: 「往下的時候會變成往上」. A long press inside a formula, then
// the end handle dragged down: the selection grew UP the screen instead, to the
// reply above. KaTeX keeps a hidden MathML copy of each formula ahead of the
// glyphs it draws, and WebKit's caret lookup answers with it (WebKitGTK 2.52,
// measured: the line under a formula's first line returned its MathML), so the
// dragged end landed before its anchor. Chromium's lookup does not do that, so
// these tests give `caretPositionFromPoint` WebKit's answers during the drag.
// The formula came from a Bash card: its `KEY=$(…); … "$KEY"` was drawn as TeX.

const command =
  `$ tailscale status 2>&1 | head -3; getent hosts controlplane.tailscale.com || echo DNS_FAIL; ` +
  `KEY=$(grep -oE 'tskey-auth-[A-Za-z0-9-]+' /searxng-deploy/.env | head -1); ` +
  `sudo timeout 60 tailscale up --auth-key="$KEY" --hostname=aya --accept-dns=true --force-reauth 2>&1 | tail -10`;
const formula = String.raw`f(x) = \alpha_1 x^{\prime} + \beta_2 x^2 + \gamma_3 x^3 + \delta_4 x^4 + \epsilon_5 x^5 + \zeta_6 x^6 + \eta_7 x^7 + \theta_8 x^8 + \iota_9 x^9`;
const session = { jid: 'web:katexsel', name: 'ts net不能連', folder: 'web_katexsel', kind: 'standard', deleted: false, model: 'test', busy: false, lastReplyId: 5 };
let id = 0;
const event = (kind: string, role: string, content: string) => ({ id: ++id, kind, role, content, files: [], createdAt: '2026-11-15T01:40:00Z' });
const events = [
  event('message', 'user', '幫我登入啊'),
  event('message', 'assistant', '要我繼續嗎？回覆「繼續修 aya」就好。'),
  event('tool', 'Bash', command),
  event('tool_result', '', 'Logged out. Log in at: https://login.example/a/xyz'),
  event('message', 'assistant', `多項式寫成 $${formula}$，係數逐項遞增，最後再整理成表。`),
];

const sent: string[] = [];

async function open(page: Page, theme: 'light' | 'dark' = 'dark') {
  await page.addInitScript((value) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.theme', value);
  }, theme);
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/events')) return route.fulfill({ json: { events, busy: false, hasMore: false, session } });
    if (path.endsWith('/messages') && route.request().method() === 'POST') {
      sent.push(route.request().postData() ?? '');
      return route.fulfill({ json: { ok: true, id: 99 } });
    }
    return route.fulfill({ json: { models: [], commands: [], sessions: [], items: [] } });
  });
  await page.goto('/');
  await expect(page.locator('.msg-text .katex-html').first()).toBeVisible();
  // During a drag, answer the caret lookup the way WebKit did.
  await page.evaluate(() => {
    const real = document.caretPositionFromPoint.bind(document);
    const firstText = (el: Element | null) => document.createTreeWalker(el!, NodeFilter.SHOW_TEXT).nextNode();
    (document as any).caretPositionFromPoint = (x: number, y: number) => {
      const mode = (window as any).__caret;
      if (mode === 'mathml') {
        // Under the dragged handle (it takes hits), the formula the finger is on.
        const katex = document.elementsFromPoint(x, y).find((el) => el.closest('.katex'))?.closest('.katex');
        if (katex) return { offsetNode: firstText(katex.querySelector('.katex-mathml')), offset: 0 };
      }
      if (mode === 'far') {
        // The reply above the formula, as in the recording's quote.
        return { offsetNode: firstText(document.querySelectorAll('.msg-text')[1]), offset: 3 };
      }
      return real(x, y);
    };
  });
}

/** The formula's drawn glyph boxes, line by line (top of each line). */
async function formulaLines(page: Page) {
  return page.evaluate(() => {
    const html = document.querySelector('.msg-text .katex-html')!;
    const walker = document.createTreeWalker(html, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const glyphs: { x: number; y: number; top: number; bottom: number }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!/[^\s​]/.test(node.textContent || '')) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width && r.height) glyphs.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom });
    }
    const lines: (typeof glyphs)[] = [];
    for (const g of glyphs) {
      const line = lines.find((l) => Math.abs(l[0].y - g.y) < 12);
      if (line) line.push(g);
      else lines.push([g]);
    }
    return lines.sort((a, b) => a[0].y - b[0].y);
  });
}

async function longPress(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await expect(page.locator('#custom-selection-overlay')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#quote-preview')).toBeVisible();
}

async function dragEndHandle(page: Page, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator('#sel-handle-end').boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 2 }] });
  for (let i = 1; i <= 10; i++) {
    const point = { x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10, id: 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#sel-highlight-boxes')).toHaveAttribute('data-bubble', 'settled');
}

const handleTop = (page: Page, id: string) => page.locator(id).evaluate((el) => parseFloat((el as HTMLElement).style.top));
const quoted = (page: Page) => page.locator('#quote-preview-text').innerText();

for (const mode of ['mathml', 'far'] as const) {
  test(`dragging the end handle down a formula keeps growing it down (caret answers: ${mode})`, async ({ page }, info) => {
    await open(page);
    const lines = await formulaLines(page);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const [first, second] = lines;
    const anchor = first[Math.min(3, first.length - 1)];
    await longPress(page, anchor.x, anchor.y);
    const startBefore = await handleTop(page, '#sel-handle-start');
    const endBefore = await handleTop(page, '#sel-handle-end');

    await page.evaluate((value) => ((window as any).__caret = value), mode);
    // The handle sits under the text; the finger carries it to the next line.
    const target = second[Math.min(4, second.length - 1)];
    await dragEndHandle(page, { x: target.x, y: target.y - 14 });
    await page.evaluate(() => ((window as any).__caret = null));

    // The start stays at the long-pressed glyph; the end has gone down a line.
    expect(Math.abs((await handleTop(page, '#sel-handle-start')) - startBefore)).toBeLessThan(2);
    expect(await handleTop(page, '#sel-handle-end')).toBeGreaterThan(endBefore + 8);
    const quote = await quoted(page);
    expect(quote).not.toContain('繼續修');
    expect(quote).not.toContain('多項式');
    await page.screenshot({ path: info.outputPath(`formula-drag-${mode}.png`) });
  });
}

test('a quote across a formula holds the formula once, as drawn', async ({ page }) => {
  await open(page);
  const reply = page.locator('.msg-text').last();
  const box = (await reply.boundingBox())!;
  await longPress(page, box.x + 12, box.y + 10);
  const end = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.msg-text p')].pop()!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const rects = [...range.getClientRects()];
    const last = rects[rects.length - 1];
    return { x: last.right - 4, y: last.top + last.height / 2 };
  });
  await dragEndHandle(page, { x: end.x, y: end.y - 14 });
  // The preview chip is cut short; the quote goes out whole with the message.
  sent.length = 0;
  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const quote = JSON.parse(sent[0]).quote as string;
  expect(quote).toContain('多項式');
  expect(quote).toContain('整理成表');
  // The hidden MathML copy (its letters, and the TeX source) is not quoted.
  expect(quote).not.toContain('\\alpha');
  expect(quote.match(/α/g)?.length ?? 0).toBe(1);
});

for (const theme of ['light', 'dark'] as const) {
  test(`a Bash card shows its command as written, not as a formula (${theme})`, async ({ page }, info) => {
    await open(page, theme);
    const card = page.locator('details.event.tool').first();
    await card.locator('summary').click();
    const body = card.locator('.event-body');
    await expect(body).toBeVisible();
    await expect(body.locator('.katex')).toHaveCount(0);
    await expect(body).toContainText(`KEY=$(grep -oE 'tskey-auth-[A-Za-z0-9-]+'`);
    await expect(body).toContainText(`sudo timeout 60 tailscale up --auth-key="$KEY" --hostname=aya`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`bash-card-${theme}.png`) });
  });
}
