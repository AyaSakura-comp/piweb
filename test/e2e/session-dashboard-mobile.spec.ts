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
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  eventsBySession['web:s01'][1].content = '手機長訊息回歸測試\n\n'.repeat(100);
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
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
  await expect(page.locator('#dashboard-view')).toHaveCSS('padding-bottom', '0px');
  const rootBox = await page.locator('#dashboard-view').boundingBox();
  const stageBox = await page.locator('.dashboard-stage').boundingBox();
  expect(Math.abs(rootBox!.y + rootBox!.height - stageBox!.y - stageBox!.height)).toBeLessThan(2);
  const firstPane = page.locator('.dashboard-pane').first();
  await firstPane.locator('.dashboard-pane-messages').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(firstPane.locator('.pane-jump-live')).not.toHaveClass(/visible/);
  const messageHeightBeforeJump = await firstPane.locator('.dashboard-pane-messages').evaluate(el => el.clientHeight);
  await firstPane.locator('.dashboard-pane-messages').evaluate(el => { el.scrollTop = 0; });
  await expect(firstPane.locator('.pane-jump-live')).toHaveClass(/visible/);
  expect(await firstPane.locator('.dashboard-pane-messages').evaluate(el => el.clientHeight)).toBe(messageHeightBeforeJump);
  const jumpBox = await firstPane.locator('.pane-jump-live').boundingBox();
  const keywordsBox = await firstPane.locator('.pane-hot-keywords').boundingBox();
  expect(jumpBox!.y + jumpBox!.height).toBeLessThanOrEqual(keywordsBox!.y);
  await expect(firstPane.locator('.pane-jump-live')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: info.outputPath('00-jump-no-overlap.png') });
  await firstPane.locator('.pane-jump-live').click();
  await expect(firstPane.locator('.pane-jump-live')).not.toHaveClass(/visible/);
  expect(await firstPane.locator('.dashboard-pane-messages').evaluate(el => el.clientHeight)).toBe(messageHeightBeforeJump);
  await page.locator('#btn-dashboard-drawer').click();
  await expect(page.locator('.drawer')).toHaveClass(/open/);
  await page.locator('#session-list .session-item').nth(1).locator('.session-tile-btn').click();
  await expect(page.locator('.drawer')).not.toHaveClass(/open/);
  await expect(page.locator('.dashboard-pane')).toHaveCount(2);
  await expect.poll(async () => {
    const paneBox = await page.locator('.dashboard-pane').first().boundingBox();
    const gridBox = await page.locator('#dashboard-grid').boundingBox();
    return paneBox!.height >= gridBox!.height - 2;
  }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(async () => {
  const boxes = await page.locator('.dashboard-pane').evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom };
  }));
  return Math.abs(boxes[0].y - boxes[1].y) < 2 && boxes[1].x > boxes[0].x;
  }).toBe(true);
  await expect(page.locator('.dashboard-splitter').first()).toBeVisible();
  const pane = page.locator('.dashboard-pane').last();
  await pane.scrollIntoViewIfNeeded();
  // One floating input for the whole Dashboard (2026-10-20 redesign): only the
  // pane last touched shows it, as a card under its transcript, and touching
  // another pane makes it hop there.
  await expect(page.locator('.dashboard-pane-composer-wrap:visible')).toHaveCount(1);
  await expect(page.locator('.dashboard-pane').first().locator('textarea')).toBeVisible();
  await expect(pane.locator('textarea')).toBeHidden();
  await pane.locator('.dashboard-pane-transcript').click();
  await expect(page.locator('.dashboard-dock-ghost')).toHaveCount(1); // mid-hop
  await page.screenshot({ path: info.outputPath('01a-composer-hop.png') });
  await expect(page.locator('.dashboard-dock-ghost')).toHaveCount(0);
  await expect(pane.locator('textarea')).toBeVisible();
  await expect(page.locator('.dashboard-pane-composer-wrap:visible')).toHaveCount(1);
  const dockLayout = await pane.evaluate((paneEl) => {
    const dock = paneEl.querySelector('.dashboard-pane-dock')!.getBoundingClientRect();
    const box = paneEl.getBoundingClientRect();
    const scroller = paneEl.querySelector('.dashboard-pane-messages') as HTMLElement;
    scroller.scrollTop = scroller.scrollHeight;
    const last = [...scroller.querySelectorAll('.msg')].pop()!.getBoundingClientRect();
    // The card has its own row: at any scroll position (iPhone screenshot
    // 2026-10-21, mid-history) no message slides behind it.
    const transcript = paneEl.querySelector('.dashboard-pane-transcript')!.getBoundingClientRect();
    return {
      dockBottom: dock.bottom,
      dockTop: dock.top,
      paneBottom: box.bottom,
      lastBottom: last.bottom,
      transcriptBottom: transcript.bottom,
    };
  });
  expect(Math.abs(dockLayout.paneBottom - 8 - dockLayout.dockBottom)).toBeLessThanOrEqual(1);
  expect(dockLayout.lastBottom).toBeLessThanOrEqual(dockLayout.dockTop);
  expect(dockLayout.transcriptBottom).toBeLessThanOrEqual(dockLayout.dockTop);
  // Jump to present on a pane without the card (iPhone 2026-10-21): the card
  // arrives on click, not pointerdown, so the button is still under the finger
  // when the tap lands, and the tap both scrolls and brings the card.
  const other = page.locator('.dashboard-pane').first();
  const otherScroller = other.locator('.dashboard-pane-messages');
  await otherScroller.evaluate((sc) => {
    sc.style.paddingTop = '1600px'; // enough history to scroll in a phone pane
    sc.scrollTop = 0;
    sc.dispatchEvent(new Event('wheel'));
    sc.dispatchEvent(new Event('scroll'));
  });
  const otherJump = other.locator('.pane-jump-live.visible');
  await expect(otherJump).toBeVisible();
  await otherJump.tap();
  await expect(other.locator('textarea')).toBeVisible();
  await expect
    .poll(() => otherScroller.evaluate((sc) => sc.scrollHeight - sc.scrollTop - sc.clientHeight))
    .toBeLessThan(4);
  await otherScroller.evaluate((sc) => {
    sc.style.paddingTop = '';
  });
  await pane.locator('.dashboard-pane-transcript').click();
  await expect(pane.locator('textarea')).toBeVisible();
  // iPhone / iPad (2026-10-21): a finger scroll through another pane moves
  // nothing; a finger tap on it brings the card and opens the keyboard at once.
  const tapPane = page.locator('.dashboard-pane').first();
  const scrollBox = (await tapPane.locator('.dashboard-pane-messages').boundingBox())!;
  const sx = scrollBox.x + scrollBox.width / 2;
  const sy = scrollBox.y + scrollBox.height * 0.7;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - i * 25 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  await expect(page.locator('.dashboard-dock-ghost')).toHaveCount(0);
  await expect(pane.locator('textarea')).toBeVisible();
  await expect(tapPane.locator('textarea')).toBeHidden();
  await expect(page.locator('textarea:focus')).toHaveCount(0);
  await tapPane.locator('.msg-text').first().tap();
  await expect(tapPane.locator('textarea')).toBeFocused();
  await expect(tapPane.locator('textarea')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pane.locator('.dashboard-pane-transcript').click();
  await expect(pane.locator('textarea')).toBeVisible();
  await page.screenshot({ path: info.outputPath('01-phone-dashboard.png') });
  // A pane drag may start on the session name or an icon button (iPhone
  // recording 2026-10-20: a finger on the name refused to drag). Movement
  // decides: past the threshold it drags and the trailing click is swallowed;
  // a still finger stays a tap.
  const paneOrder = () => page.locator('.dashboard-pane').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.jid));
  const touchDrag = async (fromSelector: string, toJid: string, pointerId: number) => {
    const from = (await page.locator(fromSelector).boundingBox())!;
    const to = (await page.locator(`.dashboard-pane[data-jid="${toJid}"]`).boundingBox())!;
    await page.evaluate(({ fromSelector, sx, sy, tx, ty, pointerId }) => {
      const source = document.querySelector(fromSelector)!;
      const init = { pointerId, pointerType: 'touch', button: 0, bubbles: true, cancelable: true };
      source.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: sx, clientY: sy }));
      for (let i = 1; i <= 8; i++) {
        window.dispatchEvent(new PointerEvent('pointermove', {
          ...init, clientX: sx + (tx - sx) * i / 8, clientY: sy + (ty - sy) * i / 8,
        }));
      }
      window.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: tx, clientY: ty }));
      source.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }, {
      fromSelector, pointerId,
      sx: from.x + Math.min(20, from.width / 2), sy: from.y + from.height / 2,
      tx: to.x + to.width / 2, ty: to.y + to.height / 2,
    });
  };
  const [leftJid, rightJid] = await paneOrder();
  await touchDrag(`.dashboard-pane[data-jid="${leftJid}"] .pane-session-name`, rightJid!, 201);
  await expect.poll(paneOrder).toEqual([rightJid, leftJid]);
  await expect(page.locator('.pane-name-edit:visible')).toHaveCount(0);
  await touchDrag(`.dashboard-pane[data-jid="${leftJid}"] .pane-model-btn`, rightJid!, 202);
  await expect.poll(paneOrder).toEqual([leftJid, rightJid]);
  await expect(page.locator('#model-sheet')).toBeHidden();
  // A still finger on the name is still a tap: it opens rename.
  await page.evaluate((jid) => {
    const name = document.querySelector(`.dashboard-pane[data-jid="${jid}"] .pane-session-name`)!;
    const r = name.getBoundingClientRect();
    const init = { pointerId: 203, pointerType: 'touch', button: 0, bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + 5 };
    name.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: r.x + 14 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: r.x + 14 }));
    name.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, leftJid);
  const renameInput = page.locator(`.dashboard-pane[data-jid="${leftJid}"] .pane-name-edit`);
  await expect(renameInput).toBeVisible();
  await renameInput.press('Escape');
  await expect(renameInput).toBeHidden();
  // Three stacked panes: dragging a splitter past a pane at its minimum height
  // must push the next splitter along instead of stopping (iPhone recording
  // 2026-10-20). Sizes are read mid-drag, before the release bounce animates.
  const expectSplitterPushesThroughMinimum = async () => {
    await expect(page.locator('.dashboard-pane')).toHaveCount(3);
    const presetBefore = await page.locator('.dashboard-preset-btn.active').getAttribute('data-preset');
    await page.locator('.dashboard-preset-btn[data-preset="vertical"]').click();
    await expect(page.locator('.dashboard-splitter')).toHaveCount(2);
    const heights = () => page.locator('.dashboard-pane').evaluateAll(els => els.map(el => (el as HTMLElement).offsetHeight));
    await expect.poll(async () => { const h = await heights(); return Math.max(...h) - Math.min(...h); }).toBeLessThan(3);
    await page.waitForTimeout(600); // let the preset's layout transition finish
    const touchSplitter = (index: number, dy: number, pointerId: number, release: boolean) =>
      page.evaluate(({ index, dy, pointerId, release }) => {
        const splitter = document.querySelectorAll('.dashboard-splitter')[index] as HTMLElement;
        const r = splitter.getBoundingClientRect();
        const init = { pointerId, pointerType: 'touch', button: 0, bubbles: true, cancelable: true, clientX: r.x + r.width / 2 };
        const y = r.y + r.height / 2;
        splitter.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientY: y }));
        for (let i = 1; i <= 10; i++) window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientY: y + dy * i / 10 }));
        if (release) window.dispatchEvent(new PointerEvent('pointerup', { ...init, clientY: y + dy }));
      }, { index, dy, pointerId, release });
    const [h0, h1, h2] = await heights();
    // Lower splitter up: the middle pane bottoms out at 95px, then the top one gives way.
    await touchSplitter(1, -(h1 - 95) - 100, 301, false);
    const pushedUp = await heights();
    expect(pushedUp[1]).toBeLessThanOrEqual(96);
    expect(Math.abs(pushedUp[0] - (h0 - 100))).toBeLessThanOrEqual(2);
    expect(Math.abs(pushedUp[2] - (h2 + (h1 - 95) + 100))).toBeLessThanOrEqual(2);
    await page.screenshot({ path: info.outputPath('01b-splitter-pushes-up.png') });
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 301, pointerType: 'touch', bubbles: true })));
    await page.waitForTimeout(600);
    // Upper splitter down past the squeezed middle pane: it pushes the lower splitter.
    const [a0, a1, a2] = await heights();
    await touchSplitter(0, a2, 302, false);
    const pushedDown = await heights();
    expect(pushedDown[1]).toBeLessThanOrEqual(96);
    expect(pushedDown[2]).toBeLessThanOrEqual(96);
    expect(pushedDown[0]).toBeGreaterThanOrEqual(a0 + a1 + a2 - 2 * 96 - 2);
    await page.screenshot({ path: info.outputPath('01c-splitter-pushes-down.png') });
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 302, pointerType: 'touch', bubbles: true })));
    await page.waitForTimeout(600);
    await page.locator(`.dashboard-preset-btn[data-preset="${presetBefore}"]`).click();
  };
  for (const index of [2, 3]) {
    await page.locator('#btn-dashboard-drawer').click();
    await page.locator('#session-list .session-item').nth(index).locator('.session-tile-btn').click();
    if (index === 2) await expectSplitterPushesThroughMinimum();
  }
  await expect(page.locator('.dashboard-pane')).toHaveCount(4);
  await expect(page.locator('.dashboard-splitter')).toHaveCount(3);
  await expect.poll(async () => {
    const grid = await page.locator('#dashboard-grid').boundingBox();
    return page.locator('.dashboard-pane').evaluateAll((els, bounds) => els.every(el => {
      const r = el.getBoundingClientRect();
      return r.y >= bounds.y - 2 && r.bottom <= bounds.y + bounds.height + 2;
    }), grid!);
  }).toBe(true);
  expect((await page.locator('.pane-session-name').first().boundingBox())!.width).toBeGreaterThan(20);
  await page.screenshot({ path: info.outputPath('02-phone-four-grid.png') });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('#btn-dashboard-drawer').click();
  await expect(page.locator('.drawer')).toHaveClass(/open/);
  await page.locator('#btn-hide-drawer').click();
  await expect(page.locator('.drawer')).not.toHaveClass(/open/);
  const mainBox = await page.locator('.main').boundingBox();
  expect(mainBox!.width).toBeGreaterThanOrEqual(842);
  await expect.poll(async () => {
    const r = await page.locator('.drawer').boundingBox();
    return r!.x + r!.width <= 1;
  }).toBe(true);
  const toolbarBox = await page.locator('.dashboard-toolbar').boundingBox();
  const titleBox = await page.locator('.dashboard-toolbar-title').boundingBox();
  const presetsBox = await page.locator('.dashboard-layout-presets').boundingBox();
  expect(toolbarBox!.height).toBeLessThanOrEqual(60);
  expect(Math.abs(titleBox!.y + titleBox!.height / 2 - presetsBox!.y - presetsBox!.height / 2)).toBeLessThan(2);
  expect(presetsBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width - 1);
  await page.screenshot({ path: info.outputPath('02-landscape.png') });
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.dashboard-pane')).toHaveCount(4);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('piweb.dashboard')!));
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('piweb.dashboard')!))).toEqual(saved);
  await page.setViewportSize({ width: 390, height: 844 });
  while (await page.locator('.dashboard-pane').count() > 1) {
    await page.locator('.dashboard-pane').last().locator('.pane-close-btn').click();
  }
  await expect(page.locator('.dashboard-pane')).toHaveCount(1);
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await expect.poll(async () => {
    const remaining = await page.locator('.dashboard-pane').boundingBox();
    const grid = await page.locator('#dashboard-grid').boundingBox();
    return remaining!.height >= grid!.height - 2;
  }).toBe(true);
  await page.screenshot({ path: info.outputPath('02-phone-after-close.png') });
  for (const width of [320, 708]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('#dashboard-view')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});
