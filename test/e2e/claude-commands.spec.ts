import { expect, test } from 'playwright/test';

test('Claude Opus background command list displays running task, interim checkpoint, and completion', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let phase = 0;
  const session = {
    jid: 'web:claude-command-test',
    name: 'Claude Opus Command Test',
    model: 'claude-code/opus',
    provider: 'claude-code',
    kind: 'standard',
    deleted: false,
    busy: false,
    badge: { label: 'CLAUDE', kind: 'other' },
  };

  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: [], busy: false, session } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/commands-running'))
      return route.fulfill({
        json: {
          commands: [
            {
              id: 'bgiedcpoz',
              taskId: 'bgiedcpoz',
              command: 'CODEX_HOME=/home/chihmin/.evo/identities/modelcorp timeout 3600 node scripts/evo-guider-operator-live.mjs',
              role: 'claude-command',
              state: phase === 0 || phase === 1 ? 'running' : 'succeeded',
              agent: phase === 0 ? 'output-received' : phase === 1 ? 'output-received' : 'continued',
              nextAction: phase === 2 ? 'assistant response' : undefined,
              output:
                phase === 0
                  ? 'operator run started...\n'
                  : phase === 1
                    ? 'operator run started...\n[checkpoint 1] dir evo-operator-live-77482350\nchecks: empty-conversation'
                    : 'operator run started...\n[checkpoint 1] dir evo-operator-live-77482350\nchecks: empty-conversation\nDONE',
              exitCode: phase === 2 ? 0 : undefined,
              startedAt: Date.now() - 5000,
              updatedAt: Date.now(),
            },
          ],
        },
      });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });

  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Claude Opus Command Test');
  expect(errors).toEqual([]);

  // 1. More menu displays 背景命令 for claude-code/opus
  await page.locator('#btn-more').click();
  const commandMenu = page.locator('#mi-commands-running');
  await expect(commandMenu).toBeVisible();
  await expect(commandMenu).toContainText('背景命令');
  await page.screenshot({ path: info.outputPath('01-claude-more-menu.png') });

  // 2. Open 背景命令 dialog
  await commandMenu.click();
  const dialog = page.getByRole('dialog', { name: '背景命令' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.command-spinner')).toBeVisible();
  await expect(dialog).toContainText('CODEX_HOME=');
  await expect(dialog).toContainText('輸出已回到 Claude 工具事件');
  await page.screenshot({ path: info.outputPath('02-claude-bg-command-running.png') });

  // 3. Inspect output
  await dialog.locator('summary').click();
  await expect(dialog).toContainText('operator run started...');
  await page.screenshot({ path: info.outputPath('03-claude-bg-command-output.png') });

  // 4. Phase 1: interim checkpoint update arrives
  phase = 1;
  await expect(dialog).toContainText('[checkpoint 1]');
  await page.screenshot({ path: info.outputPath('04-claude-bg-checkpoint.png') });

  // 5. Phase 2: completion
  phase = 2;
  await expect(dialog).toContainText('Exit 0');
  await expect(dialog).toContainText('已觀察到 Claude 後續動作：assistant response');
  await expect(dialog.locator('.command-spinner')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('05-claude-bg-completed.png') });

  // 6. Close dialog
  await dialog.getByRole('button', { name: '關閉背景命令' }).click();
  await expect(dialog).not.toBeVisible();
});
