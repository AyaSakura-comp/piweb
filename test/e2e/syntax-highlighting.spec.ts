import { expect, test } from 'playwright/test';

test.describe('mobile code-block rendering', () => {
  test('auto-detects syntax and matches the reviewed visual baseline', async ({ page }) => {
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto('/fixtures/syntax-highlighting.html');
    await expect(page.getByRole('heading', { name: 'Code highlighting' })).toBeVisible();

    const blocks = page.locator('pre code.hljs');
    await expect(blocks).toHaveCount(4);
    await expect(page.locator('#auto-javascript code')).toHaveAttribute(
      'data-language',
      /^(javascript|typescript)$/,
    );
    await expect(page.locator('#explicit-sql code')).toHaveAttribute('data-language', 'sql');

    const viewportDoesNotOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    );
    expect(viewportDoesNotOverflow).toBe(true);
    expect(browserErrors).toEqual([]);

    await expect(page.locator('.fixture')).toHaveScreenshot('syntax-highlighting-mobile.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.001,
    });
  });
});
