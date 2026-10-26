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
  /** Rewrites wait here while true, until `flush()`. */
  holdRewrites: boolean;
  flush: () => void;
};

/** Hears the sentences in order, over a few audio chunks each, but no further
 *  than `server.allowed`, so a slow test cannot miss a state in between. A
 *  sentence is what was heard, or [heard, what the clean-up makes of it]. */
async function fakeKomorebi(page: Page, sentences: Array<string | [string, string]>) {
  const held: Array<() => void> = [];
  const server: FakeServer = {
    sessions: [],
    drafts: [],
    commits: 0,
    sockets: 0,
    allowed: 1,
    holdRewrites: false,
    flush: () => held.splice(0).forEach((rewrite) => rewrite()),
  };
  await page.routeWebSocket(KOMOREBI, (ws: WebSocketRoute) => {
    server.sockets++;
    let draft = '';
    let chunks = 0;
    let item = 0;
    let heard = 0;
    let open: string | null = null;
    const queue = sentences.map((s) => (typeof s === 'string' ? [s, s] : s));
    const send = (event: object) => ws.send(JSON.stringify(event));
    const complete = () => {
      if (!open) return;
      const id = open;
      const [heardText, cleaned] = queue.shift() ?? ['', ''];
      open = null;
      send({ type: 'input_audio_buffer.committed', item_id: id });
      send({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: heardText, komorebi: {} });
      const rewrite = () => {
        draft += cleaned;
        send({ type: 'komorebi.draft.updated', item_id: id, item_ids: [id], draft });
      };
      if (server.holdRewrites) held.push(rewrite);
      else setTimeout(rewrite, 250);
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
          send({ type: 'komorebi.input_audio_transcription.partial', item_id: open, text: queue[0][0].slice(0, 4) });
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
  // The fake microphone beeps about once a second; keep the brightest level
  // the ring is given, since a poll can fall between beeps.
  await composer.evaluate((el) => {
    (window as any).__voiceLevelMax = 0;
    new MutationObserver(() => {
      const level = Number(el.style.getPropertyValue('--voice-level') || 0);
      (window as any).__voiceLevelMax = Math.max((window as any).__voiceLevelMax, level);
    }).observe(el, { attributes: true, attributeFilter: ['style'] });
  });

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
  await expect.poll(() => page.evaluate(() => (window as any).__voiceLevelMax)).toBeGreaterThan(0);

  // Typing (a hardware keyboard) edits the draft the next rewrite starts from,
  // even while the rewrite of the sentence just heard is still on its way:
  // that rewrite was made from the old draft, and the typed text wins.
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

test('the box shows the sentence as heard, then what the clean-up changed', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const server = await fakeKomorebi(page, [['嗯今天下午三點開會', '今天下午三點開會。']]);
  server.holdRewrites = true;
  await mockApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Voice');
  const input = page.locator('#input');
  const mirror = page.locator('#composer .voice-mirror');
  await page.locator('#composer .voice-ime-btn').click();

  // Being said: dim and underlined with a caret, drawn over the box.
  const preedit = mirror.locator('.voice-preedit');
  await expect(preedit).toHaveText('嗯今天下', { timeout: 5000 });
  await expect(preedit).toHaveClass(/listening/);
  await expect(input).toHaveClass(/voice-mirrored/);
  expect(await input.evaluate((el) => getComputedStyle(el).color)).toBe('rgba(0, 0, 0, 0)');
  // The layer sits on the box's pixels, in its font.
  const geometry = await page.evaluate(() => {
    const box = document.querySelector('#input')!;
    const layer = document.querySelector('#composer .voice-mirror')!;
    const a = box.getBoundingClientRect();
    const b = layer.getBoundingClientRect();
    const fa = getComputedStyle(box);
    const fb = getComputedStyle(layer);
    return {
      offset: Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)),
      font: [fa.font, fa.paddingLeft, fa.paddingTop].join() === [fb.font, fb.paddingLeft, fb.paddingTop].join(),
    };
  });
  expect(geometry.offset).toBeLessThan(0.5);
  expect(geometry.font).toBe(true);

  // Heard in full, waiting for the clean-up: it breathes.
  await expect(preedit).toHaveText('嗯今天下午三點開會');
  await expect(preedit).toHaveClass(/refining/);
  await page.screenshot({ path: info.outputPath('voice-before-dark.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.screenshot({ path: info.outputPath('voice-before-light.png') });

  // The rewrite lands: what the clean-up put in is highlighted, then fades.
  server.flush();
  await expect(input).toHaveValue('今天下午三點開會。');
  await expect(mirror.locator('.voice-fresh')).toHaveText(['。']);
  // What it took out stays a moment, struck through, then folds away.
  await expect(mirror.locator('.voice-gone')).toHaveText(['嗯']);
  await expect(mirror.locator('.voice-preedit')).toHaveCount(0);
  await page.waitForTimeout(150);
  await page.screenshot({ path: info.outputPath('voice-after-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: info.outputPath('voice-after-dark.png') });
  // Then the box shows its own text again.
  await expect(mirror).toBeHidden({ timeout: 3000 });
  await expect(input).not.toHaveClass(/voice-mirrored/);
  await expect(input).toHaveValue('今天下午三點開會。');
  expect(errors).toEqual([]);
});

test('send does not wait on a slow clean-up: the sentence goes as heard and its late rewrite stays out', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const server = await fakeKomorebi(page, [['測試語音輸入法', '測試語音輸入法。']]);
  server.holdRewrites = true; // a clean-up that takes forever (a busy host)
  const sent = await mockApi(page);
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Voice');
  const input = page.locator('#input');
  await page.locator('#composer .voice-ime-btn').click();

  // Heard and waiting for the clean-up: it already reads as text.
  const preedit = page.locator('#composer .voice-mirror .voice-preedit');
  await expect(preedit).toHaveText('測試語音輸入法', { timeout: 5000 });
  await expect(preedit).toHaveClass(/refining/);
  const colors = await page.evaluate(() => ({
    preedit: getComputedStyle(document.querySelector('#composer .voice-preedit')!).color,
    text: getComputedStyle(document.querySelector('#composer .voice-mirror')!).color,
  }));
  expect(colors.preedit).toBe(colors.text);

  const pressed = Date.now();
  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(Date.now() - pressed).toBeLessThan(2500);
  expect(sent[0].text).toBe('測試語音輸入法');
  await expect(input).toHaveValue('');

  // The rewrite arrives late: it belongs to the message already sent.
  server.flush();
  await page.waitForTimeout(500);
  await expect(input).toHaveValue('');
  await expect.poll(() => server.drafts.at(-1)).toBe('');
  expect(errors).toEqual([]);
});

test('a long voice status keeps the empty box one line, before and after it goes', async ({ page }, info) => {
  // iOS's refusal, word for word: an empty box's scrollHeight counts its
  // placeholder, and this status grew the box to three lines that stayed after
  // voice input was turned off (iPhone screenshot, 2026-10-27).
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(
        new DOMException(
          'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.',
          'NotAllowedError',
        ),
      );
  });
  await fakeKomorebi(page, []);
  await mockApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Voice');
  const input = page.locator('#input');
  const height = () => input.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const oneLine = await height();

  await page.locator('#composer .voice-ime-btn').click();
  await expect(input).toHaveAttribute('placeholder', /^語音輸入：The request is not allowed/);
  // The box measures itself while the status shows (typing then deleting, a
  // hot-keyword chip, a voice render all run autoGrow).
  await input.dispatchEvent('input');
  expect(await height()).toBe(oneLine);
  await page.screenshot({ path: info.outputPath('voice-error-status.png') });

  // Off: the box's own placeholder comes back, still one line.
  await page.locator('#composer .voice-ime-btn').click();
  await page.locator('#composer .voice-ime-btn').click();
  await expect(input).toHaveAttribute('placeholder', 'Message pi…');
  expect(await height()).toBe(oneLine);
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

  // 整理草稿 off: the SDK's refine: false, the API fields greyed; on again: the API.
  const tidy = page.locator('#btn-voice-tidy');
  await expect(tidy).toHaveAttribute('aria-checked', 'true');
  await tidy.click();
  await expect(tidy).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => server.sessions.at(-1)?.komorebi?.refine).toBe(false);
  await expect(url).toBeDisabled();
  await page.waitForTimeout(400); // the switch's own transition
  await page.screenshot({ path: test.info().outputPath('voice-settings-tidy-off.png') });
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('piweb.voiceIme.settings') || '{}').tidy),
  ).toBe(false);
  await tidy.click();
  await expect(url).toBeEnabled();
  await expect
    .poll(() => server.sessions.at(-1)?.komorebi?.refine)
    .toEqual({ provider: 'openai', base_url: 'https://api.example.test/v1', model: 'tidy-model' });
});

test('通話模式收音 off reopens the microphone without the browser processing', async ({ page }) => {
  await fakeKomorebi(page, []);
  await mockApi(page);
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    const asked: unknown[] = ((window as any).micAsks = []);
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      asked.push(constraints);
      return original(constraints);
    };
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Voice');
  await page.locator('#composer .voice-ime-btn').click();
  await expect(page.locator('#composer')).toHaveClass(/voice-listening/);
  const asks = () => page.evaluate(() => (window as any).micAsks.map((c: any) => c.audio.echoCancellation));
  expect(await asks()).toEqual([true]);

  await page.evaluate(() => (document.getElementById('settings-dialog') as HTMLDialogElement).showModal());
  const callAudio = page.locator('#btn-voice-call-audio');
  await expect(callAudio).toHaveAttribute('aria-checked', 'true');
  await callAudio.click();
  await expect(callAudio).toHaveAttribute('aria-checked', 'false');
  await expect.poll(asks).toEqual([true, false]);
  await expect(page.locator('#composer')).toHaveClass(/voice-listening/);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('piweb.voiceIme.settings') || '{}').callAudio),
  ).toBe(false);
  await page.waitForTimeout(400); // the switch's own transition
  await page.screenshot({ path: test.info().outputPath('voice-settings-call-audio-off.png') });
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
