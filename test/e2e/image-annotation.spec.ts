import { expect, test, type Page, type Locator } from 'playwright/test';

const session = {
  jid: 'web:annotation',
  name: 'Image annotation',
  model: 'claude-code/opus',
  provider: 'claude-code',
  kind: 'standard',
  deleted: false,
  busy: false,
};
const source = '/media/web_annotation/chart.svg';
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="white"/><text x="32" y="50" fill="#202020" font-size="24">Original chart</text></svg>';

// Presentation-only pacing for a human-readable recording; assertions never rely on it.
const recordWalkthrough = process.env.PIWEB_ANNOTATION_VIDEO === '1';
async function present(page: Page, ms = 1000) {
  if (recordWalkthrough) await page.waitForTimeout(ms);
}

async function setup(page: Page) {
  const requests: any[] = [];
  const events: any[] = [
    {
      id: 1,
      kind: 'message',
      role: 'assistant',
      createdAt: '2026-09-30T10:00:00Z',
      content: 'Mark the chart.',
      files: [source],
    },
  ];
  let uploadedImage: Buffer | undefined;
  await page.route('**/media/web_annotation/sent.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: uploadedImage!,
    }),
  );
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/media/web_annotation/chart.svg', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: svg }),
  );
  await page.route('**/api/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/messages') && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      requests.push(body);
      uploadedImage = Buffer.from(body.attachments[0].dataBase64, 'base64');
      events.push({
        id: 2,
        kind: 'message',
        role: 'user',
        createdAt: '2026-09-30T10:01:00Z',
        content: body.text,
        files: ['/media/web_annotation/sent.png'],
      });
      return route.fulfill({ status: 202, json: { ok: true } });
    }
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events,
          busy: false,
          session,
          hasMore: false,
          partial: null,
        },
      });
    if (path.endsWith('/media'))
      return route.fulfill({
        json: { items: [{ url: source, type: 'image', name: 'chart.svg' }] },
      });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await present(page);
  await page.locator('#input').fill('Please check my marks.');
  await present(page);
  await page.locator('#messages .msg-files img').click();
  await expect(page.locator('#lightbox')).toBeVisible();
  return requests;
}

async function reachable(target: Locator) {
  expect(
    await target.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === element || Boolean(hit && element.contains(hit));
    }),
  ).toBe(true);
}

async function draw(page: Page, touch: boolean) {
  const box = (await page.locator('#annotation-canvas').boundingBox())!;
  const points = [0.25, 0.35, 0.45, 0.55, 0.65].map((x) => ({
    x: box.x + box.width * x,
    y: box.y + box.height * 0.5,
  }));
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...points[0], id: 1 }],
    });
    for (const point of points.slice(1)) {
      await present(page, 150);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ ...point, id: 1 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    for (const point of points.slice(1)) {
      await present(page, 150);
      await page.mouse.move(point.x, point.y);
    }
    await page.mouse.up();
  }
}

async function centerPixel(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => [
    ...element.getContext('2d')!.getImageData(element.width / 2, element.height / 2, 1, 1).data,
  ]);
}

test('cancel fences a delayed image load and a delayed PNG export', async ({ page }) => {
  const requests = await setup(page);
  const edit = page.getByRole('button', { name: '畫筆標註', exact: true });
  const dialog = page.getByRole('dialog', { name: '圖片標註' });
  let releaseLoad!: () => void;
  let reachedLoad = false;
  const held = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const delayedLoad = async (route: import('playwright/test').Route) => {
    reachedLoad = true;
    await held;
    await route.fulfill({ contentType: 'image/svg+xml', body: svg }).catch(() => undefined);
  };
  await page.route('**/media/web_annotation/chart.svg', delayedLoad);
  await edit.click();
  await expect.poll(() => reachedLoad).toBe(true);
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: '確定加入附件' })).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  releaseLoad();
  await page.unroute('**/media/web_annotation/chart.svg', delayedLoad);
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#attachments .chip')).toHaveCount(0);
  await edit.click();
  await expect(page.getByRole('button', { name: '確定加入附件' })).toBeEnabled();
  await draw(page, true);
  await page.locator('#annotation-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const original = canvas.toBlob;
    canvas.toBlob = function (callback, ...args) {
      original.call(
        this,
        (blob) => {
          (window as any).releaseAnnotationExport = () => callback(blob);
        },
        ...args,
      );
    };
  });
  await page.getByRole('button', { name: '確定加入附件' }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseAnnotationExport))
    .toBe('function');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => (window as any).releaseAnnotationExport());
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#attachments .chip')).toHaveCount(0);
  await expect(page.locator('#input')).toHaveValue('Please check my marks.');
  expect(requests).toHaveLength(0);
});

test('Undo during an active touch cannot erase the previous completed stroke on cancellation', async ({
  page,
}) => {
  await setup(page);
  await page.getByRole('button', { name: '畫筆標註', exact: true }).click();
  const canvas = page.locator('#annotation-canvas');
  const undo = page.getByRole('button', { name: '復原', exact: true });
  await expect(canvas).toBeVisible();
  await draw(page, true);
  const completedPixel = await centerPixel(canvas);
  expect(completedPixel).not.toEqual([255, 255, 255, 255]);
  const box = (await canvas.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + box.width * 0.25, y: box.y + box.height * 0.25, id: 1 }],
  });
  const disabledDuringStroke = await undo.isDisabled();
  await page.keyboard.press('Control+z');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await cdp.detach();
  expect(await centerPixel(canvas)).toEqual(completedPixel);
  expect(disabledDuringStroke).toBe(true);
  await expect(undo).toBeEnabled();
  await undo.click();
  expect(await centerPixel(canvas)).toEqual([255, 255, 255, 255]);
});

test('large images export with a bounded bitmap and preserved aspect ratio', async ({ page }) => {
  await setup(page);
  await page.route('**/media/web_annotation/chart.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="8192" height="1024"><rect width="8192" height="1024" fill="white"/></svg>',
    }),
  );
  await page.getByRole('button', { name: '畫筆標註', exact: true }).click();
  await expect(page.getByRole('button', { name: '確定加入附件' })).toBeEnabled();
  expect(
    await page
      .locator('#annotation-canvas')
      .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]),
  ).toEqual([4096, 512]);
  await page.getByRole('button', { name: '確定加入附件' }).click();
  await expect(page.locator('#attachments img')).toBeVisible();
  expect(
    await page.locator('#attachments img').evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }),
  ).toEqual([4096, 512]);
});

for (const desktop of [false, true]) {
  test.describe(desktop ? 'desktop annotation' : 'mobile annotation', () => {
    test.use(
      desktop ? { viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false } : {},
    );
    test('draw, undo, cancel, confirm and send through normal image attachments', async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on('dialog', async (dialog) => {
        errors.push(`Unexpected dialog: ${dialog.message()}`);
        await dialog.dismiss();
      });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      const requests = await setup(page);
      const edit = page.getByRole('button', { name: '畫筆標註', exact: true });
      await expect(edit).toBeVisible();
      await reachable(edit);
      await present(page);
      await page.screenshot({
        path: info.outputPath('01-image-viewer.png'),
        animations: 'disabled',
      });
      await edit.click();
      const dialog = page.getByRole('dialog', { name: '圖片標註' });
      const canvas = page.locator('#annotation-canvas');
      await expect(dialog).toBeVisible();
      await expect(canvas).toBeVisible();
      // Editor actions share the viewer's ghost, monochrome outline-icon language.
      for (const name of ['取消', '確定加入附件', '復原', '清除']) {
        const action = dialog.getByRole('button', { name, exact: true });
        await expect(action.locator('svg')).toHaveCount(1);
        await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(action).toHaveCSS('border-top-width', '0px');
        await expect(action.locator('svg')).toHaveAttribute('stroke', 'currentColor');
        await expect(action.locator('svg')).toHaveAttribute('fill', 'none');
      }
      await expect(dialog.locator('select')).toHaveCSS('border-radius', '999px');
      await expect(page.getByRole('button', { name: '確定加入附件' })).toBeEnabled();
      expect(
        await dialog.evaluate((element) => {
          const r = element.getBoundingClientRect();
          return (
            r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
          );
        }),
      ).toBe(true);
      expect(
        await dialog.locator('button, select').evaluateAll((elements) =>
          elements
            .filter((element) => {
              const r = element.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
            })
            .map((element) => element.getAttribute('aria-label') || element.textContent),
        ),
      ).toEqual([]);
      await present(page);
      await page.screenshot({ path: info.outputPath('02-editor.png'), animations: 'disabled' });
      await draw(page, !desktop);
      expect(await centerPixel(canvas)).not.toEqual([255, 255, 255, 255]);
      await present(page);
      await page.getByRole('button', { name: '復原', exact: true }).click();
      expect(await centerPixel(canvas)).toEqual([255, 255, 255, 255]);
      await present(page);
      await draw(page, !desktop);
      await present(page);
      await page.getByRole('button', { name: '清除', exact: true }).click();
      expect(await centerPixel(canvas)).toEqual([255, 255, 255, 255]);
      await present(page);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.locator('#attachments .chip')).toHaveCount(0);
      await expect(page.locator('#lightbox')).toBeVisible();
      await present(page);
      await edit.click();
      await expect(page.getByRole('button', { name: '確定加入附件' })).toBeEnabled();
      await page.getByRole('button', { name: '藍色', exact: true }).click();
      await page.getByLabel('筆畫粗細').selectOption('8');
      await present(page);
      await draw(page, !desktop);
      const drawn = await centerPixel(canvas);
      expect(drawn[2]).toBeGreaterThan(drawn[0]);
      await present(page);
      await page.screenshot({ path: info.outputPath('03-drawn.png'), animations: 'disabled' });
      const confirm = page.getByRole('button', { name: '確定加入附件' });
      await reachable(confirm);
      await confirm.click();
      await expect(dialog).not.toBeVisible();
      await expect(page.locator('#lightbox')).toBeHidden();
      await expect(page.locator('#attachments .chip-image')).toHaveCount(1);
      await expect(page.locator('#input')).toHaveValue('Please check my marks.');
      expect(requests).toHaveLength(0); // Confirm queues a file; it never sends on its own.
      const exported = await page
        .locator('#attachments img')
        .evaluate(async (img: HTMLImageElement) => {
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d')!.drawImage(img, 0, 0);
          return {
            width: c.width,
            height: c.height,
            pixel: [...c.getContext('2d')!.getImageData(c.width / 2, c.height / 2, 1, 1).data],
          };
        });
      expect(exported).toEqual({ width: 640, height: 400, pixel: drawn });
      await present(page);
      await page.screenshot({
        path: info.outputPath('04-queued-attachment.png'),
        animations: 'disabled',
      });
      // Pending attachments can be opened and annotated too; cancelling keeps the existing file.
      await page.locator('#attachments img').click();
      await present(page);
      await edit.click();
      await expect(confirm).toBeEnabled();
      await present(page);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(page.locator('#lightbox')).toBeVisible();
      await page.locator('#lb-close').click();
      await expect(page.locator('#attachments .chip-image')).toHaveCount(1);
      await reachable(page.locator('#btn-send'));
      await present(page);
      await page.locator('#btn-send').click();
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0].text).toBe('Please check my marks.');
      expect(requests[0].attachments).toHaveLength(1);
      expect(requests[0].attachments[0].name).toMatch(/annotated.*\.png$/);
      const bytes = Buffer.from(requests[0].attachments[0].dataBase64, 'base64');
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.readUInt32BE(16)).toBe(640);
      expect(bytes.readUInt32BE(20)).toBe(400);
      await expect(page.locator('#attachments .chip')).toHaveCount(0);
      expect(await page.locator('#messages .msg-files img').getAttribute('src')).toBe(source);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      // Persist accepted test uploads at the API boundary and reload the real UI.
      // This is an isolated fixture, not a send into the user's real conversation.
      await page.reload();
      await expect(page.locator('#session-name')).toHaveText(session.name);
      expect(errors).toEqual([]);
      const sentImage = page.locator('#messages .msg-files img').last();
      await expect(sentImage).toHaveAttribute('src', '/media/web_annotation/sent.png');
      await expect(page.locator('#messages')).toContainText('Please check my marks.');
      expect(
        await sentImage.evaluate(async (img: HTMLImageElement) => {
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d')!.drawImage(img, 0, 0);
          return [...c.getContext('2d')!.getImageData(c.width / 2, c.height / 2, 1, 1).data];
        }),
      ).toEqual(drawn);
      await sentImage.scrollIntoViewIfNeeded();
      await present(page);
      await page.screenshot({ path: info.outputPath('05-sent.png'), animations: 'disabled' });
      expect(errors).toEqual([]);
    });
  });
}
