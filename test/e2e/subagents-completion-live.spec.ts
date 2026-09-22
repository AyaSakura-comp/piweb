import { expect, test } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
test.use({ trace: 'off' });
const origin = process.env.PIWEB_COMPLETION_URL;
const token = process.env.PIWEB_COMPLETION_TOKEN;
const fixture = process.env.PIWEB_COMPLETION_FIXTURE;
const expected = process.env.PIWEB_COMPLETION_EXPECTED;
test('background workflow survives parent idle and delivers an autonomous final answer', async ({
  page,
  context,
}, info) => {
  test.skip(!origin || !token || !fixture || !expected, 'Opt-in real cloud completion test');
  test.setTimeout(240000);
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(true);
  const response = await context.request.post(origin + '/api/sessions', {
    headers: { Origin: origin! },
    data: { name: 'Background completion regression' },
  });
  expect(response.ok()).toBe(true);
  const parent = await response.json();
  const setting = await context.request.post(
    origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/commands',
    {
      headers: { Origin: origin! },
      data: { command: 'pi model', args: { model: 'openai-codex/gpt-5.6-luna' } },
    },
  );
  expect(setting.ok()).toBe(true);
  await expect
    .poll(
      async () =>
        (await (await context.request.get(origin + '/api/sessions')).json()).sessions.find(
          (s: any) => s.jid === parent.jid,
        )?.model,
    )
    .toBe('openai-codex/gpt-5.6-luna');
  await Promise.all([
    page.waitForRequest((r) => r.url().includes(encodeURIComponent(parent.jid) + '/stream')),
    page.goto(origin + '/?session=' + encodeURIComponent(parent.jid)),
  ]);
  const prompt = `Lifecycle regression. Use native subagents, no shell fallback. Discover models/agents first. Start exactly one async workflowScript, mission:false, with THREE sequential runs.run children (keys batch1,batch2,batch3), agent delegate, model openai-codex/gpt-5.6-luna:low, context fresh. Each child MUST run bash sleep 10, then read ${fixture}, and return its batch key and the file codeword. Read-only; no edits or further agents. Await each child in the workflow; return their outputs together. After launch, immediately end this parent turn with exactly BACKGROUND_STARTED. Do not poll, call bg_wait, read the file yourself, or do other work. Wait for the native completion notification. Only AFTER the full workflow completes, reply with MAIN_RECEIVED followed by the exact file codeword and all three batch keys. Never claim completion before receiving the actual child results.`;
  await page.locator('#input').fill(prompt);
  const sent = page.waitForResponse(
    (r) =>
      r.url().includes(encodeURIComponent(parent.jid) + '/messages') &&
      r.request().method() === 'POST',
  );
  await page.locator('#btn-send').click();
  expect((await sent).ok()).toBe(true);
  const answers = page.locator('#messages .msg:not(.msg-user)');
  await expect(answers.filter({ hasText: 'BACKGROUND_STARTED' })).toBeVisible({ timeout: 90000 });
  const acknowledgedAt = Date.now();
  await answers.filter({ hasText: 'BACKGROUND_STARTED' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('01-parent-returned.png') });
  await page.locator('#btn-more').click();
  await page.locator('#mi-subagents').click();
  const dialog = page.getByRole('dialog', { name: 'Subagents' });
  await expect(dialog.locator('.subagent-row').first()).toBeVisible({ timeout: 30000 });
  await expect(dialog.locator('.subagent-row').first().locator('.subagent-state')).toHaveText(
    'Running',
    { timeout: 15000 },
  );
  await expect(dialog.locator('.subagent-row').first().locator('.subagent-state')).toHaveAttribute(
    'data-tone',
    'running',
  );
  await page.screenshot({ path: info.outputPath('01a-running-first.png') });
  await dialog.locator('.subagent-row').first().click();
  await expect(dialog.locator('.event.tool').first()).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => dialog.evaluate((e) => e.getAnimations({ subtree: true }).length))
    .toBe(0);
  await page.screenshot({ path: info.outputPath('02-background-running.png') });
  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  await expect(dialog).not.toBeVisible();
  const final = page
    .locator('#messages .msg:not(.msg-user):not(.partial)')
    .filter({ hasText: 'MAIN_RECEIVED' });
  await expect(final).toContainText(expected!, { timeout: 150000 });
  await expect(final).toContainText('batch1');
  await expect(final).toContainText('batch2');
  await expect(final).toContainText('batch3');
  const finishedAt = Date.now();
  const inventory = await (
    await context.request.get(
      origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/subagents',
    )
  ).json();
  expect(inventory.children).toHaveLength(3);
  const childProof: { key: string; started: number; finished: number; model: string }[] = [];
  for (const child of inventory.children) {
    expect(child.model).toBe('openai-codex/gpt-5.6-luna');
    expect(child.state).toBe('Response complete');
    expect(child.running).toBe(false);
    const detail = await (
      await context.request.get(
        origin +
          '/api/sessions/' +
          encodeURIComponent(parent.jid) +
          '/subagents?scope=' +
          inventory.scope +
          '&child=' +
          child.id,
      )
    ).json();
    const events = detail.events;
    expect(events.some((e: any) => e.kind === 'tool' && e.role === 'read')).toBe(true);
    expect(
      events.some(
        (e: any) => e.kind === 'tool' && e.role === 'bash' && /sleep\s+10/.test(e.content),
      ),
    ).toBe(true);
    const answer = events.filter((e: any) => e.kind === 'message' && e.role === 'assistant').at(-1);
    expect(answer.content).toContain(expected!);
    const key = answer.content.match(/batch[123]/)?.[0];
    expect(key).toBeTruthy();
    childProof.push({
      key,
      started: Date.parse(events[0].createdAt),
      finished: Date.parse(answer.createdAt),
      model: child.model,
    });
  }
  childProof.sort((a, b) => a.started - b.started);
  expect(childProof.map((c) => c.key)).toEqual(['batch1', 'batch2', 'batch3']);
  expect(childProof[1].started).toBeGreaterThanOrEqual(childProof[0].finished);
  expect(childProof[2].started).toBeGreaterThanOrEqual(childProof[1].finished);
  expect(finishedAt).toBeGreaterThanOrEqual(childProof[2].finished);
  expect(finishedAt - acknowledgedAt).toBeGreaterThan(5000);
  await expect(final).toHaveCount(1);
  await final.scrollIntoViewIfNeeded();
  await expect(final).toBeInViewport();
  await page.screenshot({ path: info.outputPath('03-autonomous-main-result.png') });
  await page.goto(origin + '/?session=' + encodeURIComponent(parent.jid));
  await expect(answers.filter({ hasText: 'MAIN_RECEIVED' })).toHaveCount(1, { timeout: 15000 });
  await answers.filter({ hasText: 'MAIN_RECEIVED' }).scrollIntoViewIfNeeded();
  await expect(answers.filter({ hasText: 'MAIN_RECEIVED' })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('04-persisted-result.png') });
  expect(errors).toEqual([]);
  await writeFile(
    info.outputPath('metrics.json'),
    JSON.stringify(
      {
        parent: parent.jid,
        acknowledgedAt,
        finishedAt,
        elapsedAfterAckMs: finishedAt - acknowledgedAt,
        errors,
        childProof,
        expectedModel: 'openai-codex/gpt-5.6-luna',
        autonomousReplyCount: 1,
      },
      null,
      2,
    ),
  );
});
