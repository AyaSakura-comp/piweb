import { expect, test } from 'playwright/test';

const liveUrl = process.env.PIWEB_LIVE_URL;

test.skip(!liveUrl, 'Set PIWEB_LIVE_URL to run the production compaction walkthrough.');

test('live mobile compaction command is discoverable and executes', async ({ page }, testInfo) => {
  test.setTimeout(10 * 60_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(liveUrl!, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Open sessions' })).toBeVisible();

  await test.step('create a clean disposable session', async () => {
    await page.getByRole('button', { name: 'Open sessions' }).click();
    const drawer = page.getByLabel('Sessions', { exact: true });
    await expect(drawer).toBeVisible();
    await expect.poll(async () => (await drawer.boundingBox())?.width ?? 0).toBeGreaterThan(250);
    await drawer.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('01-clean-session.png') });
  });

  const composer = page.getByRole('textbox', { name: 'Message' });
  const send = page.getByRole('button', { name: 'Send' });

  await test.step('seed enough history for a real compaction', async () => {
    const seedCountBefore = await page.getByText('SEED', { exact: true }).count();
    const seed = `Reply with exactly SEED. Context follows.\n${'context-data '.repeat(10_000)}`;
    await composer.fill(seed);
    await send.click();
    await expect
      .poll(() => page.getByText('SEED', { exact: true }).count(), { timeout: 8 * 60_000 })
      .toBeGreaterThan(seedCountBefore);

    const readyReply = page.getByText(/^READY\.?$/);
    const readyCountBefore = await readyReply.count();
    await composer.fill('Reply with exactly READY.');
    await send.click();
    await expect
      .poll(() => readyReply.count(), { timeout: 8 * 60_000 })
      .toBeGreaterThan(readyCountBefore);
    await expect(page.getByText('pi is working...')).toHaveCount(0, { timeout: 30_000 });
    const jump = page.getByRole('button', { name: /Jump to present/ });
    if (await jump.isVisible()) await jump.click();
    await page.screenshot({ path: testInfo.outputPath('02-ready-with-seeded-history.png') });
  });

  await test.step('discover the deployed compact command in the mobile command menu', async () => {
    await composer.fill('/pi');
    const compactCommand = page.locator('#autocomplete .ac-item').filter({ hasText: /^\/pi compact/ });
    await expect(compactCommand).toBeVisible();
    const box = await compactCommand.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    const reachable = await compactCommand.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || Boolean(hit && element.contains(hit));
    });
    expect(reachable).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('03-compact-command-menu.png') });
  });

  await test.step('execute real RPC compaction and verify its result', async () => {
    await composer.fill('/pi compact');
    await send.click();
    await expect(page.getByText(/Compacted context: .* approximately .* tokens\./).last()).toBeVisible({
      timeout: 8 * 60_000,
    });
    await page.screenshot({ path: testInfo.outputPath('04-compaction-complete.png') });
  });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
