import { test, expect } from 'playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

// Isolated real web/queue/AGY. No API interception, no production DB or restart.
test.use({ trace: 'off' });
test('real command activity and parent continuation through isolated PiWeb', async ({
  page,
  context,
}, info) => {
  test.skip(process.env.PIWEB_AGY_COMMANDS_LIVE !== '1', 'Opt-in real AGY inference');
  test.setTimeout(180000);
  const root = mkdtempSync(join(tmpdir(), 'piweb-command-live-'));
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const token = randomBytes(32).toString('hex');
  Object.assign(process.env, {
    PIDG_CONFIG: '/dev/null',
    DB_PATH: join(root, 'db.sqlite'),
    SESSIONS_DIR: join(root, 'sessions'),
    WEB_MEDIA_DIR: join(root, 'media'),
    WEB_UPLOAD_DIR: join(root, 'uploads'),
    WEB_AUTH_TOKEN: token,
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(port),
    WEB_PUBLIC_ORIGIN: '',
    WEB_TRUST_TAILSCALE_IDENTITY: 'false',
    PI_MODEL: 'agy/gemini-3.1-pro-low',
    RPC_STEER: 'false',
    PI_CWD: '/home/chihmin/src/piweb',
  });
  const db = await import('../../src/db.js');
  db.initDb();
  const { setTransport } = await import('../../src/transport/index.js');
  setTransport((await import('../../src/transport/web.js')).webTransport);
  const queue = await import('../../src/agent/queue.js');
  queue.startProcessingLoop();
  const server = (await import('../../src/web/server.js')).startWebServer();
  if (!server.listening) await new Promise<void>((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${port}`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(
      true,
    );
    const created = await context.request.post(origin + '/api/sessions', {
      headers: { Origin: origin },
      data: { name: 'Live AGY commands' },
    });
    const parent = await created.json();
    await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
    await page.goto(origin + '/?session=' + encodeURIComponent(parent.jid));
    await expect(page.locator('#input')).toBeVisible();
    await page
      .locator('#input')
      .fill(
        `Read-only command tracker test. Run exactly printf COMMAND_BEGIN; sleep ${process.env.PIWEB_AGY_LONG_TEST === '1' ? '15' : '3'}; printf COMMAND_FINISHED with run_command. Wait for the actual output. Then call view_file on /home/chihmin/src/piweb/tsconfig.json. Finally reply COMMAND_FLOW_COMPLETE and its compiler target. No subagents, edits or background scheduling.`,
      );
    await page.locator('#btn-send').click();
    await page.locator('#btn-more').click();
    await page.locator('#mi-commands-running').click();
    const dialog = page.getByRole('dialog', { name: '背景命令' });
    await expect(dialog.locator('.command-spinner')).toBeVisible({ timeout: 90000 });
    expect(
      await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    ).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await page.screenshot({ path: info.outputPath('01-real-running.png') });
    await expect(dialog).toContainText('已觀察到 AGY 後續動作', { timeout: 60000 });
    await dialog.locator('summary').click();
    await expect(dialog).toContainText('COMMAND_FINISHED');
    await page.screenshot({ path: info.outputPath('02-real-output.png') });
    await page.waitForTimeout(1000); // Readable output evidence before returning to chat.
    await dialog.getByRole('button', { name: '關閉背景命令' }).click();
    const answer = page
      .locator('#messages > .msg:not(.msg-user)')
      .filter({ hasText: 'COMMAND_FLOW_COMPLETE' });
    await expect(answer).toBeVisible({ timeout: 60000 });
    await expect(answer).toContainText('ES2022');
    await answer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('03-real-parent.png') });
    await page.waitForTimeout(1200); // Keep the final main-agent update in the recording.
    const events = db.getRecentWebEvents(parent.jid, 1000);
    expect(events.filter(event => event.kind === 'tool' && event.role === 'run_command')).toHaveLength(1);
    const continued = events.findIndex(event => event.kind === 'tool' && event.role === 'view_file');
    const response = events.findIndex(event => event.kind === 'message' && event.role === 'assistant' && event.content.includes('COMMAND_FLOW_COMPLETE'));
    expect(continued).toBeGreaterThan(-1);
    expect(response).toBeGreaterThan(continued);
    await page.reload();
    await expect(page.locator('#input')).toBeVisible();
    await page.locator('#btn-more').click();
    await page.locator('#mi-commands-running').click();
    await expect(dialog).toContainText('已觀察到 AGY 後續動作');
    await expect(dialog.locator('.command-spinner')).toHaveCount(0);
    await dialog.locator('summary').click();
    await expect(dialog).toContainText('COMMAND_FINISHED');
    await page.screenshot({path:info.outputPath('04-reconnected.png')});
    await dialog.getByRole('button',{name:'關閉背景命令'}).click();
    await answer.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    expect(errors).toEqual([]);
  } finally {
    await queue.stopProcessingLoop({ timeoutMs: 5000 });
    (await import('../../src/web/push.js')).stopPush();
    server.closeAllConnections();
    server.close();
    db.closeDb();
    rmSync(root, { recursive: true, force: true });
  }
});
