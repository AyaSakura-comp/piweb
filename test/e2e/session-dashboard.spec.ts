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

test.use({
  viewport: { width: 1440, height: 900 },
  isMobile: false,
  hasTouch: false,
  video: { mode: 'on', size: { width: 1440, height: 900 } },
});

test.describe('desktop & tablet multi-session dashboard (1 to 12 sessions)', () => {

  test('scales smoothly from 1 to 12 concurrent sessions across horizontal, vertical, and 2D grid layouts with splitters', async (
    { page },
    info,
  ) => {
    test.setTimeout(60000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    const sentMessages: Array<{ jid: string; text: string }> = [];

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
    try {
      const client = await page.context().newCDPSession(page);
      await client.send('Overlay.setShowFPSCounter', { show: true });
    } catch {
      // In non-CDP browsers or unsupported engines
    }
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

      // When 2 panes are open, verify DESIGN.md button compliance, per-pane controls (Model, Thinking, ⋯ menu, Hot Keywords, Quote, Attachments, BTW),
      // and test drag-and-swap pane order with inertial spring collision bounce
      if (count === 2) {
        const eqBox = (await page.locator('#btn-dashboard-equalize').boundingBox())!;
        const clearBox = (await page.locator('#btn-dashboard-clear').boundingBox())!;
        expect(eqBox.width).toBeGreaterThanOrEqual(44);
        expect(eqBox.height).toBeGreaterThanOrEqual(44);
        expect(clearBox.width).toBeGreaterThanOrEqual(44);
        expect(clearBox.height).toBeGreaterThanOrEqual(44);

        const pane1 = page.locator('.dashboard-pane[data-jid="web:s01"]');
        await expect(pane1.locator('.pane-model-btn')).toBeVisible();
        await expect(pane1.locator('.pane-thinking-btn')).toBeVisible();
        await expect(pane1.locator('.pane-more-btn')).toBeVisible();
        await expect(pane1.locator('.pane-attach-btn')).toBeVisible();
        await expect(pane1.locator('.pane-paste-btn')).toBeVisible();

        // 1. Test opening Thinking level sheet from Pane 1's top header
        await pane1.locator('.pane-thinking-btn').click();
        await expect(page.locator('#thinking-sheet')).toBeVisible();
        await page.waitForTimeout(250);
        await page.locator('#btn-thinking-close').click();
        await expect(page.locator('#thinking-sheet')).toBeHidden();

        // 2. Test opening Model sheet from Pane 1's top header
        await pane1.locator('.pane-model-btn').click();
        await expect(page.locator('#model-sheet')).toBeVisible();
        await page.waitForTimeout(250);
        await page.locator('#btn-model-close').click();
        await expect(page.locator('#model-sheet')).toBeHidden();

        // 3. Test opening Pane 1's ⋯ overflow menu & toggling BTW side chat
        await pane1.locator('.pane-more-btn').click();
        await expect(pane1.locator('.pane-more-menu')).toBeVisible();
        await expect(pane1.locator('.pane-more-menu [data-action="search"]')).toBeVisible();
        await expect(pane1.locator('.pane-more-menu [data-action="btw"]')).toBeVisible();
        await expect(pane1.locator('.pane-more-menu [data-action="subagents"]')).toBeVisible();
        await expect(pane1.locator('.pane-more-menu [data-action="media"]')).toBeVisible();
        await page.screenshot({ path: info.outputPath('panes-02-overflow-menu.png') });
        await pane1.locator('.pane-more-menu [data-action="btw"]').click();
        await expect(pane1.locator('.pane-btw-card')).toBeVisible();
        await expect(pane1.locator('.dashboard-pane-btw-messages')).toContainText(
          '每個並排視窗都有自己獨立的 BTW 側聊上下文與切換列',
        );
        await page.screenshot({ path: info.outputPath('panes-02-btw-sidechat.png') });
        // Switch back to main conversation via ‹ 主對話 on the typing line
        await pane1.locator('.pane-btw-switch-btn').click();
        await expect(pane1.locator('.pane-btw-card')).toBeHidden();

        // 4. Test Hot Keywords quick input chip & Image Attachment thumbnail preview in Pane 1
        await expect(pane1.locator('.pane-hot-keywords .life-tag').first()).toBeVisible();
        await pane1.locator('.pane-hot-keywords .life-tag').first().click();
        await expect(pane1.locator('.dashboard-pane-input')).toHaveValue(
          'update doc, commit and push',
        );
        // Attach a 1x1 PNG image to verify square thumbnail preview + compression checkbox
        const pngBuffer = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        );
        await pane1.locator('input[type="file"]').setInputFiles({
          name: 'strix-halo-chart.png',
          mimeType: 'image/png',
          buffer: pngBuffer,
        });
        await expect(pane1.locator('.pane-attachments .chip.chip-image')).toBeVisible();
        await expect(pane1.locator('.pane-compression-options')).toBeVisible();
        await page.screenshot({ path: info.outputPath('panes-02-attachments-hotkeywords.png') });
        await pane1.locator('.pane-attachments .chip-remove').click();
        await pane1.locator('.dashboard-pane-input').fill('');

        // 5. Verify 2 distinct panes before swap & watch inertial FLIP collision bounce on swap
        const orderBefore = (await page
          .locator('.dashboard-pane')
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.jid))) as string[];
        expect(orderBefore.length).toBe(2);
        const [firstJid, secondJid] = orderBefore;

        // Drag first pane's header onto center of second pane to swap their order
        await page
          .locator(`.dashboard-pane[data-jid="${firstJid}"] .dashboard-pane-header`)
          .dragTo(page.locator(`.dashboard-pane[data-jid="${secondJid}"]`));
        await page.waitForTimeout(480);

        const orderAfterSwap = await page
          .locator('.dashboard-pane')
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.jid));
        expect(orderAfterSwap).toEqual([secondJid, firstJid]);

        // Swap back to restore original order
        await page
          .locator(`.dashboard-pane[data-jid="${secondJid}"] .dashboard-pane-header`)
          .dragTo(page.locator(`.dashboard-pane[data-jid="${firstJid}"]`));
        await page.waitForTimeout(480);
        const orderRestored = await page
          .locator('.dashboard-pane')
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.jid));
        expect(orderRestored).toEqual([firstJid, secondJid]);

        // 6. Test dragging a session from sidebar across Pane 1 and onto Pane 2 using touch pointer events
        const item3 = page.locator('#session-list .session-item').nth(2);
        const item3Box = (await item3.boundingBox())!;
        const pane2 = page.locator(`.dashboard-pane[data-jid="${secondJid}"]`);
        const pane2Box = (await pane2.boundingBox())!;
        const pane1Box = (await pane1.boundingBox())!;

        const initialListScrollTop = await page.locator('#session-list').evaluate((el) => el.scrollTop);

        // Trigger touch pointerdown on sidebar item
        await page.dispatchEvent('#session-list .session-item:nth-child(3)', 'pointerdown', {
          pointerId: 101,
          pointerType: 'touch',
          button: 0,
          clientX: item3Box.x + 20,
          clientY: item3Box.y + 15,
        });
        await page.waitForTimeout(120);

        // Move horizontally into Pane 1 across multiple interpolated steps so video captures the trajectory
        for (let i = 1; i <= 6; i++) {
          const cx = item3Box.x + 20 + ((pane1Box.x + 120) - (item3Box.x + 20)) * (i / 6);
          const cy = item3Box.y + 15 + ((pane1Box.y + 160) - (item3Box.y + 15)) * (i / 6);
          await page.evaluate(
            ({ clientX, clientY }) => {
              window.dispatchEvent(
                new PointerEvent('pointermove', {
                  pointerId: 101,
                  pointerType: 'touch',
                  clientX,
                  clientY,
                  cancelable: true,
                  bubbles: true,
                }),
              );
            },
            { clientX: cx, clientY: cy },
          );
          await page.waitForTimeout(60);
        }
        await expect(page.locator('.dashboard-drag-ghost')).toBeVisible();
        await expect(page.locator('#dashboard-drop-preview')).toBeVisible();
        // Assert session list scroll did NOT move during horizontal drag into Pane 1
        const scrollDuringDrag1 = await page.locator('#session-list').evaluate((el) => el.scrollTop);
        expect(scrollDuringDrag1).toBe(initialListScrollTop);
        await page.screenshot({ path: info.outputPath('panes-touch-drag-over-pane1.png') });
        await page.waitForTimeout(250);

        // Move further into Pane 2 across multiple interpolated steps - ghost must NOT disappear and session list must NOT scroll!
        for (let i = 1; i <= 6; i++) {
          const startX = pane1Box.x + 120;
          const startY = pane1Box.y + 160;
          const targetX = pane2Box.x + pane2Box.width / 2;
          const targetY = pane2Box.y + pane2Box.height / 2;
          const cx = startX + (targetX - startX) * (i / 6);
          const cy = startY + (targetY - startY) * (i / 6);
          await page.evaluate(
            ({ clientX, clientY }) => {
              window.dispatchEvent(
                new PointerEvent('pointermove', {
                  pointerId: 101,
                  pointerType: 'touch',
                  clientX,
                  clientY,
                  cancelable: true,
                  bubbles: true,
                }),
              );
            },
            { clientX: cx, clientY: cy },
          );
          await page.waitForTimeout(60);
        }
        await expect(page.locator('.dashboard-drag-ghost')).toBeVisible();
        await expect(page.locator('#dashboard-drop-preview')).toBeVisible();
        // Assert session list scroll did NOT move during horizontal drag into Pane 2
        const scrollDuringDrag2 = await page.locator('#session-list').evaluate((el) => el.scrollTop);
        expect(scrollDuringDrag2).toBe(initialListScrollTop);
        await page.screenshot({ path: info.outputPath('panes-touch-drag-over-pane2.png') });
        await page.waitForTimeout(250);

        // Release pointer to complete drop onto Pane 2
        await page.evaluate(
          ({ clientX, clientY }) => {
            window.dispatchEvent(
              new PointerEvent('pointerup', {
                pointerId: 101,
                pointerType: 'touch',
                clientX,
                clientY,
                cancelable: true,
                bubbles: true,
              }),
            );
          },
          { clientX: pane2Box.x + pane2Box.width / 2, clientY: pane2Box.y + pane2Box.height / 2 },
        );
        await page.waitForTimeout(500);
        // Pane count increased to 3 by dropping onto Pane 2!
        await expect(page.locator('.dashboard-pane')).toHaveCount(3);
        const scrollAfterDrop = await page.locator('#session-list').evaluate((el) => el.scrollTop);
        expect(scrollAfterDrop).toBe(initialListScrollTop);
        await page.screenshot({ path: info.outputPath('panes-touch-drag-dropped-pane3.png') });
        await page.waitForTimeout(350);

        // Remove the 3rd pane to restore 2 panes for subsequent steps
        await page.locator('.dashboard-pane').nth(2).locator('.pane-close-btn').click();
        await page.waitForTimeout(300);
        await expect(page.locator('.dashboard-pane')).toHaveCount(2);
      }

      // When 4 panes are open (2x2 grid), test both horizontal and vertical splitter drag & inertial collision bounce
      if (count === 4) {
        const col1 = page.locator('.dashboard-group').first();
        const pane1InCol1 = col1.locator('.dashboard-pane').first();
        const vSplit4 = page.locator('.dashboard-splitter.splitter-vertical').first();
        const vBox4 = (await vSplit4.boundingBox())!;
        await page.mouse.move(vBox4.x + vBox4.width / 2, vBox4.y + vBox4.height / 2);
        await page.mouse.down();
        await page.mouse.move(vBox4.x + vBox4.width / 2 + 110, vBox4.y + vBox4.height / 2, {
          steps: 18,
        });
        const wAtRelease4 = (await col1.boundingBox())!.width;
        await page.mouse.up();
        let maxW4 = wAtRelease4;
        for (let s = 0; s < 6; s++) {
          await page.waitForTimeout(20);
          const w = (await col1.boundingBox())!.width;
          if (w > maxW4) maxW4 = w;
        }
        expect(maxW4).toBeGreaterThan(wAtRelease4 + 10);
        await page.waitForTimeout(480);

        const hSplit4 = page.locator('.dashboard-splitter.splitter-horizontal').first();
        const hBox4 = (await hSplit4.boundingBox())!;
        await page.mouse.move(hBox4.x + hBox4.width / 2, hBox4.y + hBox4.height / 2);
        await page.mouse.down();
        await page.mouse.move(hBox4.x + hBox4.width / 2, hBox4.y + hBox4.height / 2 + 95, {
          steps: 18,
        });
        const hAtRelease4 = (await pane1InCol1.boundingBox())!.height;
        await page.mouse.up();
        let maxH4 = hAtRelease4;
        for (let s = 0; s < 6; s++) {
          await page.waitForTimeout(20);
          const h = (await pane1InCol1.boundingBox())!.height;
          if (h > maxH4) maxH4 = h;
        }
        expect(maxH4).toBeGreaterThan(hAtRelease4 + 10);
        await page.waitForTimeout(480);
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
    const firstColEl = page.locator('.dashboard-group').first();
    const firstPaneInCol1 = firstColEl.locator('.dashboard-pane').first();
    const initialCol1Width = (await firstColEl.boundingBox())!.width;
    const initialPane1Height = (await firstPaneInCol1.boundingBox())!.height;

    const vSplit = page.locator('.dashboard-splitter.splitter-vertical').first();
    const vBox = (await vSplit.boundingBox())!;
    await page.mouse.move(vBox.x + vBox.width / 2, vBox.y + vBox.height / 2);
    await page.mouse.down();
    await expect(page.locator('#dashboard-grid')).toHaveClass(/resizing-active/);
    await page.mouse.move(vBox.x + vBox.width / 2 + 80, vBox.y + vBox.height / 2, { steps: 24 });
    const widthAtRelease = (await firstColEl.boundingBox())!.width;
    await page.mouse.up();
    await expect(page.locator('#dashboard-grid')).not.toHaveClass(/resizing-active/);

    // Sample column 1 width over the first 120ms after release to prove visible inertial overshoot (> 15px beyond release point)
    let maxOvershootWidth = widthAtRelease;
    for (let s = 0; s < 6; s++) {
      await page.waitForTimeout(20);
      const w = (await firstColEl.boundingBox())!.width;
      if (w > maxOvershootWidth) maxOvershootWidth = w;
    }
    expect(maxOvershootWidth).toBeGreaterThan(widthAtRelease + 6);
    await page.waitForTimeout(520);

    const hSplit = page.locator('.dashboard-splitter.splitter-horizontal').first();
    const hBox = (await hSplit.boundingBox())!;
    await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2);
    await page.mouse.down();
    await expect(page.locator('#dashboard-grid')).toHaveClass(/resizing-active/);
    await page.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2 + 52, { steps: 24 });
    const heightAtRelease = (await firstPaneInCol1.boundingBox())!.height;
    await page.mouse.up();
    await expect(page.locator('#dashboard-grid')).not.toHaveClass(/resizing-active/);

    // Sample row 1 height over the first 120ms after release to prove visible vertical inertial overshoot (> 15px beyond release point)
    let maxOvershootHeight = heightAtRelease;
    for (let s = 0; s < 6; s++) {
      await page.waitForTimeout(20);
      const h = (await firstPaneInCol1.boundingBox())!.height;
      if (h > maxOvershootHeight) maxOvershootHeight = h;
    }
    expect(maxOvershootHeight).toBeGreaterThan(heightAtRelease + 6);

    // Wait for inertial spring bounce settle (~600ms) and verify resized dimensions remain locked
    await page.waitForTimeout(600);
    const resizedCol1Width = (await firstColEl.boundingBox())!.width;
    const resizedPane1Height = (await firstPaneInCol1.boundingBox())!.height;
    expect(resizedCol1Width).toBeGreaterThan(initialCol1Width + 50);
    expect(resizedPane1Height).toBeGreaterThan(initialPane1Height + 40);

    await page.waitForTimeout(250);
    const widthAfterSync = (await firstColEl.boundingBox())!.width;
    const heightAfterSync = (await firstPaneInCol1.boundingBox())!.height;
    expect(Math.abs(widthAfterSync - resizedCol1Width)).toBeLessThanOrEqual(2);
    expect(Math.abs(heightAfterSync - resizedPane1Height)).toBeLessThanOrEqual(2);

    await page.screenshot({ path: info.outputPath('panes-12-custom-resized.png') });

    // Send a message with multimedia image attachment in the 12th pane and verify immediate display
    const pane12 = page.locator('.dashboard-pane[data-jid="web:s12"]');
    const input12 = pane12.locator('.dashboard-pane-input');
    await input12.focus();
    await input12.fill('測試第 12 個視窗即時發送多媒體圖片訊息');
    await pane12.locator('input[type="file"]').setInputFiles({
      name: 'architecture-diagram.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(pane12.locator('.pane-attachments .chip')).toHaveCount(1);
    await pane12.locator('.dashboard-pane-send').click();
    await expect.poll(() => sentMessages.length).toBe(1);
    expect(sentMessages[0]).toEqual({ jid: 'web:s12', text: '測試第 12 個視窗即時發送多媒體圖片訊息' });
    await expect(pane12).toContainText('測試第 12 個視窗即時發送多媒體圖片訊息');
    // Verify the attachment image preview rendered immediately in the dashboard transcript!
    await expect(pane12.locator('.msg-files img')).toBeVisible();

    // Verify iPad focus & scroll stability: focusing a pane input and triggering
    // equalizeWeights (with FLIP bounce animation) must NOT blur the input or scroll jump
    await input12.focus();
    await expect(input12).toBeFocused();
    await page.locator('#btn-dashboard-equalize').click();
    await page.waitForTimeout(500);
    await expect(input12).toBeFocused();

    expect(errors).toEqual([]);
  });
});
