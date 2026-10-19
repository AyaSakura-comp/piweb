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

test('phone dashboard opens, adds panes, survives rotation and closes without gaps', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
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


  await page.goto('/');
  await page.locator('#btn-topbar-dashboard').click();
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await page.locator('#btn-dashboard-drawer').click();
  await expect(page.locator('.drawer')).toHaveClass(/open/);
  await page.locator('#session-list .session-item').nth(1).locator('.session-tile-btn').click();
  await expect(page.locator('.drawer')).not.toHaveClass(/open/);
  await expect(page.locator('.dashboard-pane')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const pane = page.locator('.dashboard-pane').last();
  await pane.scrollIntoViewIfNeeded();
  await expect(pane.locator('textarea')).toBeVisible();
  await page.screenshot({ path: info.outputPath('01-phone-dashboard.png') });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.dashboard-pane')).toHaveCount(2);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('piweb.dashboard')!));
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('piweb.dashboard')!))).toEqual(saved);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.dashboard-pane').last().locator('.pane-close-btn').click();
  await expect(page.locator('.dashboard-pane')).toHaveCount(1);
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await expect.poll(async () => {
    const remaining = await page.locator('.dashboard-pane').boundingBox();
    const grid = await page.locator('#dashboard-grid').boundingBox();
    return remaining!.height >= grid!.height - 2;
  }).toBe(true);
  await page.screenshot({ path: info.outputPath('02-phone-after-close.png') });
  expect(errors).toEqual([]);
});
