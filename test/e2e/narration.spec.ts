import { expect, test, type Page } from 'playwright/test';

const event = (
  id: number,
  content: string,
  role = 'assistant',
  kind = 'message',
  files: string[] = [],
) => ({
  id,
  content,
  role,
  kind,
  createdAt: '2026-10-06T12:00:00Z',
  files,
});

async function setup(page: Page, history: ReturnType<typeof event>[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const session = {
    jid: 'web:lobe',
    name: 'LobeHub Streamdown',
    kind: 'standard',
    deleted: false,
    busy: false,
  };
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.autoScroll', 'false');
    const host = window as any;
    host.EventSource = class extends EventTarget {
      closed = false;
      constructor() {
        super();
        host.__lobeStream = this;
      }
      close() {
        this.closed = true;
      }
    };
    host.__lobeEmit = (type: string, data: unknown) => {
      host.__lobeStream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    };
  });
  const events = [...history];
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/media'))
      return route.fulfill({ json: { items: [{ type: 'image', url: '/media/lobe.svg' }] } });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events,
          session,
          busy: false,
          partial: null,
          hasMoreOlder: false,
          hasMoreNewer: false,
        },
      });
    if (path.endsWith('/messages')) {
      const row = event(events.length + 1, route.request().postDataJSON().text, 'user');
      events.push(row);
      return route.fulfill({ json: { ok: true, eventId: row.id } });
    }
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.route('**/media/lobe.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#82b5aa"/><circle cx="150" cy="100" r="65" fill="#f3dbc0"/></svg>',
    }),
  );
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await expect.poll(() => page.evaluate(() => !!(window as any).__lobeStream)).toBe(true);
  return { errors, events };
}

async function emit(page: Page, type: string, data: unknown) {
  await page.evaluate(({ type, data }) => (window as any).__lobeEmit(type, data), { type, data });
}
const partial = (page: Page, content: string, thinking = '') =>
  emit(page, 'partial', { content, thinking });


const history = [
  event(1, '簡單生成電影運鏡的爆破電影', 'user'),
  event(2, 'The video generation succeeded. Now I need to verify it with ffprobe.', '', 'thinking'),
  event(3, '生成成功！現在驗證影片品質：', 'assistant', 'narration'),
  event(4, '$ ffprobe explosion.mp4', 'bash', 'tool'),
  event(5, '影片已驗證，三個畫面都正常。'),
];

test('tool-loop narration renders as plain reply text, thinking stays in its card', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { errors } = await setup(page, history);
  const narration = page.locator('.msg.msg-narration');
  await expect(narration).toHaveCount(1);
  await expect(narration.locator('.msg-text')).toHaveText('生成成功！現在驗證影片品質：');
  await expect(page.locator('details.event.thinking')).toHaveCount(1);
  await expect(page.locator('details.event.thinking')).not.toContainText('生成成功');
  await page.screenshot({ path: info.outputPath('narration-history.png') });
  expect(errors).toEqual([]);
});

test('streamed narration finalizes in its answer-lane node without becoming a card', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { errors } = await setup(page, history.slice(0, 2));
  await partial(page, '生成成功！現在驗證影片品質：');
  await expect(page.locator('#partial-msg .msg-text')).toHaveText('生成成功！現在驗證影片品質：');
  await page.evaluate(() => {
    (window as any).__narrationRow = document.getElementById('partial-msg');
  });
  // The worker writes the narration row and clears the answer lane in one snapshot.
  await emit(page, 'event', history[2]);
  await partial(page, '');
  await emit(page, 'event', history[3]);
  const narration = page.locator('.msg.msg-narration');
  await expect(narration).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.querySelector('.msg.msg-narration') === (window as any).__narrationRow,
    ),
  ).toBe(true);
  await expect(page.locator('#partial-msg')).toHaveCount(0);
  await expect(page.locator('details.event.thinking')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('narration-live.png') });
  expect(errors).toEqual([]);
});
