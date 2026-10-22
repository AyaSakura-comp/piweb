import { expect, test } from 'playwright/test';

const sessionDefinitions = [
  { id: '01', name: '前端架構重構', badge: { label: 'OPUS', kind: 'claude' }, busy: false, msg: '請幫我檢查 Dashboard 1–12 視窗並排 RWD' },
  { id: '02', name: 'ROCm 推論壓測', badge: { label: 'AGY', kind: 'gem' }, busy: true, msg: './llama-bench -m qwen3-30b-a3b.gguf -ngl 99 -fa 1' },
  { id: '03', name: '台股 Shioaji 回測', badge: { label: 'GPT', kind: 'gpt' }, busy: false, msg: '2330 檔位 Tick 1.0 元，回測夏普率 2.41' },
  { id: '04', name: 'Breeze ASR 台語轉錄', badge: { label: 'AGY', kind: 'gem' }, busy: false, msg: '已完成 YouTube 台語逐字稿與時間戳摘要' },
  { id: '05', name: 'Qwen-Image ComfyUI', badge: { label: 'OPUS', kind: 'claude' }, busy: true, msg: '正在生成 20B DiT 賽博龐克概念美術圖' },
  { id: '06', name: 'Xvfb 串流監控', badge: { label: 'GPT', kind: 'gpt' }, busy: false, msg: 'DISPLAY :99 Tailscale Funnel 200 OK' },
  { id: '07', name: 'Strix Halo 功耗監測', badge: { label: 'AGY', kind: 'gem' }, busy: false, msg: 'APU 封裝功耗 78W · 統一記憶體 96GB' },
  { id: '08', name: 'Playwright 視覺驗證', badge: { label: 'OPUS', kind: 'claude' }, busy: false, msg: '120Hz 高解析度 2.7x Canvas 測試通過' },
  { id: '09', name: 'AssetSentry 儀表板', badge: { label: 'GPT', kind: 'gpt' }, busy: false, msg: 'Streamlit port 8501 即時庫存部位更新' },
  { id: '10', name: 'DS4 ROCm Kernel', badge: { label: 'AGY', kind: 'gem' }, busy: true, msg: 'HIP FlashAttention-2 Q8 KV cache 編譯中' },
  { id: '11', name: 'Discord Claude Bridge', badge: { label: 'OPUS', kind: 'claude' }, busy: false, msg: 'Webhook 佇列延遲 18ms · 連線正常' },
  { id: '12', name: '4get 私密搜尋引擎', badge: { label: 'GPT', kind: 'gpt' }, busy: false, msg: 'Upstream scraper proxies 100% healthy' },
];

const sessions = sessionDefinitions.map((d, i) => ({
  jid: `web:s${d.id}`,
  name: `${d.id} ${d.name}`,
  folder: `web_s${d.id}`,
  kind: 'standard',
  deleted: false,
  model: d.id === '01' ? 'openai/gpt-5' : 'agy/gemini-3-pro',
  provider: d.id === '01' ? 'openai' : 'agy',
  runningModel: d.id === '01' ? 'gpt-5' : 'gemini-3-pro',
  badge: d.badge,
  busy: d.busy,
  lastReplyId: 2,
  lastActivity: `2026-10-18 01:${String(20 - i).padStart(2, '0')}:00`,
}));

const eventsBySession: Record<string, any[]> = Object.fromEntries(
  sessionDefinitions.map((d) => [
    `web:s${d.id}`,
    [
      {
        id: 1,
        kind: 'message',
        role: 'user',
        content: `檢查任務 #${d.id}：${d.name}`,
        files: [],
        createdAt: '2026-10-18T01:05:00Z',
      },
      {
        id: 2,
        kind: 'message',
        role: 'assistant',
        content: d.msg,
        files: [],
        createdAt: '2026-10-18T01:06:00Z',
      },
    ],
  ]),
);

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('the keyboard pins the chat and dashboard shell to the panned visual viewport', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  eventsBySession['web:s01'][1].content = 'Viewport reader position regression\n\n'.repeat(100);
  const sentMessages: Array<{ jid: string; text: string }> = [];
  let serverDashboardLayout: any = null;
    await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
    await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
      route.fulfill({
        json: {
          items: [
            { word: 'update doc, commit and push', count: 18 },
            { word: 'video record and check', count: 14 },
            { word: '檢查 ROCm GPU 狀態', count: 9 },
          ],
        },
      }),
    );
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const path = decodeURIComponent(url.pathname);
      if (path === '/api/me') return route.fulfill({ json: { authed: true } });
      if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
      if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
      if (path === '/api/dashboard-layout') {
        if (route.request().method() === 'GET') {
          return route.fulfill({ json: { layout: serverDashboardLayout } });
        }
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          serverDashboardLayout = body.layout;
          return route.fulfill({ json: { ok: true } });
        }
      }
      if (path === '/api/commands')
        return route.fulfill({
          json: {
            commands: [
              { name: 'pi status', description: 'Show session status' },
              { name: 'pi new', description: 'Start a fresh pi session' },
              { name: 'agy-usage', description: 'Check Antigravity quota' },
            ],
          },
        });
      if (path === '/api/models')
        return route.fulfill({
          json: {
            models: [
              {
                ref: 'openai/gpt-5',
                id: 'gpt-5',
                name: 'GPT-5',
                label: 'GPT-5',
                provider: 'openai',
                reasoning: true,
              },
              {
                ref: 'agy/gemini-3-pro',
                id: 'gemini-3-pro',
                name: 'Gemini 3 Pro',
                label: 'Gemini 3 Pro',
                provider: 'agy',
                reasoning: true,
                current: true,
              },
              {
                ref: 'claude/claude-opus-4-6',
                id: 'claude-opus-4-6',
                name: 'Claude Opus 4.6',
                label: 'Claude Opus 4.6',
                provider: 'claude',
                reasoning: true,
              },
            ],
          },
        });

      const matchEvents = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (matchEvents) {
        const jid = matchEvents[1];
        const session = sessions.find((s) => s.jid === jid)!;
        return route.fulfill({
          json: {
            events: eventsBySession[jid] || [],
            busy: session?.busy ?? false,
            hasMore: false,
            partial: session?.busy
              ? { content: 'ROCm 7.x hipBLASLt stream running @ 92.4 tok/s…' }
              : null,
            session,
          },
        });
      }

      const matchBtw = path.match(/^\/api\/sessions\/([^/]+)\/btw$/);
      if (matchBtw && route.request().method() === 'GET') {
        const jid = matchBtw[1];
        const session = sessions.find((s) => s.jid === jid)!;
        return route.fulfill({
          json: {
            available: true,
            generation: `gen-${jid}`,
            thread: {
              modelRef: session?.model || 'openai/gpt-5',
              thinkingLevel: 'high',
              contextMessages: 4,
              messages: [
                {
                  role: 'user',
                  content: '這個視窗的 BTW 側聊可以獨立運作嗎？',
                  createdAt: '2026-10-18T01:07:55Z',
                },
                {
                  role: 'assistant',
                  content: '可以！每個並排視窗都有自己獨立的 BTW 側聊上下文與切換列。',
                  createdAt: '2026-10-18T01:08:00Z',
                },
              ],
            },
          },
        });
      }

      const matchStream = path.match(/^\/api\/sessions\/([^/]+)\/stream$/);
      if (matchStream) {
        return route.fulfill({
          contentType: 'text/event-stream; charset=utf-8',
          body: 'retry: 60000\n\n',
        });
      }

      const matchMsg = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (matchMsg && route.request().method() === 'POST') {
        const jid = matchMsg[1];
        const body = route.request().postDataJSON();
        sentMessages.push({ jid, text: body.text });
        const files = (body.attachments || []).map(
          (a: any, i: number) => `/api/sessions/${jid}/media/upload-${i}-${a.name}`,
        );
        const eventId = eventsBySession[jid].length + 1;
        eventsBySession[jid].push({
          id: eventId,
          kind: 'message',
          role: 'user',
          content: body.text,
          files,
          createdAt: '2026-10-18T01:12:00Z',
        });
        return route.fulfill({ status: 200, json: { ok: true, eventId, files } });
      }

      return route.fulfill({ json: { ok: true } });
    });



  await page.addInitScript(() => {
    let height = 844;
    let offsetTop = 0;
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => height });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, get: () => offsetTop });
    // iOS pans the visual viewport down the page when the keyboard opens; the
    // pan defaults to the bottom of the 844px layout viewport.
    (window as any).__setVisibleHeight = (value: number, emit = true, top = 844 - value) => {
      height = value;
      offsetTop = top;
      if (emit) window.visualViewport!.dispatchEvent(new Event('resize'));
    };
  });
  await page.goto('/');
  await expect(page.locator('#input')).toBeVisible();
  await page.locator('#input').focus();
  await page.locator('#messages').evaluate(el => { el.scrollTop = 100; });
  const readerTop = await page.locator('#messages').evaluate(el => el.scrollTop);
  const mainBottom = () => page.locator('.main').evaluate(el => Math.round(el.getBoundingClientRect().bottom));
  const rect = (selector: string) => page.locator(selector).evaluate(el => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
  });
  // The keyboard only shrinks the VISUAL viewport, and iOS pans it down the
  // page. A full-height shell then showed the composer's safe-area padding and
  // the page height below it as a blank band above the keyboard (iPhone
  // screenshot, 2026-10-20); a shell shrunk without following the pan floated
  // the composer at the top (715f9cc). The shell must cover exactly the
  // visible area, wherever iOS panned it.
  await page.evaluate(() => (window as any).__setVisibleHeight(480));
  await page.waitForTimeout(800); // past the 700ms settling samples
  expect(await rect('.app')).toEqual({ top: 364, bottom: 844 });
  expect((await rect('#composer')).bottom).toBe(844 - 10);
  await page.screenshot({ path: info.outputPath('01-chat-keyboard-visible-height-480.png') });
  await page.evaluate(() => (window as any).__setVisibleHeight(480, true, 300)); // iOS moved the pan
  await expect.poll(() => rect('.app')).toEqual({ top: 300, bottom: 780 });
  expect((await rect('#composer')).bottom).toBe(780 - 10);
  // iOS 26 can leave the visual viewport short after the keyboard closes
  // (WebKit 301857): the shell stayed squeezed into the top part of an empty
  // screen (iPhone screenshot, 2026-10-22). No typing focus, no keyboard.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect.poll(() => rect('.app')).toEqual({ top: 0, bottom: 844 });
  await page.waitForTimeout(800);
  expect(await rect('.app')).toEqual({ top: 0, bottom: 844 });
  expect(await mainBottom()).toBe(844);
  await page.screenshot({ path: info.outputPath('01b-chat-blurred-viewport-left-short.png') });
  await page.locator('#input').focus();
  await expect.poll(() => rect('.app')).toEqual({ top: 300, bottom: 780 });
  await page.evaluate(() => (window as any).__setVisibleHeight(844));
  await expect(page.locator('#input')).toBeFocused();
  expect(await mainBottom()).toBe(844);
  expect(await page.locator('#messages').evaluate(el => el.scrollTop)).toBe(readerTop);
  await page.evaluate(() => {
    (window as any).__setVisibleHeight(390, false);
    window.dispatchEvent(new Event('orientationchange'));
    setTimeout(() => (window as any).__setVisibleHeight(844, false), 50);
  });
  await page.waitForTimeout(800);
  expect(await mainBottom()).toBe(844);
  await page.locator('#btn-topbar-dashboard').click();
  await expect(page.locator('#dashboard-view')).toBeVisible();
  // Dashboard (iPhone recording 2026-10-22): the keyboard must not squeeze the
  // panes into the visible strip. The shell keeps its full height at the pan,
  // so every pane stays where it was on screen and the keyboard covers what is
  // below; only an input card it would cover moves up, just clear of it.
  await page.locator('#btn-dashboard-drawer').click();
  await page.locator('#session-list .session-item').nth(1).locator('.session-tile-btn').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(2);
  await page.locator('.dashboard-preset-btn[data-preset="vertical"]').click();
  await page.waitForTimeout(700);
  const onScreen = () => page.evaluate(() => {
    const top = window.visualViewport!.offsetTop;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top - top), bottom: Math.round(r.bottom - top) };
    };
    return {
      panes: [...document.querySelectorAll('.dashboard-pane')].map(box),
      dock: box(document.querySelector('.dashboard-pane.composer-active .dashboard-pane-dock')!),
      lifted: [...document.querySelectorAll('.dashboard-pane')].map(p => p.classList.contains('kb-lifted')),
    };
  });
  const paneAt = (i: number) => page.locator('.dashboard-pane').nth(i);
  await paneAt(0).locator('.msg-text').first().tap();
  await expect(paneAt(0)).toHaveClass(/composer-active/);
  const rest = await onScreen();
  await page.evaluate(() => (window as any).__setVisibleHeight(480));
  await page.waitForTimeout(800);
  const app = await rect('.app');
  expect(app).toEqual({ top: 364, bottom: 364 + 844 });
  const topTyping = await onScreen();
  expect(topTyping.panes).toEqual(rest.panes);
  expect(topTyping.dock.bottom).toBeLessThanOrEqual(480 - 6);
  // The top card is above the keyboard already: nothing moves at all.
  expect(rest.dock.bottom).toBeLessThanOrEqual(480 - 6);
  expect(topTyping.dock).toEqual(rest.dock);
  expect(topTyping.lifted).toEqual([false, false]);
  await page.screenshot({ path: info.outputPath('02-dashboard-keyboard-top-pane.png') });

  // Typing in the lower pane (it sits under the keyboard, so it is tapped with
  // the keyboard down): its card rises over the pane above, the panes stay.
  // Closing the iOS keyboard also blurs the textarea.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => (window as any).__setVisibleHeight(844));
  await page.waitForTimeout(800);
  await paneAt(1).locator('.msg-text').first().tap();
  await expect(paneAt(1)).toHaveClass(/composer-active/);
  await page.waitForTimeout(500);
  // The first tap brings the card; the second opens the keyboard.
  await expect(paneAt(1).locator('textarea')).not.toBeFocused();
  await paneAt(1).locator('.msg-text').first().tap();
  await expect(paneAt(1).locator('textarea')).toBeFocused();
  const bottomRest = (await onScreen()).dock;
  await page.evaluate(() => (window as any).__setVisibleHeight(480));
  await page.waitForTimeout(800);
  const bottomTyping = await onScreen();
  expect(bottomTyping.panes).toEqual(rest.panes);
  expect(bottomTyping.lifted).toEqual([false, true]);
  expect(bottomTyping.dock.bottom).toBe(480 - 6);
  expect(bottomTyping.dock.top).toBeGreaterThanOrEqual(8);
  await expect(paneAt(1).locator('textarea')).toBeFocused();
  // The lifted card is what a tap there hits, not the pane above.
  const hit = await page.evaluate(({ y }) => {
    const top = window.visualViewport!.offsetTop;
    return document.elementFromPoint(195, top + y)?.closest('.dashboard-pane-dock')?.closest('.dashboard-pane') ===
      document.querySelectorAll('.dashboard-pane')[1];
  }, { y: bottomTyping.dock.bottom - 20 });
  expect(hit).toBe(true);
  await page.screenshot({ path: info.outputPath('02b-dashboard-keyboard-bottom-pane.png') });

  await page.evaluate(() => (window as any).__setVisibleHeight(844));
  await expect.poll(() => page.locator('.dashboard-stage').evaluate(el => Math.round(el.getBoundingClientRect().bottom))).toBe(844);
  await expect.poll(async () => (await onScreen()).lifted).toEqual([false, false]);
  expect((await onScreen()).dock).toEqual(bottomRest);
  await page.screenshot({ path: info.outputPath('02-dashboard-after-keyboard.png') });
  // iOS 26 standalone short-viewport rule (WebKit 301108). Chromium cannot
  // emulate standalone or the bug, so force the media rule on and check the
  // guard holds: with no top inset the page is exactly screen-tall and never
  // scrolls or overflows sideways.
  const forced = await page.evaluate(() => {
    let n = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          const media = (rule as CSSMediaRule).media;
          if (media && /display-mode:\s*standalone/.test(media.mediaText)) { media.mediaText = 'all'; n++; }
        }
      } catch {}
    }
    return n;
  });
  expect(forced).toBeGreaterThan(0);
  const metrics = await page.evaluate(() => ({
    htmlMin: getComputedStyle(document.documentElement).minHeight,
    scrollH: document.documentElement.scrollHeight,
    clientH: document.documentElement.clientHeight,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(metrics.htmlMin).not.toBe('0px');
  expect(metrics.scrollH).toBe(metrics.clientH);
  expect(metrics.scrollW).toBe(metrics.clientW);
  expect(errors).toEqual([]);
});
