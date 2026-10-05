import { expect, test } from 'playwright/test';

const session = {
  jid: 'web:btw-test',
  name: 'BTW test',
  folder: 'web_btw_test',
  kind: 'standard',
  deleted: false,
  model: 'openai-codex/gpt-5.4',
  thinking: 'high',
  busy: true,
  lastReplyId: 1,
};

function routes(
  page: import('playwright').Page,
  available = true,
  current: typeof session = session,
) {
  const calls: string[] = [];
  page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    const path = decodeURIComponent(u.pathname);
    if (route.request().method() === 'POST') {
      calls.push(path);
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [current] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events: [
            {
              id: 1,
              kind: 'message',
              role: 'user',
              content: 'Main message',
              files: [],
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          busy: true,
          hasMore: false,
          session: current,
        },
      });
    if (path.endsWith('/btw'))
      return route.fulfill({
        json: {
          available,
          generation: available ? 'web_btw_test' : undefined,
          reason: available ? undefined : 'BTW bridge not installed',
          thread: available
            ? { messages: [{ role: 'assistant', content: 'BTW answer' }], busy: false }
            : undefined,
        },
      });
    return route.fulfill({ json: {} });
  });
  return calls;
}

async function switchBySwipe(page: import('playwright').Page, side: boolean) {
  // A swipe that lands during a running slide hits the moving surface's parent.
  await page.waitForFunction(() => !document.querySelector('.main.btw-sliding'));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: side ? 280 : 100, y: 300 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: side ? 100 : 280, y: 300 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator(side ? '#messages' : '#btw-messages')).toBeHidden();
  await cdp.detach();
}

test('one composer switches recipient with a visible BTW card and preserves both drafts', async ({
  page,
}, info) => {
  const calls = routes(page);
  await page.goto('/');
  await expect(page.getByText('Main message')).toBeVisible();
  const composer = page.locator('#composer textarea');
  await composer.fill('main draft');
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: /BTW/ }).click();
  await expect(page.getByText('BTW answer')).toBeVisible();
  await expect(page.locator('#btw-card')).toContainText('BTW 側聊');
  await page.screenshot({
    path: info.outputPath('btw-shared-composer.png'),
    animations: 'disabled',
  });
  await expect(page.locator('#composer textarea')).toHaveCount(1);
  await expect(composer).toHaveValue('');
  await composer.fill('side draft');
  await page.locator('#btw-back').click();
  await expect(composer).toHaveValue('main draft');
  await expect(page.getByText('Main message')).toBeVisible();
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: /BTW/ }).click();
  await expect(composer).toHaveValue('side draft');
  await expect(page.locator('#btn-attach')).toBeDisabled();
  expect(calls).not.toContain('/api/sessions/web:btw-test/messages');
});

test('BTW send uses only the dedicated endpoint and main stream remains separate', async ({
  page,
}) => {
  const calls = routes(page);
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: /BTW/ }).click();
  await expect(page.locator('#btw-card')).toBeVisible();
  const composer = page.locator('#composer textarea');
  await composer.fill('side request');
  await expect(composer).toHaveValue('side request');
  await expect(page.locator('#btn-send')).toHaveAttribute('aria-label', '傳送至 BTW');
  await page.locator('#btn-send').click();
  await expect.poll(() => calls.filter((p) => p.endsWith('/btw')).length).toBe(1);
  expect(calls).not.toContain('/api/sessions/web:btw-test/messages');
  await page.locator('#btw-back').click();
  await expect(page.getByText('Main message')).toBeVisible();
});

test('a pending BTW opening cannot accidentally submit a draft to main', async ({ page }) => {
  const calls = routes(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/sessions/*/btw', async (route) => {
    await hold;
    await route.fulfill({
      json: { available: true, generation: 'web_btw_test', thread: { messages: [] } },
    });
  });
  await page.goto('/');
  await expect(page.getByText('Main message')).toBeVisible();
  await page.locator('#input').fill('do not send to main');
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: /BTW/ }).click();
  await page.locator('#btn-send').click();
  expect(calls).not.toContain('/api/sessions/web:btw-test/messages');
  release();
  await expect(page.locator('#btw-card')).toBeVisible();
  await expect(page.locator('#input')).toHaveValue('');
  await page.locator('#btw-back').click();
  await expect(page.locator('#input')).toHaveValue('do not send to main');
});

test('unsupported bridge fails closed and cannot switch or submit to main', async ({ page }) => {
  const calls = routes(page, false);
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: /BTW/ }).click();
  await expect(page.locator('#btw-card')).toBeHidden();
  await expect(page.getByText('BTW bridge not installed')).toBeVisible();
  expect(calls).not.toContain('/api/sessions/web:btw-test/messages');
});

test('a BTW question shows immediately with an answering indicator', async ({ page }, info) => {
  routes(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/sessions/*/btw', async (route) => {
    if (route.request().method() !== 'POST') {
      return route.fulfill({
        json: { available: true, generation: 'web_btw_test', thread: { messages: [] } },
      });
    }
    await hold;
    return route.fulfill({
      json: {
        ok: true,
        thread: {
          messages: [
            { role: 'user', content: 'side question' },
            { role: 'assistant', content: 'side answer' },
          ],
        },
      },
    });
  });
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: /BTW/ }).click();
  await expect(page.locator('#btw-card')).toBeVisible();
  const composer = page.locator('#input');
  await composer.fill('side question');
  await page.locator('#btn-send').click();
  await expect(composer).toHaveValue('');
  await expect(page.locator('#btw-messages')).toContainText('side question');
  await expect(page.locator('#btw-messages .btw-waiting')).toBeVisible();
  await expect(page.locator('#btw-card')).toContainText('BTW 回答中');
  await page.screenshot({ path: info.outputPath('btw-pending.png'), animations: 'disabled' });
  release();
  await expect(page.locator('#btw-messages')).toContainText('side answer');
  await expect(page.locator('#btw-messages .btw-waiting')).toHaveCount(0);
  await expect(page.locator('#btw-card')).not.toContainText('BTW 回答中');
});

test('a failed BTW send removes the pending question and puts the draft back', async ({ page }) => {
  routes(page);
  await page.route('**/api/sessions/*/btw', async (route) => {
    if (route.request().method() !== 'POST') {
      return route.fulfill({
        json: { available: true, generation: 'web_btw_test', thread: { messages: [] } },
      });
    }
    return route.fulfill({ status: 503, json: { error: 'BTW bridge busy' } });
  });
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: /BTW/ }).click();
  await expect(page.locator('#btw-card')).toBeVisible();
  await page.locator('#input').fill('keep me');
  await page.locator('#btn-send').click();
  await expect(page.locator('#input')).toHaveValue('keep me');
  await expect(page.locator('#btw-messages')).not.toContainText('keep me');
  await expect(page.locator('#btw-messages .btw-waiting')).toHaveCount(0);
});

for (const model of ['agy/gemini-3-pro', 'claude-code/opus']) {
  test(`BTW entry is hidden for non-Pi model ${model}`, async ({ page }) => {
    const calls = routes(page, true, { ...session, model });
    await page.goto('/');
    await expect(page.getByText('Main message')).toBeVisible();
    await page.locator('#btn-more').click();
    await expect(page.locator('#more-menu')).toBeVisible();
    await expect(page.locator('#mi-btw')).toBeHidden();
    expect(calls.filter((p) => p.endsWith('/btw'))).toEqual([]);
  });
}

test('switching the session to a non-Pi model leaves BTW and hides its entry', async ({ page }) => {
  const current = { ...session };
  routes(page, true, current);
  await page.goto('/');
  await page.locator('#btn-more').click();
  await expect(page.locator('#mi-btw')).toBeVisible();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible();
  current.model = 'agy/gemini-3-pro';
  // The drawer poll (every 5s) delivers the new model.
  await expect(page.locator('#btw-card')).toBeHidden({ timeout: 12_000 });
  await expect(page.getByText('Main message')).toBeVisible();
  await expect(page.locator('#input')).toHaveAttribute('placeholder', 'Message pi…');
  await page.screenshot({ path: test.info().outputPath('left-btw-toast.png') });
  await page.locator('#btn-more').click();
  await expect(page.locator('#more-menu')).toBeVisible();
  await expect(page.locator('#mi-btw')).toBeHidden();
  await page.waitForTimeout(400);
  await page.screenshot({ path: test.info().outputPath('menu-without-btw.png') });
});

test('switches freely during a BTW run and keeps main send usable', async ({ page }, info) => {
  const calls = routes(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route('**/api/sessions/*/btw', async (route) => {
    if (route.request().method() === 'GET') {
      reads++;
      return route.fulfill({
        json: { available: true, generation: 'web_btw_test', thread: { messages: [] } },
      });
    }
    await hold;
    return route.fulfill({
      json: {
        thread: {
          messages: [
            { role: 'user', content: 'side working' },
            { role: 'assistant', content: 'side complete' },
          ],
        },
      },
    });
  });
  await page.goto('/');
  // Session selection resets the composer; type only after it has landed.
  await expect(page.getByText('Main message')).toBeVisible();
  await page.locator('#input').fill('main draft');
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible();
  await page.locator('#input').fill('side working');
  await page.locator('#btn-send').click();
  await expect(page.locator('#btw-clear')).toBeDisabled();
  await page.locator('#btw-back').click();
  await expect(page.locator('#input')).toHaveValue('main draft');
  await expect(page.locator('#btn-send')).toBeEnabled();
  await page.locator('#btn-send').click();
  await expect.poll(() => calls.some((p) => p.endsWith('/messages'))).toBe(true);
  await switchBySwipe(page, true);
  await expect(page.locator('#btw-messages')).toContainText('side working');
  await expect(page.locator('.btw-waiting')).toBeVisible();
  expect(reads).toBe(1);
  await page.screenshot({ path: info.outputPath('btw-running-switch.png') });
  await page.waitForTimeout(600);
  await switchBySwipe(page, false);
  release();
  await expect(page.locator('#btw-context-label')).not.toContainText('回答中');
  await switchBySwipe(page, true);
  await expect(page.locator('#btw-messages')).toContainText('side complete');
  await expect(page.locator('#btn-send')).toBeEnabled();
});

test('clear button clears the side thread only, after confirmation', async ({ page }, info) => {
  routes(page);
  let messages = [{ role: 'assistant', content: 'erase side only' }];
  const bodies: unknown[] = [];
  await page.route('**/api/sessions/*/btw', async (route) => {
    if (route.request().method() === 'POST') {
      bodies.push(route.request().postDataJSON());
      messages = [];
    }
    return route.fulfill({
      json: { available: true, generation: 'web_btw_test', thread: { messages } },
    });
  });
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-messages')).toContainText('erase side only');
  page.once('dialog', (d) => d.accept());
  await page.locator('#btw-clear').click();
  await expect(page.locator('#btw-messages')).not.toContainText('erase side only');
  expect(bodies).toEqual([{ action: 'clear', generation: 'web_btw_test' }]);
  await switchBySwipe(page, false);
  await expect(page.locator('#messages')).toContainText('Main message');
  await page.screenshot({ path: info.outputPath('btw-cleared-main-preserved.png') });
});

test('BTW slides with a held horizontal finger and preserves recipient drafts', async ({
  page,
}, info) => {
  routes(page);
  await page.goto('/');
  await expect(page.locator('#btw-switcher')).toHaveCount(0);
  await expect(page.locator('#btw-context-label')).toHaveText('Main agent');
  await page.locator('#input').fill('main retained');
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible();
  await page.locator('#input').fill('side retained');
  await page.locator('#btw-back').click();
  await expect(page.locator('#btw-messages')).toBeHidden();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 280, y: 300 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 160, y: 300 }],
  });
  await expect
    .poll(async () => (await page.locator('#messages').boundingBox())!.x)
    .toBeLessThan(-80);
  await expect(page.locator('#input')).toHaveValue('main retained');
  await page.screenshot({ path: info.outputPath('btw-held-swipe.png') });
  await page.waitForTimeout(500);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#input')).toHaveValue('side retained');
  await expect(page.locator('#btw-context-label')).toHaveText('BTW');
  await expect(page.locator('#messages')).toBeHidden();
  await page.waitForTimeout(500);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 100, y: 300 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 260, y: 300 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#input')).toHaveValue('main retained');
  await expect(page.locator('#btw-messages')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('BTW header follows DESIGN.md: back left, icon clear right, 44px targets, one-line status', async ({
  page,
}, info) => {
  routes(page);
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible();
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const [card, back, clear, top] = await Promise.all([
    box('#btw-card'),
    box('#btw-back'),
    box('#btw-clear'),
    box('.topbar'),
  ]);
  expect(card.y).toBeCloseTo(top.y + top.height, 0); // directly under the header
  expect(back.x).toBeLessThan(card.width / 2);
  expect(clear.x).toBeGreaterThan(card.width / 2);
  for (const b of [back, clear]) expect([b.width, b.height]).toEqual([44, 44]);
  for (const sel of ['#btw-back', '#btw-clear']) {
    const style = await page.locator(sel).evaluate((e) => getComputedStyle(e).borderTopWidth);
    expect(style).toBe('0px');
  }
  const status = page.locator('#btw-card span');
  expect(await status.evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
  await expect(page.locator('#input')).toHaveAttribute('placeholder', '問 BTW…');
  await expect(page.locator('#btw-context-label')).toBeAttached();
  expect(
    await page.locator('#btw-context-label').evaluate((e) => e.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('btw-header.png'), animations: 'disabled' });
});

test('a short drag under 28% settles back; past 28% switches', async ({ page }) => {
  routes(page);
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible();
  await page.waitForFunction(() => !document.querySelector('.main.btw-sliding'));
  const drag = async (from: number, to: number) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from, y: 300 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: to, y: 300 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await page.waitForFunction(() => !document.querySelector('.main.btw-sliding'));
  };
  await drag(100, 190); // 90px ≈ 23% of 390px
  await expect(page.locator('#btw-card')).toBeVisible();
  await drag(100, 230); // 130px ≈ 33%
  await expect(page.locator('#btw-card')).toBeHidden();
  await expect(page.locator('#messages')).toBeVisible();
});

test('main view shows a quiet BTW-answering link that opens BTW', async ({ page }) => {
  routes(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/sessions/*/btw', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        json: { available: true, generation: 'web_btw_test', thread: { messages: [] } },
      });
    }
    await hold;
    return route.fulfill({
      json: {
        thread: {
          messages: [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' },
          ],
        },
      },
    });
  });
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible();
  await page.locator('#input').fill('q');
  await page.locator('#btn-send').click();
  await expect(page.locator('#btw-card')).toContainText('BTW 回答中');
  await page.locator('#btw-back').click();
  const link = page.getByRole('button', { name: '查看 BTW（回答中）' });
  await expect(link).toBeVisible();
  await page.waitForFunction(() => !document.querySelector('.main.btw-sliding'));
  await link.click();
  await expect(page.locator('#btw-card')).toBeVisible();
  release();
  await expect(page.locator('#btw-messages')).toContainText('a');
  await page.locator('#btw-back').click();
  await expect(link).toBeHidden();
});

test('a BTW answer still running from an earlier page load shows as pending and fills in', async ({
  page,
}) => {
  routes(page);
  let reads = 0;
  await page.route('**/api/sessions/*/btw', async (route) => {
    reads++;
    const done = reads > 1;
    return route.fulfill({
      json: {
        available: true,
        generation: 'web_btw_test',
        thread: done
          ? {
              messages: [
                { role: 'user', content: 'slow q' },
                { role: 'assistant', content: 'slow answer' },
              ],
              pending: [],
            }
          : { messages: [], pending: ['slow q'] },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByText('Main message')).toBeVisible();
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible();
  await expect(page.locator('#btw-messages')).toContainText('slow q');
  await expect(page.locator('#btw-messages .btw-waiting')).toBeVisible();
  await expect(page.locator('#btw-card')).toContainText('BTW 回答中');
  await expect(page.locator('#btn-send')).toBeDisabled();
  await expect(page.locator('#btw-messages')).toContainText('slow answer', { timeout: 8000 });
  await expect(page.locator('#btw-messages .btw-waiting')).toHaveCount(0);
  await expect(page.locator('#btw-card')).not.toContainText('BTW 回答中');
});

test('while BTW is answering, the menu and the link re-enter BTW immediately', async ({ page }) => {
  routes(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route('**/api/sessions/*/btw', async (route) => {
    if (route.request().method() === 'GET') {
      reads++;
      return route.fulfill({
        json: { available: true, generation: 'web_btw_test', thread: { messages: [] } },
      });
    }
    await hold;
    return route.fulfill({
      json: {
        thread: {
          messages: [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' },
          ],
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByText('Main message')).toBeVisible();
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible();
  await page.locator('#input').fill('q');
  await page.locator('#btn-send').click();
  for (let i = 0; i < 2; i++) {
    await page.locator('#btw-back').click();
    await expect(page.locator('#btw-card')).toBeHidden();
    await page.waitForFunction(() => !document.querySelector('.main.btw-sliding'));
    if (i === 0) {
      await page.locator('#btn-more').click();
      await page.locator('#mi-btw').click();
    } else {
      await page.getByRole('button', { name: '查看 BTW（回答中）' }).click();
    }
    await expect(page.locator('#btw-card')).toBeVisible();
    await expect(page.locator('#btw-messages .btw-waiting')).toBeVisible();
  }
  expect(reads).toBe(1);
  release();
  await expect(page.locator('#btw-messages')).toContainText('a');
});
