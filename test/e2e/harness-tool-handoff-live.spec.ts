import { expect, test, type Locator } from 'playwright/test';
import { writeFile } from 'node:fs/promises';

// Real providers; opt in only against a disposable loopback instance.
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

test('mobile real tool history Opus → Gemini → Opus survives switching and reload', async ({
  page,
  context,
}, info) => {
  test.skip(!origin || !token, 'Requires disposable local PIWEB_HANDOFF_LIVE_URL/TOKEN');
  expect(['127.0.0.1', 'localhost']).toContain(new URL(origin!).hostname);
  test.setTimeout(480_000);
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  const failedRequests: string[] = [];
  const shots: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  page.on('requestfailed', (r) => failedRequests.push(new URL(r.url()).pathname));
  expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(true);
  const created = await context.request.post(origin + '/api/sessions', {
    data: { name: 'Tool history acceptance' },
  });
  expect(created.ok()).toBe(true);
  const { jid } = await created.json();
  const eventsUrl = origin + '/api/sessions/' + encodeURIComponent(jid) + '/events?limit=200';
  async function events() {
    const response = await context.request.get(eventsUrl);
    expect(response.ok()).toBe(true);
    return (await response.json()).events as {
      rowid: number;
      kind: string;
      role: string;
      content: string;
    }[];
  }
  async function shot(name: string) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.locator('#messages details.event.error')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(name + '.png') });
    shots.push(name);
  }
  async function selectModel(ref: string) {
    await reachable(page.locator('#btn-model'));
    await page.locator('#btn-model').click();
    await expect(page.locator('#model-sheet')).toBeVisible();
    await page.locator('#model-search').fill(ref);
    const model = page.locator('.model-item').filter({ hasText: ref });
    await expect(model).toHaveCount(1);
    await reachable(model);
    await model.click();
    await expect(page.locator('#model-sheet')).not.toBeVisible();
  }
  async function send(text: string, count: number) {
    await page.locator('#input').fill(text);
    await reachable(page.locator('#btn-send'));
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && r.url().endsWith(encodeURIComponent(jid) + '/messages'),
    );
    await page.locator('#btn-send').click();
    expect((await response).ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (await events()).filter((e) => e.kind === 'message' && e.role === 'assistant').length,
        { timeout: 180_000 },
      )
      .toBe(count);
    const replies = page.locator('#messages > .msg:not(.msg-user)');
    await expect(replies).toHaveCount(count);
    await replies.last().scrollIntoViewIfNeeded();
  }
  // Catch transient rendered failures, not just the final DOM state.
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    (window as any).__handoffVisualErrors = [];
    new MutationObserver(() => {
      for (const e of document.querySelectorAll('#messages details.event.error, [role="alert"]')) {
        if (e.getBoundingClientRect().height && e.textContent?.trim())
          (window as any).__handoffVisualErrors.push(e.textContent.trim());
      }
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  await page.goto(origin + '/?session=' + encodeURIComponent(jid));
  await expect(page.locator('#input')).toBeVisible();
  await shot('00-isolated-session');
  await selectModel('claude-code/opus');
  await expect(page.locator('#header-badge')).toHaveText('OPUS');
  await shot('01-opus-selected');
  const commandA = `python3 -c "import secrets; print('OPUS_TOOL_' + secrets.token_hex(8).upper())"`;
  await send(
    `Execute exactly this harmless shell command once: ${commandA}. Do not use any other tools or files. Do NOT repeat its random output or command in your final reply. Reply exactly OPUS_TOOL_DONE.`,
    1,
  );
  const first = await events();
  expect(first.some((e) => e.kind === 'tool' && e.content.includes('OPUS_TOOL_'))).toBe(true);
  const proofA = first
    .filter((e) => e.kind === 'tool_result')
    .map((e) => e.content)
    .join('\n')
    .match(/OPUS_TOOL_[A-F0-9]{16}/)?.[0];
  expect(proofA).toBeTruthy();
  expect(first.filter((e) => e.kind === 'message').every((e) => !e.content.includes(proofA!))).toBe(
    true,
  );
  await shot('02-opus-tool-completed');
  await selectModel('agy/gemini-3.1-pro-high');
  await expect(page.locator('#header-badge')).toHaveText('AGY');
  await shot('03-gemini-selected');
  const commandB = `python3 -c "import secrets; print('GEMINI_TOOL_' + secrets.token_hex(8).upper())"`;
  await send(
    `From the transferred historical tool result, recall the exact OPUS_TOOL_ random value (do not regenerate it, search files, or read archives). Then execute only this harmless command once: ${commandB}. Do NOT repeat the GEMINI_TOOL_ random output in your final reply. Final reply: GEMINI_SAW <exact earlier OPUS_TOOL_ value> GEMINI_TOOL_DONE.`,
    2,
  );
  const second = await events();
  const replies = second.filter((e) => e.kind === 'message' && e.role === 'assistant');
  expect(replies[1].content).toContain(proofA);
  const proofB = second
    .filter((e) => e.kind === 'tool_result')
    .map((e) => e.content)
    .join('\n')
    .match(/GEMINI_TOOL_[A-F0-9]{16}/)?.[0];
  expect(proofB).toBeTruthy();
  expect(
    second.filter((e) => e.kind === 'message').every((e) => !e.content.includes(proofB!)),
  ).toBe(true);
  await shot('04-gemini-recalled-tool-only-value');
  await selectModel('claude-code/opus');
  await expect(page.locator('#header-badge')).toHaveText('OPUS');
  await shot('05-opus-return');
  await send(
    'No tools or files. From the transferred historical tool results only, what exact GEMINI_TOOL_ random value was generated in the previous turn? Reply OPUS_SAW <exact value>, or UNKNOWN if unavailable.',
    3,
  );
  const finalEvents = await events();
  const finalReplies = finalEvents.filter((e) => e.kind === 'message' && e.role === 'assistant');
  expect(finalReplies[2].content).toContain(proofB);
  expect(finalEvents.filter((e) => e.kind === 'tool')).toHaveLength(
    second.filter((e) => e.kind === 'tool').length,
  );
  expect(finalEvents.filter((e) => e.kind === 'error')).toEqual([]);
  await shot('06-opus-recalled-gemini-tool-only-value');
  const visualErrors = await page.evaluate(() => (window as any).__handoffVisualErrors);
  expect(visualErrors).toEqual([]);
  await page.reload();
  await expect(page.locator('#messages > .msg:not(.msg-user)')).toHaveCount(3);
  await expect(page.locator('#messages > .msg:not(.msg-user)').last()).toContainText(proofB!);
  await shot('07-reload-persisted');
  expect(errors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await writeFile(
    info.outputPath('metrics.json'),
    JSON.stringify(
      {
        jid,
        proofA,
        proofB,
        replies: finalReplies.map((e) => e.content),
        shots,
        errors,
        failedRequests,
        visualErrors,
        viewport: '390x844',
        realProviders: true,
        isolatedLoopback: true,
        toolOnlyRandomValues: true,
      },
      null,
      2,
    ),
  );
});
