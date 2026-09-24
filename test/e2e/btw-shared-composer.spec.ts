import { expect, test } from 'playwright/test';

const session = {
  jid: 'web:btw-test', name: 'BTW test', folder: 'web_btw_test', kind: 'standard', deleted: false,
  model: 'openai-codex/gpt-5.4', thinking: 'high', busy: true, lastReplyId: 1,
};

function routes(page: import('playwright').Page, available = true, current: typeof session = session) {
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
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/events')) return route.fulfill({ json: {
      events: [{ id: 1, kind: 'message', role: 'user', content: 'Main message', files: [], createdAt: '2026-01-01T00:00:00Z' }],
      busy: true, hasMore: false, session: current,
    } });
    if (path.endsWith('/btw')) return route.fulfill({ json: {
      available, generation: available ? 'web_btw_test' : undefined,
      reason: available ? undefined : 'BTW bridge not installed',
      thread: available ? { messages: [{ role: 'assistant', content: 'BTW answer' }], busy: false } : undefined,
    } });
    return route.fulfill({ json: {} });
  });
  return calls;
}

test('one composer switches recipient with a visible BTW card and preserves both drafts', async ({ page }, info) => {
  const calls = routes(page);
  await page.goto('/');
  await expect(page.getByText('Main message')).toBeVisible();
  const composer = page.locator('#composer textarea');
  await composer.fill('main draft');
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: /BTW/ }).click();
  await expect(page.getByText('BTW answer')).toBeVisible();
  await expect(page.locator('#btw-card')).toContainText('BTW 側聊');
  await page.screenshot({ path: info.outputPath('btw-shared-composer.png'), animations: 'disabled' });
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

test('BTW send uses only the dedicated endpoint and main stream remains separate', async ({ page }) => {
  const calls = routes(page);
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.getByRole('menuitem', { name: /BTW/ }).click();
  await expect(page.locator('#btw-card')).toBeVisible();
  const composer = page.locator('#composer textarea');
  await composer.fill('side request');
  await expect(composer).toHaveValue('side request');
  await expect(page.locator('#btn-send')).toHaveAttribute('aria-label','傳送至 BTW');
  await page.locator('#btn-send').click();
  await expect.poll(() => calls.filter((p) => p.endsWith('/btw')).length).toBe(1);
  expect(calls).not.toContain('/api/sessions/web:btw-test/messages');
  await page.locator('#btw-back').click();
  await expect(page.getByText('Main message')).toBeVisible();
});

test('a pending BTW opening cannot accidentally submit a draft to main', async ({ page }) => {
  const calls = routes(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/sessions/*/btw', async (route) => {
    await hold;
    await route.fulfill({ json: { available: true, generation: 'web_btw_test', thread: { messages: [] } } });
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
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/sessions/*/btw', async (route) => {
    if (route.request().method() !== 'POST') {
      return route.fulfill({ json: { available: true, generation: 'web_btw_test', thread: { messages: [] } } });
    }
    await hold;
    return route.fulfill({ json: { ok: true, thread: { messages: [
      { role: 'user', content: 'side question' }, { role: 'assistant', content: 'side answer' },
    ] } } });
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
      return route.fulfill({ json: { available: true, generation: 'web_btw_test', thread: { messages: [] } } });
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
