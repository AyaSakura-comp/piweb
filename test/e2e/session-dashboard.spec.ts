import { expect, test } from 'playwright/test';

const sessions = [
  {
    jid: 'web:alpha',
    name: '前端架構重構',
    folder: 'web_alpha',
    kind: 'standard',
    deleted: false,
    model: 'claude-code/opus',
    provider: 'claude-code',
    runningModel: 'opus',
    badge: { label: 'OPUS', kind: 'claude' },
    busy: false,
    lastReplyId: 2,
    lastActivity: '2026-10-17 15:10:00',
  },
  {
    jid: 'web:beta',
    name: 'ROCm 推論壓測',
    folder: 'web_beta',
    kind: 'standard',
    deleted: false,
    model: 'agy/gemini-3-pro',
    provider: 'agy',
    runningModel: 'gemini-3-pro',
    badge: { label: 'AGY', kind: 'gem' },
    busy: true,
    lastReplyId: 1,
    lastActivity: '2026-10-17 15:09:00',
  },
  {
    jid: 'web:gamma',
    name: '台股 Shioaji 回測',
    folder: 'web_gamma',
    kind: 'standard',
    deleted: false,
    model: 'openai-codex/gpt-5',
    provider: 'openai-codex',
    runningModel: 'gpt-5',
    badge: { label: 'GPT', kind: 'gpt' },
    busy: false,
    lastReplyId: 1,
    lastActivity: '2026-10-17 15:08:00',
  },
];

const eventsBySession: Record<string, any[]> = {
  'web:alpha': [
    {
      id: 1,
      kind: 'message',
      role: 'user',
      content: '請幫我檢查 Dashboard 並排視窗的排版與 RWD',
      files: [],
      createdAt: '2026-10-17T15:05:00Z',
    },
    {
      id: 2,
      kind: 'message',
      role: 'assistant',
      content: '沒問題！我們已經將 Flexbox 自動並排與可拖拉分隔線（Splitter）設定完成。',
      files: [],
      createdAt: '2026-10-17T15:06:00Z',
    },
  ],
  'web:beta': [
    {
      id: 1,
      kind: 'message',
      role: 'user',
      content: '開始執行 Strix Halo llama.cpp Q8 KV cache benchmark',
      files: [],
      createdAt: '2026-10-17T15:07:00Z',
    },
    {
      id: 2,
      kind: 'tool',
      role: 'Bash',
      content: './llama-bench -m qwen3-30b-a3b.gguf -ngl 99 -fa 1',
      files: [],
      createdAt: '2026-10-17T15:08:00Z',
    },
  ],
  'web:gamma': [
    {
      id: 1,
      kind: 'message',
      role: 'user',
      content: '查詢台積電 2330 今日 Tick 模擬成交明細',
      files: [],
      createdAt: '2026-10-17T15:04:00Z',
    },
    {
      id: 2,
      kind: 'message',
      role: 'assistant',
      content: '已載入 Sinopac 模擬環境，2330 檔位 Tick 為 1.0 元，回測夏普率 2.41。',
      files: [],
      createdAt: '2026-10-17T15:05:30Z',
    },
  ],
};

test.describe('desktop & tablet multi-session dashboard', () => {
  test.use({ viewport: { width: 1280, height: 820 }, isMobile: false, hasTouch: false });

  test('drags sessions into auto-aligned side-by-side panes, resizes via splitter, and sends messages', async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    const sentMessages: Array<{ jid: string; text: string }> = [];

    await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
    await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const path = decodeURIComponent(url.pathname);
      if (path === '/api/me') return route.fulfill({ json: { authed: true } });
      if (path === '/api/sessions') return route.fulfill({ json: { sessions } });
      if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
      if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
      if (path === '/api/models') return route.fulfill({ json: { models: [] } });

      const matchEvents = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (matchEvents) {
        const jid = matchEvents[1];
        const session = sessions.find((s) => s.jid === jid)!;
        return route.fulfill({
          json: {
            events: eventsBySession[jid] || [],
            busy: session?.busy ?? false,
            hasMore: false,
            partial:
              jid === 'web:beta'
                ? { content: 'Prompt processing: 1,420 t/s · Token generation: 88.4 t/s' }
                : null,
            session,
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
        eventsBySession[jid].push({
          id: eventsBySession[jid].length + 1,
          kind: 'message',
          role: 'user',
          content: body.text,
          files: [],
          createdAt: '2026-10-17T15:12:00Z',
        });
        return route.fulfill({ status: 202, json: { ok: true } });
      }

      return route.fulfill({ json: { ok: true } });
    });

    await page.goto('/');
    await expect(page.locator('#session-name')).toHaveText('前端架構重構');

    // 1. Open Dashboard from sidebar Home button
    const navBtn = page.locator('#btn-dashboard-home');
    await expect(navBtn).toBeVisible();
    await navBtn.click();

    const dashView = page.locator('#dashboard-view');
    await expect(dashView).toBeVisible();
    await expect(page.locator('#dashboard-empty')).toBeVisible();
    await page.screenshot({ path: info.outputPath('01-dashboard-empty.png') });

    // 2. Drag first session ("前端架構重構") from sidebar into the dashboard stage
    const firstItem = page.locator('#session-list .session-item').nth(0);
    const secondItem = page.locator('#session-list .session-item').nth(1);
    const thirdItem = page.locator('#session-list .session-item').nth(2);

    await firstItem.dragTo(page.locator('#dashboard-stage'));
    await expect(page.locator('.dashboard-pane')).toHaveCount(1);
    await expect(page.locator('.dashboard-pane').first()).toContainText('前端架構重構');
    await expect(page.locator('.dashboard-pane').first()).toContainText('可拖拉分隔線');

    // 3. Drag second session ("ROCm 推論壓測") to auto-align side by side
    await secondItem.dragTo(page.locator('#dashboard-stage'));
    await expect(page.locator('.dashboard-pane')).toHaveCount(2);
    await expect(page.locator('.dashboard-splitter')).toHaveCount(1);
    await expect(page.locator('#dashboard-pane-counter')).toHaveText('2 個並排視窗');
    await page.screenshot({ path: info.outputPath('02-two-panes-aligned.png') });

    // Verify both panes are automatically equal width initially
    const beforeResize = await page.locator('.dashboard-pane').evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    );
    expect(Math.abs(beforeResize[0] - beforeResize[1])).toBeLessThan(4);

    // 4. Drag third session ("台股 Shioaji 回測") to form a 3-column workspace
    await thirdItem.dragTo(page.locator('#dashboard-stage'));
    await expect(page.locator('.dashboard-pane')).toHaveCount(3);
    await expect(page.locator('.dashboard-splitter')).toHaveCount(2);
    await expect(page.locator('#dashboard-pane-counter')).toHaveText('3 個並排視窗');
    await page.screenshot({ path: info.outputPath('03-three-panes-aligned.png') });

    // 5. Drag the first splitter to resize pane 1 wider and pane 2 narrower
    const splitter = page.locator('.dashboard-splitter').first();
    const splitBox = (await splitter.boundingBox())!;
    const cx = splitBox.x + splitBox.width / 2;
    const cy = splitBox.y + splitBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy, { steps: 8 });
    await page.mouse.up();

    const afterResize = await page.locator('.dashboard-pane').evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    );
    expect(afterResize[0]).toBeGreaterThan(afterResize[1] + 150);
    await page.screenshot({ path: info.outputPath('04-resized-panes.png') });

    // 6. Click "平均對齊" to restore equal alignment across all panes
    await page.locator('#btn-dashboard-equalize').click();
    const equalized = await page.locator('.dashboard-pane').evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    );
    expect(Math.abs(equalized[0] - equalized[1])).toBeLessThan(4);
    expect(Math.abs(equalized[1] - equalized[2])).toBeLessThan(4);

    // 7. Send a message directly inside the 3rd pane ("台股 Shioaji 回測") while monitoring the others
    const thirdPane = page.locator('.dashboard-pane[data-jid="web:gamma"]');
    await thirdPane.locator('.dashboard-pane-input').fill('下單測試 2330 零股 100 股');
    await thirdPane.locator('.dashboard-pane-send').click();
    await expect.poll(() => sentMessages.length).toBe(1);
    expect(sentMessages[0]).toEqual({ jid: 'web:gamma', text: '下單測試 2330 零股 100 股' });
    await expect(thirdPane).toContainText('下單測試 2330 零股 100 股');
    await page.screenshot({ path: info.outputPath('05-multi-session-interaction.png') });

    expect(errors).toEqual([]);
  });
});
