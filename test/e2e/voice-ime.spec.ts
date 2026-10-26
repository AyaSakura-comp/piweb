import { expect, test, type Page, type WebSocketRoute } from 'playwright/test';

// Komorebi voice input in the composers. The Komorebi server is a fake on the
// WebSocket route: after a few audio chunks it hears a sentence, streams it as
// a partial, completes it and returns the rewritten draft, as the real
// /v1/realtime does. The microphone is Chromium's fake device (a tone).
const KOMOREBI = 'wss://komorebi.crayfish-monitor.ts.net/v1/realtime';

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

type FakeServer = {
  sessions: any[];
  drafts: string[];
  commits: number;
  sockets: number;
  /** How many sentences may be heard so far; the test raises it. */
  allowed: number;
};

/** Hears the sentences in order, over a few audio chunks each, but no further
 *  than `server.allowed`, so a slow test cannot miss a state in between. */
async function fakeKomorebi(page: Page, sentences: string[]) {
  const server: FakeServer = { sessions: [], drafts: [], commits: 0, sockets: 0, allowed: 1 };
  await page.routeWebSocket(KOMOREBI, (ws: WebSocketRoute) => {
    server.sockets++;
    let draft = '';
    let chunks = 0;
    let item = 0;
    let heard = 0;
    let open: string | null = null;
    const queue = [...sentences];
    const send = (event: object) => ws.send(JSON.stringify(event));
    const complete = () => {
      if (!open) return;
      const id = open;
      const text = queue.shift() ?? '';
      open = null;
      send({ type: 'input_audio_buffer.committed', item_id: id });
      send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text, komorebi: {} });
      setTimeout(() => {
        draft += text;
        send({ type: 'komorebi.draft.updated', item_id: id, item_ids: [id], draft });
      }, 250);
    };
    ws.onMessage((raw) => {
      const event = JSON.parse(String(raw));
      if (event.type === 'session.update') server.sessions.push(event.session);
      else if (event.type === 'komorebi.draft.set') {
        draft = event.draft;
        server.drafts.push(event.draft);
      } else if (event.type === 'input_audio_buffer.commit') {
        server.commits++;
        if (open) complete();
        else send({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'empty' } });
      } else if (event.type === 'input_audio_buffer.append') {
        chunks++;
        if (!queue.length) return;
        if (!open && heard < server.allowed && chunks % 12 === 4) {
          heard++;
          open = `item_${++item}`;
          send({ type: 'input_audio_buffer.speech_started', item_id: open });
          send({ type: 'komorebi.input_audio_transcription.partial', item_id: open, text: queue[0].slice(0, 4) });
        } else if (open && chunks % 12 === 0) {
          complete();
        }
      }
    });
  });
  return server;
}

const session = { jid: 'web:voice', name: 'Voice', kind: 'standard', deleted: false, busy: false };

async function mockApi(page: Page, sessions = [session]) {
  const sent: any[] = [];
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path.endsWith('/events')) {
      const s = sessions.find((c) => c.jid === path.split('/')[3]);
      return route.fulfill({ json: { events: [], busy: false, hasMore: false, session: s } });
    }
    if (path.endsWith('/messages')) {
      sent.push({ jid: path.split('/')[3], ...route.request().postDataJSON() });
      return route.fulfill({ json: { ok: true, eventId: 100 + sent.length } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });
  return sent;
}

test('the mic button streams speech into the chat composer, keeps the keyboard away, and sends the cleaned-up draft', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const server = await fakeKomorebi(page, ['今天下午三點開會。', '記得帶筆電。']);
  const sent = await mockApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Voice');

  const input = page.locator('#input');
  const composer = page.locator('#composer');
  const mic = composer.locator('.voice-ime-btn');
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect(input).not.toHaveAttribute('inputmode', /.*/);
  // Borderless, a 44px target on touch, next to Send.
  const box = (await mic.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await mic.evaluate((el) => el.nextElementSibling?.id)).toBe('btn-send');
  const height = (await composer.boundingBox())!.height;

  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveAttribute('inputmode', 'none');
  await expect(composer).toHaveClass(/voice-listening/);
  await expect(input).toHaveAttribute('placeholder', '說話即可輸入…');
  expect(server.sessions[0]).toMatchObject({
    audio: { input: { transcription: { model: 'komorebi-smart-cpu-e2b' } } },
    komorebi: { refine: 'cpu-e2b' },
  });

  // The sentence streams in while it is being said, then lands rewritten.
  await expect(input).toHaveValue('今天下午', { timeout: 5000 });
  await expect(composer).toHaveClass(/voice-hearing/);
  // The listening ring is drawn inside the box: the composer did not grow.
  expect((await composer.boundingBox())!.height).toBe(height);
  expect(await composer.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');
  await page.screenshot({ path: info.outputPath('voice-hearing-dark.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.screenshot({ path: info.outputPath('voice-hearing-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await expect(input).toHaveValue('今天下午三點開會。', { timeout: 5000 });
  // The tone the fake microphone plays lights the ring.
  await expect
    .poll(() => composer.evaluate((el) => Number(el.style.getPropertyValue('--voice-level') || 0)))
    .toBeGreaterThan(0);

  // Typing (a hardware keyboard) edits the draft the next rewrite starts from.
  await input.evaluate((el: HTMLTextAreaElement) => {
    el.value = '明天下午三點開會。';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => server.drafts.at(-1)).toBe('明天下午三點開會。');
  server.allowed = 2;
  await expect(input).toHaveValue('明天下午三點開會。記得帶筆電。', { timeout: 6000 });

  // Send takes the whole draft; the mic stays on for the next message.
  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].text).toBe('明天下午三點開會。記得帶筆電。');
  await expect(input).toHaveValue('');
  expect(server.drafts.at(-1)).toBe('');
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await expect(composer).toHaveClass(/voice-listening/);

  // Still on after a reload; listening resumes on the next tap anywhere.
  await page.reload();
  await expect(page.locator('#session-name')).toHaveText('Voice');
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveAttribute('inputmode', 'none');
  await expect(composer).not.toHaveClass(/voice-listening/);
  await page.locator('#messages').click();
  await expect(composer).toHaveClass(/voice-listening/);

  // Off: the keyboard and the placeholder come back.
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect(input).not.toHaveAttribute('inputmode', /.*/);
  await expect(composer).not.toHaveClass(/voice-listening/);
  await expect(input).toHaveAttribute('placeholder', 'Message pi…');
  expect(errors).toEqual([]);
});

test('Settings sets the clean-up API, applied to the next sentence', async ({ page }) => {
  const server = await fakeKomorebi(page, ['一句話。']);
  await mockApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Voice');
  await page.locator('#composer .voice-ime-btn').click();
  await expect.poll(() => server.sessions.length).toBeGreaterThan(0);

  await page.evaluate(() => (document.getElementById('settings-dialog') as HTMLDialogElement).showModal());
  await expect(page.locator('#voice-refine-model-row')).toBeHidden();
  const url = page.locator('#voice-refine-url');
  await url.fill('https://api.example.test/v1');
  await expect(page.locator('#voice-refine-model-row')).toBeVisible();
  await url.blur();
  await page.locator('#voice-refine-model').fill('tidy-model');
  await page.locator('#voice-refine-model').blur();
  await expect
    .poll(() => server.sessions.at(-1)?.komorebi?.refine)
    .toEqual({ provider: 'openai', base_url: 'https://api.example.test/v1', model: 'tidy-model' });
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('piweb.voiceIme.settings') || '{}')),
  ).toMatchObject({ refineUrl: 'https://api.example.test/v1', refineModel: 'tidy-model' });
  await page.screenshot({ path: test.info().outputPath('voice-settings.png') });
});

test.describe('Dashboard', () => {
  test.use({ viewport: { width: 1376, height: 1032 }, isMobile: false, hasTouch: false });

  test('voice goes into the pane that holds the composer card and sends from it', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const sessions = [
      { ...session, jid: 'web:va', name: 'Left' },
      { ...session, jid: 'web:vb', name: 'Right' },
    ];
    const server = await fakeKomorebi(page, ['右邊這一句。']);
    const sent = await mockApi(page, sessions);
    await page.addInitScript(() => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem(
        'piweb.dashboard',
        JSON.stringify({
          direction: 'row',
          updatedAt: Date.now(),
          groups: [
            { weight: 1, items: [{ jid: 'web:va', weight: 1 }] },
            { weight: 1, items: [{ jid: 'web:vb', weight: 1 }] },
          ],
        }),
      );
      localStorage.setItem('piweb.dashboard.composer', 'web:vb');
    });
    await page.goto('/');
    await page.locator('#btn-dashboard-home').click();
    const right = page.locator('.dashboard-pane[data-jid="web:vb"]');
    const left = page.locator('.dashboard-pane[data-jid="web:va"]');
    await expect(right).toHaveClass(/composer-active/);

    await right.locator('.voice-ime-btn').click();
    const rightInput = right.locator('.dashboard-pane-input');
    await expect(rightInput).toHaveAttribute('inputmode', 'none');
    // Every composer drops the keyboard while voice input is on.
    await expect(left.locator('.dashboard-pane-input')).toHaveAttribute('inputmode', 'none');
    await expect(right.locator('.dashboard-pane-composer')).toHaveClass(/voice-listening/);
    await expect(rightInput).toHaveValue('右邊這一句。', { timeout: 6000 });
    await expect(page.locator('#input')).toHaveValue('');
    await page.screenshot({ path: info.outputPath('voice-dashboard.png') });

    await right.locator('.dashboard-pane-send').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ jid: 'web:vb', text: '右邊這一句。' });
    await expect(rightInput).toHaveValue('');
    expect(server.sockets).toBe(1);
    expect(errors).toEqual([]);
  });
});
