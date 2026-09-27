import { expect, test } from 'playwright/test';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const session = {
  jid: 'web:lightbox-album',
  name: 'Lightbox album',
  model: 'agy/gemini-3.1-pro-high',
  provider: 'agy',
  kind: 'standard',
  deleted: false,
  busy: false,
  badge: { label: 'AGY', kind: 'other' },
};

/** A solid-colour PNG, so each album entry is visibly distinct in the video. */
function png(r: number, g: number, b: number, w = 320, h = 200): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const colours: Record<string, Buffer> = {
  'old.png': png(200, 60, 60),
  'middle.png': png(60, 160, 80),
  'new.png': png(60, 90, 200),
};

// Only the middle image is in the loaded transcript page; the others are in
// the session album (older history, or not yet paged in).
const events = [
  {
    id: 1,
    kind: 'message',
    role: 'assistant',
    content: 'Here is the chart.',
    files: ['/media/web_lightbox-album/middle.png'],
    createdAt: '2026-09-26T09:00:00Z',
  },
];
const album = ['new.png', 'middle.png', 'old.png'].map((name, i) => ({
  url: `/media/web_lightbox-album/${name}`,
  name,
  eventId: 3 - i,
  createdAt: '2026-09-26T09:00:00Z',
  type: 'image',
}));

/** Real touch swipes over the viewer, the way the phone pages through the album. */
async function touchSwiper(page: import('playwright/test').Page, y = 420) {
  const cdp = await page.context().newCDPSession(page);
  return async (dx: number) => {
    const x0 = dx < 0 ? 300 : 90;
    const point = (x: number) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x0) });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x0 + (dx * i) / 8) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);
  };
}

test('tapping a transcript image opens the whole session album at that image', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/media/web_lightbox-album/*', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    return route.fulfill({ contentType: 'image/png', body: colours[name] });
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events, busy: false, session, hasMore: false, partial: null } });
    if (path.endsWith('/media')) return route.fulfill({ json: { items: album } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });

  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await page.waitForTimeout(600);
  await page.locator('#messages .msg-files img').click();

  // Starts on the tapped image, but the counter covers the whole album.
  await expect(page.locator('#lightbox')).toBeVisible();
  await expect(page.locator('#lb-count')).toHaveText('2 / 3');
  await expect(page.locator('#lb-img')).toHaveAttribute('src', /middle\.png$/);
  await expect(page.locator('#lb-strip .lb-thumb')).toHaveCount(3);
  await page.screenshot({ path: info.outputPath('01-opened-at-tapped-image.png') });
  await page.waitForTimeout(800);

  const swipe = await touchSwiper(page);
  await swipe(-200);
  await expect(page.locator('#lb-count')).toHaveText('3 / 3');
  await expect(page.locator('#lb-img')).toHaveAttribute('src', /new\.png$/);
  await page.waitForTimeout(800);
  await swipe(200);
  await expect(page.locator('#lb-count')).toHaveText('2 / 3');
  await swipe(200);
  await expect(page.locator('#lb-count')).toHaveText('1 / 3');
  await expect(page.locator('#lb-img')).toHaveAttribute('src', /old\.png$/);
  await page.screenshot({ path: info.outputPath('02-paged-to-oldest.png') });
  await page.waitForTimeout(800);
  expect(errors).toEqual([]);
});

const clip = readFileSync(new URL('./fixtures/media/demo-loop.webm', import.meta.url));

test('tapping a chat video opens it in the same album, between the images', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/media/web_lightbox-album/*', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    if (name === 'clip.webm') return route.fulfill({ contentType: 'video/webm', body: clip });
    return route.fulfill({ contentType: 'image/png', body: colours[name] });
  });
  const videoEvents = [
    ...events,
    {
      id: 2,
      kind: 'message',
      role: 'assistant',
      content: 'And the clip.',
      files: ['/media/web_lightbox-album/clip.webm'],
      createdAt: '2026-09-26T09:01:00Z',
    },
  ];
  // Newest first, as the API returns it: new, clip, middle, old.
  const mixed = ['new.png', 'clip.webm', 'middle.png', 'old.png'].map((name, i) => ({
    url: `/media/web_lightbox-album/${name}`,
    name,
    eventId: 4 - i,
    createdAt: '2026-09-26T09:00:00Z',
    type: name.endsWith('.webm') ? 'video' : 'image',
  }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: videoEvents, busy: false, session, hasMore: false, partial: null } });
    if (path.endsWith('/media')) return route.fulfill({ json: { items: mixed } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });

  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  const poster = page.getByRole('button', { name: 'Open video clip.webm' });
  await expect(poster).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath('01-chat-video-poster.png') });
  await poster.click();

  // Opens on the video, inside the full album.
  const lbVideo = page.locator('#lb-video');
  await expect(page.locator('#lightbox')).toBeVisible();
  await expect(page.locator('#lb-count')).toHaveText('3 / 4');
  await expect(lbVideo).toBeVisible();
  await expect(page.locator('#lb-img')).toBeHidden();
  await expect(lbVideo).toHaveAttribute('src', /clip\.webm$/);
  await expect.poll(() => lbVideo.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  await expect(page.locator('#lb-strip .lb-thumb-play')).toHaveCount(1);
  // Metadata alone does not prove the clip decodes and actually plays.
  await lbVideo.evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => lbVideo.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.1);
  expect(await lbVideo.evaluate((v: HTMLVideoElement) => v.error)).toBeNull();
  await page.waitForTimeout(800);
  await page.screenshot({ path: info.outputPath('02-video-in-album.png') });

  // Swipe (above the control band) to the newer image; the video stops.
  const swipe = await touchSwiper(page, 200);
  await swipe(-200);
  await expect(page.locator('#lb-count')).toHaveText('4 / 4');
  await expect(page.locator('#lb-img')).toBeVisible();
  await expect(page.locator('#lb-img')).toHaveAttribute('src', /new\.png$/);
  await expect(lbVideo).toBeHidden();
  expect(await lbVideo.getAttribute('src')).toBeNull();
  await page.screenshot({ path: info.outputPath('03-swiped-to-image.png') });

  await swipe(200);
  await swipe(200);
  await expect(page.locator('#lb-count')).toHaveText('2 / 4');
  await expect(page.locator('#lb-img')).toHaveAttribute('src', /middle\.png$/);
  await swipe(-200);
  await expect(page.locator('#lb-count')).toHaveText('3 / 4');
  await expect(lbVideo).toBeVisible();
  await page.waitForTimeout(600);

  await page.locator('#lb-close').click();
  await expect(page.locator('#lightbox')).toBeHidden();
  expect(await lbVideo.getAttribute('src')).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
