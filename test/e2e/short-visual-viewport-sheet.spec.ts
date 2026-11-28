import { expect, test, type Page } from 'playwright/test';

/*
 * iPhone turned sideways, 2026-11-28: after Send iOS reported a visual
 * viewport a few dozen px tall with no keyboard up. The Model and Thinking
 * sheets were capped to 86% of it and showed only their title at the bottom
 * edge (「Thinking 也會看不見」). With no keyboard the sheets use the layout
 * viewport, whatever the visual viewport reads.
 */

async function fakeShortVisualViewport(page: Page) {
  await page.addInitScript(() => {
    const proto = Object.getPrototypeOf(window.visualViewport);
    const real = Object.getOwnPropertyDescriptor(proto, 'height')!;
    Object.defineProperty(proto, 'height', {
      configurable: true,
      get() {
        const fake = (window as any).__fakeVisualViewportHeight;
        return typeof fake === 'number' ? fake : real.get!.call(this);
      },
    });
  });
}

async function shortenVisualViewport(page: Page, height: number) {
  await page.evaluate((h) => {
    // Nothing takes typing, so no keyboard is up.
    (document.activeElement as HTMLElement | null)?.blur();
    (window as any).__fakeVisualViewportHeight = h;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  }, height);
  // The shell samples over its settling window; let it finish.
  await page.waitForTimeout(800);
}

async function expectWholeSheet(page: Page, sheetId: string, titleText: string) {
  const sheet = page.locator(`#${sheetId}`);
  await expect(sheet).toBeVisible();
  const panel = sheet.locator('.sheet-panel');
  const title = panel.locator('.sheet-title');
  await expect(title).toHaveText(titleText);
  const box = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const head = el.querySelector('.sheet-head')!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, headBottom: head.bottom, vh: window.innerHeight };
  });
  // The panel is taller than its head and the head is fully on screen.
  expect(box.height).toBeGreaterThan(120);
  expect(box.headBottom).toBeLessThanOrEqual(box.vh);
  expect(box.top).toBeLessThan(box.vh - 120);
}

for (const viewport of [
  { name: 'sideways iPhone', width: 951, height: 669 },
  { name: 'iPhone', width: 390, height: 844 },
]) {
  test(`${viewport.name}: a short visual viewport with no keyboard leaves the Model and Thinking sheets whole`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await fakeShortVisualViewport(page);
    await page.goto('/?fixture=claude-tmux');
    await expect(page.locator('#session-name')).toHaveText('Claude tmux lab');
    await shortenVisualViewport(page, 40);
    // No keyboard: the shell stays at rest.
    await expect(page.locator('html')).not.toHaveClass(/keyboard-shell/);

    await page.getByRole('button', { name: 'Choose model' }).click();
    await expectWholeSheet(page, 'model-sheet', 'Model');
    await page.screenshot({ path: testInfo.outputPath('model-sheet.png') });
    await page.locator('#model-sheet .sheet-head .icon-btn').last().click();
    await expect(page.locator('#model-sheet')).toBeHidden();

    await page.locator('#btn-thinking').click();
    await expectWholeSheet(page, 'thinking-sheet', 'Thinking level');
    await page.screenshot({ path: testInfo.outputPath('thinking-sheet.png') });
  });
}
