import { expect, test } from 'playwright/test';

const session = {
  jid: 'web:hotwords',
  name: 'Hot words',
  folder: 'web_hotwords',
  kind: 'standard',
  deleted: false,
  model: 'test',
  busy: false,
  lastReplyId: 1,
};
const words = ['commit', 'push', 'deploy', 'qwen', 'update', '影片', '功能', '測試', 'skill', 'agent'];

function mockApi(page: import('playwright/test').Page, sent: unknown[]) {
  return page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events: [{ id: 1, kind: 'message', role: 'assistant', content: 'hi', files: [], createdAt: '2026-01-01T00:00:00Z' }],
          busy: false,
          hasMore: false,
          session,
        },
      });
    if (path.endsWith('/messages')) {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { models: [], commands: [], sessions: [] } });
  });
}

test('top ten keywords sit above the composer, scroll sideways and multi-select into the box', async ({ page }, info) => {
  const sent: unknown[] = [];
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { generatedAt: '2026-10-14T00:00:00Z', windowDays: 7, items: words.map((word, i) => ({ word, count: 40 - i })) } }),
  );
  await mockApi(page, sent);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto('/');
  const row = page.locator('#hot-keywords');
  await expect(row).toBeVisible();
  await expect(row.locator('.hot-keyword')).toHaveText(words);

  const rowBox = (await row.boundingBox())!;
  const composer = (await page.locator('#composer').boundingBox())!;
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(composer.y + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('hot-keywords.png') });

  // Ten chips do not fit a phone row: the row scrolls, the page does not.
  const overflow = await row.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
  expect(overflow.scroll).toBeGreaterThan(overflow.client);
  await row.evaluate((node) => node.scrollBy({ left: 200 }));
  await expect.poll(() => row.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  await row.evaluate((node) => node.scrollTo({ left: 0 }));

  // A finger dragging the row sideways is a scroll, not a tap.
  await row.locator('.hot-keyword[data-word="qwen"]').dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 200, clientY: 760 }] });
  await row.locator('.hot-keyword[data-word="qwen"]').dispatchEvent('touchmove', { touches: [{ identifier: 1, clientX: 140, clientY: 760 }] });
  await row.locator('.hot-keyword[data-word="qwen"]').dispatchEvent('touchend', { touches: [] });
  await expect(page.locator('#input')).toHaveValue('');

  const box = page.locator('#input');
  const chip = (word: string) => row.locator(`.hot-keyword[data-word="${word}"]`);
  // Multi-select: each tap adds its word; the chips stay pressed.
  await chip('commit').tap();
  await chip('push').tap();
  await chip('影片').tap();
  await expect(box).toHaveValue('commit push 影片');
  // The keyboard is left alone: a tap neither focuses the box (opening it)...
  await expect(box).not.toBeFocused();
  for (const word of ['commit', 'push', '影片']) await expect(chip(word)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('hot-keywords-selected.png') });

  // ...nor takes focus from it (closing it).
  await box.focus();
  await chip('push').tap();
  await expect(box).toBeFocused();
  // Tapping a pressed chip takes its word back out.
  await expect(box).toHaveValue('commit 影片');
  await expect(chip('push')).toHaveAttribute('aria-pressed', 'false');

  // Typing the word away releases its chip.
  await box.fill('影片');
  await expect(chip('commit')).toHaveAttribute('aria-pressed', 'false');
  await expect(chip('影片')).toHaveAttribute('aria-pressed', 'true');
  expect(sent).toHaveLength(0);

  // Sending empties the box and releases the rest.
  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length).toBe(1);
  await expect(chip('影片')).toHaveAttribute('aria-pressed', 'false');

  await page.evaluate(() => document.querySelector('.app')!.classList.add('life-mode'));
  await expect(row).toBeHidden();
});

test('refetches when the page comes back, and shows no empty row without a file', async ({ page }) => {
  let served = 0;
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => {
    served += 1;
    return served === 1
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ json: { items: [{ word: 'deploy', count: 3 }] } });
  });
  await mockApi(page, []);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto('/');
  await expect(page.locator('#composer')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator('#hot-keywords')).toBeHidden();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#hot-keywords .hot-keyword')).toHaveText(['deploy']);
});

test('switches keyword window days from the settings dialog and persists to localStorage', async ({ page }) => {
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({
      json: {
        generatedAt: '2026-10-15T00:00:00Z',
        windowDays: 1,
        items: [{ word: 'deploy', count: 10 }, { word: 'push', count: 9 }],
        windows: {
          '1': [{ word: 'deploy', count: 10 }, { word: 'push', count: 9 }],
          '7': [{ word: 'commit', count: 30 }, { word: 'qwen', count: 25 }],
        },
      },
    }),
  );
  await mockApi(page, []);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto('/');

  const row = page.locator('#hot-keywords');
  await expect(row).toBeVisible();
  // Default is 1 day
  await expect(row.locator('.hot-keyword')).toHaveText(['deploy', 'push']);

  // Open settings via menu
  await page.locator('#btn-menu').click();
  await page.locator('#btn-settings').click();
  const select = page.locator('#hot-keywords-days');
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('1');

  // Change to 7 days
  await select.selectOption('7');
  await expect(row.locator('.hot-keyword')).toHaveText(['commit', 'qwen']);
  expect(await page.evaluate(() => localStorage.getItem('piweb.hot_keywords_days'))).toBe('7');

  // Close settings
  await page.locator('#btn-settings-close').click();
  await expect(row.locator('.hot-keyword')).toHaveText(['commit', 'qwen']);
});
