import { createServer, type Server, type ServerResponse } from 'node:http';
import { expect, test, type Page } from 'playwright/test';
import { placeQueries } from '../../public/place-map.js';

// The user, 2026-11-28 (a Life reply listing this weekend's markets and fairs,
// each with its venue): 「如果有偵測到地址，他就會 embedded google map pin 著，如果
// 有多個地址就一起 pin in same map」, then 「你可以用 system prompt drive agent 回覆
// 的時候要滿足某種特別的格式，他就會把多個地址包起來」, then of Google's route
// embed 「這個很醜，改好看一點」, then of the list under the map 「重新設計這個東西」.
// A Pi reply ends with a ```map block, one `name | address` per line; the
// transcript shows one still map in the app's colours with a numbered pin per
// place and, over its foot, a card per place: one in view, a swipe or a pin
// for the next. A card opens the place in Google Maps, its arrow directions. The geocoder (Nominatim) and the
// map style are faked: the test records what the page asks them.

const JID = 'web:map01';
const session = {
  jid: JID,
  name: '週末市集',
  folder: 'web_map01',
  kind: 'standard',
  deleted: false,
  badge: { label: 'SOL', kind: 'sol' },
  busy: false,
  lastReplyId: 2,
  lastActivity: '2026-11-28 01:00:00',
};

// Made-up coordinates: north to south, 1 → 3. Photon knows venues by name;
// Nominatim (KNOWN) knows streets, and some names too.
const PHOTON_KNOWN: Record<string, [number, number]> = {
  中埔穀倉農創園區: [23.447, 120.494],
  總爺藝文中心: [23.186, 120.269],
};
const KNOWN: Record<string, [number, number]> = {
  中埔穀倉農創園區: [23.447, 120.494],
  總爺藝文中心: [23.186, 120.269],
  '臺南市中西區民族路二段': [22.997, 120.201],
};
const PLACES = [
  { name: '中埔穀倉農創園區', address: '嘉義縣中埔鄉頂山門36號' },
  { name: '總爺藝文中心', address: '臺南市麻豆區南勢里總爺5號' },
  // Neither the event nor the house number is known: the street is.
  { name: '府城市集', address: '臺南市中西區民族路二段76號' },
];
const block = (places: { name: string; address: string }[]) =>
  ['```map', ...places.map((p) => (p.address ? `${p.name} | ${p.address}` : p.name)), '```'].join('\n');
const REPLY = [
  '這週末可以去：',
  '',
  '- **中埔穀倉 11–12月市集** — 11/21–12/20，中埔穀倉農創園區，免費',
  '- **2026 Mattauw大地藝術季** — 9/5–12/6，麻豆總爺藝文中心',
  '- **府城市集** — 11/29（六），民族路二段',
  '',
  block(PLACES),
].join('\n');

const searchUrl = (p: { name: string; address: string }) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address ? `${p.name} ${p.address}` : p.name)}`;
const directionsUrl = (p: { name: string; address: string }) =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.address ? `${p.name} ${p.address}` : p.name)}`;

/** Fake Nominatim, Photon and map style; Google Maps pages for the links. */
async function fakeServices(page: Page) {
  const lookups: Array<{ q: string; at: number }> = [];
  const photon: Array<{ q: string; at: number }> = [];
  const styles: string[] = [];
  await page.context().route('https://photon.komoot.io/**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    photon.push({ q, at: Date.now() });
    const hit = PHOTON_KNOWN[q];
    return route.fulfill({
      json: { type: 'FeatureCollection', features: hit ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [hit[1], hit[0]] }, properties: { name: q } }] : [] },
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.context().route('https://nominatim.openstreetmap.org/**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    lookups.push({ q, at: Date.now() });
    const hit = KNOWN[q];
    return route.fulfill({
      json: hit ? [{ lat: String(hit[0]), lon: String(hit[1]), display_name: q }] : [],
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.context().route('https://tiles.openfreemap.org/styles/**', (route) => {
    styles.push(new URL(route.request().url()).pathname);
    const dark = route.request().url().endsWith('/fiord');
    return route.fulfill({
      json: { version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': dark ? '#3b4a5a' : '#dfe6da' } }] },
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.context().route('https://www.google.com/maps/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Google Maps</title>' }),
  );
  return { lookups, photon, styles };
}

async function routeApi(page: Page, events: unknown[], ssePort?: number) {
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('http://127.0.0.1:*/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events, busy: false, hasMore: false, partial: null, session } });
    if (path.endsWith('/stream')) {
      if (ssePort) return route.continue({ url: `http://127.0.0.1:${ssePort}/stream?${url.searchParams}` });
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    }
    return route.fulfill({ json: { ok: true, commands: [], models: [], items: [] } });
  });
}

async function open(page: Page, theme = 'dark') {
  await page.addInitScript((t) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.dashboardEnabled', 'false');
    localStorage.setItem('piweb.theme', t);
  }, theme);
  await page.goto('/');
  await expect(page.locator('#messages')).toBeVisible();
}

const reply = (content: string) => [
  { id: 1, kind: 'message', role: 'user', content: '這週末台南嘉義有什麼市集？', createdAt: '2026-11-28T01:00:00Z' },
  { id: 2, kind: 'message', role: 'assistant', content, createdAt: '2026-11-28T01:01:00Z' },
];

/** Each pin's centre relative to the map, and where the cards begin. */
const pinCentres = (page: Page) =>
  page.locator('#messages .place-map').evaluate((card) => {
    const view = card.querySelector('.place-map-view')!.getBoundingClientRect();
    const cards = card.querySelector('.place-map-cards')!.getBoundingClientRect();
    return [...card.querySelectorAll<HTMLElement>('.place-map-marker')].map((pin) => {
      const r = pin.getBoundingClientRect();
      return {
        n: pin.textContent,
        x: r.left + r.width / 2 - view.left,
        y: r.top + r.height / 2 - view.top,
        w: view.width,
        cardsTop: cards.top - view.top,
      };
    });
  });

/** Which card is fully in view across the map, and which pin stands out. */
const inFront = (page: Page) =>
  page.locator('#messages .place-map').evaluate((card) => {
    const frame = card.getBoundingClientRect();
    const shown = [...card.querySelectorAll<HTMLElement>('.place-map-card')].findIndex((item) => {
      const r = item.getBoundingClientRect();
      return r.left >= frame.left - 1 && r.right <= frame.right + 1;
    });
    const active = [...card.querySelectorAll<HTMLElement>('.place-map-card')].findIndex((item) => item.dataset.active);
    const pressed = card.querySelector('.place-map-marker[aria-pressed="true"]')?.textContent ?? null;
    return { shown, active, pressed };
  });

test('a reply\'s places are numbered pins on one map with a card each over its foot', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { lookups, photon, styles } = await fakeServices(page);
  await routeApi(page, reply(REPLY));
  await open(page);

  const card = page.locator('#messages .place-map');
  await expect(card).toHaveCount(1);
  const shownAt = Date.now();
  // The block is the map, not a code listing of its lines.
  await expect(page.locator('#messages .msg-text pre')).toHaveCount(0);
  // The list is there at once; the map once the places are found.
  await expect(card.locator('.place-map-name')).toHaveText(PLACES.map((p) => p.name));
  await expect(card.locator('.place-map-address')).toHaveText(PLACES.map((p) => p.address));
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  // Five lookups one a second took over five seconds; names and streets side by side, about one.
  expect(Date.now() - shownAt).toBeLessThan(3500);
  expect(styles).toEqual(['/styles/fiord']);

  // 「那個地圖要載入好久」: every name goes to Photon at once (it knows venues);
  // Nominatim, one request a second as its policy asks, takes the streets
  // (OpenStreetMap rarely has Taiwan's house numbers) of the places Photon did
  // not know, and never a name Photon found.
  expect(photon.map((l) => l.q).sort()).toEqual(PLACES.map((p) => p.name).sort());
  expect(photon.at(-1)!.at - photon[0].at).toBeLessThan(500);
  const asked = lookups.map((l) => l.q);
  expect(asked).toContain('臺南市中西區民族路二段');
  for (const q of ['中埔穀倉農創園區', '總爺藝文中心', '府城市集', '臺南市中西區民族路二段76號']) expect(asked).not.toContain(q);
  for (let i = 1; i < lookups.length; i++) expect(lookups[i].at - lookups[i - 1].at).toBeGreaterThanOrEqual(1000);

  // Three pins, numbered as the cards, inside the frame and clear of the cards
  // over its foot, north above south and east right of west, as the places lie.
  const pins = await pinCentres(page);
  expect(pins.map((p) => p.n)).toEqual(['1', '2', '3']);
  for (const p of pins) {
    expect(p.x).toBeGreaterThanOrEqual(12);
    expect(p.x).toBeLessThanOrEqual(p.w - 12);
    expect(p.y).toBeGreaterThanOrEqual(30);
    expect(p.y).toBeLessThanOrEqual(p.cardsTop - 16);
  }
  expect(pins[0].y).toBeLessThan(pins[1].y);
  expect(pins[1].y).toBeLessThan(pins[2].y);
  expect(pins[0].x).toBeGreaterThan(pins[1].x);
  expect(pins[1].x).toBeGreaterThan(pins[2].x);

  // The first place is in front: its card in view, its pin standing out.
  expect(await inFront(page)).toEqual({ shown: 0, active: 0, pressed: '1' });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('place-map-dark.png') });
  // A pin brings its card...
  await card.locator('.place-map-marker', { hasText: '3' }).click();
  await expect.poll(() => inFront(page)).toEqual({ shown: 2, active: 2, pressed: '3' });
  // ...and a swipe through the cards moves the pins.
  await card.locator('.place-map-cards').evaluate((strip) => {
    const items = strip.querySelectorAll<HTMLElement>('.place-map-card');
    strip.scrollTo({ left: items[1].offsetLeft - items[0].offsetLeft, behavior: 'instant' });
  });
  await expect.poll(() => inFront(page)).toEqual({ shown: 1, active: 1, pressed: '2' });
  await page.screenshot({ path: info.outputPath('place-map-dark-second.png') });

  // A swipe on the cards is theirs: the drawer and Life edge gestures never see it.
  expect(
    await card.locator('.place-map-cards').evaluate((strip) => {
      let seen = 0;
      const count = () => seen++;
      document.addEventListener('touchstart', count);
      const r = strip.getBoundingClientRect();
      const touch = new Touch({ identifier: 1, target: strip, clientX: r.right - 20, clientY: r.top + 20 });
      strip.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch], changedTouches: [touch] }));
      document.removeEventListener('touchstart', count);
      return seen;
    }),
  ).toBe(0);

  // A card opens the place in Google Maps, its arrow directions to it; 44px targets.
  const mains = card.locator('.place-map-card-main');
  const gos = card.locator('.place-map-go');
  for (const [i, place] of PLACES.entries()) {
    await expect(mains.nth(i)).toHaveAttribute('href', searchUrl(place));
    await expect(gos.nth(i)).toHaveAttribute('href', directionsUrl(place));
  }
  expect((await mains.nth(1).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await gos.nth(1).boundingBox()).toMatchObject({ width: 44, height: 44 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);

  const [opened] = await Promise.all([page.context().waitForEvent('page'), mains.nth(1).click()]);
  expect(opened.url()).toBe(searchUrl(PLACES[1]));
  await opened.close();
  const [route] = await Promise.all([page.context().waitForEvent('page'), gos.nth(1).click()]);
  expect(route.url()).toBe(directionsUrl(PLACES[1]));
  await route.close();
  // Opened, not copied (a transcript link copies on tap).
  await expect(page.locator('#toast')).toBeHidden();

  // The theme switch redraws in the day colours; the places are not asked again.
  const lookedUp = lookups.length + photon.length;
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await expect.poll(() => styles).toEqual(['/styles/fiord', '/styles/positron']);
  await expect(card).toHaveAttribute('data-state', 'ready');
  await page.waitForTimeout(800);
  await page.screenshot({ path: info.outputPath('place-map-light.png') });

  // A reload finds them in this browser's cache.
  await page.reload();
  await expect(page.locator('#messages .place-map')).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  expect(lookups.length + photon.length).toBe(lookedUp);
  expect(errors).toEqual([]);
});

// 「想要手指可以自由操作地圖」 (2026-11-28): in the transcript the map is a picture
// (a finger on it scrolls the transcript); a tap opens it full screen as a live
// map that a finger drags and a pinch (here the wheel) zooms, with the cards.
test('a tap opens the map full screen, where it moves with the finger and zooms', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await fakeServices(page);
  await routeApi(page, reply(REPLY));
  await open(page);
  const card = page.locator('#messages .place-map');
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  const canvases = await page.locator('canvas').count();
  const appClass = await page.locator('#app').getAttribute('class');

  await card.locator('.place-map-view').click();
  const viewer = page.locator('.place-map-viewer');
  await expect(viewer).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  await expect(viewer).toHaveAttribute('role', 'dialog');
  await expect(viewer.locator('.maplibregl-canvas')).toHaveCount(1);
  // Opening the map is not the transcript's tap for full-screen reading.
  expect(await page.locator('#app').getAttribute('class')).toBe(appClass);
  expect(await viewer.locator('.place-map-viewer-close').evaluate((el) => [el.offsetWidth, el.offsetHeight])).toEqual([44, 44]);
  const pins = viewer.locator('.place-map-marker');
  await expect(pins).toHaveText(['1', '2', '3']);
  await expect(viewer.locator('.place-map-marker[aria-pressed="true"]')).toHaveText('1');
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('viewer-open.png') });

  const centre = async (n: number) => {
    const box = (await pins.nth(n).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  // A drag moves the map, pins and all, with the finger.
  const map = (await viewer.locator('.place-map-viewer-map').boundingBox())!;
  const before = await centre(0);
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 3);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width / 2 - 60, map.y + map.height / 3 + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const after = await centre(0);
  // (MapLibre waits out a few pixels before a drag, and lets it glide on after.)
  expect(Math.abs(after.x - before.x + 60)).toBeLessThan(15);
  expect(Math.abs(after.y - before.y - 50)).toBeLessThan(15);
  // Zooming in spreads the pins apart.
  const spread = async () => {
    const [a, b] = [await centre(0), await centre(1)];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const near = await spread();
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(900);
  expect(await spread()).toBeGreaterThan(near * 1.3);

  // A card in front brings its place to the middle of the map.
  await viewer.locator('.place-map-cards').evaluate((strip) => {
    const items = strip.querySelectorAll<HTMLElement>('.place-map-card');
    strip.scrollTo({ left: items[2].offsetLeft - items[0].offsetLeft, behavior: 'instant' });
  });
  await expect(viewer.locator('.place-map-marker[aria-pressed="true"]')).toHaveText('3');
  await page.waitForTimeout(800);
  expect(Math.abs((await centre(2)).x - map.x - map.width / 2)).toBeLessThan(30);
  await page.screenshot({ path: info.outputPath('viewer-third.png') });

  // Its touches are the map's: the drawer and Life edge swipes never see them.
  expect(
    await viewer.evaluate((overlay) => {
      let seen = 0;
      const count = () => seen++;
      document.addEventListener('touchstart', count);
      const r = overlay.getBoundingClientRect();
      const touch = new Touch({ identifier: 1, target: overlay, clientX: r.right - 10, clientY: r.top + r.height / 2 });
      overlay.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch], changedTouches: [touch] }));
      document.removeEventListener('touchstart', count);
      return seen;
    }),
  ).toBe(0);

  // Escape (or ✕) closes it and lets the live map go.
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  expect(await page.locator('canvas').count()).toBe(canvases);
  await card.locator('.place-map-view').click();
  await expect(viewer).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  await viewer.locator('.place-map-viewer-close').click();
  await expect(viewer).toHaveCount(0);
  expect(errors).toEqual([]);
});

// iPhone recording, 2026-11-28 (「他不會自己切」): two toy factories on neighbouring
// streets; the second line held two addresses and a 鄰, so nothing found it and a
// swipe to its card left the map as it was. Its street is found now, and the two
// pins stand apart, the one in front standing out.
test('a swipe to the next card moves the map to that place, even one of two on neighbouring streets', async ({ page }, info) => {
  const { lookups } = await fakeServices(page);
  KNOWN['嘉義縣民雄鄉興南村工業五路'] = [23.51968, 120.43309];
  KNOWN['嘉義縣民雄鄉興南村工業一路'] = [23.51923, 120.43305];
  const factories = [
    { name: 'KHTOY 金興玩具旗艦館（金興玩具一廠）', address: '嘉義縣民雄鄉興南村工業五路5號' },
    { name: '金興玩具二廠', address: '嘉義縣民雄鄉興南村3鄰工業一路6之6號、工業五路3號' },
  ];
  await routeApi(page, reply(`民雄的兩間廠：\n\n${block(factories)}`));
  await open(page);
  const card = page.locator('#messages .place-map');
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  expect(lookups.map((l) => l.q)).toContain('嘉義縣民雄鄉興南村工業一路');
  expect(lookups.map((l) => l.q).some((q) => q.includes('3鄰工業一路') && !q.includes('號'))).toBe(false);

  const pins = await pinCentres(page);
  expect(pins.map((p) => p.n)).toEqual(['1', '2']);
  expect(Math.hypot(pins[0].x - pins[1].x, pins[0].y - pins[1].y)).toBeGreaterThan(26);
  const opacity = (n: string) =>
    card.locator('.place-map-marker', { hasText: n }).evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await inFront(page)).toEqual({ shown: 0, active: 0, pressed: '1' });
  await expect.poll(() => opacity('2')).toBeLessThan(0.6);

  await card.locator('.place-map-cards').evaluate((strip) => {
    const items = strip.querySelectorAll<HTMLElement>('.place-map-card');
    strip.scrollTo({ left: items[1].offsetLeft - items[0].offsetLeft, behavior: 'instant' });
  });
  await expect.poll(() => inFront(page)).toEqual({ shown: 1, active: 1, pressed: '2' });
  await expect.poll(() => opacity('1')).toBeLessThan(0.6);
  await expect.poll(() => opacity('2')).toBe(1);
  await expect(card.locator('.place-map-lost')).toBeHidden();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('neighbouring-streets.png') });
});

test('a place found nowhere keeps its row without a pin; none found leaves the list', async ({ page }) => {
  const { lookups } = await fakeServices(page);
  const unknown = { name: '不存在的地方', address: '' };
  await routeApi(page, [
    ...reply(`兩個地方：\n\n${block([PLACES[1], unknown])}`),
    { id: 3, kind: 'message', role: 'user', content: '那這個呢？', createdAt: '2026-11-28T01:02:00Z' },
    { id: 4, kind: 'message', role: 'assistant', content: `找不到：\n\n${block([{ name: '查無此處', address: '' }])}`, createdAt: '2026-11-28T01:03:00Z' },
  ]);
  await open(page);
  const [some, none] = [page.locator('#messages .place-map').first(), page.locator('#messages .place-map').last()];
  await expect(some).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  await expect(some.locator('.place-map-marker')).toHaveText(['1']);
  await expect(some.locator('.place-map-card').nth(1)).toHaveAttribute('data-unlocated', 'true');
  // Swiped to, the card with no pin says so over the map; back on a pin, it goes.
  await expect(some.locator('.place-map-lost')).toBeHidden();
  const swipeTo = (i: number) =>
    some.locator('.place-map-cards').evaluate((strip, n) => {
      const items = strip.querySelectorAll<HTMLElement>('.place-map-card');
      strip.scrollTo({ left: items[n].offsetLeft - items[0].offsetLeft, behavior: 'instant' });
    }, i);
  await swipeTo(1);
  await expect(some.locator('.place-map-lost')).toBeVisible();
  await expect(some.locator('.place-map-lost')).toHaveText('地圖上找不到這個地點');
  await swipeTo(0);
  await expect(some.locator('.place-map-lost')).toBeHidden();
  await expect(some.locator('.place-map-card-main').nth(1)).toHaveAttribute('href', searchUrl(unknown));
  await expect(none).toHaveAttribute('data-state', 'list', { timeout: 15_000 });
  await expect(none.locator('.place-map-view')).toBeHidden();
  await expect(none.locator('.place-map-card-main')).toHaveText(['1查無此處']);
  await expect(none.locator('.place-map-card-main')).toBeVisible();
  const asked = lookups.map((l) => l.q);
  expect(asked).toEqual(expect.arrayContaining(['不存在的地方', '查無此處']));
  expect(asked).not.toContain('總爺藝文中心'); // Photon knew it
});

test.describe('a streaming reply', () => {
  let server: Server;
  let port = 0;
  const clients: ServerResponse[] = [];
  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      res.write('retry: 60000\n\n');
      clients.push(res);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as { port: number }).port;
  });
  test.afterAll(async () => {
    for (const client of clients) client.end();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const send = (event: string, data: unknown) => {
    for (const client of clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  test('looks up only the places as written, never a half-written line', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const { lookups, photon } = await fakeServices(page);
    await routeApi(page, reply(REPLY).slice(0, 1), port);
    await open(page);
    await expect.poll(() => clients.length).toBeGreaterThan(0);

    send('busy', { busy: true });
    // The model writes the block a few characters at a time, stopping for a
    // moment mid-place as models do.
    let text = '';
    for (const piece of REPLY.match(/[\s\S]{1,6}/g)!) {
      text += piece;
      send('partial', { content: text, thinking: '' });
      await page.waitForTimeout(text.endsWith('總爺藝') || text.endsWith('民族路') ? 420 : 40);
    }
    await page.waitForTimeout(300);
    send('event', { id: 2, kind: 'message', role: 'assistant', content: REPLY, createdAt: '2026-11-28T01:01:00Z' });
    send('busy', { busy: false });

    const card = page.locator('#messages .place-map');
    await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await expect(card.locator('.place-map-marker')).toHaveText(['1', '2', '3']);
    const whole = new Set(PLACES.flatMap((p) => Object.values(placeQueries(p)).flat()));
    for (const { q } of [...lookups, ...photon]) expect(whole.has(q), q).toBe(true);
    expect(errors).toEqual([]);
  });
});
