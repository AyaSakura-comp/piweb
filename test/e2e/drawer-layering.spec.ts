import { expect, test } from 'playwright/test';

test('open session drawer stays above the jump button and composer', async ({ page }) => {
  await page.goto('/fixtures/drawer-layering.html');

  const drawerAction = page.getByRole('button', { name: 'Recently deleted' });
  await expect(drawerAction).toBeVisible();

  const topElementId = await drawerAction.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const topElement = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return topElement?.closest('[id]')?.id;
  });
  expect(topElementId).toBe('drawer-target');

  await drawerAction.click();
  await expect(page.locator('#click-result')).toHaveText('Drawer action clicked');
  await expect(page.locator('#drawer')).toHaveScreenshot('drawer-over-main-controls.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.001,
  });
});

test('bottom sheet opened from the drawer owns the foreground', async ({ page }) => {
  await page.goto('/fixtures/drawer-layering.html');
  await page.getByRole('button', { name: 'Open test sheet' }).click();

  const sheetAction = page.getByRole('button', { name: 'Sheet action' });
  await expect(sheetAction).toBeVisible();
  const topElementId = await sheetAction.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const topElement = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return topElement?.closest('[id]')?.id;
  });
  expect(topElementId).toBe('sheet-action');

  await sheetAction.click();
  await expect(sheetAction).toHaveText('Sheet action clicked');
});
