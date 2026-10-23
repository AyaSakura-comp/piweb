import { expect, test, type Page } from 'playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const session = {
  jid: 'web:s01', name: 'Keyboard send', folder: 'web_s01', kind: 'standard', deleted: false,
  model: 'openai/gpt-5', provider: 'openai', runningModel: 'gpt-5', badge: { label: 'GPT', kind: 'gpt' },
  busy: false, lastReplyId: 1, lastActivity: '2026-10-23 09:00:00',
};

async function openChat(page: Page) {
  const sent: string[] = [];
  const events: any[] = [
    { id: 1, kind: 'message', role: 'assistant', content: '有什麼需要幫忙的嗎？', files: [], createdAt: '2026-10-23T09:00:00Z' },
  ];
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    // The iOS keyboard: only the visual viewport shrinks, and iOS pans it.
    let height = 844;
    let offsetTop = 0;
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => height });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, get: () => offsetTop });
    (window as any).__keyboard = (value: number, top: number) => {
      height = value;
      offsetTop = top;
      window.visualViewport!.dispatchEvent(new Event('resize'));
    };
  });
  await page.route('**/api/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const method = route.request().method();
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: method === 'GET' ? { layout: null } : { ok: true } });
    if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path.endsWith('/events')) return route.fulfill({ json: { events, busy: false, hasMore: false, partial: null, session } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream; charset=utf-8', body: 'retry: 60000\n\n' });
    if (path.endsWith('/messages') && method === 'POST') {
      sent.push(route.request().postDataJSON().text);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  await expect(page.locator('#input')).toBeVisible();
  return sent;
}

const rect = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
  });

test('Send tapped with the keyboard up stays under the finger and sends', async ({ page }) => {
  const sent = await openChat(page);
  await page.locator('#input').focus();
  // Panned less than a full keyboard: the pinned composer sits above the page
  // bottom, so a shell released on blur would move Send out from under the tap.
  await page.evaluate(() => (window as any).__keyboard(480, 300));
  await expect.poll(() => rect(page, '.app')).toEqual({ top: 300, bottom: 780 });
  await page.locator('#input').fill('鍵盤開著直接按送出');
  const before = await rect(page, '#btn-send');
  // The tap blurs the box first (iPhone recording 2026-10-23); the shell must
  // not move until iOS starts lowering the keyboard.
  const moved = page.evaluate(
    (top) =>
      new Promise<number | null>((resolve) => {
        setTimeout(() => resolve(null), 1500); // the click landed elsewhere
        document.getElementById('btn-send')!.addEventListener(
          'click',
          (e) => resolve(Math.round((e.currentTarget as HTMLElement).getBoundingClientRect().top) - top),
          { once: true },
        );
      }),
    before.top,
  );
  await page.locator('#btn-send').tap();
  expect(await moved).toBe(0);
  await expect.poll(() => sent).toEqual(['鍵盤開著直接按送出']);
  await expect(page.locator('#input')).toHaveValue('');
  // iOS lowers the keyboard frame by frame; the shell follows it and lets go.
  for (const [height, top] of [[600, 200], [740, 80], [844, 0]]) {
    await page.evaluate(([h, t]) => (window as any).__keyboard(h, t), [height, top]);
    await expect.poll(() => rect(page, '.app')).toEqual({ top, bottom: top + height });
  }
  await expect(page.locator('html')).not.toHaveClass(/keyboard-shell/);
});

test('Send tapped mid-composition sends the committed text and clears the box', async ({ page }) => {
  const sent = await openChat(page);
  const input = page.locator('#input');
  await input.focus();
  await page.evaluate(() => {
    const box = document.getElementById('input') as HTMLTextAreaElement;
    // 注音 still being converted: iOS commits the marked text only as focus leaves.
    box.dispatchEvent(new CompositionEvent('compositionstart'));
    box.value = 'ㄎㄨ';
    box.addEventListener(
      'blur',
      () =>
        setTimeout(() => {
          box.value = '哭';
          box.dispatchEvent(new CompositionEvent('compositionend', { data: '哭' }));
        }, 30),
      { once: true },
    );
  });
  await page.locator('#btn-send').tap();
  await expect.poll(() => sent).toEqual(['哭']);
  await expect(input).toHaveValue('');
});

test('the keyboard opening eases the shell along the iOS pan instead of jumping', async ({ page }) => {
  await openChat(page);
  await page.locator('#input').focus();
  const tops = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const seen: number[] = [];
        const app = document.querySelector('.app')!;
        const start = performance.now();
        const sample = () => {
          seen.push(Math.round(app.getBoundingClientRect().top));
          if (performance.now() - start < 400) requestAnimationFrame(sample);
          else resolve(seen);
        };
        (window as any).__keyboard(480, 364);
        requestAnimationFrame(sample);
      }),
  );
  const seen = await tops;
  // Rises from the resting place through the middle, never jumping straight to the pin.
  expect(seen.some((top) => top > 60 && top < 300)).toBe(true);
  expect(seen.every((top, i) => top >= (seen[i - 1] ?? 0))).toBe(true);
  expect(seen.at(-1)).toBe(364);
  expect(await rect(page, '#composer')).toEqual(expect.objectContaining({ bottom: 844 - 10 }));
});
