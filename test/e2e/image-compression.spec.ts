import { expect, test, type Page } from 'playwright/test';

test.use({ launchOptions: { slowMo: process.env.PIWEB_RECORD_VIDEO === '1' ? 150 : 0 } });

type Upload = { text: string; attachments: { name: string; dataBase64: string }[] };
const session = {
  jid: 'web:image-test',
  name: 'Image upload',
  folder: 'web_image_test',
  kind: 'standard',
  deleted: false,
  busy: false,
  lastReplyId: 1,
};

async function setup(page: Page) {
  const uploads: Upload[] = [];
  await page.route('**/api/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (route.request().method() === 'POST') {
      if (path.endsWith('/messages')) uploads.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events: [
            {
              id: 1,
              kind: 'message',
              role: 'user',
              content: 'Attachment test',
              files: [],
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          busy: false,
          hasMore: false,
          session,
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  await expect(page.getByText('Attachment test', { exact: true })).toBeVisible();
  return uploads;
}

async function image(page: Page, width: number, height: number, mimeType = 'image/png') {
  const data = await page.evaluate(
    ({ width, height, mimeType }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#268';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'white';
      ctx.font = '40px sans-serif';
      ctx.fillText('Piweb image 22.6W', 8, 60);
      return canvas.toDataURL(mimeType).split(',')[1];
    },
    { width, height, mimeType },
  );
  return {
    name: mimeType === 'image/png' ? 'screenshot.png' : 'photo.jpg',
    mimeType,
    buffer: Buffer.from(data, 'base64'),
  };
}

async function send(page: Page) {
  const button = page.getByRole('button', { name: 'Send', exact: true });
  expect(
    await button.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return (
        r.width >= 44 &&
        r.height >= 44 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight &&
        (hit === node || node.contains(hit))
      );
    }),
  ).toBe(true);
  await button.click();
}

async function dimensions(page: Page, attachment: Upload['attachments'][number]) {
  return page.evaluate(async (a) => {
    const bytes = Uint8Array.from(atob(a.dataBase64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const result = [bitmap.width, bitmap.height];
    bitmap.close();
    return result;
  }, attachment);
}

test('compresses picker and pasted images before upload; checkbox restores original bytes', async ({
  page,
}, info) => {
  if (process.env.PIWEB_RECORD_VIDEO === '1') test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const uploads = await setup(page);
  const portrait = await image(page, 1057, 2052);
  await page.locator('#file-input').setInputFiles(portrait);
  const checkbox = page.getByRole('checkbox', { name: '壓縮圖片' });
  await page.locator('#input').fill('直式：1057×2052 → 528×1025；預設壓縮');
  await expect(checkbox).toBeChecked();
  await expect(page.locator('#image-compression-options')).toContainText('541,200');
  await expect(page.locator('#image-compression-options')).not.toContainText('最長邊');
  const label = page.locator('label[for="compress-images"]');
  expect(
    await label.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.height >= 44 && (node === hit || node.contains(hit));
    }),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('01-compression-default.png') });
  await send(page);
  await expect.poll(() => uploads.length).toBe(1);
  expect(await dimensions(page, uploads[0].attachments[0])).toEqual([528, 1025]);
  expect(uploads[0].attachments[0].dataBase64).not.toBe(portrait.buffer.toString('base64'));

  await expect(page.locator('#btn-send')).toBeEnabled();
  await page.locator('#file-input').setInputFiles(portrait);
  await checkbox.uncheck();
  await page.locator('#input').fill('取消壓縮：原始1057×2052，檔案位元組不變');
  await page.screenshot({ path: info.outputPath('02-original-selected.png') });
  await send(page);
  await expect.poll(() => uploads.length).toBe(2);
  expect(uploads[1].attachments[0].dataBase64).toBe(portrait.buffer.toString('base64'));
  expect(await dimensions(page, uploads[1].attachments[0])).toEqual([1057, 2052]);

  await page.reload();
  await expect(page.getByText('Attachment test', { exact: true })).toBeVisible();
  const landscape = await image(page, 2052, 1057, 'image/jpeg');
  await page.evaluate(
    ({ data, name, type }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type }));
      document
        .querySelector('#input')!
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
    },
    { data: landscape.buffer.toString('base64'), name: landscape.name, type: landscape.mimeType },
  );
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.locator('#input').fill('貼上橫式 JPEG：2052×1057 → 1025×528');
  await send(page);
  await expect.poll(() => uploads.length).toBe(3);
  expect(await dimensions(page, uploads[2].attachments[0])).toEqual([1025, 528]);
  expect(uploads[2].attachments[0].name).toMatch(/\.jpe?g$/);

  await expect(page.locator('#btn-send')).toBeEnabled();
  // Real JPEG EXIF orientation 6: decode must rotate before calculating size.
  const exif = Buffer.alloc(36);
  exif.writeUInt16BE(0xffe1, 0);
  exif.writeUInt16BE(34, 2);
  Buffer.from('Exif\0\0').copy(exif, 4);
  exif.write('II', 10, 'ascii');
  exif.writeUInt16LE(42, 12);
  exif.writeUInt32LE(8, 14);
  exif.writeUInt16LE(1, 18);
  exif.writeUInt16LE(0x112, 20);
  exif.writeUInt16LE(3, 22);
  exif.writeUInt32LE(1, 24);
  exif.writeUInt16LE(6, 28);
  const rotated = {
    ...landscape,
    buffer: Buffer.concat([landscape.buffer.subarray(0, 2), exif, landscape.buffer.subarray(2)]),
  };
  await page.locator('#file-input').setInputFiles(rotated);
  await page.locator('#input').fill('EXIF 旋轉 JPEG：先修正方向，再等比例縮圖');
  await send(page);
  await expect.poll(() => uploads.length).toBe(4);
  expect(await dimensions(page, uploads[3].attachments[0])).toEqual([528, 1025]);

  await expect(page.locator('#btn-send')).toBeEnabled();
  const small = await image(page, 200, 100);
  const document = {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('keep original document'),
  };
  const gif = {
    name: 'animation.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  };
  await page.locator('#file-input').setInputFiles([small, document, gif]);
  await page.locator('#input').fill('小圖、文字與GIF：全部保留原始檔案');
  await expect(checkbox).toBeChecked();
  await page.screenshot({ path: info.outputPath('03-mixed-attachments.png') });
  await send(page);
  await expect.poll(() => uploads.length).toBe(5);
  expect(uploads[4].attachments.map((a) => a.dataBase64)).toEqual(
    [small, document, gif].map((f) => f.buffer.toString('base64')),
  );
  // Pixel-budget regressions: these must NOT all have a 1025px long edge.
  const cases = [
    { width: 4032, height: 3024, expected: [849, 637], name: '4:3 landscape' },
    { width: 2000, height: 2000, expected: [735, 735], name: 'square' },
    { width: 1080, height: 2410, expected: [492, 1099], name: 'tall screenshot' },
    { width: 2000, height: 200, expected: [2000, 200], name: 'small-area panorama' },
  ];
  for (const [index, c] of cases.entries()) {
    await expect(page.locator('#btn-send')).toBeEnabled();
    const source = await image(page, c.width, c.height);
    await page.locator('#file-input').setInputFiles(source);
    await page
      .locator('#input')
      .fill(`${c.name}: ${c.width}×${c.height} → ${c.expected.join('×')}`);
    await expect(checkbox).toBeChecked();
    await page.screenshot({ path: info.outputPath(`04-area-${index}.png`) });
    const before = uploads.length;
    await send(page);
    await expect.poll(() => uploads.length).toBe(before + 1);
    const actual = await dimensions(page, uploads[before].attachments[0]);
    expect(actual).toEqual(c.expected);
    expect(actual[0] * actual[1]).toBeLessThanOrEqual(541200);
    if (c.width * c.height <= 541200) {
      expect(uploads[before].attachments[0].dataBase64).toBe(source.buffer.toString('base64'));
    }
  }
  await info.attach('verified-payload-dimensions.json', {
    body: JSON.stringify(
      await Promise.all(
        uploads.map(async (u) => ({
          text: u.text,
          images: await Promise.all(
            u.attachments
              .filter((a) => /\.(png|jpe?g|gif)$/.test(a.name))
              .map(async (a) => ({ name: a.name, dimensions: await dimensions(page, a) })),
          ),
        })),
      ),
      null,
      2,
    ),
    contentType: 'application/json',
  });
  await expect(page.locator('#btn-send')).toBeEnabled();
  await page.locator('#file-input').setInputFiles(portrait);
  await page.locator('#input').fill('測試完成：以541,200總像素為上限，不再限制最長邊');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('05-mobile-finished.png') });
  expect(errors).toEqual([]);
});

test('pixel-budget checkbox remains contained on desktop', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setup(page);
  await page.locator('#file-input').setInputFiles(await image(page, 2000, 2000));
  await expect(page.getByRole('checkbox', { name: '壓縮圖片' })).toBeVisible();
  await expect(page.locator('#image-compression-options')).toContainText('541,200');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('desktop.png') });
});
