import { expect, test, type Locator } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
// RPC login credentials must never enter a Playwright network trace.
test.use({ trace: 'off' });
const measurements: unknown[] = [];
const origin = process.env.PIWEB_SUBAGENTS_LIVE_URL;
const token = process.env.PIWEB_SUBAGENTS_LIVE_TOKEN;
async function reachable(target: Locator) {
  await expect
    .poll(() =>
      target.evaluate((e) => {
        const r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          width: r.width,
          height: r.height,
          reachable: hit === e || (!!hit && e.contains(hit)),
          blocker: hit?.id || hit?.tagName,
        };
      }),
    )
    .toMatchObject({ reachable: true });
  measurements.push(
    await target.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return {
        label: e.getAttribute('aria-label') || e.textContent?.slice(0, 80),
        width: r.width,
        height: r.height,
        reachable: true,
      };
    }),
  );
  // Existing composer Send is a compact baseline control; new viewer controls
  // are checked at 44px in the deterministic test. Do not resize unrelated UI.
}
test('real Luna foreground and background children from PiWeb to history and isolation', async ({
  page,
  context,
}, info) => {
  test.skip(!origin || !token, 'Opt-in disposable real Luna deployment and token required');
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  const login = await context.request.post(origin + '/api/login', { data: { token } });
  expect(login.ok()).toBe(true);
  const create = await context.request.post(origin + '/api/sessions', {
    headers: { Origin: origin! },
    data: { name: 'Luna Subagents evidence' },
  });
  expect(create.ok()).toBe(true);
  const parent = await create.json();
  await Promise.all([
    page.waitForRequest((r) => r.url().includes(encodeURIComponent(parent.jid) + '/stream')),
    page.goto(origin! + '/?session=' + encodeURIComponent(parent.jid)),
  ]);
  await expect(page.locator('#input')).toBeVisible();
  await expect(page.locator('#session-name')).not.toHaveText('no session');
  await page.locator('#btn-more').click();
  await reachable(page.locator('#mi-subagents'));
  await page.locator('#mi-subagents').click();
  const dialog = page.getByRole('dialog', { name: 'Subagents' });
  await expect(dialog).toContainText('No subagents');
  await page.screenshot({ path: info.outputPath('00-empty.png') });
  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  const fixture = process.env.PIWEB_SUBAGENTS_FIXTURE;
  expect(fixture, 'PIWEB_SUBAGENTS_FIXTURE must name a disposable fixture').toBeTruthy();
  const prompt = `Integration test: use the subagent tool to launch exactly TWO native luna-web children, model openai-codex/gpt-5.6-luna:low, context fresh, acceptance {level:"none",reason:"read-only UI integration test"}. First launch async:true task: "BACKGROUND witness: read ${fixture}, say 'Background tool phase', run bash command sleep 25, then return Markdown heading 'Background Luna verified', the token from the file, sum of the numbers, and a JavaScript fenced code block const sum = 42;". Then launch async:false task: "FOREGROUND witness: read ${fixture}, then return Markdown heading 'Foreground Luna verified', token and product of the numbers." Do not use local inference or spawn other agents. Do not modify files. Do not run shell yourself. After those launches acknowledge briefly. Do not poll status or sleep in the parent.`;
  await page.locator('#input').fill(prompt);
  await reachable(page.locator('#btn-send'));
  await page.locator('#btn-send').click();
  await expect(page.locator('#messages')).toContainText('Integration test:');
  await page.locator('#btn-more').click();
  await expect
    .poll(() => page.locator('#more-menu').evaluate((e) => getComputedStyle(e).opacity))
    .toBe('1');
  await reachable(page.locator('#mi-subagents'));
  await page.screenshot({ path: info.outputPath('01-function-menu.png') });
  await page.locator('#mi-subagents').click();
  const background = dialog.locator('.subagent-row').filter({ hasText: 'BACKGROUND' });
  await expect(background).toBeVisible({ timeout: 90000 });
  await expect(background).toContainText('Recorded activity');
  await page.screenshot({ path: info.outputPath('02-live-list.png') });
  await reachable(background);
  await background.click();
  await expect(dialog.locator('.event.tool')).not.toHaveCount(0, { timeout: 30000 });
  await dialog.locator('.event.tool summary').first().click();
  await page.screenshot({ path: info.outputPath('03-live-tools.png') });
  await expect(
    dialog.locator('.msg h1, .msg h2, .msg h3').filter({ hasText: 'Background Luna verified' }),
  ).toBeVisible({ timeout: 90000 });
  await expect(dialog).toContainText('LUNA-WEB-42');
  await expect(dialog.locator('pre code')).toContainText('const sum');
  await expect(dialog.locator('.subagents-note')).toContainText('Response ready');
  await page.screenshot({ path: info.outputPath('04-completed-child.png') });
  await dialog.getByRole('button', { name: 'Back to subagents' }).click();
  await expect(dialog.locator('.subagent-row')).toHaveCount(2, { timeout: 60000 });
  await expect(dialog.locator('.subagent-row').filter({ hasText: 'FOREGROUND' })).toContainText(
    'Response ready',
    { timeout: 60000 },
  );
  await page.screenshot({ path: info.outputPath('05-all-completed.png') });
  const list = await (
    await context.request.get(
      origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/subagents',
    )
  ).json();
  expect(list.children).toHaveLength(2);
  expect(list.children.every((c: any) => c.model === 'openai-codex/gpt-5.6-luna')).toBe(true);
  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  await Promise.all([
    page.waitForRequest((r) => r.url().includes(encodeURIComponent(parent.jid) + '/stream')),
    page.goto(origin! + '/?session=' + encodeURIComponent(parent.jid)),
  ]);
  await expect(page.locator('#input')).toBeVisible();
  await page.locator('#btn-more').click();
  await page.locator('#mi-subagents').click();
  await expect(dialog.locator('.subagent-row')).toHaveCount(2);
  await dialog.locator('.subagent-row').filter({ hasText: 'FOREGROUND' }).click();
  await expect(dialog).toContainText('425');
  await page.screenshot({ path: info.outputPath('06-reconnected-history.png') });
  expect(
    await dialog.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  const otherResponse = await context.request.post(origin + '/api/sessions', {
    headers: { Origin: origin! },
    data: { name: 'Isolation witness' },
  });
  expect(otherResponse.ok()).toBe(true);
  const other = await otherResponse.json();
  await Promise.all([
    page.waitForRequest((r) => r.url().includes(encodeURIComponent(other.jid) + '/stream')),
    page.goto(origin + '/?session=' + encodeURIComponent(other.jid)),
  ]);
  await expect(page.locator('#input')).toBeVisible();
  await page.locator('#btn-more').click();
  await page.locator('#mi-subagents').click();
  await expect(dialog).toContainText('No subagents');
  await expect(dialog).not.toContainText('Luna verified');
  const foreign = await context.request.get(
    origin +
      '/api/sessions/' +
      encodeURIComponent(other.jid) +
      '/subagents?scope=' +
      list.scope +
      '&child=' +
      list.children[0].id,
  );
  expect(foreign.status()).toBe(409);
  await page.screenshot({ path: info.outputPath('07-other-session-isolated.png') });
  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  expect(errors).toEqual([]);
  await writeFile(
    info.outputPath('metrics.json'),
    JSON.stringify(
      {
        viewport: { width: 390, height: 844 },
        parent: parent.jid,
        other: other.jid,
        children: list.children,
        measurements,
        consoleAndPageErrors: errors,
        crossSessionStatus: foreign.status(),
        viewportContained: true,
        horizontalOverflow: false,
        baselineException: 'Existing composer Send is smaller than 44px; no unrelated UI resizing.',
        inference: 'Real openai-codex/gpt-5.6-luna only; foreground and background',
      },
      null,
      2,
    ),
  );
  await info.attach('live-session-identities', {
    body: JSON.stringify(
      {
        parent: parent.jid,
        other: other.jid,
        children: list.children,
        checks: {
          consoleErrors: errors,
          viewport: '390x844',
          crossSessionStatus: foreign.status(),
        },
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
