import { expect, test } from 'playwright/test';

test('usage button follows Claude Code model/account without mixing AGY or GPT quota', async ({
  page,
}, info) => {
  const session = {
    jid: 'web:usage',
    name: 'Usage routing',
    kind: 'standard',
    deleted: false,
    busy: false,
    model: 'claude-code/opus',
    provider: 'claude-code',
    badge: { label: 'OPUS', kind: 'claude' },
  };
  const received: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: [], busy: false, session, hasMore: false } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/commands') && route.request().method() === 'POST') {
      received.push(route.request().postDataJSON().command);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  const cases = [
    ['claude-code/opus', 'claude-usage', 'Claude'],
    ['claude-code/sonnet', 'claude-usage', 'Claude'],
    ['claude-code/haiku', 'claude-usage', 'Claude'],
    ['agy/claude-opus-4-6-thinking', 'agy-usage', 'agy'],
    ['openai-codex/test', 'gpt-usage', 'GPT'],
    ['', 'claude-usage', 'Claude'],
  ];
  for (const [model, command, label] of cases) {
    session.model = model;
    await page.goto('/');
    const button = page.locator('#btn-gpt-usage');
    // On a 390px phone the usage shortcut lives in the ⋯ menu, not the topbar.
    await expect(button).toBeHidden();
    await expect(button).toHaveAttribute('title', '/' + command);
    await expect(button).toHaveAttribute('aria-label', `Show ${label} usage`);
    await page.locator('#btn-more').click();
    await expect(page.locator('#mi-usage-cmd')).toHaveText('/' + command);
    const before = received.length;
    await page.locator('#mi-usage').click();
    await expect.poll(() => received.length).toBe(before + 1);
    expect(received.at(-1)).toBe(command);
  }
  // Wide enough that the chat column beside the pinned drawer is over 600px.
  await page.setViewportSize({ width: 900, height: 844 });
  await expect(page.locator('#btn-gpt-usage')).toBeVisible();
  await expect(page.locator('#btn-status')).toBeVisible();
  await page.screenshot({ path: info.outputPath('claude-usage-button.png') });
  expect(errors).toEqual([]);
});
