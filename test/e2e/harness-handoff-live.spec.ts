import { expect, test, type Locator } from 'playwright/test';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Opt-in only: a disposable local PiWeb with real Claude Code + AGY credentials.
const origin = process.env.PIWEB_HANDOFF_LIVE_URL;
const token = process.env.PIWEB_HANDOFF_LIVE_TOKEN;
test.use({ trace: 'off' });

async function reachable(target: Locator) {
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === element || Boolean(hit && element.contains(hit));
      }),
    )
    .toBe(true);
}

test('mobile Opus → Gemini → Opus transfers only observable dialogue', async ({
  page,
  context,
}, info) => {
  test.skip(!origin || !token, 'Requires disposable local PIWEB_HANDOFF_LIVE_URL/TOKEN');
  test.setTimeout(420_000);
  page.setDefaultTimeout(25_000);
  const pageErrors: string[] = [];
  const requestErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') pageErrors.push(e.text());
  });
  page.on('requestfailed', (r) => requestErrors.push(r.url()));
  expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(true);
  const created = await context.request.post(origin + '/api/sessions', {
    data: { name: 'Disposable Opus Gemini handoff video' },
  });
  expect(created.ok()).toBe(true);
  const { jid } = await created.json();
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const code = `CEDAR-${suffix}`;
  const geminiMarker = `GEMINI_SIGNED_${suffix}`;
  const shots: string[] = [];
  async function shot(name: string) {
    await page.screenshot({ path: info.outputPath(name + '.png') });
    shots.push(name);
  }
  async function selectModel(ref: string) {
    await reachable(page.locator('#btn-model'));
    await page.locator('#btn-model').click();
    await expect(page.locator('#model-sheet')).toBeVisible();
    await page.locator('#model-search').fill(ref);
    const model = page.locator('.model-item').filter({ hasText: ref });
    await expect(model).toHaveCount(1, { timeout: 45_000 });
    await reachable(model);
    await model.click();
    await expect(page.locator('#model-sheet')).not.toBeVisible();
  }
  async function send(text: string) {
    await page.locator('#input').fill(text);
    await reachable(page.locator('#btn-send'));
    const submitted = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && r.url().endsWith(encodeURIComponent(jid) + '/messages'),
    );
    await page.locator('#btn-send').click();
    expect((await submitted).ok()).toBe(true);
  }
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto(origin + '/?session=' + encodeURIComponent(jid));
  await expect(page.locator('#input')).toBeVisible();
  await shot('00-disposable-session');
  await selectModel('claude-code/opus');
  await expect(page.locator('#header-badge')).toHaveText('OPUS');
  await shot('01-opus-selected');
  await send(
    `No tools or files. Remember this exact code: ${code}. Reply exactly OPUS_READY ${code}.`,
  );
  const opusFirst = page
    .locator('#messages > .msg:not(.msg-user)')
    .filter({ hasText: `OPUS_READY ${code}` });
  await expect(opusFirst).toBeVisible({ timeout: 120_000 });
  await opusFirst.scrollIntoViewIfNeeded();
  await shot('02-opus-answered');

  await selectModel('agy/gemini-3.1-pro-high');
  await expect(page.locator('#header-badge')).toHaveText('AGY');
  await shot('03-gemini-selected');
  await send(
    `No tools or files. What exact code did Opus receive in the previous turn? Answer GEMINI_SAW <code>, then add the phrase ${geminiMarker}. Say UNKNOWN if the previous turn is unavailable.`,
  );
  const gemini = page
    .locator('#messages > .msg:not(.msg-user)')
    .filter({ hasText: `GEMINI_SAW ${code}` });
  await expect(gemini).toBeVisible({ timeout: 180_000 });
  await expect(gemini).toContainText(geminiMarker);
  await gemini.scrollIntoViewIfNeeded();
  await shot('04-gemini-inherited-opus');

  await selectModel('claude-code/opus');
  await expect(page.locator('#header-badge')).toHaveText('OPUS');
  await shot('05-opus-selected-again');
  await send(
    'No tools or files. What exact GEMINI_SIGNED_ phrase did Gemini use in its immediately previous answer? Reply with that phrase, or UNKNOWN if unavailable.',
  );
  const assistantMessages = page.locator('#messages > .msg:not(.msg-user)');
  await expect(assistantMessages).toHaveCount(3, { timeout: 120_000 });
  const opusReturn = assistantMessages.last();
  await expect(opusReturn).toContainText(geminiMarker);
  await opusReturn.scrollIntoViewIfNeeded();
  await shot('06-opus-inherited-gemini');
  await page.reload();
  await expect(page.locator('#messages > .msg:not(.msg-user)')).toHaveCount(3);
  await expect(page.locator('#messages > .msg:not(.msg-user)').last()).toContainText(geminiMarker);
  await shot('07-reloaded-persisted');
  expect(await page.locator('#messages details.event.error').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(requestErrors).toEqual([]);
  const events = await context.request.get(
    origin + '/api/sessions/' + encodeURIComponent(jid) + '/events?limit=200',
  );
  expect(events.ok()).toBe(true);
  const messages = (await events.json()).events.filter((e: any) => e.kind === 'message');
  const replies = messages.filter((e: any) => e.role === 'assistant').map((e: any) => e.content);
  expect(replies).toHaveLength(3);
  expect(replies[0]).toContain(code);
  expect(replies[1]).toContain(code);
  expect(replies[2]).toContain(geminiMarker);
  await writeFile(
    info.outputPath('metrics.json'),
    JSON.stringify(
      {
        jid,
        modelSequence: ['claude-code/opus', 'agy/gemini-3.1-pro-high', 'claude-code/opus'],
        replies,
        shots,
        pageErrors,
        requestErrors,
        persistedAfterReload: true,
        isolatedLocalFrontend: true,
        realProviders: true,
        viewport: '390x844',
      },
      null,
      2,
    ),
  );
});
