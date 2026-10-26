import { expect, test, type Page } from 'playwright/test';

// A selection in a Dashboard pane quotes itself into the pane's card, and its
// selection backdrop stays up over the whole screen. The chat's card stacks
// above that backdrop; a pane's card cannot, so the first tap on its × (or Send,
// or the box) only dismissed the selection — on iPhone the × opened the
// keyboard and the quote stayed (recording 2026-10-26). The backdrop now passes
// a tap on a composer card on to it.
test.use({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });

const sessions = ['Hey', 'Piweb'].map((name, i) => ({
  jid: `web:q${i}`,
  name,
  folder: `web_q${i}`,
  kind: 'standard',
  deleted: false,
  busy: false,
  lastReplyId: 1,
  lastActivity: `2026-10-26 01:0${i}:00`,
}));

async function quoteInPane(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem(
      'piweb.dashboard',
      JSON.stringify({
        direction: 'column',
        updatedAt: Date.now(),
        groups: [
          { weight: 1, items: [{ jid: 'web:q0', weight: 1 }] },
          { weight: 1, items: [{ jid: 'web:q1', weight: 1 }] },
        ],
      }),
    );
    localStorage.setItem('piweb.dashboard.composer', 'web:q0');
  });
  await page.route('**/media/piweb-shared/hot-keywords.json', (r) => r.fulfill({ json: { items: [] } }));
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events: [
            {
              id: 1,
              kind: 'message',
              role: 'assistant',
              content: '你截圖那張為什麼看不懂 AI 給的 entry: 571fe685，這是一段可以選起來引用的文字。',
              files: [],
              createdAt: '2026-10-26T01:00:00Z',
            },
          ],
          busy: false,
          hasMore: false,
        },
      });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [], sessions: [] } });
  });
  await page.goto('/');
  await page.locator('#btn-topbar-dashboard').click();
  const pane = page.locator('.dashboard-pane[data-jid="web:q0"]');
  await expect(pane).toHaveClass(/composer-active/);

  // Long press and drag: the selection quotes itself into the card.
  const text = pane.locator('.dashboard-pane-messages .msg-text').first();
  const box = (await text.boundingBox())!;
  const client = await page.context().newCDPSession(page);
  const at = { x: box.x + 30, y: box.y + 10 };
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...at, id: 1 }] });
  await page.waitForTimeout(800);
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: at.x + 120, y: at.y, id: 1 }],
  });
  await page.waitForTimeout(100);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
  const quote = pane.locator('.pane-quote-preview .quote-preview-text');
  await expect(quote).not.toHaveText('');
  await expect(pane.locator('.pane-quote-remove')).toBeVisible();
  await expect(page.locator('#sel-backdrop')).toBeVisible();
  return { pane, errors };
}

const center = async (page: Page, selector: string) => {
  const b = (await page.locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test('one tap on × removes the quote from a pane card, without opening the keyboard', async ({
  page,
}, info) => {
  const { pane, errors } = await quoteInPane(page);
  const x = await center(page, '.dashboard-pane[data-jid="web:q0"] .pane-quote-remove');
  // The backdrop is what the finger lands on.
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, x),
  ).toBe('sel-backdrop');
  await page.screenshot({ path: info.outputPath('quote-before.png') });
  await page.touchscreen.tap(x.x, x.y);
  await expect(pane.locator('.pane-quote-preview')).toBeHidden();
  await expect(page.locator('#sel-backdrop')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
  await page.screenshot({ path: info.outputPath('quote-removed.png') });
  expect(errors).toEqual([]);
});

test('a tap on the transcript only dismisses the selection; a tap on the box focuses it', async ({
  page,
}) => {
  const { pane } = await quoteInPane(page);
  const preview = pane.locator('.pane-quote-preview');
  const transcript = await center(page, '.dashboard-pane[data-jid="web:q0"] .dashboard-pane-messages');
  await page.touchscreen.tap(transcript.x, transcript.y + 60);
  await expect(page.locator('#sel-backdrop')).toBeHidden();
  await expect(preview).toBeVisible();

  // Select again; this time tap the box itself.
  await page.reload();
  const again = await quoteInPane(page);
  const input = await center(page, '.dashboard-pane[data-jid="web:q0"] .dashboard-pane-input');
  await page.touchscreen.tap(input.x, input.y);
  await expect(page.locator('#sel-backdrop')).toBeHidden();
  await expect(again.pane.locator('.dashboard-pane-input')).toBeFocused();
  await expect(again.pane.locator('.pane-quote-preview')).toBeVisible();
});
