import { expect, test, type Locator } from 'playwright/test';
import { writeFile } from 'node:fs/promises';

// Opt-in production read-only quota query. Credentials must not enter traces.
test.use({ trace: 'off' });
const origin = process.env.PIWEB_USAGE_LIVE_URL;
const token = process.env.PIWEB_USAGE_LIVE_TOKEN;

async function reachable(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === element || Boolean(hit && element.contains(hit));
      }),
    )
    .toBe(true);
}

test('deployed Claude usage button returns real quota for Opus, Sonnet and Haiku', async ({
  page,
  context,
}, info) => {
  test.skip(!origin || !token, 'Requires explicit live URL and token');
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const login = await context.request.post(origin + '/api/login', { data: { token } });
  expect(login.ok()).toBe(true);
  const created = await context.request.post(origin + '/api/sessions', {
    headers: { Origin: origin! },
    data: { name: 'Claude usage verification' },
  });
  expect(created.ok()).toBe(true);
  const parent = await created.json();
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto(origin + '/?session=' + encodeURIComponent(parent.jid));
  await expect(page.locator('#input')).toBeVisible();
  const evidence: { model: string; eventId: number; content: string }[] = [];
  let reportCount = 0;
  for (const [index, model] of ['opus', 'sonnet', 'haiku'].entries()) {
    const modelButton = page.locator('#btn-model');
    await reachable(modelButton);
    await modelButton.click();
    await expect(page.locator('#model-sheet')).toBeVisible();
    await page.locator('#model-search').fill('claude-code/' + model);
    const item = page.locator('.model-item').filter({ hasText: 'claude-code/' + model });
    await expect(item).toHaveCount(1);
    await reachable(item);
    await item.click();
    await expect(page.locator('#model-sheet')).not.toBeVisible();
    const usage = page.locator('#btn-gpt-usage');
    await expect(usage).toHaveAttribute('title', '/claude-usage', { timeout: 20000 });
    await expect(usage).toHaveAttribute('aria-label', 'Show Claude usage');
    await page.screenshot({ path: info.outputPath(`${index * 2 + 1}-${model}-selected.png`) });
    await reachable(usage);
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/commands') &&
        response.request().postDataJSON()?.command === 'claude-usage',
    );
    await usage.click();
    expect((await submitted).ok()).toBe(true);
    const reports = page
      .locator('#messages details.event.system')
      .filter({ hasText: 'Claude current status / usage' });
    await expect(reports).toHaveCount(++reportCount, { timeout: 30000 });
    const report = reports.last();
    await expect(report).toContainText(/目前時段（5 小時）：[0-9.]+% 已使用/);
    await expect(report).toContainText(/本週：[0-9.]+% 已使用/);
    await expect(report).toContainText('重置：');
    await expect(report).not.toContainText('ChatGPT');
    await report.scrollIntoViewIfNeeded();
    await expect(page.locator('#messages .event.error')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${index * 2 + 2}-${model}-usage.png`) });
    await page.waitForTimeout(1200); // Intentional readable report dwell in the continuous video.
    const eventsResponse = await context.request.get(
      origin + '/api/sessions/' + encodeURIComponent(parent.jid) + '/events?limit=100',
    );
    expect(eventsResponse.ok()).toBe(true);
    const events = (await eventsResponse.json()).events;
    const latest = events
      .filter((event: any) => event.kind === 'system' && event.role === 'claude-usage')
      .at(-1);
    expect(latest).toBeTruthy();
    if (evidence.length) expect(latest.id).toBeGreaterThan(evidence.at(-1)!.eventId);
    evidence.push({ model, eventId: latest.id, content: latest.content });
  }
  await page.reload();
  await expect(page.locator('#btn-gpt-usage')).toHaveAttribute('title', '/claude-usage');
  const saved = page
    .locator('#messages details.event.system')
    .filter({ hasText: 'Claude current status / usage' });
  await expect(saved).toHaveCount(3);
  await saved.last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('07-reconnected.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await writeFile(
    info.outputPath('metrics.json'),
    JSON.stringify(
      {
        parent: parent.jid,
        viewport: '390x844',
        reports: evidence,
        browserErrors: errors,
        reloadPersisted: true,
        mockedApi: false,
        modelInference: false,
      },
      null,
      2,
    ),
  );
});
