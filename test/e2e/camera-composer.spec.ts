import { expect, test } from 'playwright/test';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('camera split: drag open, resize, zoom, send snapshot and text, then close', async ({
  page,
}, info) => {
  const reopenCamera = async () => {
    await page.locator('#btn-send').focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#camera-shutter')).toBeEnabled();
    await expect
      .poll(() => page.locator('#camera-pane').evaluate((el) => el.getAnimations().length))
      .toBe(0);
  };
  const errors: string[] = [];
  const sent: any[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const session = {
    jid: 'web:camera',
    name: 'Camera test',
    kind: 'standard',
    busy: false,
    model: 'test',
    deleted: false,
  };
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/api/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/api/me') return route.fulfill({ json: { authed: true } });
    if (p === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (p.endsWith('/events'))
      return route.fulfill({
        json: {
          events: [
            {
              id: 1,
              kind: 'message',
              role: 'assistant',
              content: '把相機對準想問的東西，直接拍照送出；也可以先輸入問題。',
            },
          ],
          session,
          busy: false,
          hasMore: false,
        },
      });
    if (p.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (p.endsWith('/messages')) {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { models: [], commands: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator('#btn-send').boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const distance of [120, 220, 320]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - distance }],
    });
    await expect(page.locator('#camera-pane')).toBeVisible();
    await expect
      .poll(async () => {
        const pane = (await page.locator('#camera-pane').boundingBox())!;
        const divider = (await page.locator('#camera-divider').boundingBox())!;
        return Math.abs(pane.height + divider.height - distance);
      })
      .toBeLessThan(3);
  }
  await page.screenshot({ path: info.outputPath('00-follow-finger.png') });
  expect(sent).toHaveLength(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const spring = await page.locator('#camera-pane').evaluate((element) => {
    const effect = element.getAnimations()[0]?.effect as KeyframeEffect;
    return effect?.getKeyframes().map((k) => parseFloat(String(k.height)));
  });
  expect(spring).toHaveLength(4);
  expect(spring[1]).toBeGreaterThan(spring[3]);
  expect(spring[2]).toBeLessThan(spring[3]);
  await expect
    .poll(() => page.locator('#camera-preview').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(1);
  const expectBottomCamera = async () => {
    // Read all boxes in one frame; upload completion can hide the progress bar.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const camera = document.querySelector('#camera-pane')!.getBoundingClientRect();
          const composer = document.querySelector('#composer-wrap')!.getBoundingClientRect();
          const transcript = document.querySelector('#messages')!.getBoundingClientRect();
          return (
            transcript.bottom <= composer.top + 1 &&
            composer.bottom <= camera.top + 1 &&
            camera.bottom <= innerHeight + 1
          );
        }),
      )
      .toBe(true);
  };
  await expectBottomCamera();
  await expect
    .poll(async () => {
      const r = (await page.locator('.camera-view').boundingBox())!;
      return r.width / r.height;
    })
    .toBeCloseTo(2 / 3, 1);
  await expect(page.locator('.camera-bokeh')).toBeHidden();
  await expect(page.getByRole('button', { name: '模擬光圈 f/16', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({ path: info.outputPath('01-default-two-three.png') });
  await page.waitForTimeout(800);
  // Lens flips release both preview layers' previous stream.
  const oldTrack = await page
    .locator('#camera-preview')
    .evaluateHandle((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0]);
  await page.locator('#camera-flip').click();
  await expect
    .poll(() => page.locator('#camera-preview').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(1);
  expect(await oldTrack.evaluate((t) => t.readyState)).toBe('ended');
  await expect(page.locator('#camera-preview')).toHaveCSS('transform', 'matrix(-1, 0, 0, 1, 0, 0)');
  await page.locator('#camera-flip').click();
  await expect
    .poll(() => page.locator('#camera-preview').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(1);
  // Fuji controls: tap focus, radial simulated aperture, two-finger zoom.
  const view = (await page.locator('.camera-view').boundingBox())!;
  await page.touchscreen.tap(100, view.y + 150);
  await expect(page.locator('.camera-focus-ring')).toBeVisible();
  await expect(page.locator('.camera-aperture-label')).toContainText('模擬景深');
  const beforePinch = (await page.locator('#camera-pane').boundingBox())!.height;
  const pinchY = view.y + 200;
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
  expect((await page.locator('#camera-pane').boundingBox())!.height).toBeCloseTo(beforePinch, 0);
  expect(sent).toHaveLength(0);
  const wheel = page.locator('.camera-ap-track');
  const wheelBox = (await wheel.boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 290, y: wheelBox.y + 22 }],
  });
  for (let i = 1; i <= 8; i++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 290 - i * 22, y: wheelBox.y + 22 }],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => wheel.evaluate((el) => el.scrollLeft)).toBeGreaterThan(40);
  await page.getByRole('button', { name: '模擬光圈 f/16', exact: true }).click();
  await expect(page.locator('.camera-bokeh')).toBeHidden();
  await page.getByRole('button', { name: '模擬光圈 f/1.2', exact: true }).click();
  await expect(page.locator('.camera-bokeh')).toBeVisible();
  await page.screenshot({ path: info.outputPath('01b-fuji-focus-aperture-pinch.png') });
  const divider = page.locator('#camera-divider');
  const before = (await page.locator('#camera-pane').boundingBox())!.height;
  await divider.focus();
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () => (await page.locator('#camera-pane').boundingBox())!.height)
    .toBeGreaterThan(before);
  const split = (await divider.boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 195, y: split.y + 10 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 195, y: split.y - 50 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect
    .poll(async () => (await page.locator('#camera-pane').boundingBox())!.height)
    .toBeGreaterThan(before + 40);
  const viewBox = (await page.locator('.camera-view').boundingBox())!;
  const frameBox = (await page.locator('.camera-frame').boundingBox())!;
  expect(frameBox.width).toBeCloseTo(viewBox.width, 0);
  expect(frameBox.height).toBeCloseTo(viewBox.height, 0);
  await page.locator('#camera-zoom').fill('2');
  await page.locator('#camera-zoom').dispatchEvent('input');
  await page.screenshot({ path: info.outputPath('02-zoom-resize.png') });
  const captureView = (await page.locator('.camera-view').boundingBox())!;
  await page.locator('#camera-shutter').click();
  await page.locator('#camera-send').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].text).toContain('可以使用以圖搜尋或上網查證');
  expect(sent[0].attachments[0].dataBase64).toMatch(/^\/9j\//);
  const dimensions = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${data}`;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, sent[0].attachments[0].dataBase64);
  expect(dimensions.width).toBeGreaterThan(0);
  expect(Math.max(dimensions.width, dimensions.height)).toBeLessThanOrEqual(1920);
  expect(dimensions.width / dimensions.height).toBeCloseTo(
    captureView.width / captureView.height,
    1,
  );
  await expect(page.locator('#camera-pane')).toBeHidden();
  await reopenCamera();
  await expectBottomCamera();
  await page.setViewportSize({ width: 390, height: 540 });
  await page.locator('#camera-shutter').click();
  await page.locator('#input').fill('這是什麼？');
  const composerBox = (await page.locator('#composer').boundingBox())!;
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(540);
  await expectBottomCamera();
  await expect(page.locator('#camera-pane')).toBeVisible();
  await page.screenshot({ path: info.outputPath('03-type-with-camera.png') });
  await page.waitForTimeout(800);
  await page.locator('#camera-send').click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].text).toBe('這是什麼？');
  await expect(page.locator('#camera-pane')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await reopenCamera();
  const track = await page
    .locator('#camera-preview')
    .evaluateHandle((v: HTMLVideoElement) => (v.srcObject as MediaStream).getVideoTracks()[0]);
  const previewBox = (await page.locator('.camera-view').boundingBox())!;
  const startY = previewBox.y + previewBox.height / 2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 195, y: startY }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 195, y: startY + 60 }],
  });
  await expect(page.locator('#camera-pane')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#camera-pane')).toBeHidden();
  expect(await track.evaluate((t) => t.readyState)).toBe('ended');
  expect(
    await page.locator('#camera-preview').evaluate((v: HTMLVideoElement) => v.srcObject),
  ).toBeNull();
  await page.locator('#input').fill('文字訊息');
  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2].attachments).toEqual([]);
  await page.screenshot({ path: info.outputPath('04-closed.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Close button must animate rather than disappearing immediately.
  const reopen = async () => {
    await page.locator('#btn-send').focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#camera-pane')).toBeVisible();
    await expect
      .poll(() => page.locator('#camera-pane').evaluate((el) => el.getAnimations().length))
      .toBe(0);
  };
  await reopen();
  await page.locator('#camera-close').click();
  await expect(page.locator('#camera-pane')).toBeVisible();
  expect(
    await page.locator('#camera-pane').evaluate((el) => el.getAnimations().length),
  ).toBeGreaterThan(0);
  await expect(page.locator('#camera-pane')).toBeHidden();
  await reopen();
  // A slow adjustment stays open; a short fast downward flick dismisses.
  let grip = (await divider.boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 195, y: grip.y + 10 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 195, y: grip.y + 60 }],
  });
  await page.waitForTimeout(200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#camera-pane')).toBeVisible();
  grip = (await divider.boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 195, y: grip.y + 10 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 195, y: grip.y + 35 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: 195, y: grip.y + 65 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#camera-pane')).toBeHidden();
  expect(sent).toHaveLength(3);
  expect(errors).toEqual([]);
});

for (const mode of ['denied', 'late'] as const) {
  test(`camera ${mode} permission is safely cancellable`, async ({ page }) => {
    const session = {
      jid: 'web:camera',
      name: 'Camera test',
      kind: 'standard',
      busy: false,
      model: 'test',
      deleted: false,
    };
    await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
    await page.route('**/api/**', (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/api/me') return route.fulfill({ json: { authed: true } });
      if (p === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
      if (p.endsWith('/events'))
        return route.fulfill({
          json: {
            events: [
              {
                id: 1,
                kind: 'message',
                role: 'assistant',
                content: '把相機對準想問的東西，直接拍照送出；也可以先輸入問題。',
              },
            ],
            session,
            busy: false,
            hasMore: false,
          },
        });
      if (p.endsWith('/stream'))
        return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      if (p.endsWith('/messages')) {
        throw new Error('Unexpected send');
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { models: [], commands: [], sessions: [] } });
    });
    await page.goto('/');
    await expect(page.locator('#session-name')).toHaveText(session.name);

    await page.evaluate((mode) => {
      const w = window as typeof window & { releaseCamera?: () => void; stopped?: boolean };
      navigator.mediaDevices.getUserMedia = () =>
        mode === 'denied'
          ? Promise.reject(new DOMException('Denied', 'NotAllowedError'))
          : new Promise((resolve) => {
              w.releaseCamera = () =>
                resolve({
                  getTracks: () => [
                    {
                      stop: () => {
                        w.stopped = true;
                      },
                    },
                  ],
                } as unknown as MediaStream);
            });
    }, mode);
    await page.locator('#btn-send').focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#camera-pane')).toBeVisible();
    if (mode === 'denied') await expect(page.locator('#camera-status')).toContainText('無法開啟');
    await page.locator('#camera-close').click();
    if (mode === 'late') {
      await page.evaluate(() =>
        (window as typeof window & { releaseCamera: () => void }).releaseCamera(),
      );
      await expect
        .poll(() => page.evaluate(() => (window as typeof window & { stopped?: boolean }).stopped))
        .toBe(true);
    }
    await expect(page.locator('#camera-pane')).toBeHidden();
    await expect(page.locator('#input')).toBeEnabled();
  });
}
