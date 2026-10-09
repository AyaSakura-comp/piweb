import { expect, test, type Page } from 'playwright/test';

const CLIP = '/fixtures/media/stream-clip.webm';
const TONE = '/fixtures/media/stream-tone.mp3';
const SHORT = '/fixtures/media/demo-tone.mp3';

const sessions = [
  { jid: 'web:stream', name: 'Stream player', kind: 'standard', deleted: false, busy: false },
  { jid: 'web:other', name: 'Other session', kind: 'standard', deleted: false, busy: false },
];
const event = (id: number, content: string, files: string[] = [], role = 'assistant') => ({
  id,
  kind: 'message',
  role,
  content,
  files,
  createdAt: '2026-10-09T06:00:00Z',
});
const history = [
  event(1, '做一段影片跟音樂', [], 'user'),
  event(2, '影片好了。', [CLIP]),
  event(3, '兩首音樂。', [TONE, SHORT]),
];
const mediaItems = [SHORT, TONE, CLIP].map((url, i) => ({
  url,
  name: url.split('/').pop(),
  eventId: 3 - i,
  createdAt: '2026-10-09T06:00:00Z',
  type: url.endsWith('.webm') ? 'video' : 'audio',
}));

async function setup(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const ranges: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/fixtures/media/stream-'))
      ranges.push(`${url.pathname} ${request.headers().range ?? 'no-range'}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    (window as any).EventSource = class extends EventTarget {
      close() {}
    };
  });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path.endsWith('/media')) return route.fulfill({ json: { items: mediaItems } });
    if (path.endsWith('/events')) {
      const session = sessions.find((s) => path.includes(encodeURIComponent(s.jid)))!;
      return route.fulfill({
        json: {
          events: session.jid === 'web:stream' ? history : [],
          session,
          busy: false,
          partial: null,
          hasMoreOlder: false,
          hasMoreNewer: false,
        },
      });
    }
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText('Stream player');
  return { errors, ranges };
}

const audioEl = (page: Page) => page.locator('.stream-player .sp-audio');
const videoEl = (page: Page) => page.locator('.stream-player .sp-video');
const time = (page: Page, which: 'audio' | 'video') =>
  (which === 'audio' ? audioEl(page) : videoEl(page)).evaluate((m: HTMLMediaElement) => m.currentTime);

test('video and audio stream in a persistent dock with a session playlist', async ({ page }, info) => {
  const { errors, ranges } = await setup(page);
  const dock = page.getByRole('region', { name: 'Media player' });
  await expect(dock).toBeHidden();

  // Audio attachments are track rows, not native players.
  const track = page.getByRole('button', { name: 'Play audio stream-tone.mp3' });
  await expect(track).toBeVisible();
  await expect(page.locator('#messages audio')).toHaveCount(0);
  await track.click();

  await expect(dock).toBeVisible();
  await expect(dock.locator('.sp-title')).toHaveText('stream-tone.mp3');
  await expect.poll(() => time(page, 'audio')).toBeGreaterThan(0.3);
  await expect(dock).toHaveAttribute('data-state', 'playing');
  await expect(track).toHaveClass(/stream-current/);
  await expect(track).toHaveAttribute('data-stream-playing', 'true');
  // Streamed by byte range, not fetched whole.
  expect(ranges.some((r) => r.startsWith(`${TONE} bytes=`))).toBe(true);
  // Lock screen / headset metadata.
  expect(await page.evaluate(() => navigator.mediaSession?.metadata?.title)).toBe('stream-tone.mp3');
  await page.screenshot({ path: info.outputPath('01-audio-docked.png') });

  // Seek to the middle with the range input.
  await dock.locator('.sp-seek').evaluate((input: HTMLInputElement) => {
    input.value = '500';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => time(page, 'audio')).toBeGreaterThan(3.5);

  // Expanded view: playlist position, download.
  await dock.locator('.sp-info').click();
  await expect(dock.locator('.sp-position')).toHaveText('2 / 3');
  await expect(dock.getByRole('link', { name: 'Download audio stream-tone.mp3' })).toHaveAttribute(
    'download',
    'stream-tone.mp3',
  );
  await page.screenshot({ path: info.outputPath('02-audio-expanded.png') });

  // Next goes to the following track in transcript order.
  await dock.getByRole('button', { name: 'Next' }).click();
  await expect(dock.locator('.sp-title')).toHaveText('demo-tone.mp3');
  await expect(dock.locator('.sp-position')).toHaveText('3 / 3');
  await expect(dock.getByRole('button', { name: 'Next' })).toBeDisabled();

  // The video poster plays in the dock; the end auto-advances to the next item.
  await page.getByRole('button', { name: 'Play video stream-clip.webm' }).click();
  await expect(dock).toHaveAttribute('data-type', 'video');
  await expect(videoEl(page)).toBeVisible();
  await expect.poll(() => time(page, 'video')).toBeGreaterThan(0.3);
  expect(await audioEl(page).getAttribute('src')).toBeNull();
  expect(ranges.some((r) => r.startsWith(`${CLIP} bytes=`))).toBe(true);
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('03-video-expanded.png') });
  await videoEl(page).evaluate((v: HTMLVideoElement) => {
    v.currentTime = v.duration - 0.3;
  });
  await expect(dock.locator('.sp-title')).toHaveText('stream-tone.mp3');
  await expect.poll(() => time(page, 'audio')).toBeGreaterThan(0.3);

  // Switching sessions keeps it playing.
  await page.locator('#btn-menu').click();
  await page.locator('.session-item', { hasText: 'Other session' }).click();
  await expect(page.locator('#session-name')).toHaveText('Other session');
  const before = await time(page, 'audio');
  await expect.poll(() => time(page, 'audio')).toBeGreaterThan(before + 0.3);
  await expect(dock).toBeVisible();
  await dock.locator('.sp-info').click();
  await page.screenshot({ path: info.outputPath('04-playing-across-sessions.png') });

  await dock.getByRole('button', { name: 'Close player' }).click();
  await expect(dock).toBeHidden();
  expect(await audioEl(page).getAttribute('src')).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Media sheet audio keeps the sheet open, video closes it to play', async ({ page }, info) => {
  const { errors } = await setup(page);
  const dock = page.getByRole('region', { name: 'Media player' });
  await page.locator('#btn-more').click();
  await page.locator('#mi-media').click();
  await expect(page.locator('#media-sheet')).toBeVisible();

  await page.getByRole('button', { name: 'audio: stream-tone.mp3' }).click();
  await expect(dock.locator('.sp-title')).toHaveText('stream-tone.mp3');
  await expect(page.locator('#media-sheet')).toBeVisible();
  await expect.poll(() => time(page, 'audio')).toBeGreaterThan(0.3);
  await expect(page.getByRole('button', { name: 'audio: stream-tone.mp3' })).toHaveClass(
    /stream-current/,
  );
  await page.screenshot({ path: info.outputPath('01-sheet-audio.png') });

  // Tapping the current item again pauses it instead of restarting.
  await page.getByRole('button', { name: 'audio: stream-tone.mp3' }).click();
  await expect(dock).toHaveAttribute('data-state', 'paused');

  await page.getByRole('button', { name: 'video: stream-clip.webm' }).click();
  await expect(page.locator('#media-sheet')).toBeHidden();
  await expect(dock).toHaveAttribute('data-type', 'video');
  await expect.poll(() => time(page, 'video')).toBeGreaterThan(0.3);
  // The API lists newest first; the playlist is oldest first: clip, tone, short.
  await dock.locator('.sp-info').click();
  await expect(dock.locator('.sp-position')).toHaveText('1 / 3');
  await page.screenshot({ path: info.outputPath('02-sheet-video.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: info.outputPath('03-sheet-video-light.png') });
  expect(errors).toEqual([]);
});
