import { resolve } from 'node:path';
import { expect, test } from 'playwright/test';

// Opt-in: the real Komorebi server (PIWEB_E2E_KOMOREBI=1, or a wss:// URL).
// Chromium's fake microphone plays Komorebi's two-sentence test recording; the
// draft must arrive in the composer and be what Send sends.
const live = process.env.PIWEB_E2E_KOMOREBI;
const wav = resolve(import.meta.dirname, '../../third_party/komorebi-voice/tests/fixtures/two-sentences.wav');

test.skip(!live, 'set PIWEB_E2E_KOMOREBI=1 to talk to the real Komorebi server');
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
    ],
  },
});

test('speech from the microphone becomes the sent message, via the real Komorebi server', async ({ page }, info) => {
  test.setTimeout(90_000);
  const session = { jid: 'web:voice', name: 'Voice', kind: 'standard', deleted: false, busy: false };
  const sent: any[] = [];
  const events: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    try {
      events.push(JSON.parse(String(payload)).type);
    } catch {
      // Not JSON.
    }
  }));
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: [], busy: false, hasMore: false, session } });
    if (path.endsWith('/messages')) {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, eventId: 1 } });
    }
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [], items: [] } });
  });
  // PIWEB_E2E_KOMOREBI_TIDY=off runs it with 整理草稿 off (refine: false).
  const tidy = process.env.PIWEB_E2E_KOMOREBI_TIDY !== 'off';
  await page.addInitScript(
    ([url, tidy]) => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem(
        'piweb.voiceIme.settings',
        JSON.stringify({ ...(String(url).startsWith('wss://') ? { url } : {}), tidy }),
      );
    },
    [live!, tidy] as const,
  );
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Voice');

  const input = page.locator('#input');
  await page.locator('#composer .voice-ime-btn').click();
  await expect(page.locator('#composer')).toHaveClass(/voice-listening/, { timeout: 15_000 });
  // A real rewrite lands: what the clean-up changed shows in the box.
  if (tidy) {
    await page
      .locator('#composer .voice-mirror .voice-fresh, #composer .voice-mirror .voice-gone')
      .first()
      .waitFor({ timeout: 60_000 });
  }
  const changes = await page.locator('#composer .voice-mirror').evaluate((el) =>
    [...el.querySelectorAll('.voice-fresh, .voice-gone')].map((n) => `${n.className.includes('gone') ? '-' : '+'}${n.textContent}`),
  );
  await page.screenshot({ path: info.outputPath('voice-live-changes.png') });
  // The recording loops; wait for both sentences to be heard and rewritten.
  await expect.poll(() => events.filter((t) => t === 'komorebi.draft.updated').length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  const shown = await input.inputValue();
  expect(shown).toMatch(/[一-鿿]/);
  await page.screenshot({ path: info.outputPath('voice-live.png') });

  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length, { timeout: 20_000 }).toBe(1);
  expect(sent[0].text).toMatch(/[一-鿿]/);
  await page.waitForTimeout(6000);
  console.log('changes:', changes.join(' '), '\nshown:', shown, '\nsent:', sent[0].text, '\nafter:', await input.inputValue(), '\nevents:', [...new Set(events)].join(' '));
});
