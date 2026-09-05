import { createServer, type Server, type ServerResponse } from 'node:http';
import { expect, test, type Locator, type Page, type Route } from 'playwright/test';

const AGY_MODEL_REF = 'agy/gemini-3.1-pro-high';
const DEFAULT_MODEL_REF = 'openai-codex/gpt-5.6-sol';

const SESSION = {
  jid: 'web:agy-session',
  name: 'Agy Assistant Session',
  kind: 'standard',
  deleted: false,
  busy: false,
  lastActivity: '2026-09-05 23:00:00',
  lastReplyId: 0,
  model: DEFAULT_MODEL_REF,
  thinking: '',
  badge: { label: 'SOL', kind: 'sol' },
};

const MODELS = [
  {
    ref: AGY_MODEL_REF,
    name: 'Gemini 3.1 Pro (High)',
    provider: 'agy',
    reasoning: true,
  },
  {
    ref: 'agy/gemini-3.1-flash-high',
    name: 'Gemini 3.1 Flash (High)',
    provider: 'agy',
    reasoning: true,
  },
  {
    ref: DEFAULT_MODEL_REF,
    name: 'GPT-5.6 Sol',
    provider: 'openai-codex',
    reasoning: false,
  },
];

async function expectPointerReachable(locator: Locator) {
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      reachable: target === element || Boolean(target && element.contains(target)),
      blocker:
        target instanceof HTMLElement
          ? target.getAttribute('aria-label') || target.id || target.tagName
          : null,
    };
  });
  expect(hit, `pointer blocker: ${hit.blocker}`).toMatchObject({ reachable: true });
}

test.describe('agy end-to-end model interaction and streaming lifecycle', () => {
  let sseServer: Server;
  let ssePort: number;
  const sseClients: ServerResponse[] = [];

  test.beforeAll(async () => {
    sseServer = createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 60000\n\n');
      sseClients.push(res);
      req.on('close', () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
      });
    });

    await new Promise<void>((resolve) => {
      sseServer.listen(0, '127.0.0.1', () => resolve());
    });
    ssePort = (sseServer.address() as any).port;
  });

  test.afterAll(async () => {
    for (const client of sseClients) {
      client.end();
    }
    await new Promise<void>((resolve) => sseServer.close(() => resolve()));
  });

  function broadcastSSE(event: string, data: unknown) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      client.write(chunk);
    }
  }

  test('selects agy model, syncs usage command, streams thinking/tool/reply, and handles termination', async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const commandsReceived: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const messagesReceived: Array<{ text: string }> = [];

    let currentSession = { ...SESSION };
    const recordedEvents: Array<Record<string, unknown>> = [];

    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => failedRequests.push(request.url()));

    await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));

    await page.route('**/api/**', async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;

      if (path === '/api/me') return route.fulfill({ json: { authed: true } });
      if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
      if (path === '/api/models') return route.fulfill({ json: { models: MODELS } });
      if (path === '/api/push/key') return route.fulfill({ json: { key: '' } });
      if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });

      if (path === '/api/sessions' && request.method() === 'GET') {
        return route.fulfill({ json: { sessions: [currentSession] } });
      }

      if (path.endsWith('/stream')) {
        return route.continue({
          url: `http://127.0.0.1:${ssePort}/stream?${url.searchParams.toString()}`,
        });
      }

      if (path.endsWith('/events')) {
        return route.fulfill({
          json: {
            events: recordedEvents,
            busy: currentSession.busy,
            hasMore: false,
            partial: null,
            session: currentSession,
          },
        });
      }

      if (path.endsWith('/commands') && request.method() === 'POST') {
        const body = request.postDataJSON() as { command: string; args?: Record<string, unknown> };
        commandsReceived.push(body);

        if (body.command === 'pi model' && body.args?.model) {
          const newModel = String(body.args.model);
          currentSession = {
            ...currentSession,
            model: newModel,
            badge: newModel.startsWith('agy/')
              ? { label: 'AGY', kind: 'other' }
              : { label: 'SOL', kind: 'sol' },
          };
        }
        return route.fulfill({ json: { ok: true } });
      }

      if (path.endsWith('/messages') && request.method() === 'POST') {
        const body = request.postDataJSON() as { text: string };
        messagesReceived.push(body);
        return route.fulfill({ json: { ok: true, sessionTitle: currentSession.name } });
      }

      if (path.endsWith('/seen')) {
        return route.fulfill({ json: { ok: true } });
      }

      return route.fulfill({ status: 404, json: { error: `Unhandled fixture route: ${path}` } });
    });

    // ── Milestone 1: Open session and inspect initial model controls ──────────
    await page.goto('/');
    await expect(page.locator('#session-name')).toHaveText(SESSION.name);
    await expect(page.locator('#header-badge')).toHaveText('SOL');

    const initialUsageBtn = page.locator('#btn-gpt-usage');
    await expect(initialUsageBtn).toHaveAttribute('aria-label', 'Show GPT usage');
    await expect(initialUsageBtn).toHaveAttribute('title', '/gpt-usage');

    const modelBtn = page.locator('#btn-model');
    await expectPointerReachable(modelBtn);
    const modelBtnBox = await modelBtn.boundingBox();
    expect(modelBtnBox?.width).toBeGreaterThanOrEqual(34);
    expect(modelBtnBox?.height).toBeGreaterThanOrEqual(34);

    await page.screenshot({ path: testInfo.outputPath('01-initial-session.png') });
    await page.waitForTimeout(600); // Visual evidence pacing

    // ── Milestone 2: Open model picker, search and select agy model ────────────
    await modelBtn.click();
    const modelSheet = page.locator('#model-sheet');
    await expect(modelSheet).toBeVisible();

    const sheetContained = await modelSheet.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      return rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height;
    });
    expect(sheetContained).toBe(true);

    const modelSearch = page.locator('#model-search');
    await modelSearch.fill('gemini-3.1');
    await page.waitForTimeout(200); // Debounce delay

    const agyItem = page.locator('.model-item', { hasText: 'agy/gemini-3.1-pro-high' });
    await expect(agyItem).toBeVisible();
    await expect(agyItem.locator('.provider-badge')).toHaveText('AGY');
    await expect(agyItem.locator('.m-tag')).toHaveText('reasoning');

    const agyItemBox = await agyItem.boundingBox();
    expect(agyItemBox?.width).toBeGreaterThanOrEqual(38);
    expect(agyItemBox?.height).toBeGreaterThanOrEqual(38);
    await expectPointerReachable(agyItem);

    await page.screenshot({ path: testInfo.outputPath('02-model-sheet-search.png') });
    await page.waitForTimeout(600);

    // Select the agy model
    await agyItem.click();
    await expect(modelSheet).toBeHidden();

    // Verify command was received and session switched to agy
    await expect
      .poll(() => commandsReceived.some((c) => c.command === 'pi model' && c.args?.model === AGY_MODEL_REF))
      .toBe(true);

    // Header badge updates to AGY
    await expect(page.locator('#header-badge')).toHaveText('AGY');

    // Usage button syncs to /agy-usage
    const agyUsageBtn = page.locator('#btn-gpt-usage');
    await expect(agyUsageBtn).toHaveAttribute('aria-label', 'Show agy usage');
    await expect(agyUsageBtn).toHaveAttribute('title', '/agy-usage');

    await page.screenshot({ path: testInfo.outputPath('03-agy-model-active.png') });
    await page.waitForTimeout(600);

    // ── Milestone 3: Test agy usage button interaction ────────────────────────
    await expectPointerReachable(agyUsageBtn);
    const usageBtnBox = await agyUsageBtn.boundingBox();
    expect(usageBtnBox?.width).toBeGreaterThanOrEqual(34);
    expect(usageBtnBox?.height).toBeGreaterThanOrEqual(34);

    await agyUsageBtn.click();
    await expect
      .poll(() => commandsReceived.some((c) => c.command === 'agy-usage'))
      .toBe(true);

    // ── Milestone 4: Type and send user prompt ─────────────────────────────────
    const composerInput = page.getByRole('textbox', { name: 'Message' });
    await composerInput.fill('幫我檢查 piweb 專案狀態並列出目錄檔案');

    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expectPointerReachable(sendBtn);
    const sendBtnBox = await sendBtn.boundingBox();
    expect(sendBtnBox?.width).toBeGreaterThanOrEqual(38);
    expect(sendBtnBox?.height).toBeGreaterThanOrEqual(38);

    await page.screenshot({ path: testInfo.outputPath('04-user-prompt-typed.png') });
    await page.waitForTimeout(600);

    await sendBtn.click();
    await expect
      .poll(() => messagesReceived.some((m) => m.text.includes('檢查 piweb 專案狀態')))
      .toBe(true);

    // Stream the user message event
    const userEvent = {
      id: 1,
      kind: 'message',
      role: 'user',
      content: '幫我檢查 piweb 專案狀態並列出目錄檔案',
      files: [],
      createdAt: '2026-09-05 23:01:00',
    };
    recordedEvents.push(userEvent);
    broadcastSSE('event', userEvent);
    broadcastSSE('busy', { busy: true });

    await expect(page.locator('.msg.msg-user')).toContainText('幫我檢查 piweb 專案狀態');
    await page.screenshot({ path: testInfo.outputPath('05-user-message-rendered.png') });
    await page.waitForTimeout(600);

    // ── Milestone 5: Stream agy thinking block ────────────────────────────────
    const thinkingEvent = {
      id: 2,
      kind: 'thinking',
      content: '正在分析使用者需求，需要透過 run_command 執行 git status 與目錄檢視。',
      createdAt: '2026-09-05 23:01:02',
    };
    recordedEvents.push(thinkingEvent);
    broadcastSSE('event', thinkingEvent);

    const thinkingRow = page.locator('details.event.thinking');
    await expect(thinkingRow).toBeVisible();
    await expect(thinkingRow.locator('.label')).toContainText('Thinking');
    await expect(thinkingRow.locator('.peek')).toContainText('正在分析使用者需求');

    await page.screenshot({ path: testInfo.outputPath('06-agy-thinking-streamed.png') });
    await page.waitForTimeout(600);

    // ── Milestone 6: Stream agy tool call ────────────────────────────────────
    const toolCallEvent = {
      id: 3,
      kind: 'tool',
      role: 'run_command',
      content: 'git status --short',
      createdAt: '2026-09-05 23:01:03',
    };
    recordedEvents.push(toolCallEvent);
    broadcastSSE('event', toolCallEvent);

    const toolRow = page.locator('details.event.tool');
    await expect(toolRow).toBeVisible();
    await expect(toolRow.locator('.label')).toContainText('run_command');

    await page.screenshot({ path: testInfo.outputPath('07-agy-tool-calling.png') });
    await page.waitForTimeout(600);

    // ── Milestone 7: Stream agy tool result ───────────────────────────────────
    const toolResultEvent = {
      id: 4,
      kind: 'tool_result',
      content: 'M src/agent/agy.ts\n?? test/e2e/agy-interaction.spec.ts',
      createdAt: '2026-09-05 23:01:04',
    };
    recordedEvents.push(toolResultEvent);
    broadcastSSE('event', toolResultEvent);

    const toolResultRow = page.locator('details.event.tool_result');
    await expect(toolResultRow).toBeVisible();
    await expect(toolResultRow.locator('.label')).toContainText('Result');

    await page.screenshot({ path: testInfo.outputPath('08-agy-tool-result-received.png') });
    await page.waitForTimeout(600);

    // ── Milestone 8: Stream final assistant response ──────────────────────────
    const assistantReplyEvent = {
      id: 5,
      kind: 'message',
      role: 'assistant',
      content: '已為您完成檢查：目前 Git 工作目錄正常，agy 執行緒與 E2E 測試規格檔案已建立就緒。',
      files: [],
      createdAt: '2026-09-05 23:01:06',
    };
    recordedEvents.push(assistantReplyEvent);
    broadcastSSE('event', assistantReplyEvent);
    broadcastSSE('busy', { busy: false });

    const assistantMsg = page.locator('#messages > .msg:not(.msg-user)');
    await expect(assistantMsg).toBeVisible();
    await expect(assistantMsg).toContainText('已為您完成檢查');

    await page.screenshot({ path: testInfo.outputPath('09-agy-final-reply-streamed.png') });
    await page.waitForTimeout(600);

    // ── Milestone 9: Expand details and verify pointer reachability ───────────
    const thinkingSummary = thinkingRow.locator('summary');
    await expectPointerReachable(thinkingSummary);
    await thinkingSummary.click();
    await expect(thinkingRow).toHaveAttribute('open', '');
    await expect(thinkingRow.locator('.event-body')).toContainText('正在分析使用者需求');

    const toolSummary = toolRow.locator('summary');
    await expectPointerReachable(toolSummary);
    await toolSummary.click();
    await expect(toolRow).toHaveAttribute('open', '');
    await expect(toolRow.locator('.event-body')).toContainText('git status --short');

    const resultSummary = toolResultRow.locator('summary');
    await expectPointerReachable(resultSummary);
    await resultSummary.click();
    await expect(toolResultRow).toHaveAttribute('open', '');
    await expect(toolResultRow.locator('.event-body')).toContainText('test/e2e/agy-interaction.spec.ts');

    await page.screenshot({ path: testInfo.outputPath('10-all-details-expanded.png') });
    await page.waitForTimeout(600);

    // ── Milestone 10: Verify premature termination (SIGTERM) clean error handling ──
    const terminationEvent = {
      id: 6,
      kind: 'error',
      role: 'error',
      content: 'exited with code 143 (SIGTERM)',
      createdAt: '2026-09-05 23:01:08',
    };
    recordedEvents.push(terminationEvent);
    broadcastSSE('event', terminationEvent);

    const errorRow = page.locator('details.event.error');
    await expect(errorRow).toBeVisible();
    await expect(errorRow.locator('.event-body')).toContainText('exited with code 143 (SIGTERM)');

    // Ensure the misleading timeout warning is NEVER shown
    const allTranscriptText = await page.locator('#messages').innerText();
    expect(allTranscriptText).not.toContain('超過 print-timeout 被中止');
    expect(allTranscriptText).not.toContain('目前上限 60m');

    await page.screenshot({ path: testInfo.outputPath('11-clean-termination-handled.png') });
    await page.waitForTimeout(600);

    // ── Quantitative geometry and health checks ───────────────────────────────
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});
