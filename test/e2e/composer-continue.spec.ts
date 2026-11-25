import { expect, test, type Page } from 'playwright/test';

// iPhone/iPad, 2026-11-25 (composer screenshot, mic and Send circled, after a
// typed "Contineu"): 「Add continue icon button, and it will send continue
// message to session agent」. One tap sends "continue" to the open session;
// the button shows only while the composer has nothing else to send.

const session = {
  jid: 'web:continue',
  name: 'Continue',
  kind: 'standard',
  deleted: false,
  busy: true,
};

async function open(page: Page, { width = 390, theme = 'dark', delayMs = 0 } = {}) {
  const sent: any[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/messages') && route.request().method() === 'POST') {
      sent.push({ path, body: route.request().postDataJSON() });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return route.fulfill({ json: { ok: true, eventId: 7, files: [] } });
    }
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events: [
            {
              id: 5,
              kind: 'message',
              role: 'user',
              content: '把盤前的線圖畫出來',
              createdAt: '2026-11-25T14:30:00Z',
            },
            {
              id: 6,
              kind: 'tool',
              content: '[Tool call interrupted: the session ended]',
              createdAt: '2026-11-25T14:31:00Z',
            },
          ],
          busy: false,
          hasMore: false,
          session,
        },
      });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/btw'))
      return route.fulfill({
        json: {
          available: true,
          generation: 'web_continue',
          thread: { messages: [], busy: false },
        },
      });
    return route.fulfill({ json: { commands: [], models: [], items: [], layout: null } });
  });
  await page.addInitScript((theme) => {
    localStorage.setItem('piweb.mode', 'chat');
    localStorage.setItem('piweb.theme', theme);
  }, theme);
  await page.goto('/#web:continue');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await expect(page.locator('#input')).toBeVisible();
  return sent;
}

for (const [width, theme] of [
  [390, 'dark'],
  [390, 'light'],
  [641, 'dark'],
  [641, 'light'],
] as const) {
  test(`⏩ sits left of the mic and sends "continue" in one tap (${width}px ${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const sent = await open(page, { width, theme });
    const button = page.getByRole('button', { name: '繼續：傳送 continue' });
    await expect(button).toBeVisible();

    // A borderless 44px target between the box and the mic; Send stays last.
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const style = await button.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderTopWidth };
    });
    expect(style).toEqual({ bg: 'rgba(0, 0, 0, 0)', border: '0px' });
    const order = await page
      .locator('#composer')
      .evaluate((form) =>
        [...form.children]
          .filter((el) => (el as HTMLElement).offsetParent)
          .map((el) => (el.classList.contains('voice-ime-btn') ? 'mic' : el.id)),
      );
    expect(order.slice(-4)).toEqual(['input', 'btn-continue', 'mic', 'btn-send']);
    await page.screenshot({ path: info.outputPath(`continue-${width}-${theme}.png`) });

    await button.tap();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({
      path: '/api/sessions/web:continue/messages',
      body: { text: 'continue', quote: '', attachments: [] },
    });
    // Nothing in the box changed, and it is ready for the next one.
    await expect(page.locator('#input')).toHaveValue('');
    await expect(button).toBeEnabled();
    await expect(button).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('typing or an attachment puts ⏩ away and gives the box its width back', async ({
  page,
}, info) => {
  await open(page);
  const button = page.locator('#btn-continue');
  const input = page.locator('#input');
  const emptyWidth = (await input.boundingBox())!.width;

  await input.fill('再試一次');
  await expect(button).toBeHidden();
  expect((await input.boundingBox())!.width).toBeGreaterThan(emptyWidth + 40);
  await page.screenshot({ path: info.outputPath('continue-typing-390-dark.png') });

  await input.fill('');
  await expect(button).toBeVisible();

  // While the mic listens, saying "continue" does the same; the status keeps its room.
  await page.locator('#composer').evaluate((form) => form.classList.add('voice-listening'));
  await expect(button).toBeHidden();
  await page.locator('#composer').evaluate((form) => form.classList.remove('voice-listening'));
  await expect(button).toBeVisible();

  await page
    .locator('#file-input')
    .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('#attachments')).toBeVisible();
  await expect(button).toBeHidden();
});

test('BTW has no ⏩: a side question never goes to the main agent', async ({ page }) => {
  await open(page);
  await expect(page.locator('#btn-continue')).toBeVisible();
  await page.getByRole('button', { name: '開啟 BTW' }).tap();
  await expect(page.locator('#app')).toHaveClass(/btw-active/);
  await expect(page.locator('#btn-continue')).toBeHidden();
  await page.getByRole('button', { name: '返回主對話' }).tap();
  await expect(page.locator('#app')).not.toHaveClass(/btw-active/);
  await expect(page.locator('#btn-continue')).toBeVisible();
});

test('a second tap while the first is on its way does not send twice', async ({ page }) => {
  const sent = await open(page, { delayMs: 600 });
  const button = page.locator('#btn-continue');
  await button.tap();
  await expect(button).toBeDisabled();
  await button.tap({ force: true });
  await expect(button).toBeEnabled();
  await page.waitForTimeout(300);
  expect(sent.length).toBe(1);
});
