import { expect, test } from 'playwright/test';

const session = {
  jid: 'web:quotebottom',
  name: 'Quote bottom',
  folder: 'web_quotebottom',
  kind: 'standard',
  deleted: false,
  model: 'test',
  busy: false,
  lastReplyId: 40,
};
const events = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  kind: 'message',
  role: i % 2 ? 'assistant' : 'user',
  content: i === 39 ? '最後一行：Optionaln 是指把 50 案改成可選，還是只推送既有修正？' : `第 ${i + 1} 則訊息，填滿畫面用的文字。`,
  files: [],
  createdAt: '2026-10-14T11:00:00Z',
}));

test('selecting the last transcript line keeps it above the quote bar, and BTW only ends the selection', async ({ page }, info) => {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/events')) return route.fulfill({ json: { events, busy: false, hasMore: false, session } });
    if (path.includes('/btw')) return route.fulfill({ json: { events: [], busy: false } });
    return route.fulfill({ json: { models: [], commands: [], sessions: [] } });
  });
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: ['commit', 'push', 'deploy'].map((word) => ({ word, count: 5 })) } }),
  );
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto('/');
  const last = page.locator('.msg-text').last();
  await expect(last).toContainText('最後一行');
  // At the live tail, the last line sits right above the composer.
  await expect.poll(() => page.evaluate(() => {
    const m = document.getElementById('messages')!;
    return m.scrollHeight - m.clientHeight - m.scrollTop;
  })).toBeLessThan(4);

  // Long-press the last line.
  const box = (await last.boundingBox())!;
  const point = { x: box.x + 60, y: box.y + box.height - 8, id: 1 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(page.locator('#custom-selection-overlay')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#quote-preview')).toBeVisible();
  await expect(page.locator('#selection-actions')).toBeVisible();
  await page.waitForTimeout(250);

  const geometry = await page.evaluate(() => {
    const rect = (el: Element | null) => el!.getBoundingClientRect();
    const highlights = [...document.querySelectorAll('.sel-highlight-rect')].map((el) => el.getBoundingClientRect());
    return {
      composerTop: rect(document.getElementById('composer-wrap')).top,
      btwTop: document.querySelector('.btw-pending-row:not([hidden])')?.getBoundingClientRect().top ?? Infinity,
      selectionBottom: Math.max(...highlights.map((h) => h.bottom)),
      endHandleBottom: rect(document.querySelector('#sel-handle-end .sel-handle-line')).bottom,
      toolbar: rect(document.getElementById('selection-actions')),
    };
  });
  const coveredFrom = Math.min(geometry.composerTop, geometry.btwTop);
  // The selected line and its handle are not under the quote bar / BTW row...
  expect(geometry.selectionBottom).toBeLessThanOrEqual(coveredFrom + 1);
  expect(geometry.endHandleBottom).toBeLessThanOrEqual(coveredFrom + 1);
  // ...and neither is the 引用／複製 toolbar.
  expect(geometry.toolbar.bottom).toBeLessThanOrEqual(coveredFrom + 1);
  await page.screenshot({ path: info.outputPath('quote-bottom-line.png') });

  // Tapping where BTW sits ends the selection (the backdrop takes the tap); it
  // does not switch to BTW, and the picked quote stays.
  const btw = page.locator('.btw-pending-row:not([hidden]) button');
  await expect(btw).toBeVisible();
  const btwBox = (await btw.boundingBox())!;
  await page.touchscreen.tap(btwBox.x + btwBox.width / 2, btwBox.y + btwBox.height / 2);
  await expect(page.locator('#custom-selection-overlay')).not.toHaveClass(/active/);
  await expect(page.locator('#selection-actions')).toBeHidden();
  await page.waitForTimeout(300);
  await expect(page.locator('.app')).not.toHaveClass(/btw-active/);
  await expect(page.locator('#quote-preview')).toBeVisible();

  // Removing the quote scrolls back, keeping the live tail.
  await page.locator('#quote-preview-remove').click();
  await expect.poll(() => page.evaluate(() => {
    const m = document.getElementById('messages')!;
    return m.scrollHeight - m.clientHeight - m.scrollTop;
  })).toBeLessThan(4);
});
