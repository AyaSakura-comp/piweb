import { expect, test } from 'playwright/test';

// A Mac screen recording (tens of MB) used to upload in full, fail on the
// server with "Attachment exceeds the size limit", and vanish from the
// composer. Now it is refused before uploading and stays put.
const SESSION = {
  jid: 'web:size-limit',
  name: 'Size limit',
  kind: 'standard',
  busy: false,
  lastActivity: '2026-10-21 00:00:00',
  lastReplyId: 0,
};

test('an oversized video is refused before upload and stays in the composer', async ({
  page,
}, info) => {
  const posts: string[] = [];
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/me')
      // Limits as the running server reports them (falls back to 25/64 MB).
      return route.fulfill({
        json: {
          authed: true,
          maxAttachmentBytes: 25 * 1024 * 1024,
          maxUploadBodyBytes: 64 * 1024 * 1024,
        },
      });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [SESSION] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: { events: [], busy: false, hasMore: false, session: { ...SESSION, deleted: false } },
      });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/messages') && request.method() === 'POST') {
      posts.push(path);
      return route.fulfill({ json: { ok: true, eventId: 1 } });
    }
    return route.fulfill({ json: { commands: [], models: [], items: [] } });
  });

  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(SESSION.name);
  await page.locator('#file-input').setInputFiles({
    name: '螢幕錄影 2026-10-21 凌晨1.37.34.mov',
    mimeType: 'video/quicktime',
    buffer: Buffer.alloc(30 * 1024 * 1024),
  });
  await page.locator('#input').fill('看一下這個錄影');
  await page.locator('#btn-send').click();

  await expect.poll(() => dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain('螢幕錄影 2026-10-21 凌晨1.37.34.mov 有 30 MB');
  expect(dialogs[0]).toContain('單檔上限 25 MB');
  expect(posts).toEqual([]);
  await expect(page.locator('#input')).toHaveValue('看一下這個錄影');
  await expect(page.locator('#attachments')).toContainText('螢幕錄影');
  await page.screenshot({ path: info.outputPath('01-kept-in-composer.png') });

  // A file under the limit still sends.
  await page.locator('#attachments button[aria-label^="Remove"]').first().click();
  await page.locator('#file-input').setInputFiles({
    name: 'short.mov',
    mimeType: 'video/quicktime',
    buffer: Buffer.alloc(2 * 1024 * 1024),
  });
  await page.locator('#btn-send').click();
  await expect.poll(() => posts).toHaveLength(1);
});
