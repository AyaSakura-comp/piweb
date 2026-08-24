import { expect, test } from 'playwright/test';

test.describe('mobile day mode', () => {
  test.beforeEach(async ({ page }) => {
    // Clear once on this origin. An init script would run again on reload and
    // erase the very persistence behavior this suite is meant to verify.
    await page.goto('/health');
    await page.evaluate(() => localStorage.clear());
  });

  test('switches to a persisted light palette and back to dark', async ({ page }) => {
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto('/fixtures/theme-toggle.html');
    const toggle = page.getByRole('button', { name: 'Switch to light mode' });

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveText(/Light mode/);
    await toggle.click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ffffff');
    await expect(page.getByRole('button', { name: 'Switch to dark mode' })).toHaveText(/Dark mode/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('piweb.theme'))).toBe('light');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe('rgb(255, 255, 255)');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible();

    const viewportDoesNotOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    );
    expect(viewportDoesNotOverflow).toBe(true);
    expect(browserErrors).toEqual([]);

    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1e1f22');
  });

  test('matches the reviewed light-mode mobile baseline', async ({ page }) => {
    await page.goto('/fixtures/theme-toggle.html');
    await page.getByRole('button', { name: 'Switch to light mode' }).click();

    await expect(page.locator('#drawer')).toHaveScreenshot('day-mode-mobile.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.001,
    });
  });

  test('renders command output on a light Japanese paper surface', async ({ page }) => {
    await page.goto('/fixtures/theme-toggle.html');
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    await page.locator('#drawer').evaluate((drawer) => drawer.classList.remove('open'));
    await page.locator('.scrim').evaluate((scrim) => scrim.setAttribute('hidden', ''));

    const preview = page.locator('#light-code-preview');
    const code = preview.locator('pre code');
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        code.evaluate((element) => getComputedStyle(element.parentElement).backgroundColor),
      )
      .toBe('rgb(244, 242, 237)');
    await expect
      .poll(() => code.evaluate((element) => getComputedStyle(element).color))
      .toBe('rgb(53, 51, 47)');
    await expect(preview).toHaveScreenshot('day-mode-code-output.png', {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.001,
    });
  });
});
