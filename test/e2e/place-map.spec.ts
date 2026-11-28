import { createServer, type Server, type ServerResponse } from 'node:http';
import { expect, test, type Page } from 'playwright/test';

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

// Made-up coordinates: north to south, 1 → 3.
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

/** Fake Nominatim and map style; Google Maps pages for the links. */
async function fakeServices(page: Page) {
  const lookups: Array<{ q: string; at: number }> = [];
  const styles: string[] = [];
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
  return { lookups, styles };
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
  const { lookups, styles } = await fakeServices(page);
  await routeApi(page, reply(REPLY));
  await open(page);

  const card = page.locator('#messages .place-map');
  await expect(card).toHaveCount(1);
  // The block is the map, not a code listing of its lines.
  await expect(page.locator('#messages .msg-text pre')).toHaveCount(0);
  // The list is there at once; the map once the places are found.
  await expect(card.locator('.place-map-name')).toHaveText(PLACES.map((p) => p.name));
  await expect(card.locator('.place-map-address')).toHaveText(PLACES.map((p) => p.address));
  await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  expect(styles).toEqual(['/styles/fiord']);

  // Name first, then the address, then its street (OpenStreetMap rarely has
  // Taiwan's house numbers); one request a second, as Nominatim asks.
  expect(lookups.map((l) => l.q)).toEqual([
    '中埔穀倉農創園區',
    '總爺藝文中心',
    '府城市集',
    '臺南市中西區民族路二段76號',
    '臺南市中西區民族路二段',
  ]);
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
  const asked = lookups.length;
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
  expect(lookups.length).toBe(asked);
  expect(errors).toEqual([]);
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
  await expect(some.locator('.place-map-card-main').nth(1)).toHaveAttribute('href', searchUrl(unknown));
  await expect(none).toHaveAttribute('data-state', 'list', { timeout: 15_000 });
  await expect(none.locator('.place-map-view')).toBeHidden();
  await expect(none.locator('.place-map-card-main')).toHaveText(['1查無此處']);
  await expect(none.locator('.place-map-card-main')).toBeVisible();
  expect(lookups.map((l) => l.q).sort()).toEqual(['不存在的地方', '查無此處', '總爺藝文中心'].sort());
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
    const { lookups } = await fakeServices(page);
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
    const whole = new Set(['中埔穀倉農創園區', '總爺藝文中心', '府城市集', '臺南市中西區民族路二段76號', '臺南市中西區民族路二段']);
    for (const { q } of lookups) expect(whole.has(q), q).toBe(true);
    expect(errors).toEqual([]);
  });
});
