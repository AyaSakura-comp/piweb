import { expect, test } from 'playwright/test';
import { writeFile } from 'node:fs/promises';

// Explicit opt-in: real Docker web + host worker, real cloud inference.
// Never include auth in traces, screenshots, source, or report.
test.use({ trace: 'off' });
const origin = process.env.PIWEB_SUBAGENTS_LIVE_URL;
const token = process.env.PIWEB_SUBAGENTS_LIVE_TOKEN;
const existing = process.env.PIWEB_SUBAGENTS_EXISTING_SESSION;

test('five real workflow children are browsable through the deployed PiWeb', async ({
  page,
  context,
}, info) => {
  test.skip(
    !origin || !token || !existing,
    'Requires explicit deployed origin, token and witness session',
  );
  test.setTimeout(300000);
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(true);
  const dialog = page.getByRole('dialog', { name: 'Subagents' });
  async function capture(name: string) {
    await expect
      .poll(() => dialog.evaluate((e) => e.getAnimations({ subtree: true }).length))
      .toBe(0);
    await page.screenshot({ path: info.outputPath(name) });
  }
  async function openList(jid: string) {
    await Promise.all([
      page.waitForRequest((r) => r.url().includes(encodeURIComponent(jid) + '/stream')),
      page.goto(origin + '/?session=' + encodeURIComponent(jid)),
    ]);
    await expect(page.locator('#input')).toBeVisible();
    await page.locator('#btn-more').click();
    await page.locator('#mi-subagents').click();
    await expect(dialog).toBeVisible();
  }
  // Original reported failure: exactly five persisted Luna histories existed,
  // but container fallback cwd silently filtered out their parent.
  await openList(existing!);
  await expect(dialog.locator('.subagent-row')).toHaveCount(5, { timeout: 15000 });
  await capture('00-original-five.png');
  for (let i = 0; i < 5; i++) {
    await dialog.locator('.subagent-row').nth(i).click();
    await expect(dialog.locator('.msg, .event').first()).toBeVisible();
    await expect(dialog.locator('.subagents-note')).toContainText('gpt-5.6-luna');
    await dialog.getByRole('button', { name: 'Back to subagents' }).click();
    await expect(dialog.locator('.subagent-row')).toHaveCount(5);
  }
  if (process.env.PIWEB_SUBAGENTS_FIVE_LAUNCH !== '1') return;
  const created = await context.request.post(origin + '/api/sessions', {
    headers: { Origin: origin! },
    data: { name: 'Five Luna regression' },
  });
  expect(created.ok()).toBe(true);
  const parent = await created.json();
  // Session-specific setting only; never change global inference defaults.
  const settings = await context.request.post(
    origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/commands',
    {
      headers: { Origin: origin! },
      data: { command: 'pi model', args: { model: 'openai-codex/gpt-5.6-luna' } },
    },
  );
  expect(settings.ok()).toBe(true);
  await expect
    .poll(async () => {
      const response = await context.request.get(origin + '/api/sessions');
      return (await response.json()).sessions.find((s: any) => s.jid === parent.jid)?.model;
    })
    .toBe('openai-codex/gpt-5.6-luna');
  await openList(parent.jid);
  await expect(dialog).toContainText('No subagents');
  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  await expect(dialog).not.toBeVisible();
  const prompt = `Regression test matching a five-way research delegation. You are explicitly authorized to use subagents. Discover agents/models first. Launch exactly ONE async workflowScript with runs.all for FIVE native scout children, keys A,B,C,D,E, each model openai-codex/gpt-5.6-luna:low, context fresh; mission false, globalConcurrencyLimit 5, no worktree. Each child task is read-only: use read on /home/chihmin/src/piweb/package.json, report the package name, then run bash sleep 8 once to keep the UI observable and return Markdown heading "Witness X" and exact token "FIVE-LUNA-X-42" replacing X with its own key. No other agents, web research, file edits, or local inference. Return all five child results from the workflow. After launching acknowledge briefly and let completion notifications arrive; do not poll. These five distinct child tokens are the acceptance contract.`;
  await page.locator('#input').fill(prompt);
  await expect(page.locator('#input')).toHaveValue(prompt);
  const submitted = page.waitForResponse(
    (r) =>
      r.url().includes(encodeURIComponent(parent.jid) + '/messages') &&
      r.request().method() === 'POST',
  );
  await page.locator('#btn-send').click();
  expect((await submitted).ok()).toBe(true);
  await expect(page.locator('#messages')).toContainText('Regression test matching');
  await page.locator('#btn-more').click();
  await page.locator('#mi-subagents').click();
  await expect(dialog.locator('.subagent-row')).toHaveCount(5, { timeout: 150000 });
  await capture('01-new-five.png');
  const response = await context.request.get(
    origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/subagents',
  );
  const inventory = await response.json();
  expect(inventory.children).toHaveLength(5);
  const witnessed: string[] = [];
  for (let i = 0; i < 5; i++) {
    await dialog.locator('.subagent-row').nth(i).click();
    await expect(dialog.locator('.subagents-note')).toContainText('gpt-5.6-luna');
    await expect(dialog.locator('.event.tool')).not.toHaveCount(0, { timeout: 30000 });
    await dialog.locator('.event.tool summary').first().click();
    // A token in the child's USER task is not execution proof. Require an
    // actual assistant answer plus its rendered heading and persisted state.
    const answerNode = dialog
      .locator('.msg:not(.msg-user)')
      .filter({ hasText: /FIVE-LUNA-[A-E]-42/ });
    await expect(answerNode).toBeVisible({ timeout: 120000 });
    await expect(answerNode.locator('h1,h2,h3')).toContainText(/Witness [A-E]/);
    await expect(dialog.locator('.subagents-note')).toContainText('Response ready');
    const answer = await answerNode.last().innerText();
    witnessed.push(answer.match(/FIVE-LUNA-[A-E]-42/)![0]);
    await capture(`0${i + 2}-child.png`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.getByRole('button', { name: 'Back to subagents' }).click();
    await expect(dialog.locator('.subagent-row')).toHaveCount(5);
  }
  expect(new Set(witnessed).size).toBe(5);
  await openList(parent.jid);
  await expect(dialog.locator('.subagent-row')).toHaveCount(5);
  await capture('07-reconnected-five.png');
  expect(errors).toEqual([]);
  await writeFile(
    info.outputPath('metrics.json'),
    JSON.stringify(
      {
        original: existing,
        parent: parent.jid,
        children: inventory.children,
        witnessed,
        errors,
        viewport: '390x844',
        deployed: origin,
        inference: 'Real five-child GPT Luna workflow; no API mocking',
      },
      null,
      2,
    ),
  );
});
