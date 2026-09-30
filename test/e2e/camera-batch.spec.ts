import { expect, test } from 'playwright/test';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});
const prompt =
  '請幫我辨識並說明這些照片裡的內容。如果需要更多資訊，可以使用以圖搜尋或上網查證，並附上來源；無法確定的部分請明確說明，不要猜測。';

test('shutter stages a removable batch; Send alone uploads; failure preserves photos', async ({
  page,
}, info) => {
  const sent: Array<{ text: string; attachments: Array<{ name: string; dataBase64: string }> }> =
    [];
  let fail = false;
  let releaseUpload!: () => void;
  const uploadHeld = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const session = {
    jid: 'web:camera-batch',
    name: 'Camera photo batch',
    kind: 'standard',
    model: 'test',
    deleted: false,
    busy: false,
  };
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/api/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/me') return r.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return r.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return r.fulfill({ json: { session, events: [], busy: false, hasMore: false } });
    if (path.endsWith('/stream'))
      return r.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/messages')) {
      sent.push(r.request().postDataJSON());
      if (sent.length === 1) await uploadHeld;
      return r.fulfill({
        status: fail ? 503 : 200,
        json: fail ? { error: 'Test upload unavailable' } : { ok: true },
      });
    }
    return r.fulfill({ json: { models: [], commands: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await page.locator('#btn-send').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#camera-shutter')).toBeEnabled();
  const chips = page.locator('#attachments .chip-image');
  await expect(page.locator('#camera-send')).toBeDisabled();
  expect(sent).toHaveLength(0);
  await expect(chips).toHaveCount(0);
  await page.locator('#camera-shutter').click();
  await page.locator('#camera-shutter').click();
  await page.locator('#camera-shutter').click();
  await expect(chips).toHaveCount(3);
  await expect(page.locator('#camera-batch-count')).toContainText('3');
  expect(sent).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('01-three-photos-staged.png') });
  await chips.nth(1).locator('.chip-remove').click();
  await expect(chips).toHaveCount(2);
  await page.waitForTimeout(700);
  await page.locator('#camera-send').click();
  // The HTTP response remains held: dismissal must not wait for upload success.
  await expect(page.locator('#camera-pane')).toBeHidden();
  await expect(chips).toHaveCount(2);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].text).toBe(prompt);
  expect(sent[0].attachments).toHaveLength(2);
  await expect(chips).toHaveCount(2);
  await expect(chips.first().locator('.chip-remove')).toBeDisabled();
  releaseUpload();
  await expect(chips).toHaveCount(0);
  await page.locator('#btn-send').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#camera-shutter')).toBeEnabled();
  await page.locator('#camera-shutter').click();
  await page.locator('#input').fill('只回答我的問題');
  fail = true;
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#camera-send').click();
  await expect.poll(() => sent.length).toBe(2);
  await expect(page.locator('#btn-send')).toBeEnabled();
  await expect(chips).toHaveCount(1);
  await expect(page.locator('#input')).toHaveValue('只回答我的問題');
  expect(
    await chips.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth),
  ).toBeGreaterThan(0);
  fail = false;
  await expect(page.locator('#camera-pane')).toBeHidden();
  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2].text).toBe('只回答我的問題');
  expect(sent[2].attachments).toHaveLength(1);
  expect(sent[2].attachments[0].name).toBe(sent[1].attachments[0].name);
  await expect(chips).toHaveCount(0);
  await expect(page.locator('#camera-pane')).toBeHidden();
  await expect(page.locator('#btn-send')).toBeVisible();
  await page.screenshot({ path: info.outputPath('02-success-batch-cleared.png') });
  expect(errors).toEqual([]);
});
