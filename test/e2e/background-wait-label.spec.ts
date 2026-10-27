import { expect, test, type Page } from 'playwright/test';

// Hay 回測 (2026-10-27): Claude replied and ended its turn, but a command it
// had left in the background never finished, so the session kept spinning
// with "pi is working…" under a finished answer. The typing line now says
// what the session waits for.
const command = (state: string) => ({
  kind: 'system',
  role: 'claude-command',
  content: JSON.stringify({
    id: 'bws3gl4is',
    command: 'until [ -f gone ]; do sleep 3; done',
    role: 'claude-command',
    state,
    agent: 'output-received',
    output: '',
  }),
});
const user = { kind: 'message', role: 'user', content: '修，但是不要 pattern match' };
const reply = { kind: 'message', role: 'assistant', content: '三個問題都修好了。' };
const tool = { kind: 'tool', role: 'Bash', content: 'ls' };

const histories: Record<string, any[]> = {
  // Replied; the command it left behind is still running.
  'web:wait': [user, command('running'), reply],
  // Replied, then woke up and is calling tools again.
  'web:again': [user, command('running'), reply, tool],
  // The command finished; whatever holds the turn now is not a command.
  'web:done': [user, command('running'), reply, command('failed')],
};
const sessions = Object.keys(histories).map((jid, i) => ({
  jid,
  name: jid.slice(4),
  folder: jid.replace(':', '_'),
  kind: 'standard',
  deleted: false,
  model: 'claude-code/opus',
  badge: { label: 'OPUS', kind: 'claude' },
  busy: true,
  lastReplyId: 1,
  lastActivity: `2026-10-27 15:4${i}:00`,
}));

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith('/api/')) {
      if (path.endsWith('hot-keywords.json')) return route.fulfill({ json: { items: [] } });
      return route.continue().catch(() => {});
    }
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path.endsWith('/events')) {
      const jid = path.split('/')[3];
      const events = histories[jid].map((e, i) => ({ id: i + 1, files: [], createdAt: '2026-10-27T15:30:00Z', ...e }));
      return route.fulfill({
        json: { events, busy: true, hasMore: false, session: sessions.find((s) => s.jid === jid) },
      });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: `retry: 60000\ndata: {"busy":true}\n\n` });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
}

const label = (page: Page) => page.locator('#typing .typing-label');

test('the typing line says it waits for a background command once the reply is in', async ({ page }, info) => {
  await setup(page);
  await page.goto('/?session=' + encodeURIComponent('web:wait'));
  await expect(page.locator('#messages')).toContainText('三個問題都修好了');
  await expect(page.locator('#typing')).toBeVisible();
  await expect(label(page)).toHaveText('等待背景命令…');
  await page.screenshot({ path: info.outputPath('waiting.png') });

  for (const jid of ['web:again', 'web:done']) {
    await page.goto('/?session=' + encodeURIComponent(jid));
    await expect(page.locator('#messages')).toContainText('三個問題都修好了');
    await expect(page.locator('#typing')).toBeVisible();
    await expect(label(page), jid).toHaveText('pi is working…');
  }

  // A Dashboard pane reads the same.
  await page.goto('/?session=' + encodeURIComponent('web:wait'));
  await page.locator('#btn-topbar-dashboard').click();
  const pane = page.locator('.dashboard-pane[data-jid="web:wait"]');
  await expect(pane.locator('.dashboard-pane-messages')).toContainText('三個問題都修好了');
  await expect(pane.locator('.dashboard-pane-typing .typing-label')).toHaveText('等待背景命令…');
});
