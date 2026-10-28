import { expect, test, type Locator, type Page } from 'playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

// Real browser → web API → control/message loops → Claude Code's own /btw
// (side_question) beside a running TUI turn → SSE, at phone size, recorded.
// Explicit opt-in, disposable data, no production service touched. Login goes
// through the API before the page opens, so no credential is ever on screen.
test.use({ trace: 'off', video: { mode: 'on', size: { width: 390, height: 844 } } });

async function clickReachable(locator: Locator) {
  await expect(locator).toBeVisible();
  const hit = await locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const point = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return point === element || Boolean(point && element.contains(point));
  });
  expect(hit, 'the control must be reachable by a tap').toBe(true);
  await locator.click();
}

// Opening BTW first reads the side thread from the worker; the composer belongs
// to BTW only once the switch lands (its label says who it sends to).
async function switchTo(page: Page, target: 'btw' | 'main') {
  const name = target === 'btw' ? '開啟 BTW' : '返回主對話';
  await clickReachable(page.getByRole('button', { name }));
  await expect(page.locator('#input')).toHaveAttribute('aria-label', target === 'btw' ? '傳送至 BTW' : 'Message');
  await page.waitForFunction(() => !document.querySelector('.btw-sliding'));
}

test('real Claude BTW: side questions beside a running turn, follow-up, reload, clear', async ({
  page,
  context,
}, info) => {
  test.skip(process.env.PIWEB_CLAUDE_E2E_LIVE !== '1', 'Opt-in real Claude inference');
  const model = process.env.PIWEB_CLAUDE_E2E_MODEL || 'haiku';
  expect(['haiku', 'sonnet', 'opus', 'fable']).toContain(model);
  const modelRef = `claude-code/${model}`;
  const thinking = process.env.PIWEB_CLAUDE_E2E_THINKING || (model === 'haiku' ? 'off' : 'high');
  const turnTimeout = model === 'haiku' ? 90_000 : 180_000;
  test.setTimeout(turnTimeout * 5);
  const root = mkdtempSync(join(tmpdir(), 'piweb-claude-btw-e2e-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  mkdirSync(join(root, 'media', 'piweb-shared'), { recursive: true });
  writeFileSync(join(root, 'media', 'piweb-shared', 'hot-keywords.json'), '{"items":[]}\n');
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
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
    PI_MODEL: modelRef,
    PI_THINKING: thinking,
    PI_CWD: cwd,
    RPC_STEER: 'false',
    AGY_ENABLED: 'false',
    CLAUDE_TMUX_ENABLED: 'true',
    CLAUDE_TMUX_TURN_TIMEOUT_MS: String(turnTimeout),
    POLL_INTERVAL_MS: '50',
    STREAM_TOOLS: 'true',
    STREAM_THINKING: 'true',
  });
  const db = await import('../../src/db.js');
  db.initDb();
  const bridge = await import('../../src/agent/claude-tmux.js');
  db.setMeta('models', JSON.stringify(bridge.listClaudeTmuxModels(true)));
  (await import('../../src/transport/index.js')).setTransport(
    (await import('../../src/transport/web.js')).webTransport,
  );
  (await import('../../src/agent/queue.js')).startProcessingLoop();
  (await import('../../src/worker/control.js')).startControlLoop();
  const server = (await import('../../src/web/server.js')).startWebServer();
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${port}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  const timings: Record<string, number> = {};
  const started = Date.now();
  const btwRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/btw'))
      btwRequests.push(`${Date.now() - started}ms ${request.method()} ${request.postData() ?? ''}`);
  });
  page.on('requestfinished', async (request) => {
    if (request.url().includes('/btw'))
      btwRequests.push(`${Date.now() - started}ms done ${(await request.response())?.status()} ${request.method()}`);
  });
  let folder: string | undefined;
  try {
    expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(true);
    const created = await context.request.post(origin + '/api/sessions', {
      headers: { Origin: origin },
      data: { name: `Claude ${model} BTW live` },
    });
    expect(created.ok()).toBe(true);
    const session = await created.json();
    folder = db.getChannel(session.jid)!.folder;
    await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
    await page.goto(origin + '/?session=' + encodeURIComponent(session.jid));
    const input = page.locator('#input');
    const send = page.locator('#btn-send');
    const sideMessages = page.locator('#btw-messages');
    await expect(input).toBeVisible();
    await clickReachable(page.getByRole('button', { name: 'Choose model' }));
    await clickReachable(page.locator('.model-item').filter({ hasText: modelRef }));
    await expect(page.locator('#header-badge')).toHaveText(model.toUpperCase());

    // 1. Before the first turn there is no conversation to fork: BTW still answers.
    await switchTo(page, 'btw');
    await expect(page.locator('#btw-card')).toBeVisible();
    await input.fill('Reply with exactly FRESH_SIDE_OK and nothing else.');
    let t = Date.now();
    await clickReachable(send);
    await expect(input).toHaveValue('');
    await expect(sideMessages.getByText('FRESH_SIDE_OK', { exact: true })).toBeVisible({ timeout: turnTimeout });
    timings.freshSideSeconds = (Date.now() - t) / 1000;
    await page.screenshot({ path: info.outputPath('01-btw-before-first-turn.png') });
    await switchTo(page, 'main');

    // 2. The main turn: a codeword, then a long tool call that keeps it busy.
    await input.fill(
      'Remember the codeword HERON_58 for this conversation. Use the Bash tool to run exactly: sleep 40 && echo SLEPT_58 . Then reply exactly MAIN_DONE_58. Do not use subagents.',
    );
    await clickReachable(send);
    await expect(page.locator('.event.tool').first()).toBeVisible({ timeout: turnTimeout });
    await expect(page.locator('#typing')).toBeVisible();
    await page.screenshot({ path: info.outputPath('02-main-running.png') });

    // 3. A side question while the tool runs sees the conversation and the command.
    await switchTo(page, 'btw');
    // The thread asked before the first turn is still there.
    await expect(sideMessages).toContainText('FRESH_SIDE_OK');
    await input.fill('BTW: what is the codeword, and what command is the main conversation running right now? One line.');
    t = Date.now();
    await clickReachable(send);
    await expect(sideMessages.locator('.btw-waiting')).toBeVisible();
    await page.screenshot({ path: info.outputPath('03-btw-pending.png') });
    const sideAnswer = sideMessages.locator('.msg:not(.msg-user)').filter({ hasText: 'HERON_58' });
    await expect(sideAnswer).toBeVisible({ timeout: turnTimeout });
    timings.sideSeconds = (Date.now() - t) / 1000;
    await expect(sideAnswer).toContainText(/sleep/i);
    expect(
      (await context.request.get(origin + '/api/sessions')).ok() &&
        db.getChannel(session.jid) !== undefined,
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('04-btw-answered-main-busy.png') });

    // 4. A follow-up sees the earlier side answer.
    await input.fill('Repeat the codeword from your previous side answer, then the word AGAIN_58.');
    t = Date.now();
    await clickReachable(send);
    await expect(sideMessages.locator('.msg:not(.msg-user)').filter({ hasText: 'AGAIN_58' })).toBeVisible({
      timeout: turnTimeout,
    });
    timings.followUpSeconds = (Date.now() - t) / 1000;
    await expect(sideMessages.locator('.msg:not(.msg-user)').filter({ hasText: 'AGAIN_58' })).toContainText('HERON_58');

    // 5. Back to main: the turn finishes normally and never saw the side chat.
    await switchTo(page, 'main');
    // Left at its newest message, the main view comes back there with what
    // arrived meanwhile in view, not under "Jump to present".
    expect(
      await page.locator('#messages').evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight),
    ).toBeLessThan(40);
    await expect(page.locator('#jump-live')).not.toHaveClass(/visible/);
    await page.screenshot({ path: info.outputPath('05-back-in-main.png') });
    // The final reply is exactly the word: an interim reply may name it too
    // ("I'll reply MAIN_DONE_58 once it finishes") while the command runs.
    const finalReply = () =>
      db.getRecentWebEvents(session.jid, 200).some(
        (e) => e.kind === 'message' && e.role === 'assistant' && e.content.trim() === 'MAIN_DONE_58',
      );
    await expect.poll(finalReply, { timeout: turnTimeout }).toBe(true);
    await expect(page.locator('#messages > .msg:not(.msg-user)').last()).toContainText('MAIN_DONE_58');
    await expect(page.locator('#typing')).toBeHidden({ timeout: turnTimeout });
    await page.screenshot({ path: info.outputPath('06-main-done.png') });
    const events = JSON.stringify(db.getRecentWebEvents(session.jid, 500));
    expect(events).not.toContain('AGAIN_58');
    expect(events).not.toContain('FRESH_SIDE_OK');

    // 6. After a reload the side thread is still there; clear empties only it.
    await page.reload();
    await expect(page.locator('#messages')).toContainText('MAIN_DONE_58');
    await switchTo(page, 'btw');
    await expect(sideMessages).toContainText('AGAIN_58');
    await page.screenshot({ path: info.outputPath('07-btw-after-reload.png') });
    page.once('dialog', (dialog) => dialog.accept());
    await clickReachable(page.locator('#btw-clear'));
    await expect(sideMessages).not.toContainText('AGAIN_58');
    await switchTo(page, 'main');
    await expect(page.locator('#messages')).toContainText('MAIN_DONE_58');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    writeFileSync(
      info.outputPath('timings.json'),
      `${JSON.stringify({ model, thinking, ...timings, btwRequests, errors }, null, 2)}\n`,
    );
    if (folder) bridge.closeClaudeTmuxSession(folder);
    // The page's SSE stream would hold close() open until the test timeout.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
