import { expect, test } from 'playwright/test';

// piscord renders Discord replies' tables, math and mermaid to images in a bare
// page that imports this repo's /lobehub-rich.js (src/live-page/snapshot.ts in
// ~/src/pi-discord-gateway): no index.html, no app.js, and only the renderer's
// own modules, app.css and vendor/ beside it. A renderer that needs anything
// more fails there silently and every table reaches Discord as raw Markdown
// (2026-10-27). This page is that page, served from the fixture's public/.
const SNAP_PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/vendor/katex/katex.min.css">
<link rel="stylesheet" href="/app.css">
</head><body>
<div id="snap"><div class="msg-text"></div></div>
<script src="/vendor/katex/katex.min.js"></script>
<script src="/vendor/highlight/highlight.min.js"></script>
<script type="module">
  import { renderLobehubStatic, updateLobehubRich } from '/lobehub-rich.js';
  window.__render = (src) => renderLobehubStatic(document.querySelector('#snap .msg-text'), src);
  window.__snapReady = typeof updateLobehubRich === 'function';
</script>
</body></html>`;

test('the renderer loads and draws a table, math and mermaid in piscord’s bare snap page', async ({
  page,
}, info) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  // Only what piscord serves: a top-level module (it serves those the renderer
  // imports, so any one requested here qualifies), app.css, favicon.svg and
  // vendor/. Anything else is a contract break, refused as piscord would.
  await page.route('**/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/__piscord-snap')
      return route.fulfill({ contentType: 'text/html', body: SNAP_PAGE });
    if (
      /^\/[\w.-]+\.js$/.test(path) ||
      ['/app.css', '/favicon.svg'].includes(path) ||
      path.startsWith('/vendor/')
    )
      return route.continue();
    problems.push(`not served by piscord: ${path}`);
    return route.fulfill({ status: 404, body: 'not found' });
  });

  await page.goto('/__piscord-snap');
  await page.waitForFunction(() => (window as any).__snapReady === true, null, { timeout: 10_000 });

  const body = page.locator('#snap .msg-text');
  await page.evaluate(() =>
    (window as any).__render('| 項目 | 資訊 |\n|--|--|\n| **地點** | 新竹縣五峰鄉 |\n'),
  );
  await expect(body.locator('table td').first()).toHaveText('地點');
  await page.locator('#snap').screenshot({ path: info.outputPath('table.png') });

  await page.evaluate(() => (window as any).__render('$$\nE = mc^2\n$$'));
  await expect(body.locator('.katex').first()).toBeVisible();

  await page.evaluate(() => (window as any).__render('```mermaid\ngraph TD\n  A-->B\n```'));
  await expect(body.locator('.mermaid-chart svg')).toBeVisible({ timeout: 15_000 });
  await page.locator('#snap').screenshot({ path: info.outputPath('mermaid.png') });

  expect(problems).toEqual([]);
});
