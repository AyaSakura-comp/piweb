import { expect, test, type Page } from 'playwright/test';

// A narrow pane hides its Status / Usage icons; its ⋯ menu must offer them
// instead, with the usage command for the provider that session runs on.
const sessions = [
  { name: 'GPT pane', model: 'openai-codex/gpt-5.5' },
  { name: 'Agy pane', model: 'agy/gemini-3-pro' },
  { name: 'Claude pane', model: 'claude-code/opus' },
].map((s, i) => ({
  jid: `web:u${i}`,
  folder: `web_u${i}`,
  kind: 'standard',
  deleted: false,
  busy: false,
  lastReplyId: 2,
  lastActivity: `2026-10-22 01:${String(30 - i).padStart(2, '0')}:00`,
  ...s,
}));

test.use({ viewport: { width: 1180, height: 820 }, isMobile: false, hasTouch: false });

async function setup(page: Page) {
  const commands: { jid: string; command: string }[] = [];
  await page.addInitScript(
    ([layout]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem('piweb.dashboard', JSON.stringify(layout));
    },
    [
      {
        direction: 'row',
        updatedAt: Date.now(),
        groups: sessions.map((s) => ({ weight: 1, items: [{ jid: s.jid, weight: 1 }] })),
      },
    ],
  );
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path.endsWith('/commands') && route.request().method() === 'POST') {
      commands.push({ jid: path.split('/')[3], command: route.request().postDataJSON().command });
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => s.jid === path.split('/')[3]);
      return route.fulfill({ json: { events: [], busy: false, hasMore: false, session } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  await page.goto('/');
  await page.locator('#btn-dashboard-home').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(3);
  return commands;
}

test('a narrow pane offers Status and Usage in its menu', async ({ page }, info) => {
  const commands = await setup(page);
  const expected = ['gpt-usage', 'agy-usage', 'claude-usage'];
  for (const [i, s] of sessions.entries()) {
    const pane = page.locator(`.dashboard-pane[data-jid="${s.jid}"]`);
    await expect(pane.locator('.pane-usage-btn')).toBeHidden();
    await pane.locator('.pane-more-btn').click();
    const usage = pane.locator('.pane-more-menu [data-action="usage"]');
    await expect(usage).toBeVisible();
    await expect(usage.locator('.mi-cmd')).toHaveText(`/${expected[i]}`);
    await expect(pane.locator('.pane-more-menu [data-action="status"]')).toBeVisible();
    if (i === 0) await page.screenshot({ path: info.outputPath('menu-narrow.png') });
    await usage.click();
    await expect(pane.locator('.pane-more-menu')).toBeHidden();
  }
  await expect.poll(() => commands.map((c) => c.command)).toEqual(expected);
  expect(commands.map((c) => c.jid)).toEqual(sessions.map((s) => s.jid));

  const first = page.locator(`.dashboard-pane[data-jid="${sessions[0].jid}"]`);
  await first.locator('.pane-more-btn').click();
  await first.locator('.pane-more-menu [data-action="status"]').click();
  await expect.poll(() => commands.at(-1)).toEqual({ jid: sessions[0].jid, command: 'pi status' });
});

test('a wide pane keeps the icons and leaves them out of the menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  // Close two panes so the last one is wide.
  for (const s of sessions.slice(0, 2))
    await page.locator(`.dashboard-pane[data-jid="${s.jid}"] .pane-close-btn`).click();
  const pane = page.locator(`.dashboard-pane[data-jid="${sessions[2].jid}"]`);
  await expect(page.locator('.dashboard-pane')).toHaveCount(1);
  await expect(pane.locator('.pane-usage-btn')).toBeVisible();
  await expect(pane.locator('.pane-usage-btn')).toHaveAttribute('title', '/claude-usage');
  await pane.locator('.pane-more-btn').click();
  await expect(pane.locator('.pane-more-menu')).toBeVisible();
  await expect(pane.locator('.pane-more-menu [data-action="usage"]')).toBeHidden();
  await expect(pane.locator('.pane-more-menu [data-action="status"]')).toBeHidden();
});
