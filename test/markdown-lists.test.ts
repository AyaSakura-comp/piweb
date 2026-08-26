import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

describe('markdown list rendering', () => {
  let server: http.Server;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let filePath = path.join('/home/chihmin/src/piweb/public', req.url || '/');
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body><div id="c"></div><script type="module">
          import { renderRich } from '/markdown.js';
          window.renderRich = renderRich;
          window.__ready = true;
        </script></body></html>`);
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath);
        const types: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(data);
      });
    });

    await new Promise<void>((resolve) => server.listen(3472, resolve));

    browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    page = await browser.newPage();
    await page.goto('http://localhost:3472/');
    await page.waitForFunction(() => (window as any).__ready === true);
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  async function render(markdown: string) {
    return page.evaluate((md: string) => {
      const c = document.getElementById('c')!;
      c.innerHTML = '';
      (window as any).renderRich(c, md);
      return {
        html: c.innerHTML,
        olCount: c.querySelectorAll('ol').length,
        ulCount: c.querySelectorAll('ul').length,
        topLiCount: c.querySelectorAll(':scope > ol > li, :scope > ul > li').length,
      };
    }, markdown);
  }

  it('keeps loose ordered lists (with blank lines between items) in a single ol element', async () => {
    const md = `1. **Item 1**:\n   - sub a\n   - sub b\n\n2. **Item 2**:\n   - sub c\n\n3. **Item 3**`;
    const res = await render(md);
    expect(res.olCount).toBe(1);
    expect(res.topLiCount).toBe(3);
    expect(res.ulCount).toBe(2);
  });

  it('preserves start attribute for ordered lists starting at non-1 number', async () => {
    const md = `4. Step 4\n5. Step 5`;
    const res = await render(md);
    expect(res.olCount).toBe(1);
    expect(res.topLiCount).toBe(2);
    const startAttr = await page.evaluate(
      () => document.querySelector('#c ol')?.getAttribute('start'),
    );
    expect(startAttr).toBe('4');
  });

  it('handles loose unordered lists with blank lines in a single ul element', async () => {
    const md = `- Apple\n\n- Banana\n\n- Cherry`;
    const res = await render(md);
    expect(res.ulCount).toBe(1);
    expect(res.topLiCount).toBe(3);
  });

  it('correctly transitions between ordered and unordered lists at same indent', async () => {
    const md = `1. First\n2. Second\n\n- Bullet A\n- Bullet B`;
    const res = await render(md);
    expect(res.olCount).toBe(1);
    expect(res.ulCount).toBe(1);
  });

  it('correctly separates list from subsequent heading or paragraph', async () => {
    const md = `1. First\n2. Second\n\n### Heading\n\nParagraph text`;
    const res = await render(md);
    expect(res.olCount).toBe(1);
    expect(res.topLiCount).toBe(2);
    const hasHeading = await page.evaluate(() =>
      Boolean(document.querySelector('#c h3')),
    );
    const hasP = await page.evaluate(() =>
      Boolean(document.querySelector('#c p')),
    );
    expect(hasHeading).toBe(true);
    expect(hasP).toBe(true);
  });
});
