import { createServer, type Server, type ServerResponse } from 'node:http';
import { expect, test, type Page } from 'playwright/test';

// The user, 2026-11-28 (a Life reply listing this weekend's markets and fairs,
// each with its venue): 「如果有偵測到地址，他就會 embedded google map pin 著，如果
// 有多個地址就一起 pin in same map」, then 「你可以用 system prompt drive agent 回覆
// 的時候要滿足某種特別的格式，他就會把多個地址包起來」. A Pi reply ends with a
// ```map block, one place per line; the transcript shows it as one Google Map
// with every place pinned, and under it a row per place that opens it in Google
// Maps. Google is faked here: the test records what the page asks it for.

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
const PLACES = ['中埔穀倉農創園區 嘉義縣中埔鄉', '麻豆總爺藝文中心 臺南市麻豆區', '臺南市中西區民族路二段76號'];
const REPLY = [
  '這週末可以去：',
  '',
  '- **中埔穀倉 11–12月市集** — 11/21–12/20，中埔穀倉農創園區，免費',
  '- **2026 Mattauw大地藝術季** — 9/5–12/6，麻豆總爺藝文中心',
  '- **府城市集** — 11/29（六），民族路二段',
  '',
  '```map',
  ...PLACES,
  '```',
].join('\n');

// Several places are the stops of one route: the keyless embed that pins every
// one (a `q=A|B|C` search pinned one or two of them).
const mapUrl = ([first, ...rest]: string[]) =>
  rest.length
    ? `https://maps.google.com/maps?saddr=${encodeURIComponent(first)}&daddr=${rest.map(encodeURIComponent).join('+to:')}&output=embed`
    : `https://maps.google.com/maps?q=${encodeURIComponent(first)}&output=embed`;
const searchUrl = (place: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;

/** Fake Google: a map frame that says what it was asked for, and records each ask. */
async function fakeGoogle(page: Page) {
  const maps: string[] = [];
  await page.context().route('https://maps.google.com/**', (route) => {
    maps.push(route.request().url());
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<body style="margin:0;background:#cfe3c8;font:14px sans-serif;display:grid;place-items:center;height:100vh">地圖</body>',
    });
  });
  await page.context().route('https://www.google.com/maps/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Google Maps</title>' }),
  );
  return maps;
}

async function routeApi(page: Page, events: unknown[], ssePort?: number) {
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/**', (route) => {
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

async function open(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.dashboardEnabled', 'false');
  });
  await page.goto('/');
  await expect(page.locator('#messages')).toBeVisible();
}

test('a reply\'s places are pinned on one map, and each opens in Google Maps', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const maps = await fakeGoogle(page);
  await routeApi(page, [
    { id: 1, kind: 'message', role: 'user', content: '這週末台南嘉義有什麼市集？', createdAt: '2026-11-28T01:00:00Z' },
    { id: 2, kind: 'message', role: 'assistant', content: REPLY, createdAt: '2026-11-28T01:01:00Z' },
  ]);
  await open(page);

  const card = page.locator('#messages .place-map');
  await expect(card).toHaveCount(1);
  // The block is the map, not a code listing of its lines.
  await expect(page.locator('#messages .msg-text pre')).toHaveCount(0);
  // One map, all three places in its one query.
  await expect(card).toHaveAttribute('data-loaded', 'true');
  await expect(card.locator('iframe')).toHaveAttribute('src', mapUrl(PLACES));
  expect(maps).toEqual([mapUrl(PLACES)]);
  // A row per place, each to that place in Google Maps.
  const rows = card.locator('.place-map-place');
  await expect(rows).toHaveText(PLACES);
  for (const [i, place] of PLACES.entries()) await expect(rows.nth(i)).toHaveAttribute('href', searchUrl(place));
  for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);

  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('place-map-dark.png') });
  await page.evaluate(() => {
    localStorage.setItem('piweb.theme', 'light');
  });
  await page.reload();
  await expect(page.locator('#messages .place-map')).toHaveAttribute('data-loaded', 'true');
  await page.locator('#messages .place-map').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('place-map-light.png') });

  // A place opens in Google Maps (a transcript link would copy instead).
  const [maps2] = await Promise.all([
    page.context().waitForEvent('page'),
    page.locator('#messages .place-map-place').nth(1).click(),
  ]);
  expect(maps2.url()).toBe(searchUrl(PLACES[1]));
  await expect(page.locator('#toast')).toBeHidden();
  expect(errors).toEqual([]);
});

test('one place is one pin', async ({ page }) => {
  const maps = await fakeGoogle(page);
  const place = '奇美博物館 臺南市仁德區';
  await routeApi(page, [
    { id: 1, kind: 'message', role: 'user', content: '奇美博物館在哪？', createdAt: '2026-11-28T01:00:00Z' },
    {
      id: 2,
      kind: 'message',
      role: 'assistant',
      content: `在臺南市仁德區，台1線旁。\n\n\`\`\`map\n- ${place}\n\`\`\``,
      createdAt: '2026-11-28T01:01:00Z',
    },
  ]);
  await open(page);
  const card = page.locator('#messages .place-map');
  await expect(card).toHaveAttribute('data-loaded', 'true');
  await expect(card.locator('iframe')).toHaveAttribute('src', mapUrl([place]));
  // A list marker the model put in front of the line is not part of the place.
  await expect(card.locator('.place-map-place')).toHaveText([place]);
  expect(maps).toEqual([mapUrl([place])]);
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

  test('loads its map once, with every place, not for each line as it is written', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const maps = await fakeGoogle(page);
    await routeApi(page, [
      { id: 1, kind: 'message', role: 'user', content: '這週末台南嘉義有什麼市集？', createdAt: '2026-11-28T01:00:00Z' },
    ], port);
    await open(page);
    await expect.poll(() => clients.length).toBeGreaterThan(0);

    send('busy', { busy: true });
    // The model writes the block a few characters at a time, stopping for a
    // moment mid-place as models do.
    let text = '';
    for (const piece of REPLY.match(/[\s\S]{1,6}/g)!) {
      text += piece;
      send('partial', { content: text, thinking: '' });
      await page.waitForTimeout(text.endsWith('麻豆總爺') || text.endsWith('民族路') ? 420 : 40);
    }
    await page.waitForTimeout(300);
    send('event', { id: 2, kind: 'message', role: 'assistant', content: REPLY, createdAt: '2026-11-28T01:01:00Z' });
    send('busy', { busy: false });

    const card = page.locator('#messages .place-map');
    await expect(card).toHaveAttribute('data-loaded', 'true');
    await expect(card.locator('.place-map-place')).toHaveText(PLACES);
    await page.waitForTimeout(1200);
    expect(maps).toEqual([mapUrl(PLACES)]);
    expect(errors).toEqual([]);
  });
});
