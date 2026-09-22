import { test, expect } from 'playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

// Production smoke is explicitly opt-in. It creates only its own disposable
// session/workspace, never changes existing sessions or restarts services.
test.use({ trace: 'off', video: { mode: 'on', size: { width: 390, height: 844 } } });
test('deployed HTTPS Claude Opus: tools, Stop, memory and reload', async ({
  page,
  context,
}, info) => {
  test.skip(process.env.PIWEB_DEPLOY_SMOKE !== '1', 'Explicit production deployment smoke');
  test.setTimeout(300000);
  const origin = process.env.PIWEB_E2E_LIVE_URL!;
  const token = process.env.PIWEB_E2E_TOKEN!;
  expect(origin).toMatch(/^https:\/\//);
  expect(token).toBeTruthy();
  const cwd = mkdtempSync(join(tmpdir(), 'piweb-deployed-opus-'));
  let jid: string | undefined;
  let folder: string | undefined;
  let passed = false;
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const metrics: Record<string, unknown> = { deployed: true, model: 'claude-code/opus', cwd };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const { closeClaudeTmuxSession } = await import('../../src/agent/claude-tmux.js');
  try {
    expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(
      true,
    );
    const catalog = await context.request.get(origin + '/api/models');
    expect((await catalog.json()).models.some((m: any) => m.ref === 'claude-code/opus')).toBe(true);
    const created = await context.request.post(origin + '/api/sessions', {
      headers: { Origin: origin },
      data: { name: 'Opus deployment smoke' },
    });
    expect(created.ok()).toBe(true);
    jid = (await created.json()).jid;
    const db = new Database(process.env.DB_PATH!, { readonly: true });
    try {
      folder = (
        db.prepare('select folder from channels where jid=?').get(jid) as { folder: string }
      ).folder;
    } finally {
      db.close();
    }
    const sessionUrl = origin + '/api/sessions/' + encodeURIComponent(jid!);
    for (const [command, args] of [
      ['pi cwd', { path: cwd }],
      ['pi thinking', { level: 'medium' }],
    ] as const) {
      expect(
        (
          await context.request.post(sessionUrl + '/commands', {
            headers: { Origin: origin },
            data: { command, args },
          })
        ).ok(),
      ).toBe(true);
    }
    await expect
      .poll(
        async () => {
          const result = await context.request.get(origin + '/api/sessions');
          return (await result.json()).sessions.find((s: any) => s.jid === jid)?.cwd;
        },
        { timeout: 30000 },
      )
      .toBe(cwd);
    await page.addInitScript(() => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem('piweb.theme', 'dark');
    });
    await page.goto(origin + '/?session=' + encodeURIComponent(jid!));
    await page.getByRole('button', { name: 'Choose model' }).click();
    await page.locator('.model-item').filter({ hasText: 'claude-code/opus' }).click();
    await expect(page.locator('#header-badge')).toHaveText('OPUS');
    await page.screenshot({ path: info.outputPath('01-deployed-opus.png') });
    const input = page.locator('#input');
    const send = page.locator('#btn-send');
    const stop = page.locator('#btn-stop');
    const answers = page.locator('#messages > .msg:not(.msg-user)');
    await input.fill(
      'Use Bash to write 部署測試_OK to result.txt in the current working directory, then Read to verify it. Remember DEPLOY_ORCHID_42 only in this conversation, do not write memory files. Reply DEPLOY_OPUS_OK. No subagents.',
    );
    await send.click();
    const first = answers.filter({ hasText: 'DEPLOY_OPUS_OK' });
    await expect(first).toBeVisible({ timeout: 120000 });
    await expect(stop).toBeHidden();
    expect(readFileSync(join(cwd, 'result.txt'), 'utf8')).toContain('部署測試_OK');
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeInViewport();
    await page.screenshot({ path: info.outputPath('02-deployed-tools.png') });
    const before = await page.locator('.event.tool').count();
    await input.fill(
      'Benchmark Python integer addition throughput for 20 seconds. Use Bash with run_in_background=false and timeout=30000, python3 -u and a loop incrementing an integer until time.monotonic() reaches start+20, then print the count. Print RUNNING before the loop. No sleep, files, other tools or delegation.',
    );
    await send.click();
    await expect
      .poll(() => page.locator('.event.tool').count(), { timeout: 120000 })
      .toBeGreaterThan(before);
    await stop.click();
    await expect(stop).toBeHidden({ timeout: 15000 });
    const notice = page.getByText('Aborted the current task.', { exact: false });
    await expect(notice).toBeVisible();
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('03-deployed-stop.png') });
    await input.fill(
      'Reply exactly DEPLOY_CONTINUED followed by the code I asked you to remember. No tools.',
    );
    await send.click();
    const continued = answers.filter({ hasText: 'DEPLOY_CONTINUED' });
    await expect(continued).toContainText('DEPLOY_ORCHID_42', { timeout: 120000 });
    await expect(stop).toBeHidden();
    await continued.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('04-deployed-continuation.png') });
    await page.reload();
    await expect(answers.filter({ hasText: 'DEPLOY_CONTINUED' })).toContainText('DEPLOY_ORCHID_42');
    await answers.filter({ hasText: 'DEPLOY_CONTINUED' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('05-deployed-reload.png') });
    await page.waitForTimeout(1200);
    const state = JSON.parse(
      readFileSync(join(process.env.SESSIONS_DIR!, folder!, 'claude-tmux-session.json'), 'utf8'),
    );
    const actualModels = [
      ...new Set(
        readFileSync(state.transcriptPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((r) => r.type === 'assistant' && r.message?.model)
          .map((r) => String(r.message.model)),
      ),
    ];
    expect(actualModels.length).toBeGreaterThan(0);
    for (const model of actualModels) expect(model.toLowerCase()).toContain('opus');
    const response = await context.request.get(sessionUrl + '/events?limit=200');
    const events = (await response.json()).events;
    expect(events.filter((e: any) => e.kind === 'error')).toEqual([]);
    expect(
      events.filter(
        (e: any) =>
          e.kind === 'tool_result' && /Blocked:|<tool_use_error>|Error:|failed/i.test(e.content),
      ),
    ).toEqual([]);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    passed = true;
    Object.assign(metrics, {
      passed,
      actualModels,
      pageErrors: errors,
      consoleErrors,
      jid,
      tools: true,
      stop: true,
      memory: true,
      reload: true,
    });
  } finally {
    // Stop only failed/in-flight test work; do not enqueue a new control before
    // deleting a successful idle session, which would race deletion ownership.
    if (jid) {
      if (!passed) {
        await context.request
          .post(origin + '/api/sessions/' + encodeURIComponent(jid) + '/commands', {
            headers: { Origin: origin },
            data: { command: 'pi stop', args: {} },
          })
          .catch(() => undefined);
      }
      if (folder) closeClaudeTmuxSession(folder);
      if (passed) {
        await expect
          .poll(
            async () =>
              (
                await context.request.delete(origin + '/api/sessions/' + encodeURIComponent(jid!), {
                  headers: { Origin: origin },
                })
              ).status(),
            { timeout: 15000 },
          )
          .toBe(200);
      }
    }
    if (passed) rmSync(cwd, { recursive: true, force: true });
    writeFileSync(
      info.outputPath('metrics.json'),
      JSON.stringify({ ...metrics, passed }, null, 2) + '\n',
    );
  }
});
