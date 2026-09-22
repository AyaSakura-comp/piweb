import { expect, test, type Locator } from 'playwright/test';

test.use({ video: { mode: 'on', size: { width: 390, height: 844 } } });

async function expectPointerReachable(locator: Locator, primaryAction = false) {
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
  // Shared topbar icons retain the app's compact 34px contract; enforce the
  // 44px phone target on the primary composer actions Send and Stop.
  if (primaryAction) {
    expect(result.width).toBeGreaterThanOrEqual(44);
    expect(result.height).toBeGreaterThanOrEqual(44);
  }
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
  await expect(page.locator('#header-badge')).toHaveText('HAIKU');
  await page.screenshot({ path: testInfo.outputPath('01-claude-session.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video

  const modelButton = page.getByRole('button', { name: 'Choose model' });
  await expectPointerReachable(modelButton);
  await modelButton.click();
  const modelSheet = page.locator('#model-sheet');
  await expect(modelSheet).toBeVisible();

  const haiku = page.locator('.model-item').filter({ hasText: 'claude-code/haiku' });
  const sonnet = page.locator('.model-item').filter({ hasText: 'claude-code/sonnet' });
  const opus = page.locator('.model-item').filter({ hasText: 'claude-code/opus' });
  await expect(haiku).toBeVisible();
  await expect(sonnet).toBeVisible();
  await expect(opus).toBeVisible();

  await expect(haiku.locator('.provider-badge')).toHaveText('HAIKU');
  await expect(sonnet.locator('.provider-badge')).toHaveText('SONNET');
  await expect(opus.locator('.provider-badge')).toHaveText('OPUS');

  const badgeStyle = await sonnet.locator('.provider-badge').evaluate((badge) => ({
    color: getComputedStyle(badge).color,
    background: getComputedStyle(badge).backgroundColor,
  }));
  expect(badgeStyle.color).not.toBe('rgb(181, 186, 193)');
  expect(badgeStyle.background).not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath('02-claude-model-picker.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video

  // Switch to Sonnet
  await sonnet.click();
  await expect(modelSheet).toBeHidden();
  await expect(page.locator('#header-badge')).toHaveText('SONNET');

  // Verify thinking levels for Sonnet: low/medium/high/xhigh/max enabled; off/minimal blocked
  const thinkingButton = page.locator('#btn-thinking');
  await expectPointerReachable(thinkingButton);
  await thinkingButton.click();
  const thinkingSheet = page.locator('#thinking-sheet');
  await expect(thinkingSheet).toBeVisible();

  const offLevel = page.locator('.thinking-item[data-level="off"]');
  const minimalLevel = page.locator('.thinking-item[data-level="minimal"]');
  const lowLevel = page.locator('.thinking-item[data-level="low"]');
  const mediumLevel = page.locator('.thinking-item[data-level="medium"]');
  const highLevel = page.locator('.thinking-item[data-level="high"]');
  const xhighLevel = page.locator('.thinking-item[data-level="xhigh"]');
  const maxLevel = page.locator('.thinking-item[data-level="max"]');

  await expect(offLevel).toHaveClass(/blocked/);
  await expect(offLevel).toBeDisabled();
  await expect(offLevel.locator('.thinking-item-pill.blocked')).toHaveText('Unavailable');

  await expect(minimalLevel).toHaveClass(/blocked/);
  await expect(minimalLevel).toBeDisabled();

  await expect(lowLevel).not.toHaveClass(/blocked/);
  await expect(lowLevel).toBeEnabled();

  await expect(mediumLevel).not.toHaveClass(/blocked/);
  await expect(mediumLevel).toBeEnabled();

  await expect(highLevel).not.toHaveClass(/blocked/);
  await expect(highLevel).toBeEnabled();

  await expect(xhighLevel).not.toHaveClass(/blocked/);
  await expect(xhighLevel).toBeEnabled();

  await expect(maxLevel).not.toHaveClass(/blocked/);
  await expect(maxLevel).toBeEnabled();

  await page.screenshot({ path: testInfo.outputPath('02b-sonnet-thinking-sheet.png') });
  await page.waitForTimeout(400);

  // Click medium level
  await mediumLevel.click();
  await expect(thinkingSheet).toBeHidden();
  await expect(thinkingButton).toHaveAttribute('data-level', 'medium');

  const composer = page.locator('#input');
  const send = page.locator('#btn-send');
  await composer.fill('Inspect the project and summarize the tmux bridge.');
  await expectPointerReachable(send, true);
  await send.click();
  await expect(
    page.locator('.event.thinking').filter({ hasText: 'Reading the bridge implementation' }),
  ).toBeVisible();
  await expect(page.locator('.event.tool').filter({ hasText: 'README.piweb.md' })).toBeVisible();
  const stop = page.getByRole('button', { name: 'Stop the current task' });
  await expect(stop).toBeVisible();
  await expectPointerReachable(stop, true);
  await page.screenshot({ path: testInfo.outputPath('03-autonomous-tool-run.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video
  await expect(page.getByText('Claude Code stays warm in tmux')).toBeVisible();
  await expect(stop).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('04-completed-answer.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video

  await composer.fill('Run a long verification pass.');
  await send.click();
  await expect(stop).toBeVisible();
  await expectPointerReachable(stop, true);
  await stop.click();
  await expect(page.getByText('Stopped the Claude Code tmux task.')).toBeVisible();
  await expect(stop).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('05-stopped-cleanly.png') });
  await page.waitForTimeout(400); // deliberate evidence hold for the unified video

  await page.getByRole('button', { name: 'Open sessions' }).click();
  const drawer = page.locator('#drawer');
  await expect(drawer).toHaveClass(/open/);
  await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
  await expect(drawer.locator('.provider-badge')).toHaveText('SONNET');
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

  // Close drawer
  await page.locator('#btn-hide-drawer').click();
  await expect(drawer).not.toHaveClass(/open/);

  // Switch to Opus
  await modelButton.click();
  await expect(modelSheet).toBeVisible();
  await opus.click();
  await expect(modelSheet).toBeHidden();
  await expect(page.locator('#header-badge')).toHaveText('OPUS');

  // Verify thinking sheet for Opus: low/medium/high/xhigh/max enabled; off/minimal blocked
  await thinkingButton.click();
  await expect(thinkingSheet).toBeVisible();
  await expect(offLevel).toHaveClass(/blocked/);
  await expect(offLevel).toBeDisabled();
  await expect(minimalLevel).toHaveClass(/blocked/);
  await expect(minimalLevel).toBeDisabled();
  await expect(highLevel).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('07-opus-thinking-sheet.png') });
  await page.waitForTimeout(400);
  await page.locator('#btn-thinking-close').click();
  await expect(thinkingSheet).toBeHidden();

  // Switch back to Haiku
  await modelButton.click();
  await expect(modelSheet).toBeVisible();
  await haiku.click();
  await expect(modelSheet).toBeHidden();
  await expect(page.locator('#header-badge')).toHaveText('HAIKU');

  // Verify thinking sheet for Haiku: off enabled; all others blocked
  await thinkingButton.click();
  await expect(thinkingSheet).toBeVisible();
  await expect(offLevel).not.toHaveClass(/blocked/);
  await expect(offLevel).toBeEnabled();
  await expect(minimalLevel).toHaveClass(/blocked/);
  await expect(minimalLevel).toBeDisabled();
  await expect(lowLevel).toHaveClass(/blocked/);
  await expect(lowLevel).toBeDisabled();
  await expect(highLevel).toHaveClass(/blocked/);
  await expect(highLevel).toBeDisabled();
  await expect(page.locator('#thinking-note')).toContainText(
    'Configured effort medium is unavailable',
  );
  await page.screenshot({ path: testInfo.outputPath('08-haiku-thinking-sheet.png') });
  await page.waitForTimeout(400);
  await page.locator('#btn-thinking-close').click();
  await expect(thinkingSheet).toBeHidden();

  // Select the supported level after switching from a reasoning model.
  await thinkingButton.click();
  await offLevel.click();
  await expect(thinkingButton).toHaveAttribute('data-level', 'off');

  // Load the same production shell with the persisted light-theme preference.
  // No DOM/style overrides: theme.js reads this setting during normal boot.
  await page.evaluate(() => localStorage.setItem('piweb.theme', 'light'));
  await page.goto('/?fixture=claude-tmux');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#header-badge')).toHaveText('HAIKU');
  await modelButton.click();
  await expect(modelSheet).toBeVisible();
  for (const row of [haiku, sonnet, opus]) {
    await expect(row).toBeVisible();
    const color = await row.locator('.provider-badge').evaluate((element) => ({
      text: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    }));
    expect(color.text).not.toBe(color.background);
    expect(color.background).not.toBe('rgba(0, 0, 0, 0)');
  }
  await page.screenshot({ path: testInfo.outputPath('09-light-model-picker.png') });
  await page.waitForTimeout(600);
  await sonnet.click();
  await expect(page.locator('#header-badge')).toHaveText('SONNET');
  await thinkingButton.click();
  await expect(highLevel).toBeEnabled();
  await expect(offLevel).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('10-light-thinking.png') });
  await page.waitForTimeout(600);
  await page.locator('#btn-thinking-close').click();
  await composer.fill('Verify the bridge in light mode.');
  await expectPointerReachable(send, true);
  await send.click();
  await expect(page.getByText('Claude Code stays warm in tmux')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('11-light-answer.png') });
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
