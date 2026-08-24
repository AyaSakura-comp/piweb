import { expect, test } from 'playwright/test';

test('touch long-press uses only the in-app transcript selection', async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await page.goto('/fixtures/text-selection.html');
  const text = page.locator('.msg-text p').first();
  await expect(text).toBeVisible();

  const textBox = await text.boundingBox();
  expect(textBox).not.toBeNull();
  const point = {
    x: textBox!.x + Math.min(120, textBox!.width / 2),
    y: textBox!.y + textBox!.height / 2,
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...point, id: 1 }],
  });
  const overlay = page.locator('#custom-selection-overlay');
  await expect(overlay).toBeVisible();
  const nativeSelectionAllowed = await text.evaluate((element) =>
    element.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })),
  );
  expect(nativeSelectionAllowed).toBe(false);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.getByRole('toolbar')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.rangeCount ?? -1)).toBe(0);

  const geometry = await page.evaluate(() => {
    const message = document.querySelector('.msg-text')!.getBoundingClientRect();
    const start = document
      .querySelector('#sel-handle-start .sel-handle-line')!
      .getBoundingClientRect();
    const end = document.querySelector('#sel-handle-end .sel-handle-line')!.getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.sel-highlight-rect')].map((element) =>
      element.getBoundingClientRect(),
    );
    return {
      message: {
        left: message.left,
        top: message.top,
        right: message.right,
        bottom: message.bottom,
      },
      start: { left: start.left, top: start.top, right: start.right, bottom: start.bottom },
      end: { left: end.left, top: end.top, right: end.right, bottom: end.bottom },
      boxes: boxes.map((box) => ({
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      })),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });

  expect(geometry.boxes.length).toBeGreaterThan(0);
  for (const handle of [geometry.start, geometry.end]) {
    expect(handle.left).toBeGreaterThan(0);
    expect(handle.top).toBeGreaterThan(0);
    expect(handle.right).toBeLessThan(geometry.viewport.width);
    expect(handle.bottom).toBeLessThan(geometry.viewport.height);
  }
  for (const box of geometry.boxes) {
    expect(box.left).toBeGreaterThanOrEqual(geometry.message.left - 1);
    expect(box.top).toBeGreaterThanOrEqual(geometry.message.top - 1);
    expect(box.right).toBeLessThanOrEqual(geometry.message.right + 1);
    expect(box.bottom).toBeLessThanOrEqual(geometry.message.bottom + 1);
  }

  await page.screenshot({
    path: testInfo.outputPath('01-custom-selection.png'),
    animations: 'disabled',
  });
  await expect(page.locator('.main')).toHaveScreenshot('custom-selection-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.001,
  });

  await page.getByRole('button', { name: '引用' }).click();
  await expect(overlay).toBeHidden();
  const quotePreview = page.locator('#quote-preview');
  await expect(quotePreview).toBeVisible();
  const quoteBox = await quotePreview.boundingBox();
  expect(quoteBox).not.toBeNull();
  expect(quoteBox!.y).toBeGreaterThanOrEqual(0);
  expect(quoteBox!.y + quoteBox!.height).toBeLessThanOrEqual(844);
  await page.screenshot({
    path: testInfo.outputPath('02-quote-preview.png'),
    animations: 'disabled',
  });

  expect(browserErrors).toEqual([]);
});
