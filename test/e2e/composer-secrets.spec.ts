import { expect, test, type Page } from 'playwright/test';

// 🔑 login details (2026-11-12): typed into an inline card above the composer,
// sent once with the message in `secrets`, never kept in the page's storage and
// never shown in the transcript beyond their name. Made-up details only.

const USERNAME = 'octo-user-7731';
const PASSWORD = 'pa$$ w0rd-9182';

async function open(page: Page, { secrets = true, theme = 'dark' } = {}) {
  const sent: any[] = [];
  const sessions = [{ jid: 'web:a', name: 'A', kind: 'standard', deleted: false, busy: false }, { jid: 'web:b', name: 'B', kind: 'standard', deleted: false, busy: false }];
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true, secrets } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
    if (path.endsWith('/messages') && route.request().method() === 'POST') {
      sent.push({ path, body: route.request().postDataJSON() });
      return route.fulfill({ json: { ok: true, eventId: 1, files: [] } });
    }
    if (path.endsWith('/events')) return route.fulfill({ json: { events: [], busy: false, hasMore: false, session: sessions.find((s) => path.includes(s.jid)) } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], items: [], layout: null } });
  });
  await page.addInitScript((theme) => {
    localStorage.setItem('piweb.mode', 'chat');
    localStorage.setItem('piweb.theme', theme);
  }, theme);
  await page.goto('/#web:a');
  await expect(page.locator('#input')).toBeVisible();
  return sent;
}

async function addDetail(page: Page, name = 'GitHub') {
  await page.getByRole('button', { name: '加上登入資料' }).click();
  const card = page.locator('#secret-panel');
  await expect(card).toBeVisible();
  await expect(page.locator('#secret-name')).toBeFocused();
  await page.locator('#secret-name').fill(name);
  await page.locator('#secret-username').fill(USERNAME);
  await page.locator('#secret-password').fill(PASSWORD);
  await page.getByRole('button', { name: '加入登入資料' }).click();
  await expect(card).toBeHidden();
}

test('a login detail rides along with the next message, once, and leaves no trace in the page', async ({ page }) => {
  const sent = await open(page);
  await expect(page.locator('#secret-password')).toHaveAttribute('type', 'password');
  await addDetail(page);
  await expect(page.locator('.chip-secret')).toHaveText(/🔑 GitHub/);
  // The fields were emptied when the card closed.
  await page.getByRole('button', { name: '加上登入資料' }).click();
  await expect(page.locator('#secret-password')).toHaveValue('');
  await page.getByRole('button', { name: '取消' }).click();

  await page.locator('#input').fill('幫我登入 GitHub');
  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].body).toMatchObject({
    text: '幫我登入 GitHub',
    secrets: [{ name: 'GitHub', username: USERNAME, password: PASSWORD }],
  });
  await expect(page.locator('.chip-secret')).toHaveCount(0);

  await page.locator('#input').fill('next');
  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].body.secrets).toBeUndefined();

  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(USERNAME);
  expect(stored).not.toContain('w0rd');
});

test('details can be sent on their own, and do not follow you to another conversation', async ({ page }) => {
  const sent = await open(page);
  await addDetail(page);
  await page.locator('#btn-send').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].body.text).toBe('');
  expect(sent[0].body.secrets).toHaveLength(1);

  await addDetail(page, 'Mail');
  await expect(page.locator('.chip-secret')).toHaveCount(1);
  await page.locator('#btn-menu').click();
  await page.locator('#session-list .session-item', { hasText: 'B' }).click();
  await expect(page.locator('#session-name')).toHaveText('B');
  await expect(page.locator('.chip-secret')).toHaveCount(0);
});

test('the key is not offered until the host can seal details', async ({ page }) => {
  await open(page, { secrets: false });
  await expect(page.getByRole('button', { name: '加上登入資料' })).toBeHidden();
});

for (const theme of ['dark', 'light'] as const) {
  test(`the card at phone width (${theme})`, async ({ page }, info) => {
    await open(page, { theme });
    await page.getByRole('button', { name: '加上登入資料' }).click();
    await page.locator('#secret-name').fill('GitHub');
    await page.locator('#secret-username').fill(USERNAME);
    await page.locator('#secret-password').fill(PASSWORD);
    for (const target of ['#secret-cancel', '#secret-add', '#btn-secret']) {
      const box = (await page.locator(target).boundingBox())!;
      expect(box.width, target).toBeGreaterThanOrEqual(target === '#btn-secret' ? 38 : 44);
    }
    const wrap = (await page.locator('#composer-wrap').boundingBox())!;
    expect(wrap.x + wrap.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath(`card-${theme}.png`) });
    await page.getByRole('button', { name: '加入登入資料' }).click();
    await page.locator('#input').fill('幫我登入');
    await page.screenshot({ path: info.outputPath(`chip-${theme}.png`) });
  });
}
