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
  // nothing; a finger tap on it brings the card, and a second tap opens the
  // keyboard (2026-10-22).
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
  // The first tap only brings the card; the second tap opens the keyboard.
  await tapPane.locator('.msg-text').first().tap();
  await expect(tapPane.locator('textarea')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator('textarea:focus')).toHaveCount(0);
  await tapPane.locator('.msg-text').first().tap();
  await expect(tapPane.locator('textarea')).toBeFocused();
  await expect(tapPane.locator('textarea')).toBeVisible();
  // A third tap on the same pane closes the keyboard; the card stays.
  await tapPane.locator('.msg-text').first().tap();
  await expect(page.locator('textarea:focus')).toHaveCount(0);
  await expect(tapPane.locator('textarea')).toBeVisible();
  await tapPane.locator('.msg-text').first().tap();
  await expect(tapPane.locator('textarea')).toBeFocused();
  // With the keyboard already up, a tap on another pane moves it along.
  await pane.locator('.msg-text').first().tap();
  await expect(pane.locator('textarea')).toBeFocused();
  await tapPane.locator('.msg-text').first().tap();
  await expect(tapPane.locator('textarea')).toBeFocused();
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
    await page.waitForTimeout(600); // boxes measured mid-swap spring would aim at stale spots
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
  // ⋯ is the header button a phone-width pane always shows (the rest fold into it).
  await touchDrag(`.dashboard-pane[data-jid="${leftJid}"] .pane-more-btn`, rightJid!, 202);
  await expect.poll(paneOrder).toEqual([leftJid, rightJid]);
  await expect(page.locator('.pane-more-menu:visible')).toHaveCount(0);
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
  // Two stacked panes with an image attached (recording 2026-10-21): the card
  // used to fill the pane and leave a sliver of transcript with Jump to present
  // painted over the header. A short pane drops the shortcut chips and the
  // compression hint instead.
  const expectShortPaneKeepsTranscript = async () => {
    await expect(page.locator('.dashboard-pane')).toHaveCount(2);
    const presetBefore = await page.locator('.dashboard-preset-btn.active').getAttribute('data-preset');
    await page.locator('.dashboard-preset-btn[data-preset="vertical"]').click();
    await page.waitForTimeout(600);
    const active = page.locator('.dashboard-pane.composer-active');
    // Nothing attached: a short pane keeps its shortcut chips.
    await expect(active.locator('.pane-hot-keywords')).toBeVisible();
    await active.locator('input[type="file"]').setInputFiles({
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
    });
    await expect(active.locator('.chip-image')).toHaveCount(1);
    await expect(active.locator('.pane-compression-options')).toBeVisible();
    await expect(active.locator('.pane-compression-hint')).toBeHidden();
    await expect(active.locator('.pane-hot-keywords')).toBeHidden();
    const transcript = await active.locator('.dashboard-pane-transcript').boundingBox();
    expect(transcript!.height).toBeGreaterThanOrEqual(90);
    await page.screenshot({ path: info.outputPath('01d-short-pane-attachment.png') });
    await active.locator('.chip-remove').click();
    await expect(active.locator('.chip-image')).toHaveCount(0);
    await page.locator(`.dashboard-preset-btn[data-preset="${presetBefore}"]`).click();
    await page.waitForTimeout(600);
    await expect(active.locator('.pane-hot-keywords')).toBeVisible();
  };
  // The finger decides, by thirds of the target pane: a third of the way in
  // is enough for above/below, no 20% edge band, wherever the header was
  // grabbed. The middle row is left / swap / right.
  const expectDropJudgedByFinger = async () => {
    const presetBefore = await page.locator('.dashboard-preset-btn.active').getAttribute('data-preset');
    await page.locator('.dashboard-preset-btn[data-preset="vertical"]').click();
    await page.waitForTimeout(600);
    const order = () => page.locator('.dashboard-pane').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.jid));
    const before = await order();
    const dragTopPane = async (stops: Array<[number, string | null]>, grabX: number) => {
      const b = (await page.locator('.dashboard-pane').nth(1).boundingBox())!;
      const h = (await page.locator('.dashboard-pane').nth(0).locator('.dashboard-pane-header').boundingBox())!;
      const x = h.x + h.width * grabX;
      const y0 = h.y + h.height / 2;
      await page.locator('.dashboard-pane').nth(0).locator('.dashboard-pane-header').dispatchEvent('pointerdown', {
        pointerId: 55, pointerType: 'touch', button: 0, clientX: x, clientY: y0, isPrimary: true,
      });
      let y = y0;
      const move = async (to: number) => {
        for (let i = 1; i <= 6; i++) {
          const cy = y + ((to - y) * i) / 6;
          await page.evaluate(({ x, cy }) => window.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 55, pointerType: 'touch', clientX: x, clientY: cy, cancelable: true, bubbles: true,
          })), { x, cy });
        }
        y = to;
      };
      for (const [rel, text] of stops) {
        await move(rel < 0 ? y0 + 20 : b.y + b.height * rel);
        if (text) {
          await expect(page.locator('#dashboard-drop-label')).toContainText(text);
          await expect(page.locator('#dashboard-drop-preview')).toBeVisible();
        } else {
          await expect(page.locator('#dashboard-drop-preview')).toBeHidden(); // still over itself
        }
      }
      expect(y).toBeLessThan(b.y + b.height * 0.8); // the old bottom band was below 80%
      await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 55, pointerType: 'touch', clientX: x, clientY: y, bubbles: true,
      })), { x, y });
      await page.waitForTimeout(700);
    };
    // Grabbed by the name at the left of the header and dragged straight down.
    await dragTopPane([[-1, null], [0.3, '上方'], [0.5, '左側'], [0.7, '下方']], 0.15);
    await page.screenshot({ path: info.outputPath('01e-drag-by-finger.png') });
    expect(await order()).toEqual([before[1], before[0]]);
    await dragTopPane([[0.45, '交換']], 0.5);
    expect(await order()).toEqual(before);
    await page.locator(`.dashboard-preset-btn[data-preset="${presetBefore}"]`).click();
    await page.waitForTimeout(600);
  };
  await expectDropJudgedByFinger();
  // Long-press quoting works in a pane as in the chat: on touch every
  // transcript is user-select:none, so panes need the custom selection too.
  const expectPaneQuote = async () => {
    const panes = page.locator('.dashboard-pane');
    const longPress = async (i: number) => {
      const pt = await panes.nth(i).evaluate((p) => {
        const sc = p.querySelector('.dashboard-pane-messages')!.getBoundingClientRect();
        for (const el of p.querySelectorAll('.dashboard-pane-messages .msg-text')) {
          const r = el.getBoundingClientRect();
          if (r.top >= sc.top + 4 && r.top + 16 <= sc.bottom) return { x: r.left + 12, y: r.top + 10 };
        }
        return null;
      });
      expect(pt).not.toBeNull();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt!.x, y: pt!.y, id: 9 }] });
      await page.waitForTimeout(500);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const quoteOf = (i: number) => panes.nth(i).locator('.pane-quote-preview .quote-preview-text');
    const selected = () => page.evaluate(() =>
      [...((CSS as any).highlights.get('piweb-selection') ?? [])].map((r: Range) => r.toString()).join(''));
    const jid1 = await panes.nth(1).getAttribute('data-jid');
    await expect(panes.nth(1)).not.toHaveClass(/composer-active/);
    await longPress(1);
    await expect(page.locator('#selection-actions')).toBeVisible();
    // Selecting quotes at once, as in the chat: the card comes to this pane
    // with the quote, without focusing it (no keyboard).
    const picked = await selected();
    expect(picked.length).toBeGreaterThan(0);
    await expect(quoteOf(1)).toContainText(picked.slice(0, 4));
    await expect(panes.nth(1)).toHaveClass(/composer-active/);
    await expect(page.locator(`.dashboard-pane[data-jid="${jid1}"] textarea`)).not.toBeFocused();
    // The selection is still where the pill is: right above or below it, and
    // above the card that now holds the quote.
    await page.waitForTimeout(100);
    const geo = await page.evaluate(() => {
      const r = [...((CSS as any).highlights.get('piweb-selection') ?? [])][0].getBoundingClientRect();
      const pill = document.getElementById('selection-actions')!.getBoundingClientRect();
      const card = document.querySelector('.dashboard-pane.composer-active .dashboard-pane-dock')!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, pillTop: pill.top, pillBottom: pill.bottom, cardTop: card.top };
    });
    expect(geo.bottom).toBeLessThanOrEqual(geo.cardTop);
    expect(Math.min(Math.abs(geo.pillTop - geo.bottom), Math.abs(geo.top - geo.pillBottom))).toBeLessThan(20);
    await page.screenshot({ path: info.outputPath('01e-pane-selection-quoted.png') });
    // 引用 then only puts the cursor in that card.
    await page.locator('#selection-quote').tap();
    await expect(page.locator('#selection-actions')).toBeHidden();
    await expect(page.locator(`.dashboard-pane[data-jid="${jid1}"] textarea`)).toBeFocused();
    await expect(quoteOf(1)).toContainText(picked.slice(0, 4));
    await page.screenshot({ path: info.outputPath('01f-pane-quote.png') });
    await page.locator(`.dashboard-pane[data-jid="${jid1}"] .pane-quote-remove`).tap();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // A tap ends it (the backdrop), then a long press selects in another pane,
    // whose handle drags, though every pane shares the one set of handles.
    await longPress(1);
    await expect(page.locator('#selection-actions')).toBeVisible();
    await page.locator('#sel-backdrop').tap();
    await expect(page.locator('#selection-actions')).toBeHidden();
    await longPress(0);
    await expect(page.locator('#selection-actions')).toBeVisible();
    const before = await selected();
    expect(before.length).toBeGreaterThan(0);
    const end = (await page.locator('#sel-handle-end').boundingBox())!;
    const ex = end.x + end.width / 2;
    const ey = end.y + end.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ex, y: ey, id: 10 }] });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ex + i * 10, y: ey + i * 8, id: 10 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await selected()).length).toBeGreaterThan(before.length);
    await page.waitForTimeout(600); // the first bubble has shrunk away
    await expect(page.locator('#sel-highlight-boxes .sel-bubble-layer')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('01g-pane-selection.png') });
    await page.locator('#sel-backdrop').tap();
    await expect(page.locator('#selection-actions')).toBeHidden();
    // Ending the selection keeps its quote, as in the chat.
    await expect(quoteOf(0)).toContainText((await selected()).slice(0, 2) || before.slice(0, 2));
    await page.waitForTimeout(800); // a control tapped right after ending a selection is swallowed (700ms)
  };
  await expectPaneQuote();
  await expectShortPaneKeepsTranscript();
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
