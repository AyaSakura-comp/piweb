import { expect, test, type Locator } from 'playwright/test';
import { writeFile } from 'node:fs/promises';

// Explicit opt-in: deployed PiWeb plus real AGY cloud inference.
// Authentication must never be stored in traces, screenshots, source, or reports.
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
          width: rect.width,
          height: rect.height,
          reachable: hit === element || Boolean(hit && element.contains(hit)),
          blocker: hit instanceof HTMLElement ? hit.id || hit.tagName : null,
        };
      }),
    )
    .toMatchObject({ reachable: true });
}

test('real AGY child progress and transcript are visible from deployed PiWeb', async ({
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

  const login = await context.request.post(origin + '/api/login', { data: { token } });
  expect(login.ok()).toBe(true);
  const created = await context.request.post(origin + '/api/sessions', {
    headers: { Origin: origin! },
    data: { name: 'AGY subagent video evidence' },
  });
  expect(created.ok()).toBe(true);
  const parent = await created.json();

  const selected = await context.request.post(
    origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/commands',
    {
      headers: { Origin: origin! },
      data: { command: 'pi model', args: { model } },
    },
  );
  expect(selected.ok()).toBe(true);
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
  await expect(page.locator('#input')).toBeVisible();
  await expect(page.locator('#header-badge')).toHaveText('AGY');
  await page.screenshot({ path: info.outputPath('00-agy-ready.png') });

  const prompt =
    'Live PiWeb observability test. Use invoke_subagent exactly once to launch one child with role "AGY video witness". The child must synchronously read /home/chihmin/src/piweb/package.json and return a Markdown heading "AGY child verified", the exact package name, and exact token AGY-PIWEB-42. Do not use schedule, background commands, or delayed callbacks. Do not modify files. Wait for the child result and then include the heading, package name, and token in your own main-agent reply before ending this turn.';
  await page.locator('#input').fill(prompt);
  await reachable(page.locator('#btn-send'));
  const submitted = page.waitForResponse(
    (response) =>
      response.url().includes(encodeURIComponent(parent.jid) + '/messages') &&
      response.request().method() === 'POST',
  );
  await page.locator('#btn-send').click();
  expect((await submitted).ok()).toBe(true);
  await expect(page.locator('#messages')).toContainText('Live PiWeb observability test');

  const activity = page.locator('details.event.tool').filter({ hasText: 'invoke_subagent' });
  await expect(activity).toBeVisible({ timeout: 120_000 });
  await activity.locator('summary').click();
  await expect(activity).toContainText('AGY video witness');
  await page.screenshot({ path: info.outputPath('01-agy-child-active.png') });

  await page.locator('#btn-more').click();
  await reachable(page.locator('#mi-subagents'));
  await page.locator('#mi-subagents').click();
  const dialog = page.getByRole('dialog', { name: 'Subagents' });
  await expect(dialog).toBeVisible();
  const child = dialog.locator('.subagent-row').filter({ hasText: 'AGY video witness' });
  await expect(child).toBeVisible({ timeout: 150_000 });
  await expect(child).toContainText('AGY');
  await page.screenshot({ path: info.outputPath('02-agy-child-list.png') });

  await reachable(child);
  await child.click();
  await expect(dialog.locator('.subagents-note')).toContainText('AGY');
  const childDelivery = dialog.locator('.event.tool').filter({ hasText: 'send_message' });
  await expect(childDelivery).toBeVisible({ timeout: 90_000 });
  await childDelivery.locator('summary').click();
  await expect(childDelivery).toContainText('AGY-PIWEB-42');
  await expect(childDelivery).toContainText('AGY child verified');
  const childAnswer = dialog.locator('.msg:not(.msg-user)').last();
  await expect(childAnswer).toBeVisible();
  await expect(childAnswer).toContainText('piweb');
  await expect(childAnswer).toContainText(/parent agent|main agent/i);
  await page.screenshot({ path: info.outputPath('03-agy-child-transcript.png') });
  await page.waitForTimeout(800);

  const projection = await context.request.get(
    origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/subagents',
  );
  expect(projection.ok()).toBe(true);
  const inventory = await projection.json();
  expect(inventory.children).toHaveLength(1);
  expect(inventory.children[0]).toMatchObject({ source: 'agy' });

  await dialog.getByRole('button', { name: 'Close subagents' }).click();
  await expect(dialog).not.toBeVisible();
  const parentAnswer = page
    .locator('#messages > .msg:not(.msg-user)')
    .filter({ hasText: 'AGY-PIWEB-42' });
  await expect(parentAnswer).toBeVisible({ timeout: 90_000 });
  await expect(parentAnswer).toContainText('AGY child verified');
  await parentAnswer.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('04-parent-result.png') });
  await page.waitForTimeout(1_200); // Keep the returned main-agent update visible in the video.

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
        children: inventory.children,
        consoleAndPageErrors: errors,
        failedRequests,
        horizontalOverflow: false,
        inference:
          'Real AGY invoke_subagent through deployed PiWeb; no API fixture or mocked events',
      },
      null,
      2,
    ),
  );
});
