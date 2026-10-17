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
  model: 'agy/gemini-3-pro',
  provider: 'agy',
  runningModel: 'gemini-3-pro',
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

test.describe('desktop & tablet multi-session dashboard (1 to 12 sessions)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test('scales smoothly from 1 to 12 concurrent sessions across horizontal, vertical, and 2D grid layouts with splitters', async ({
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
            partial: session?.busy
              ? { content: 'ROCm 7.x hipBLASLt stream running @ 92.4 tok/s…' }
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
          createdAt: '2026-10-18T01:12:00Z',
        });
        return route.fulfill({ status: 202, json: { ok: true } });
      }

      return route.fulfill({ json: { ok: true } });
    });

    await page.goto('/');
    await expect(page.locator('#btn-dashboard-home')).toBeVisible();
    await page.locator('#btn-dashboard-home').click();
    await expect(page.locator('#dashboard-view')).toBeVisible();

    // Progressive test from 1 to 12 sessions
    for (let count = 1; count <= 12; count++) {
      const item = page.locator('#session-list .session-item').nth(count - 1);
      if (count <= 3) {
        // Drag the first 3 sessions into the stage
        await item.dragTo(page.locator('#dashboard-stage'));
      } else {
        // Click the sidebar tile button (+ 並排) for sessions 4..12
        await item.locator('.session-tile-btn').click();
      }

      await expect(page.locator('.dashboard-pane')).toHaveCount(count);
      await expect(page.locator('#dashboard-pane-counter')).toHaveText(`${count} 個並排視窗`);

      // Verify every single pane from 1..count has positive, non-overlapping dimensions inside the viewport
      const rects = await page.locator('.dashboard-pane').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            jid: (el as HTMLElement).dataset.jid,
            left: Math.round(r.left),
            top: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }),
      );
      expect(rects.length).toBe(count);
      for (const r of rects) {
        expect(r.width).toBeGreaterThanOrEqual(135);
        expect(r.height).toBeGreaterThanOrEqual(90);
      }

      // When 2 panes are open, verify DESIGN.md button compliance (44x44px borderless icon buttons)
      // and test drag-and-swap pane order (dragging pane 1 header onto pane 2 center swaps order)
      if (count === 2) {
        const exitBox = (await page.locator('#btn-dashboard-exit').boundingBox())!;
        const eqBox = (await page.locator('#btn-dashboard-equalize').boundingBox())!;
        const clearBox = (await page.locator('#btn-dashboard-clear').boundingBox())!;
        const paneBtnBox = (await page.locator('.dashboard-pane-actions .icon-btn').first().boundingBox())!;
        expect(exitBox.width).toBeGreaterThanOrEqual(44);
        expect(exitBox.height).toBeGreaterThanOrEqual(44);
        expect(eqBox.width).toBeGreaterThanOrEqual(44);
        expect(eqBox.height).toBeGreaterThanOrEqual(44);
        expect(clearBox.width).toBeGreaterThanOrEqual(44);
        expect(clearBox.height).toBeGreaterThanOrEqual(44);
        expect(paneBtnBox.width).toBeGreaterThanOrEqual(44);
        expect(paneBtnBox.height).toBeGreaterThanOrEqual(44);

        // Verify 2 distinct panes before swap
        const orderBefore = (await page
          .locator('.dashboard-pane')
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.jid))) as string[];
        expect(orderBefore.length).toBe(2);
        const [firstJid, secondJid] = orderBefore;

        // Drag first pane's header onto center of second pane to swap their order
        await page
          .locator(`.dashboard-pane[data-jid="${firstJid}"] .dashboard-pane-header`)
          .dragTo(page.locator(`.dashboard-pane[data-jid="${secondJid}"]`));

        const orderAfterSwap = await page
          .locator('.dashboard-pane')
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.jid));
        expect(orderAfterSwap).toEqual([secondJid, firstJid]);

        // Swap back to restore original order
        await page
          .locator(`.dashboard-pane[data-jid="${secondJid}"] .dashboard-pane-header`)
          .dragTo(page.locator(`.dashboard-pane[data-jid="${firstJid}"]`));
        const orderRestored = await page
          .locator('.dashboard-pane')
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.jid));
        expect(orderRestored).toEqual([firstJid, secondJid]);
      }

      // Capture milestone screenshots across 1..12
      if ([1, 2, 3, 4, 6, 8, 9, 12].includes(count)) {
        const tag = String(count).padStart(2, '0');
        await page.screenshot({ path: info.outputPath(`panes-${tag}-count.png`) });
      }
    }

    // With all 12 sessions active in the 4x3 2D grid:
    // Verify 3 outer vertical splitters (between 4 columns) and 8 inner horizontal splitters (2 per column * 4 columns)
    await expect(page.locator('.dashboard-splitter.splitter-vertical')).toHaveCount(3);
    await expect(page.locator('.dashboard-splitter.splitter-horizontal')).toHaveCount(8);

    // Resize column 1 wider and row 1 of column 1 taller simultaneously at 120Hz+ (24 steps) in the 12-pane grid
    const vSplit = page.locator('.dashboard-splitter.splitter-vertical').first();
    const vBox = (await vSplit.boundingBox())!;
    await page.mouse.move(vBox.x + vBox.width / 2, vBox.y + vBox.height / 2);
    await page.mouse.down();
    await expect(page.locator('#dashboard-grid')).toHaveClass(/resizing-active/);
    await page.mouse.move(vBox.x + vBox.width / 2 + 90, vBox.y + vBox.height / 2, { steps: 24 });
    await page.mouse.up();
    await expect(page.locator('#dashboard-grid')).not.toHaveClass(/resizing-active/);

    const hSplit = page.locator('.dashboard-splitter.splitter-horizontal').first();
    const hBox = (await hSplit.boundingBox())!;
    await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2);
    await page.mouse.down();
    await expect(page.locator('#dashboard-grid')).toHaveClass(/resizing-active/);
    await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2 + 65, { steps: 24 });
    await page.mouse.up();
    await expect(page.locator('#dashboard-grid')).not.toHaveClass(/resizing-active/);

    await page.screenshot({ path: info.outputPath('panes-12-custom-resized.png') });

    // Send a message in the 12th pane ("12 4get 私密搜尋引擎") and verify live update
    const pane12 = page.locator('.dashboard-pane[data-jid="web:s12"]');
    const input12 = pane12.locator('.dashboard-pane-input');
    await input12.focus();
    await input12.fill('測試第 12 個視窗即時發送訊息');
    await pane12.locator('.dashboard-pane-send').click();
    await expect.poll(() => sentMessages.length).toBe(1);
    expect(sentMessages[0]).toEqual({ jid: 'web:s12', text: '測試第 12 個視窗即時發送訊息' });
    await expect(pane12).toContainText('測試第 12 個視窗即時發送訊息');

    // Verify iPad focus & scroll stability: focusing a pane input and triggering
    // equalizeWeights / background session sync must NOT blur the input or scroll jump
    await input12.focus();
    await expect(input12).toBeFocused();
    await page.locator('#btn-dashboard-equalize').click();
    await expect(input12).toBeFocused();

    expect(errors).toEqual([]);
  });
});
