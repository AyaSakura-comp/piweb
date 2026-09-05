import { createServer, type Server, type ServerResponse } from 'node:http';
import { expect, test, type Locator, type Route } from 'playwright/test';
import { COMMANDS } from '../../src/commands/catalog.js';

const SESSION = {
  jid: 'web:kv-test-session',
  name: 'KV Cache Test Session',
  kind: 'standard',
  deleted: false,
  busy: false,
  lastActivity: '2026-09-06 02:40:00',
  lastReplyId: 0,
  model: 'llama/qwen-2.5-coder-32b',
  thinking: '',
  badge: { label: 'LOCAL', kind: 'local' },
};

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

test.describe('piweb kv-cache extension command workflow and visual verification', () => {
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

  test('executes /kv status and /kv save with autocomplete and rich markdown table streaming', async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const commandsReceived: Array<{ command: string; args?: Record<string, unknown> }> = [];

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
      if (path === '/api/commands') return route.fulfill({ json: { commands: COMMANDS } });
      if (path === '/api/models') {
        return route.fulfill({
          json: {
            models: [
              {
                ref: 'llama/qwen-2.5-coder-32b',
                name: 'Qwen 2.5 Coder 32B (Local)',
                provider: 'llama',
                reasoning: false,
              },
            ],
          },
        });
      }
      if (path === '/api/push/key') return route.fulfill({ json: { key: '' } });
      if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });

      if (path === '/api/sessions' && request.method() === 'GET') {
        return route.fulfill({ json: { sessions: [SESSION] } });
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
            busy: false,
            hasMore: false,
            partial: null,
            session: SESSION,
          },
        });
      }

      if (path.endsWith('/commands') && request.method() === 'POST') {
        const body = request.postDataJSON() as { command: string; args?: Record<string, unknown> };
        commandsReceived.push(body);
        return route.fulfill({ json: { ok: true } });
      }

      if (path.endsWith('/seen')) {
        return route.fulfill({ json: { ok: true } });
      }

      return route.fulfill({ status: 404, json: { error: `Unhandled fixture route: ${path}` } });
    });

    // ── Milestone 1: Open PiWeb session ──────────────────────────────────────
    await page.goto('/');
    await expect(page.locator('#session-name')).toHaveText(SESSION.name);
    await expect(page.locator('#header-badge')).toHaveText('LOCAL');

    const composerInput = page.getByRole('textbox', { name: 'Message' });
    await expect(composerInput).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('01-initial-session.png') });
    await page.waitForTimeout(700); // Visual pacing for video

    // ── Milestone 2: Trigger slash autocomplete for /kv ──────────────────────
    await composerInput.fill('/kv');
    await composerInput.press('End');

    const autocomplete = page.locator('#autocomplete');
    await expect(autocomplete).toBeVisible();

    // Verify autocomplete viewport containment
    const acContained = await autocomplete.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      return rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height;
    });
    expect(acContained).toBe(true);

    // Verify KV subcommands exist in the autocomplete list
    const kvStatusOption = page.locator('.ac-item', { hasText: '/kv status' });
    await expect(kvStatusOption).toBeVisible();
    await expect(kvStatusOption.locator('.ac-desc')).toContainText('Show KV cache status');

    await expect(page.locator('.ac-item', { hasText: '/kv save' })).toBeVisible();
    await expect(page.locator('.ac-item', { hasText: '/kv restore' })).toBeVisible();
    await expect(page.locator('.ac-item', { hasText: '/kv prune' })).toBeVisible();
    await expect(page.locator('.ac-item', { hasText: '/kv help' })).toBeVisible();

    await expectPointerReachable(kvStatusOption);
    await page.screenshot({ path: testInfo.outputPath('02-autocomplete-kv.png') });
    await page.waitForTimeout(800);

    // ── Milestone 3: Select and execute /kv status ────────────────────────────
    await kvStatusOption.click();
    await expect(autocomplete).toBeHidden();
    await expect(composerInput).toHaveValue('/kv status');

    const sendBtn = page.getByRole('button', { name: 'Send' });
    await expectPointerReachable(sendBtn);
    await page.screenshot({ path: testInfo.outputPath('03-kv-status-selected.png') });
    await page.waitForTimeout(600);

    await sendBtn.click();
    await expect
      .poll(() => commandsReceived.some((c) => c.command === 'kv status'))
      .toBe(true);

    // Broadcast the status result as an SSE system event
    const statusContent = [
      '### ⚡ Pi KV Cache Manager Status',
      '',
      '- **Llama Server**: `http://127.0.0.1:8001` (Slot: `0`)',
      '- **Cache Storage Root**: `/home/chihmin/.cache/llama-slots`',
      '- **Disk Usage**: **2.35 GB** / 30 GB (5 total snapshots)',
      '- **Session Snapshots**: 4 / 5 max',
      '- **LRU Evictions Performed**: 0',
      '- **Active Session Tokens**: 18,140 (Saved: 18,140, Delta: 0)',
      '- **Incremental Auto-save**: Enabled (every 3,000 tok, min 3,000)',
      '- **Golden Base Cache**: ✅ 28,498 tokens (620.07 MB)',
      '',
      '#### Stored Sessions:',
      '| Session ID / Name | Tokens | Disk Size | Last Accessed |',
      '| :--- | :---: | :---: | :---: |',
      '| `01a071c3...` | 35,487 | 756.73 MB | 9/6/2026, 2:19:18 AM |',
      '| `01a072c6...` | 17,546 | 405.91 MB | 9/6/2026, 2:14:20 AM |',
      '| `01a072d2...` | 16,587 | 387.16 MB | 9/6/2026, 2:26:31 AM |',
    ].join('\n');

    const statusEvent = {
      id: 1,
      kind: 'system',
      role: 'kv status',
      content: statusContent,
      files: [],
      createdAt: '2026-09-06 02:41:00',
    };
    recordedEvents.push(statusEvent);
    broadcastSSE('event', statusEvent);

    const systemRow = page.locator('details.event.system');
    await expect(systemRow).toBeVisible();
    await expect(systemRow).toHaveAttribute('open', '');
    await expect(systemRow.locator('.label')).toContainText('kv status');
    await expect(systemRow.locator('.event-body')).toContainText('Pi KV Cache Manager Status');
    await expect(systemRow.locator('.event-body table')).toBeVisible();
    await expect(systemRow.locator('.event-body')).toContainText('Golden Base Cache');

    await page.screenshot({ path: testInfo.outputPath('04-kv-status-table-rendered.png') });
    await page.waitForTimeout(1000);

    // ── Milestone 4: Type and execute /kv save checkpoint-e2e ─────────────────
    await composerInput.fill('/kv save checkpoint-e2e');
    await page.screenshot({ path: testInfo.outputPath('05-kv-save-typed.png') });
    await page.waitForTimeout(600);

    await sendBtn.click();
    await expect
      .poll(() =>
        commandsReceived.some(
          (c) => c.command === 'kv save' && c.args?.name === 'checkpoint-e2e',
        ),
      )
      .toBe(true);

    const saveSuccessEvent = {
      id: 2,
      kind: 'system',
      role: 'kv save',
      content: '✅ Successfully saved 18,140 tokens (425.12 MB) in 12.4ms (`snap_checkpoint-e2e.bin`)',
      files: [],
      createdAt: '2026-09-06 02:41:05',
    };
    recordedEvents.push(saveSuccessEvent);
    broadcastSSE('event', saveSuccessEvent);

    const saveRow = page.locator('details.event.system').nth(1);
    await expect(saveRow).toBeVisible();
    await expect(saveRow.locator('.label')).toContainText('kv save');
    await expect(saveRow.locator('.event-body')).toContainText('Successfully saved 18,140 tokens');

    await page.screenshot({ path: testInfo.outputPath('06-kv-save-rendered.png') });
    await page.waitForTimeout(1000);

    // ── Quality Gates: Zero console/page errors ──────────────────────────────
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});
