import { expect, test, type Page } from 'playwright/test';
import { deflateSync } from 'node:zlib';

// iPhone, 2026-11-24 (landscape screenshot of the viewer, filmstrip circled):
// 「把這個設計成可以蓋到圖片，但是點一下中間的圖片他會消失（淡淡的消失），儘量滿版」.
// The picture gets the whole screen; the bar and filmstrip lie over it, and a
// tap on the picture fades them away (another brings them back).

const session = {
  jid: 'web:lightbox-chrome',
  name: 'Lightbox chrome',
  model: 'agy/gemini-3.1-pro-high',
  provider: 'agy',
  kind: 'standard',
  deleted: false,
  busy: false,
  badge: { label: 'AGY', kind: 'other' },
};

/** A wide chart-like PNG: light background with coloured bars. */
function png(w: number, h: number, seed: number): Buffer {
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
  const palette = [
    [228, 87, 70],
    [240, 150, 60],
    [70, 190, 130],
    [60, 140, 220],
    [150, 100, 200],
  ];
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const bar = Math.floor(x / (w / 10));
      const top = h * (0.15 + ((bar * 37 + seed * 11) % 60) / 100);
      const inBar = x % (w / 10) > w / 60 && y > top && y < h * 0.92;
      const [r, g, b] = inBar ? palette[(bar + seed) % palette.length] : [250, 250, 248];
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const names = Array.from({ length: 8 }, (_, i) => `chart-${i + 1}.png`);
const images = Object.fromEntries(names.map((name, i) => [name, png(1200, 560, i)]));
const events = [
  {
    id: 1,
    kind: 'message',
    role: 'assistant',
    content: 'Charts.',
    files: names.map((name) => `/media/web_lightbox-chrome/${name}`),
    createdAt: '2026-11-24T09:00:00Z',
  },
];

async function openViewer(page: Page, width: number, height: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height });
  await page.addInitScript((value) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.theme', value);
  }, theme);
  await page.route('**/media/web_lightbox-chrome/*', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    return route.fulfill({ contentType: 'image/png', body: images[name] });
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events, busy: false, session, hasMore: false, partial: null } });
    if (path.endsWith('/media')) return route.fulfill({ json: { items: [] } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await page.waitForTimeout(400);
  await page.locator('#messages .msg-files img').nth(3).click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await expect(page.locator('#lb-count')).toHaveText('4 / 8');
  await expect.poll(() => page.locator('#lb-img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1200);
  await page.waitForTimeout(400);
}

/** What the controls look like: fully shown (1) or faded away (0, no touches). */
async function chrome(page: Page) {
  return page.evaluate(() =>
    ['.lb-bar', '.lb-strip'].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return `${style.opacity}/${style.visibility}`;
    }),
  );
}

async function tapCentre(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

for (const [width, height, theme] of [
  [844, 390, 'dark'],
  [844, 390, 'light'],
  [390, 844, 'dark'],
  [390, 844, 'light'],
] as const) {
  test(`the picture fills the screen under the controls, and a tap fades them (${width}x${height} ${theme})`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openViewer(page, width, height, theme);

    // The stage is the whole screen; the bar and the strip lie over it.
    const stage = (await page.locator('#lb-stage').boundingBox())!;
    expect(stage).toEqual({ x: 0, y: 0, width, height });
    const img = (await page.locator('#lb-img').boundingBox())!;
    // As large as the screen allows: no margin on the axis it fills.
    expect(Math.max(img.width / width, img.height / height)).toBeGreaterThan(0.995);
    if (width > height) {
      // Landscape: as tall as the screen allows, so the controls lie over it.
      const bar = (await page.locator('.lb-bar').boundingBox())!;
      const strip = (await page.locator('.lb-strip').boundingBox())!;
      expect(bar.y + bar.height).toBeGreaterThan(img.y);
      expect(strip.y).toBeLessThan(img.y + img.height);
    }
    expect(await chrome(page)).toEqual(['1/visible', '1/visible']);
    await page.screenshot({ path: info.outputPath(`01-controls-${width}x${height}-${theme}.png`) });

    // One tap on the picture: the controls fade away; the viewer stays.
    await tapCentre(page, '#lb-img');
    await page.waitForTimeout(450);
    const mid = await chrome(page);
    await page.waitForTimeout(300);
    expect(await chrome(page)).toEqual(['0/hidden', '0/hidden']);
    expect(mid).not.toEqual(['1/visible', '1/visible']);
    await expect(page.locator('#lightbox')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`02-picture-only-${width}x${height}-${theme}.png`) });

    // Hidden controls take no touches: a tap where the close button was does not close.
    const close = await page.locator('#lb-close').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.touchscreen.tap(close.x, close.y);
    await page.waitForTimeout(700);
    await expect(page.locator('#lightbox')).toBeVisible();
    // ... and that tap (the picture or the backdrop) brought them back.
    expect(await chrome(page)).toEqual(['1/visible', '1/visible']);

    // Another tap on the picture hides them again; a tap on it brings them back.
    await tapCentre(page, '#lb-img');
    await page.waitForTimeout(700);
    expect(await chrome(page)).toEqual(['0/hidden', '0/hidden']);
    await tapCentre(page, '#lb-img');
    await page.waitForTimeout(700);
    expect(await chrome(page)).toEqual(['1/visible', '1/visible']);
    expect(errors).toEqual([]);
  });
}

test('a double tap zooms and leaves the controls as they were', async ({ page }) => {
  await openViewer(page, 390, 844, 'dark');
  const box = (await page.locator('#lb-img').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(120);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(800);
  const zoomed = (await page.locator('#lb-img').boundingBox())!;
  expect(zoomed.width).toBeGreaterThan(box.width * 2);
  expect(await chrome(page)).toEqual(['1/visible', '1/visible']);
});

test('with the controls showing, a tap on the backdrop still closes the viewer', async ({ page }) => {
  await openViewer(page, 390, 844, 'dark');
  const img = (await page.locator('#lb-img').boundingBox())!;
  // Below the picture, above the filmstrip: plain backdrop.
  const strip = (await page.locator('.lb-strip').boundingBox())!;
  await page.touchscreen.tap(195, (img.y + img.height + strip.y) / 2);
  await expect(page.locator('#lightbox')).toBeHidden();
});
