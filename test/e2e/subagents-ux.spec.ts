import { expect, test } from 'playwright/test';

test('Subagents readable cards, stable polling, animated navigation and reduced motion', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  let updated = false;
  let holdList = false,
    listHeld = false;
  let releaseList: () => void = () => {};
  const session = {
    jid: 'web:ux',
    name: 'UX test',
    kind: 'standard',
    deleted: false,
    model: '',
    thinking: '',
    busy: false,
    lastReplyId: 0,
  };
  const children = () =>
    Array.from({ length: 12 }, (_, i) => ({
      id: `child-${i}`,
      name: `subagent-luna-web-b1537602-ba63-4e83-a533-16d55bebcd76-${i + 1}`,
      model: 'openai-codex/gpt-5.6-luna',
      state: updated ? 'Response complete' : 'Activity unconfirmed',
      running: i === 0 && !updated,
      updatedAt: 1700000000000 + i,
      task: `Task: ${i === 0 ? '檢查登入流程與錯誤處理，整理測試結果' : 'Review independent module ' + (i + 1)}. ${'Long task detail '.repeat(15)}`,
    })).sort((a, b) => (updated ? b.updatedAt - a.updatedAt : 0));
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (holdList && u.pathname.endsWith('/subagents') && !u.searchParams.has('child')) {
      listHeld = true;
      await new Promise<void>((resolve) => {
        releaseList = resolve;
      });
    }
    if (u.pathname === '/api/me') return route.fulfill({ json: { authed: true } });
    if (u.pathname === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (u.pathname.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (u.pathname.endsWith('/events'))
      return route.fulfill({ json: { events: [], busy: false, hasMore: false, session } });
    if (u.pathname.endsWith('/subagents'))
      return route.fulfill({
        json: {
          scope: 'ux-scope',
          children: children(),
          events: [
            { id: 'one', rowid: 1, kind: 'tool', role: 'read', content: 'src/auth.ts', files: [] },
            {
              id: 'two',
              rowid: 2,
              kind: 'message',
              role: 'assistant',
              content: '## Review result\n\n登入流程正常。\n\n```js\nconst verified = true;\n```',
              files: [],
            },
          ],
          hasMore: false,
        },
      });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await page.locator('#btn-more').click();
  await page.locator('#mi-subagents').click();
  const dialog = page.getByRole('dialog', { name: 'Subagents' });
  await expect(dialog.locator('.subagents-count')).toHaveText('12');
  const rows = dialog.locator('.subagent-row');
  await expect(rows).toHaveCount(12);
  await expect(rows.first().locator('.subagent-state')).toHaveText('Running');
  await expect(rows.first().locator('.subagent-state')).toHaveAttribute('data-tone', 'running');
  expect(
    await rows
      .first()
      .locator('.subagent-state')
      .evaluate((e) => getComputedStyle(e, '::before').animationName),
  ).toBe('subagent-spin');
  await expect(rows.first().locator('.subagent-name')).toHaveText('Luna web');
  await expect(rows.first().locator('.subagent-model')).toHaveText('gpt-5.6-luna');
  await expect(rows.first()).not.toContainText('b1537602');
  await expect(dialog).toHaveAttribute('data-view', 'list');
  await expect.poll(() => dialog.evaluate((e) => e.getAnimations().length)).toBe(0);
  await page.screenshot({ path: info.outputPath('01-cards.png') });
  const target = rows.filter({ hasText: 'Review independent module 8.' });
  await target.scrollIntoViewIfNeeded();
  await target.focus();
  const targetTop = await target.evaluate((e) => e.getBoundingClientRect().top);
  updated = true;
  await expect(target.locator('.subagent-state')).toHaveText('Response ready');
  await expect(dialog.locator('[data-tone="running"]')).toHaveCount(0);
  await expect(target).toBeFocused();
  await expect(rows.first()).toContainText('Review independent module 12.');
  await expect
    .poll(async () =>
      Math.abs((await target.evaluate((e) => e.getBoundingClientRect().top)) - targetTop),
    )
    .toBeLessThan(1);
  const scroll = await dialog.locator('.subagents-body').evaluate((e) => e.scrollTop);
  await target.click();
  await expect(dialog).toHaveAttribute('data-view', 'detail');
  await expect(dialog.locator('.subagents-header h2')).toHaveText('Luna web');
  await expect(dialog.locator('.msg h2')).toHaveText('Review result');
  await dialog.locator('.event.tool summary').click();
  await expect(dialog.locator('.event.tool')).toHaveAttribute('open', '');
  await expect
    .poll(() => dialog.locator('.subagents-body').evaluate((e) => e.getAnimations().length))
    .toBe(0);
  await page.screenshot({ path: info.outputPath('02-detail.png') });
  holdList = true;
  await dialog.getByRole('button', { name: 'Back to subagents' }).click();
  await expect(target).toBeFocused();
  await expect
    .poll(() => dialog.locator('.subagents-body').evaluate((e) => e.scrollTop))
    .toBe(scroll);
  await expect.poll(() => listHeld).toBe(true);
  await dialog.getByRole('button', { name: 'Close subagents' }).focus();
  const returned = page.waitForResponse(
    (r) => r.url().includes('/subagents') && !new URL(r.url()).searchParams.has('child'),
  );
  holdList = false;
  releaseList();
  await returned;
  // Wait for the next normal poll to also settle: neither response may steal focus.
  await page.waitForResponse(
    (r) => r.url().includes('/subagents') && !new URL(r.url()).searchParams.has('child'),
  );
  await expect(dialog.getByRole('button', { name: 'Close subagents' })).toBeFocused();
  for (const button of [dialog.getByRole('button', { name: 'Close subagents' }), target]) {
    expect(
      await button.evaluate((e) => {
        const r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.width >= 44 && r.height >= 44 && (hit === e || e.contains(hit));
      }),
    ).toBe(true);
  }
  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  await expect(dialog).not.toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.locator('#btn-more').click();
  await page.locator('#mi-subagents').click();
  await expect(rows).toHaveCount(12);
  expect(await dialog.evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('03-light.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});
