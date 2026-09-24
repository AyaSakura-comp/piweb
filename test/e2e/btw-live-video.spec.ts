import { expect, test, type Locator } from 'playwright/test';

// Opt-in only: an isolated PiWeb + worker backed by real Pi RPC and pi-btw.
// Never include credentials in a Playwright trace or test artifact.
test.use({ trace: 'off' });
const origin = process.env.PIWEB_BTW_LIVE_URL;
const token = process.env.PIWEB_BTW_LIVE_TOKEN;

async function reachable(locator: Locator) {
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { reachable: point === element || !!point && element.contains(point),
      width: rect.width, height: rect.height, blocker: point?.id || point?.tagName };
  });
  expect(hit, `Pointer blocked by ${hit.blocker}`).toMatchObject({ reachable: true });
  return hit;
}

test('real PiWeb BTW bridge: concurrent parent, side transcript, reload and isolation', async ({ page, context }, info) => {
  test.skip(!origin || !token, 'Set opt-in disposable PIWEB_BTW_LIVE_URL and PIWEB_BTW_LIVE_TOKEN');
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error') errors.push(e.text()); });
  page.on('requestfailed', (r) => {
    if (r.url().includes('/btw') || r.url().includes('/messages')) errors.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`);
  });
  const login = await context.request.post(origin! + '/api/login', { data: { token } });
  expect(login.ok()).toBe(true);
  const makeSession = async (name: string) => {
    const response = await context.request.post(origin! + '/api/sessions', {
      headers: { Origin: origin! }, data: { name },
    });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ jid: string }>;
  };
  const session = await makeSession('BTW isolated video parent');
  await page.goto(origin! + '/?session=' + encodeURIComponent(session.jid));
  await expect(page.locator('#input')).toBeVisible();
  await page.screenshot({ path: info.outputPath('00-main-idle.png') });

  const mainPrompt = 'Integration test: use the bash tool to run `sleep 20`, then reply exactly MAIN_PROOF_731. Do not use subagents or edit files.';
  await page.locator('#input').fill(mainPrompt);
  await reachable(page.locator('#btn-send'));
  await page.locator('#btn-send').click();
  await expect(page.locator('#messages')).toContainText('MAIN_PROOF_731'); // user prompt persisted
  await page.screenshot({ path: info.outputPath('01-main-started.png') });

  await page.locator('#btn-more').click();
  await reachable(page.locator('#mi-btw'));
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible({ timeout: 45_000 });
  expect(await page.locator('#btw-card').evaluate((element) => {
    const r = element.getBoundingClientRect();
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  })).toBe(true);
  await page.screenshot({ path: info.outputPath('02-btw-open.png') });
  const sessionsNow = await (await context.request.get(origin! + '/api/sessions')).json();
  expect(sessionsNow.sessions.find((s: { jid: string }) => s.jid === session.jid)?.busy,
    'the main agent must still be running when BTW is submitted').toBe(true);
  const sidePrompt = 'Reply exactly SIDE_PROOF_731, with no tools.';
  await page.locator('#input').fill(sidePrompt);
  await reachable(page.locator('#btn-send'));
  const sentSide = page.waitForResponse((r) => r.url().includes('/btw') && r.request().method() === 'POST');
  await page.locator('#btn-send').click();
  // Immediate feedback: the question leaves the composer and shows as pending.
  await expect(page.locator('#input')).toHaveValue('');
  await expect(page.locator('#btw-messages')).toContainText('SIDE_PROOF_731');
  await expect(page.locator('#btw-messages .btw-waiting')).toBeVisible();
  await page.screenshot({ path: info.outputPath('02b-btw-pending.png') });
  const sideResponse = await sentSide;
  expect(sideResponse.ok(), await sideResponse.text()).toBe(true);
  await expect(page.locator('#btw-card'), 'side recipient must remain selected after the answer').toBeVisible();
  await expect(page.locator('#btw-messages').getByText('SIDE_PROOF_731', { exact: true })).toBeInViewport({ timeout: 150_000 });
  await page.screenshot({ path: info.outputPath('03-btw-answered.png') });
  const eventsResponse = await context.request.get(origin! + '/api/sessions/' + encodeURIComponent(session.jid) + '/events');
  expect(eventsResponse.ok()).toBe(true);
  const events = await eventsResponse.json();
  expect(JSON.stringify(events.events)).not.toContain('SIDE_PROOF_731');

  await reachable(page.locator('#btw-back'));
  await page.locator('#btw-back').click();
  await expect(page.locator('#messages')).toContainText('MAIN_PROOF_731');
  await expect(page.locator('#messages')).not.toContainText('SIDE_PROOF_731');
  await page.screenshot({ path: info.outputPath('04-return-main.png') });
  await expect.poll(async () => {
    const response = await context.request.get(origin! + '/api/sessions/' + encodeURIComponent(session.jid) + '/events');
    const data = await response.json();
    return data.events.some((event: { role: string; content: string }) =>
      event.role === 'assistant' && event.content?.includes('MAIN_PROOF_731'));
  }, { timeout: 150_000 }).toBe(true);
  // PiWeb consumes ?session on navigation; reload without it can select a
  // different previously-created session in a multi-session fixture.
  await page.goto(origin! + '/?session=' + encodeURIComponent(session.jid));
  await expect(page.locator('#messages')).toContainText('MAIN_PROOF_731', { timeout: 15_000 });
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-messages').getByText('SIDE_PROOF_731', { exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('05-reconnected-side.png') });

  const other = await makeSession('BTW isolation witness');
  await page.goto(origin! + '/?session=' + encodeURIComponent(other.jid));
  await expect(page.locator('#input')).toBeVisible();
  await page.locator('#btn-more').click();
  await page.locator('#mi-btw').click();
  await expect(page.locator('#btw-card')).toBeVisible();
  await expect(page.locator('#btw-messages')).not.toContainText('SIDE_PROOF_731');
  await page.screenshot({ path: info.outputPath('06-other-session-empty.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // Optional: a non-Pi harness (e.g. agy/…) must close BTW and hide its entry.
  const nonPiModel = process.env.PIWEB_BTW_LIVE_NONPI_MODEL;
  if (nonPiModel) {
    const setModel = await context.request.post(origin! + '/api/sessions/' + encodeURIComponent(other.jid) + '/commands', {
      headers: { Origin: origin! }, data: { command: 'pi model', args: { model: nonPiModel } },
    });
    expect(setModel.ok(), await setModel.text()).toBe(true);
    await expect(page.locator('#btw-card'), 'drawer poll must leave BTW after the switch').toBeHidden({ timeout: 30_000 });
    await expect(page.getByText('BTW 僅支援 Pi 模型')).toBeVisible();
    await page.screenshot({ path: info.outputPath('07-nonpi-left-btw.png') });
    await page.locator('#btn-more').click();
    await expect(page.locator('#more-menu')).toBeVisible();
    await expect(page.locator('#mi-btw')).toBeHidden();
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath('08-nonpi-menu.png') });
    await page.keyboard.press('Escape');
    const refused = await (await context.request.get(origin! + '/api/sessions/' + encodeURIComponent(other.jid) + '/btw')).json();
    expect(refused.available).toBe(false);
  }
  for (const jid of [session.jid, other.jid]) {
    await context.request.delete(origin! + '/api/sessions/' + encodeURIComponent(jid) + '?permanent=1', { headers: { Origin: origin! } });
  }
  expect(errors).toEqual([]);
});
