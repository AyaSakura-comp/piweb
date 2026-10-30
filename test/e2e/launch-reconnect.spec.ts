import { expect, test, type Page } from 'playwright/test';

// A Home Screen app shows a launch that cannot fetch its page as a blank white
// screen, with no error and no retry. The service worker answers such a launch
// with a reconnect page that reloads once Piweb answers again.

async function controlled(page: Page) {
  await page.goto('/');
  await expect(page.locator('#composer-wrap')).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null);
}

for (const theme of ['dark', 'light'] as const) {
  test(`a launch that cannot reach Piweb reconnects instead of staying blank (${theme})`, async ({
    page,
    context,
  }, info) => {
    await page.addInitScript((t) => localStorage.setItem('piweb.theme', t), theme);
    await controlled(page);

    await context.setOffline(true);
    await page.reload();
    const status = page.getByRole('status');
    await expect(status).toHaveText("Can't reach Piweb. Reconnecting…");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      theme === 'dark' ? 'rgb(49, 51, 56)' : 'rgb(255, 255, 255)',
    );
    await page.screenshot({ path: info.outputPath(`reconnect-${theme}.png`) });

    await context.setOffline(false);
    await expect(page.locator('#composer-wrap')).toBeVisible({ timeout: 10_000 });
  });
}

test('a launch whose page never answers gets the reconnect page, then the app', async ({
  page,
  context,
}) => {
  await controlled(page);

  let stall = true;
  await context.route(
    (url) => url.pathname === '/',
    async (route) => {
      if (stall) await new Promise((r) => setTimeout(r, 15_000));
      await route.continue();
    },
  );
  const started = Date.now();
  await page.reload({ waitUntil: 'commit' });
  await expect(page.getByRole('status')).toBeVisible({ timeout: 14_000 });
  expect(Date.now() - started).toBeGreaterThan(9_000);

  stall = false;
  await expect(page.locator('#composer-wrap')).toBeVisible({ timeout: 20_000 });
});
