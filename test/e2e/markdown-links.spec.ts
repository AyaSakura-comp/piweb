import { expect, test } from 'playwright/test';

test('bold embedded URLs render as compact secure links instead of literal markdown', async ({
  page,
}, testInfo) => {
  await page.goto('/fixtures/markdown-links.html');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');

  const links = page.locator('#content td strong a');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveText('攀山者繩盤收繩法示範');
  await expect(links.first()).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=3CzZO7JujJU',
  );
  await expect(links.first()).toHaveAttribute('target', '_blank');
  await expect(links.first()).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('#content')).not.toContainText('](');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.screenshot({ path: testInfo.outputPath('embedded-markdown-links.png') });
});
