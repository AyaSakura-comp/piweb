import { test, expect, type Locator } from 'playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

async function clickReachable(locator: Locator) {
  await expect(locator).toBeVisible();
  expect(
    await locator.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === element || Boolean(hit && element.contains(hit));
    }),
  ).toBe(true);
  await locator.click();
}

// Real web API → SQLite → message/control loops → tmux → Claude → SSE.
// Explicit opt-in, disposable data, no production service restart. API login is
// performed before video navigation so credentials never appear on screen.
test.use({ trace: 'off', video: { mode: 'on', size: { width: 390, height: 844 } } });
test('real Claude bridge mobile tools, stop, continuation, resume and reload', async ({
  page,
  context,
}, info) => {
  test.skip(process.env.PIWEB_CLAUDE_E2E_LIVE !== '1', 'Opt-in real Claude inference');
  const model = process.env.PIWEB_CLAUDE_E2E_MODEL || 'haiku';
  expect(['haiku', 'sonnet', 'opus']).toContain(model);
  const modelRef = `claude-code/${model}`;
  const turnTimeout = model === 'haiku' ? 60000 : 120000;
  test.setTimeout(turnTimeout * 4 + 60000);
  const root = mkdtempSync(join(tmpdir(), 'piweb-claude-e2e-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const token = randomBytes(32).toString('hex');
  const env = {
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
    PI_THINKING: model === 'haiku' ? 'off' : 'medium',
    PI_CWD: cwd,
    RPC_STEER: 'false',
    AGY_ENABLED: 'false',
    CLAUDE_TMUX_ENABLED: 'true',
    CLAUDE_TMUX_TURN_TIMEOUT_MS: String(turnTimeout),
    POLL_INTERVAL_MS: '50',
    STREAM_TOOLS: 'true',
    STREAM_THINKING: 'true',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const db = await import('../../src/db.js');
  db.initDb();
  const bridge = await import('../../src/agent/claude-tmux.js');
  db.setMeta('models', JSON.stringify(bridge.listClaudeTmuxModels(true)));
  (await import('../../src/transport/index.js')).setTransport(
    (await import('../../src/transport/web.js')).webTransport,
  );
  const queue = await import('../../src/agent/queue.js');
  const control = await import('../../src/worker/control.js');
  queue.startProcessingLoop();
  control.startControlLoop();
  const server = (await import('../../src/web/server.js')).startWebServer();
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${port}`;
  let folder: string | undefined;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const metrics: Record<string, unknown> = {
    viewport: { width: 390, height: 844 },
    mode: 'isolated-real-web-worker-claude',
    requestedModel: modelRef,
    thinking: env.PI_THINKING,
  };
  try {
    expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(
      true,
    );
    const created = await context.request.post(origin + '/api/sessions', {
      headers: { Origin: origin },
      data: { name: `Claude ${model} live verification` },
    });
    expect(created.ok()).toBe(true);
    const session = await created.json();
    folder = db.getChannel(session.jid)!.folder;
    await page.addInitScript(() => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem('piweb.theme', 'dark');
    });
    await page.goto(origin + '/?session=' + encodeURIComponent(session.jid));
    const input = page.locator('#input');
    const send = page.locator('#btn-send');
    const stop = page.locator('#btn-stop');
    await expect(input).toBeVisible();
    await clickReachable(page.getByRole('button', { name: 'Choose model' }));
    await clickReachable(page.locator('.model-item').filter({ hasText: modelRef }));
    await expect(page.locator('#header-badge')).toHaveText(model.toUpperCase());
    await page.screenshot({ path: info.outputPath('01-real-ready.png') });
    await input.fill(
      'Use Bash to write the text 橋接測試_OK into result.txt in this working directory. Then use Read to verify that file. Remember the code ORCHID_42 only in this conversation for the next turn; do not write any memory files. Finally reply exactly LIVE_BRIDGE_OK. Do not use subagents.',
    );
    await clickReachable(send);
    await expect(stop).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.event.tool').first()).toBeVisible({ timeout: turnTimeout });
    await page.screenshot({ path: info.outputPath('02-real-tool.png') });
    const answers = page.locator('#messages > .msg:not(.msg-user)');
    const firstAnswer = answers.filter({ hasText: 'LIVE_BRIDGE_OK' });
    await expect(firstAnswer).toBeVisible({ timeout: turnTimeout });
    await firstAnswer.scrollIntoViewIfNeeded();
    await expect(firstAnswer).toBeInViewport();
    await expect(stop).toBeHidden();
    expect(readFileSync(join(cwd, 'result.txt'), 'utf8')).toContain('橋接測試_OK');
    expect(db.getRecentWebEvents(session.jid, 200).some((e) => e.kind === 'tool_result')).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('03-real-file-verified.png') });
    await page.waitForTimeout(1000); // readable milestone in the continuous recording
    const beforeTools = await page.locator('.event.tool').count();
    await input.fill(
      'Benchmark Python integer addition throughput for 20 seconds. Use Bash with run_in_background=false and timeout=30000 to run python3 -u with a loop that increments an integer until time.monotonic() reaches start+20, then prints the iteration count. Print BENCHMARK_RUNNING before the loop. Do not sleep, use other tools, write files, or delegate. Finally reply BENCHMARK_COMPLETE.',
    );
    await clickReachable(send);
    await expect
      .poll(() => page.locator('.event.tool').count(), { timeout: turnTimeout })
      .toBeGreaterThan(beforeTools);
    await page.locator('.event.tool').last().scrollIntoViewIfNeeded();
    await expect(page.locator('.event.tool').last()).toBeInViewport();
    await page.screenshot({ path: info.outputPath('04-real-before-stop.png') });
    await clickReachable(stop);
    await expect(stop).toBeHidden({ timeout: 15000 });
    const stopNotice = page.getByText('Aborted the current task.', { exact: false });
    await expect(stopNotice).toBeVisible();
    await stopNotice.scrollIntoViewIfNeeded();
    await expect(stopNotice).toBeInViewport();
    await page.screenshot({ path: info.outputPath('05-real-stopped.png') });
    await input.fill(
      'Reply with exactly AFTER_STOP and the code I asked you to remember. Do not use tools.',
    );
    await clickReachable(send);
    const continued = answers.filter({ hasText: 'AFTER_STOP' });
    await expect(continued).toBeVisible({ timeout: turnTimeout });
    await expect(continued).toContainText('ORCHID_42');
    await continued.scrollIntoViewIfNeeded();
    await expect(continued).toBeInViewport();
    await expect(stop).toBeHidden();
    await page.screenshot({ path: info.outputPath('06-real-continuation.png') });
    const statePath = join(root, 'sessions', folder, 'claude-tmux-session.json');
    const sessionId = JSON.parse(readFileSync(statePath, 'utf8')).sessionId;
    expect(bridge.closeClaudeTmuxSession(folder)).toBe(true);
    await input.fill('Reply with exactly RESUMED and the code you remember. No tools.');
    await clickReachable(send);
    const resumed = answers.filter({ hasText: 'RESUMED' });
    await expect(resumed).toBeVisible({ timeout: turnTimeout });
    await expect(resumed).toContainText('ORCHID_42');
    await resumed.scrollIntoViewIfNeeded();
    await expect(resumed).toBeInViewport();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).sessionId).toBe(sessionId);
    await expect(stop).toBeHidden();
    await page.screenshot({ path: info.outputPath('07-real-resumed.png') });
    await page.reload();
    await expect(answers.filter({ hasText: 'RESUMED' })).toContainText('ORCHID_42');
    await answers.filter({ hasText: 'RESUMED' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('08-real-reloaded.png') });
    await page.waitForTimeout(1500);
    const events = db.getRecentWebEvents(session.jid, 200);
    expect(events.filter((e) => e.kind === 'error')).toEqual([]);
    expect(
      events.filter(
        (e) =>
          e.kind === 'tool_result' && /Blocked:|<tool_use_error>|Error:|failed/i.test(e.content),
      ),
    ).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
    // Verify the upstream model, not merely the model-picker alias/badge.
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const actualModels = [
      ...new Set(
        readFileSync(state.transcriptPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((record) => record.type === 'assistant' && record.message?.model)
          .map((record) => String(record.message.model)),
      ),
    ];
    expect(actualModels.length).toBeGreaterThan(0);
    for (const actual of actualModels) expect(actual.toLowerCase()).toContain(model);
    Object.assign(metrics, {
      passed: true,
      actualModels,
      tools: events.filter((e) => e.kind === 'tool').length,
      durableErrors: [],
      pageErrors,
      consoleErrors,
      fileVerified: true,
      stop: true,
      memoryAfterStop: true,
      resumedSameSession: true,
      reload: true,
    });
  } finally {
    await queue.stopProcessingLoop({ timeoutMs: 5000 });
    await control.stopControlLoop();
    if (folder) bridge.closeClaudeTmuxSession(folder);
    (await import('../../src/web/push.js')).stopPush();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.closeDb();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    writeFileSync(info.outputPath('metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
    await info.attach('metrics', {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    });
  }
});
