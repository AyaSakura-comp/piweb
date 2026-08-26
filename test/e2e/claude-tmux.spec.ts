import { expect, test, type Locator } from 'playwright/test';

test.use({ video: { mode: 'on', size: { width: 390, height: 844 } } });

async function expectPointerReachable(locator: Locator) {
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      reachable: hit === element || Boolean(hit && element.contains(hit)),
      width: rect.width,
      height: rect.height,
      blocker: hit instanceof HTMLElement ? hit.id || hit.className || hit.tagName : null,
    };
  });
  expect(result, `pointer blocker: ${result.blocker}`).toMatchObject({ reachable: true });
}

test('Claude Code tmux mobile workflow is clear, autonomous, and stoppable', async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/?fixture=claude-tmux');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#session-name')).toHaveText('Claude tmux lab');
  await expect(page.locator('#header-badge')).toHaveText('CLAUDE');
  await page.screenshot({ path: testInfo.outputPath('01-claude-session.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video

  const modelButton = page.getByRole('button', { name: 'Choose model' });
  await expectPointerReachable(modelButton);
  await modelButton.click();
  const modelSheet = page.locator('#model-sheet');
  await expect(modelSheet).toBeVisible();
  const haiku = page.locator('.model-item').filter({ hasText: 'claude-code/haiku' });
  await expect(haiku).toBeVisible();
  await expect(haiku.locator('.provider-badge')).toHaveText('CLAUDE');
  const badgeStyle = await haiku.locator('.provider-badge').evaluate((badge) => ({
    color: getComputedStyle(badge).color,
    background: getComputedStyle(badge).backgroundColor,
  }));
  expect(badgeStyle.color).not.toBe('rgb(181, 186, 193)');
  expect(badgeStyle.background).not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath('02-claude-model-picker.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video
  await haiku.click();
  await expect(modelSheet).toBeHidden();
  await expect(page.locator('#header-badge')).toHaveText('CLAUDE');

  const composer = page.locator('#input');
  const send = page.locator('#btn-send');
  await composer.fill('Inspect the project and summarize the tmux bridge.');
  await expectPointerReachable(send);
  await send.click();
  await expect(
    page.locator('.event.thinking').filter({ hasText: 'Reading the bridge implementation' }),
  ).toBeVisible();
  await expect(page.locator('.event.tool').filter({ hasText: 'README.piweb.md' })).toBeVisible();
  const stop = page.getByRole('button', { name: 'Stop the current task' });
  await expect(stop).toBeVisible();
  await expectPointerReachable(stop);
  await page.screenshot({ path: testInfo.outputPath('03-autonomous-tool-run.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video
  await expect(page.getByText('Claude Code stays warm in tmux')).toBeVisible();
  await expect(stop).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('04-completed-answer.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video

  await composer.fill('Run a long verification pass.');
  await send.click();
  await expect(stop).toBeVisible();
  await expectPointerReachable(stop);
  await stop.click();
  await expect(page.getByText('Stopped the Claude Code tmux task.')).toBeVisible();
  await expect(stop).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('05-stopped-cleanly.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video

  await page.getByRole('button', { name: 'Open sessions' }).click();
  const drawer = page.locator('#drawer');
  await expect(drawer).toHaveClass(/open/);
  await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
  await expect(drawer.locator('.provider-badge')).toHaveText('CLAUDE');
  const contained = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    return (
      rect.left >= 0 &&
      rect.top >= 0 &&
      rect.right <= (viewport?.width ?? innerWidth) &&
      rect.bottom <= (viewport?.height ?? innerHeight)
    );
  });
  expect(contained).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('06-session-drawer.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
