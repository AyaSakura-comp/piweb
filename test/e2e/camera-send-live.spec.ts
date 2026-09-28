import { expect, test } from 'playwright/test';

const origin = process.env.PIWEB_CAMERA_TEST_URL;
const token = process.env.PIWEB_CAMERA_TEST_TOKEN;
test.use({
  trace: 'off',
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('camera bottom pane sends a JPEG into a real disposable PiWeb and survives reload', async ({
  page,
  context,
}, info) => {
  test.skip(!origin || !token, 'Requires isolated web-only PiWeb; never use a production URL');
  expect(new URL(origin!).hostname).toBe('127.0.0.1');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  expect((await context.request.post(origin + '/api/login', { data: { token } })).ok()).toBe(true);
  const created = await context.request.post(origin + '/api/sessions', {
    data: { name: 'Camera send verification' },
  });
  expect(created.ok()).toBe(true);
  const { jid } = await created.json();
  // Catalogues are irrelevant to upload and would probe host providers.
  await page.route('**/api/models', (r) => r.fulfill({ json: { models: [] } }));
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto(origin + '/?session=' + encodeURIComponent(jid));
  await expect(page.locator('#session-name')).toHaveText('Camera send verification');
  const cdp = await context.newCDPSession(page);
  const send = page.locator('#btn-send');
  const box = (await send.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const distance of [120, 220, 360]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - distance }],
    });
    await expect(page.locator('#camera-pane')).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs(
          (await page.locator('#camera-pane').boundingBox())!.height +
            (await page.locator('#camera-divider').boundingBox())!.height -
            distance,
        ),
      )
      .toBeLessThan(3);
    await page.waitForTimeout(350);
  }
  await expect(page.locator('#btn-camera')).toHaveCount(0);
  await expect(page.locator('#camera-pane')).toBeVisible();
  await expect(send).toHaveClass(/camera-armed/);
  await page.screenshot({ path: info.outputPath('00-following-finger.png') });
  await page.waitForTimeout(1000);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const pane = page.locator('#camera-pane');
  await expect(pane).toBeVisible();
  await expect
    .poll(() => page.locator('#camera-preview').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(1);
  expect((await page.locator('#composer-wrap').boundingBox())!.y).toBeLessThan(
    (await pane.boundingBox())!.y,
  );
  await expect
    .poll(async () => {
      const r = (await page.locator('.camera-view').boundingBox())!;
      return r.width / r.height;
    })
    .toBeCloseTo(2 / 3, 1);
  await page.screenshot({ path: info.outputPath('01-two-three-camera.png') });
  await page.waitForTimeout(1000);
  const cameraView = (await page.locator('.camera-view').boundingBox())!;
  await page.touchscreen.tap(100, cameraView.y + 140);
  await expect(page.locator('.camera-focus-ring')).toBeVisible();
  await page.screenshot({ path: info.outputPath('01b-tap-focus.png') });
  const pinchY = cameraView.y + 200;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 130, y: pinchY, id: 1 },
      { x: 250, y: pinchY, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: 100, y: pinchY, id: 1 },
      { x: 280, y: pinchY, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.locator('#camera-zoom').inputValue()).not.toBe('1');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: '模擬光圈 f/2.8', exact: true }).click();
  await expect(page.locator('.camera-aperture-label')).toContainText('f/2.8');
  await page.screenshot({ path: info.outputPath('01c-aperture-pinch.png') });
  await page.waitForTimeout(700);
  async function sendFrame(text?: string, count = 1) {
    for (let i = 0; i < count; i++) await page.locator('#camera-shutter').click();
    await expect(page.locator('#attachments .chip-image')).toHaveCount(count);
    await page.screenshot({ path: info.outputPath(`batch-${count}-ready.png`) });
    await page.waitForTimeout(700);
    if (text) await page.locator('#input').fill(text);
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith(encodeURIComponent(jid) + '/messages') && r.request().method() === 'POST',
    );
    await page.locator('#camera-send').click();
    expect((await response).ok()).toBe(true);
  }
  await sendFrame(undefined, 2);
  const messages = page.locator('#messages .msg-user');
  await expect(messages).toHaveCount(1);
  await expect(messages.first()).toContainText('可以使用以圖搜尋或上網查證');
  await expect(messages.first().locator('img')).toHaveCount(2);
  await expect
    .poll(() =>
      messages
        .first()
        .locator('img')
        .first()
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(pane).toBeHidden();
  await page.screenshot({ path: info.outputPath('02-first-photo-delivered-camera-closed.png') });
  await page.waitForTimeout(1000);
  await send.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#camera-shutter')).toBeEnabled();
  await page.getByRole('button', { name: '模擬光圈 f/16', exact: true }).click();
  await expect(page.locator('.camera-bokeh')).toBeHidden();
  await sendFrame('請描述第二張照片。');
  await expect(messages).toHaveCount(2);
  await expect(messages.last()).toContainText('請描述第二張照片。');
  await page.screenshot({ path: info.outputPath('03-second-photo-delivered.png') });
  await page.waitForTimeout(1000);
  await expect(pane).toBeHidden();
  await send.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#camera-shutter')).toBeEnabled();
  await expect.poll(() => pane.evaluate((el) => el.getAnimations().length)).toBe(0);
  const track = await page
    .locator('#camera-preview')
    .evaluateHandle((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0]);
  const view = (await page.locator('.camera-view').boundingBox())!;
  const startY = view.y + view.height / 2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 195, y: startY }],
  });
  for (const distance of [20, 40, 60]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 195, y: startY + distance }],
    });
    await page.waitForTimeout(300);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(pane).toBeHidden();
  expect(await track.evaluate((t) => t.readyState)).toBe('ended');
  await page.screenshot({ path: info.outputPath('04-pulled-down-closed.png') });
  await page.reload();
  await expect(messages).toHaveCount(2);
  const images = messages.locator('img');
  await expect(images).toHaveCount(3);
  for (const img of await images.all()) {
    const src = await img.getAttribute('src');
    const image = await context.request.get(new URL(src!, origin).href);
    expect(image.ok()).toBe(true);
    const bytes = await image.body();
    expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff');
  }
  await page.screenshot({ path: info.outputPath('04-reloaded-persisted.png') });
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);
});
