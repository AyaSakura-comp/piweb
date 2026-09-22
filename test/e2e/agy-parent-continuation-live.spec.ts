import { expect, test, type Locator } from 'playwright/test';
import { writeFile } from 'node:fs/promises';

test.use({ trace: 'off' });

const origin = process.env.PIWEB_AGY_LIVE_URL;
const token = process.env.PIWEB_AGY_LIVE_TOKEN;
const model = process.env.PIWEB_AGY_LIVE_MODEL || 'agy/gemini-3.1-pro-low';

async function reachable(target: Locator) {
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          reachable: hit === element || Boolean(hit && element.contains(hit)),
          width: rect.width,
          height: rect.height,
        };
      }),
    )
    .toMatchObject({ reachable: true });
}

test('AGY parent continues with its own tool after the child returns and updates PiWeb', async ({
  page,
  context,
}, info) => {
  test.skip(!origin || !token, 'Requires PIWEB_AGY_LIVE_URL and PIWEB_AGY_LIVE_TOKEN');
  test.setTimeout(300_000);
  page.setDefaultTimeout(20_000);

  const errors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', (request) => failedRequests.push(request.url()));

  expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(true);
  const created = await context.request.post(origin + '/api/sessions', {
    headers: { Origin: origin! },
    data: { name: 'AGY parent continuation evidence' },
  });
  expect(created.ok()).toBe(true);
  const parent = await created.json();
  expect(
    (
      await context.request.post(
        origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/commands',
        {
          headers: { Origin: origin! },
          data: { command: 'pi model', args: { model } },
        },
      )
    ).ok(),
  ).toBe(true);
  await expect
    .poll(async () => {
      const response = await context.request.get(origin + '/api/sessions');
      return (await response.json()).sessions.find((session: any) => session.jid === parent.jid)
        ?.model;
    })
    .toBe(model);

  await Promise.all([
    page.waitForRequest((request) =>
      request.url().includes(encodeURIComponent(parent.jid) + '/stream'),
    ),
    page.goto(origin + '/?session=' + encodeURIComponent(parent.jid)),
  ]);
  await expect(page.locator('#header-badge')).toHaveText('AGY');

  const prompt =
    'Sequential continuation test. First use invoke_subagent exactly once with role "AGY continuation child". The child must synchronously read /home/chihmin/src/piweb/package.json and send you the exact token AGY-CHILD-DONE-42 plus the package name. Do not use schedule, background commands, or delayed callbacks. After and only after you receive that child result, you (the main agent, not another child) must call view_file on /home/chihmin/src/piweb/tsconfig.json. Then reply in this main conversation with the Markdown heading "AGY parent continued", token AGY-CHILD-DONE-42, package name piweb, and compiler target ES2022. Do not end your turn before all steps are complete.';
  await page.locator('#input').fill(prompt);
  await reachable(page.locator('#btn-send'));
  const submitted = page.waitForResponse(
    (response) =>
      response.url().includes(encodeURIComponent(parent.jid) + '/messages') &&
      response.request().method() === 'POST',
  );
  await page.locator('#btn-send').click();
  expect((await submitted).ok()).toBe(true);

  const launch = page.locator('details.event.tool').filter({ hasText: 'invoke_subagent' });
  await expect(launch).toBeVisible({ timeout: 120_000 });
  await launch.locator('summary').click();
  await expect(launch).toContainText('AGY continuation child');
  await page.screenshot({ path: info.outputPath('01-child-launched.png') });
  await page.waitForTimeout(800);

  await page.locator('#btn-more').click();
  await reachable(page.locator('#mi-subagents'));
  await page.locator('#mi-subagents').click();
  const dialog = page.getByRole('dialog', { name: 'Subagents' });
  const child = dialog.locator('.subagent-row').filter({ hasText: 'AGY continuation child' });
  await expect(child).toBeVisible({ timeout: 150_000 });
  await expect(child).toContainText('AGY');
  await child.click();
  const delivery = dialog.locator('.event.tool').filter({ hasText: 'send_message' });
  await expect(delivery).toBeVisible({ timeout: 90_000 });
  await delivery.locator('summary').click();
  await expect(delivery).toContainText('AGY-CHILD-DONE-42');
  await expect(delivery).toContainText('piweb');
  await page.screenshot({ path: info.outputPath('02-child-result.png') });
  await page.waitForTimeout(800);

  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  await expect(dialog).not.toBeVisible();
  const parentTool = page
    .locator('details.event.tool')
    .filter({ hasText: 'view_file' })
    .filter({ hasText: 'tsconfig.json' });
  await expect(parentTool).toBeVisible({ timeout: 120_000 });
  await parentTool.locator('summary').click();
  await expect(parentTool).toContainText('tsconfig.json');
  await parentTool.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('03-parent-continued-tool.png') });
  await page.waitForTimeout(800);

  const answer = page
    .locator('#messages > .msg:not(.msg-user)')
    .filter({ hasText: 'AGY-CHILD-DONE-42' });
  await expect(answer).toBeVisible({ timeout: 120_000 });
  await expect(answer.locator('h1,h2,h3')).toContainText('AGY parent continued');
  await expect(answer).toContainText('piweb');
  await expect(answer).toContainText('ES2022');
  await answer.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('04-main-agent-updated.png') });
  await page.waitForTimeout(1_500);

  const eventsResponse = await context.request.get(
    origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/events?limit=200',
  );
  expect(eventsResponse.ok()).toBe(true);
  const events = (await eventsResponse.json()).events as Array<{
    id: number;
    kind: string;
    role: string;
    content: string;
  }>;
  const launchIndex = events.findIndex(
    (event) => event.kind === 'tool' && event.role === 'invoke_subagent',
  );
  const continueIndex = events.findIndex(
    (event) =>
      event.kind === 'tool' &&
      event.role === 'view_file' &&
      event.content.includes('tsconfig.json'),
  );
  const answerIndex = events.findIndex(
    (event) =>
      event.kind === 'message' &&
      event.role === 'assistant' &&
      event.content.includes('AGY parent continued') &&
      event.content.includes('AGY-CHILD-DONE-42'),
  );
  expect(launchIndex).toBeGreaterThan(-1);
  expect(continueIndex).toBeGreaterThan(launchIndex);
  expect(answerIndex).toBeGreaterThan(continueIndex);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect(failedRequests).toEqual([]);

  await writeFile(
    info.outputPath('metrics.json'),
    JSON.stringify(
      {
        viewport: '390x844',
        parent: parent.jid,
        model,
        sequence: { launchIndex, continueIndex, answerIndex },
        errors,
        failedRequests,
        horizontalOverflow: false,
        inference: 'Real AGY child followed by real main-agent view_file continuation',
      },
      null,
      2,
    ),
  );
});
