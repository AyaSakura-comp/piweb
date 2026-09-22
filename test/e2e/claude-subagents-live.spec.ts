import { test, expect, type Locator } from 'playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

async function clickReachable(target: Locator) {
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return (
          r.width >= 44 &&
          r.height >= 44 &&
          (hit === element || Boolean(hit && element.contains(hit)))
        );
      }),
    )
    .toBe(true);
  await target.click();
}
test.use({ trace: 'off', video: { mode: 'on', size: { width: 390, height: 844 } } });
test('real Claude Opus parent exposes two background children and receives their final results', async ({
  page,
  context,
}, info) => {
  test.skip(process.env.PIWEB_CLAUDE_SUBAGENTS_LIVE !== '1', 'Opt-in fixture subagent inference');
  test.setTimeout(240000);
  const childModel = process.env.PIWEB_CLAUDE_CHILD_MODEL || 'haiku';
  expect(['haiku', 'sonnet', 'opus']).toContain(childModel);
  const root = mkdtempSync(join(tmpdir(), 'piweb-claude-subagents-live-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'alpha.txt'), 'ALPHA_CHILD_42\n');
  writeFileSync(join(cwd, 'beta.txt'), 'BETA_CHILD_84\n');
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
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
    PI_MODEL: 'claude-code/opus',
    PI_THINKING: 'medium',
    PI_CWD: cwd,
    RPC_STEER: 'false',
    AGY_ENABLED: 'false',
    CLAUDE_TMUX_ENABLED: 'true',
    CLAUDE_TMUX_TURN_TIMEOUT_MS: '180000',
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
  if (!server.listening) await new Promise<void>((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${port}`;
  let folder: string | undefined;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const metrics: Record<string, unknown> = {
    passed: false,
    viewport: '390x844',
    integration: 'real web + queue + Claude Opus parent + two fixture children',
    requestedParent: 'claude-code/opus',
    requestedChildModel: childModel,
  };
  try {
    expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(
      true,
    );
    const created = await context.request.post(origin + '/api/sessions', {
      headers: { Origin: origin },
      data: { name: 'Claude subagent integration' },
    });
    expect(created.ok()).toBe(true);
    const session = await created.json();
    folder = db.getChannel(session.jid)!.folder;
    const endpoint = origin + '/api/sessions/' + encodeURIComponent(session.jid);
    await context.request.post(endpoint + '/commands', {
      headers: { Origin: origin },
      data: { command: 'pi model', args: { model: 'claude-code/opus' } },
    });
    // The create endpoint enqueues pi new before this model command. Observe its
    // acknowledgement before racing the first message against startup controls.
    await expect.poll(() => db.getChannel(session.jid)?.modelOverride).toBe('claude-code/opus');
    await page.addInitScript(() => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem('piweb.theme', 'dark');
    });
    await page.goto(origin + '/?session=' + encodeURIComponent(session.jid));
    await expect(page.locator('#input')).toBeVisible();
    await page
      .locator('#input')
      .fill(
        `Subagent viewer integration test. Use exactly TWO Agent tool calls in parallel, each general-purpose with model ${childModel} and run_in_background=true. Descriptions must be "Claude reader A" and "Claude reader B". Each child must first use Bash to benchmark Python integer addition for 8 seconds using a time.monotonic bounded loop (not sleep), then use Read: A reads alpha.txt and B reads beta.txt in this workspace. Each replies CHILD_A_DONE or CHILD_B_DONE plus the file content. Do not modify files, write memory, use other agents, or delegate further. Wait for their automatic completion notifications (no polling), then your final reply must contain PARENT_CHILDREN_DONE and both child results. An acknowledgement is not the final result.`,
      );
    await clickReachable(page.locator('#btn-send'));
    await page.locator('#btn-more').click();
    await clickReachable(page.locator('#mi-subagents'));
    const dialog = page.getByRole('dialog', { name: 'Subagents' });
    await expect(dialog.locator('.subagent-row')).toHaveCount(2, { timeout: 120000 });
    const childA = dialog.locator('.subagent-row').filter({ hasText: 'Claude reader A' });
    const childB = dialog.locator('.subagent-row').filter({ hasText: 'Claude reader B' });
    await expect(childA).toContainText('CLAUDE');
    await expect(childB).toContainText('CLAUDE');
    await expect(dialog.locator('[data-tone="running"]').first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: info.outputPath('01-claude-children-running.png') });
    await clickReachable(childA);
    await expect(dialog.locator('.subagents-note')).toContainText('CLAUDE');
    await expect(dialog.locator('.event.tool').first()).toBeVisible({ timeout: 60000 });
    await page.screenshot({ path: info.outputPath('02-child-a-tools.png') });
    const first = dialog.locator('.msg:not(.msg-user)').filter({ hasText: 'CHILD_A_DONE' });
    await expect(first).toContainText('ALPHA_CHILD_42', { timeout: 120000 });
    await first.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('03-child-a-final.png') });
    await clickReachable(dialog.getByRole('button', { name: 'Back to subagents' }));
    await clickReachable(childB);
    const second = dialog.locator('.msg:not(.msg-user)').filter({ hasText: 'CHILD_B_DONE' });
    await expect(second).toContainText('BETA_CHILD_84', { timeout: 120000 });
    await second.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('04-child-b-final.png') });
    await clickReachable(dialog.getByRole('button', { name: 'Close subagents' }));
    const answer = page
      .locator('#messages > .msg:not(.msg-user)')
      .filter({ hasText: 'PARENT_CHILDREN_DONE' });
    await expect(answer).toContainText('ALPHA_CHILD_42', { timeout: 120000 });
    await expect(answer).toContainText('BETA_CHILD_84');
    await expect(page.locator('#btn-stop')).toBeHidden();
    await answer.scrollIntoViewIfNeeded();
    await expect(answer).toBeInViewport();
    await page.screenshot({ path: info.outputPath('05-parent-final.png') });
    await page.waitForTimeout(1200);
    await page.reload();
    await page.locator('#btn-more').click();
    await page.locator('#mi-subagents').click();
    await expect(dialog.locator('.subagent-row')).toHaveCount(2);
    await expect(dialog.locator('[data-tone="running"]')).toHaveCount(0);
    await dialog.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    await page.screenshot({ path: info.outputPath('06-reloaded-children.png') });
    await page.waitForTimeout(1000); // Hold the settled reloaded inventory in the video.
    const projection = await context.request.get(endpoint + '/subagents');
    expect(projection.ok()).toBe(true);
    const data = await projection.json();
    expect(data.children.every((c: any) => c.source === 'claude-code' && c.running === false)).toBe(
      true,
    );
    expect(data.children).toHaveLength(2);
    for (const child of data.children) {
      expect(child.model.toLowerCase()).toContain(childModel);
      const detail = await context.request.get(
        endpoint + '/subagents?' + new URLSearchParams({ scope: data.scope, child: child.id }),
      );
      expect(detail.ok()).toBe(true);
      expect((await detail.json()).events.filter((event: any) => event.kind === 'error')).toEqual(
        [],
      );
    }
    const state = JSON.parse(
      readFileSync(join(root, 'sessions', folder, 'claude-tmux-session.json'), 'utf8'),
    );
    const parentModels = [
      ...new Set(
        readFileSync(state.transcriptPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((row) => row.type === 'assistant' && !row.isSidechain && row.message?.model)
          .map((row) => String(row.message.model)),
      ),
    ];
    expect(parentModels.length).toBeGreaterThan(0);
    for (const model of parentModels) expect(model.toLowerCase()).toContain('opus');
    expect(db.getRecentWebEvents(session.jid, 300).filter((e) => e.kind === 'error')).toEqual([]);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
    Object.assign(metrics, {
      passed: true,
      children: data.children,
      parentModels,
      errors,
      parentContinuation: true,
      reload: true,
    });
  } finally {
    await queue.stopProcessingLoop({ timeoutMs: 5000 });
    await control.stopControlLoop();
    if (folder) bridge.closeClaudeTmuxSession(folder);
    (await import('../../src/web/push.js')).stopPush();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.closeDb();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    writeFileSync(info.outputPath('metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  }
});
