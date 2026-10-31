import { expect, test } from 'playwright/test';

const SEQUENCE_DIAGRAM_MARKDOWN = `這是一張呈現 **Main Agent (主對話)**、**Subagent / Tool** 與 **KV Manager / Model Registry** 之間呼叫關係的 Sequence Diagram：

\`\`\`mermaid
sequenceDiagram
  autonumber
  participant Main as Main Agent (主對話)
  participant Tool as Tool (modelRegistry.complete)
  participant KV as KV Manager (Context Cache)
  participant API as Pi Agent API

  Main->>Tool: 工具內呼叫 modelRegistry.complete(prompt)
  Tool->>KV: 查詢 prefix KV cache 是否命中
  KV-->>Tool: 回傳 cached KV state
  Tool->>API: 發送增量 token 請求
  API-->>Tool: 串流回傳 completion
  Tool-->>Main: 回傳工具執行結果
\`\`\`

下方段落應該在手機畫面上依然清晰可見，不會被 Mermaid 圖表整個蓋住。`;

test.describe('mobile Mermaid diagram fit, collapse/expand toggle, and zoom modal', () => {
  test('fits the complete diagram inside the mobile viewport without covering the phone layout and supports collapsing/expanding', async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    const session = {
      jid: 'web:mermaid1',
      name: 'Browser',
      folder: 'web_mermaid1',
      kind: 'standard',
      deleted: false,
      model: 'agy/gemini-3-pro',
      provider: 'agy',
      runningModel: 'gemini-3-pro',
      badge: { label: 'AGY', kind: 'gem' },
      busy: false,
      lastReplyId: 2,
      lastActivity: '2026-10-18 12:17:00',
    };

    const events = [
      {
        id: 1,
        kind: 'message',
        role: 'user',
        content: '我現在有kv manager , 然後如果我直接打 pi agent api , 那...',
        files: [],
        createdAt: '2026-10-18T04:16:00Z',
      },
      {
        id: 2,
        kind: 'message',
        role: 'assistant',
        content: SEQUENCE_DIAGRAM_MARKDOWN,
        files: [],
        createdAt: '2026-10-18T04:17:00Z',
      },
    ];

    await page.addInitScript(() => localStorage.setItem('piweb.mode', 'sessions'));
    await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
      route.fulfill({
        json: {
          items: [
            { word: 'deploy', count: 10 },
            { word: 'commit', count: 9 },
            { word: 'push', count: 8 },
            { word: '模型', count: 5 },
          ],
        },
      }),
    );
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const path = decodeURIComponent(url.pathname);
      if (path === '/api/me') return route.fulfill({ json: { authed: true } });
      if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
      if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
      if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
      if (path === '/api/models')
        return route.fulfill({
          json: {
            models: [
              {
                ref: 'agy/gemini-3-pro',
                id: 'gemini-3-pro',
                name: 'Gemini 3 Pro',
                provider: 'agy',
                reasoning: true,
              },
            ],
          },
        });
      if (path === '/api/sessions/web:mermaid1/events')
        return route.fulfill({
          json: {
            events,
            busy: false,
            hasMore: false,
            partial: null,
            session,
          },
        });
      if (path === '/api/sessions/web:mermaid1/btw')
        return route.fulfill({ json: { available: false } });
      if (path.endsWith('/stream'))
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream; charset=utf-8',
          body: 'event: busy\ndata: {"busy":false}\n\n',
        });
      return route.fulfill({ status: 200, json: { ok: true } });
    });

    await page.goto('/');
    const wrap = page.locator('.mermaid-wrap').first();
    const svg = wrap.locator('.mermaid-chart svg');
    await expect(svg).toBeVisible();

    // 1. Verify the entire diagram fits horizontally and vertically inside .mermaid-scroll
    // and does NOT cover the entire mobile viewport (height <= 420px on an 844px phone screen)
    const wrapBox = (await wrap.boundingBox())!;
    const svgBox = (await svg.boundingBox())!;
    expect(svgBox.width).toBeLessThanOrEqual(wrapBox.width);
    expect(wrapBox.height).toBeLessThanOrEqual(420);
    // Verify the prose below the diagram is simultaneously visible on the mobile screen!
    await expect(page.getByText('下方段落應該在手機畫面上依然清晰可見')).toBeInViewport();

    await page.screenshot({ path: info.outputPath('01-mobile-mermaid-fitted.png') });

    // 2. Verify the collapse / expand button works cleanly
    const toggleBtn = wrap.locator('.mermaid-toggle-btn');
    await expect(toggleBtn).toBeVisible();
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(toggleBtn).toContainText('收合');

    await toggleBtn.click();
    await expect(wrap).toHaveClass(/is-collapsed/);
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(toggleBtn).toContainText('展開');
    await expect(wrap.locator('.mermaid-scroll')).toBeHidden();
    const collapsedBox = (await wrap.boundingBox())!;
    expect(collapsedBox.height).toBeLessThanOrEqual(46);

    await page.screenshot({ path: info.outputPath('02-mobile-mermaid-collapsed.png') });

    // 3. Click again to expand back
    await toggleBtn.click();
    await expect(wrap).not.toHaveClass(/is-collapsed/);
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(svg).toBeVisible();

    // 4. Verify fullscreen zoom modal also fits the complete diagram inside the mobile modal stage
    await wrap.locator('.mermaid-zoom-btn').click();
    const modal = page.locator('#mermaid-modal');
    await expect(modal).toBeVisible();
    const modalSvg = modal.locator('.mm-modal-stage svg');
    await expect(modalSvg).toBeVisible();
    // Measured at rest: it grows out of the diagram first (DESIGN.md "Viewer motion").
    await expect(modal).not.toHaveAttribute('data-motion', /./);
    await expect(modal.locator('.mm-modal-stage')).not.toHaveAttribute('data-motion', /./);
    const modalBodyBox = (await modal.locator('.mm-modal-body').boundingBox())!;
    const modalSvgBox = (await modalSvg.boundingBox())!;
    expect(modalSvgBox.width).toBeLessThanOrEqual(modalBodyBox.width + 2);
    expect(modalSvgBox.height).toBeLessThanOrEqual(modalBodyBox.height + 2);

    await page.screenshot({ path: info.outputPath('03-mobile-mermaid-modal.png') });
    await modal.locator('.mm-modal-close').click();
    await expect(modal).toBeHidden();

    expect(errors).toEqual([]);
  });
});
