import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

describe('markdown rendering', () => {
  let server: http.Server;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const filePath = path.join(path.resolve('public'), req.url || '/');
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

  it('renders a bold embedded URL in a table as a secure clickable link', async () => {
    const md = `| 影片 | 說明 |\n|---|---|\n| **[攀山者繩盤收繩法示範](https://www.youtube.com/watch?v=3CzZO7JujJU)** | 直接示範 |`;
    await render(md);
    const result = await page.evaluate(() => {
      const anchor = document.querySelector<HTMLAnchorElement>('#c td strong a');
      return anchor
        ? {
            text: anchor.textContent,
            href: anchor.href,
            target: anchor.target,
            rel: anchor.rel,
            literalSyntaxVisible: document.querySelector('#c td')?.textContent?.includes(']('),
          }
        : null;
    });

    expect(result).toEqual({
      text: '攀山者繩盤收繩法示範',
      href: 'https://www.youtube.com/watch?v=3CzZO7JujJU',
      target: '_blank',
      rel: 'noopener noreferrer',
      literalSyntaxVisible: false,
    });
  });

  it('keeps an unsafe embedded URL inert inside bold text', async () => {
    await render('**[unsafe](data:text/html,evil)**');
    const result = await page.evaluate(() => ({
      anchors: document.querySelectorAll('#c a').length,
      text: document.querySelector('#c strong')?.textContent,
    }));

    expect(result).toEqual({ anchors: 0, text: 'unsafe' });
  });

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
    const startAttr = await page.evaluate(() =>
      document.querySelector('#c ol')?.getAttribute('start'),
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
    const hasHeading = await page.evaluate(() => Boolean(document.querySelector('#c h3')));
    const hasP = await page.evaluate(() => Boolean(document.querySelector('#c p')));
    expect(hasHeading).toBe(true);
    expect(hasP).toBe(true);
  });

  it('renders embedded [[image: /media/...]] block in correct position', async () => {
    const md = `Title\n\n[[image: /media/web_life/book.jpg]]\n\nFooter note`;
    await render(md);
    const media = await page.evaluate(() => {
      const img = document.querySelector('#c .msg-inline-media img');
      const p = document.querySelectorAll('#c p');
      return {
        found: Boolean(img),
        src: img?.getAttribute('src'),
        paragraphs: [...p].map((el) => el.textContent),
      };
    });
    expect(media.found).toBe(true);
    expect(media.src).toBe('/media/web_life/book.jpg');
    expect(media.paragraphs).toEqual(['Title', 'Footer note']);
  });

  it('keeps two prices in one table row in their own cells', async () => {
    // `$199 | 省$340` used to parse as inline math from the first `$` to the
    // second, swallowing the cell boundary: the price column rendered
    // "199|省340" and the discount column came out empty.
    const md =
      `| 加購品 | 加購價 | 折扣 |\n|---|---|---|\n` +
      `| **3M 細滑牙線棒雙線分享包** | **$99** | 省$30 |\n` +
      `| 樂扣樂扣 雙刀組 | $199 | 省$340 |`;
    await render(md);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('#c tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent),
      ),
    );

    expect(rows).toEqual([
      ['3M 細滑牙線棒雙線分享包', '$99', '省$30'],
      ['樂扣樂扣 雙刀組', '$199', '省$340'],
    ]);
    const bold = await page.evaluate(() => document.querySelector('#c td strong')?.textContent);
    expect(bold).toBe('3M 細滑牙線棒雙線分享包');
  });

  it('leaves a currency pair in prose alone but still renders real inline math', async () => {
    await render('**小計：$618**（已折抵 $84）');
    const subtotal = await page.evaluate(() => ({
      text: document.querySelector('#c p')?.textContent,
      bold: document.querySelector('#c strong')?.textContent,
    }));
    expect(subtotal.text).toBe('小計：$618（已折抵 $84）');
    expect(subtotal.bold).toBe('小計：$618');

    // KaTeX is not loaded in this harness, so extracted math falls back to a
    // <span> holding its own source — which is exactly what tells the two cases
    // apart: a pipe inside real prose math is still TeX, not a cell boundary.
    await render('條件機率 $P(A | B)$ 的定義');
    const math = await page.evaluate(() => ({
      text: document.querySelector('#c p')?.textContent,
      mathSpan: document.querySelector('#c p span')?.textContent ?? null,
    }));
    expect(math.mathSpan).toBe('$P(A | B)$');
    expect(math.text).toBe('條件機率 $P(A | B)$ 的定義');

    // CJK prose has no spaces to lean on, so the closing `$` running straight
    // into a digit is what marks this as two prices rather than a formula.
    await render('原價$199特價$340');
    const cjk = await page.evaluate(() => ({
      text: document.querySelector('#c p')?.textContent,
      mathSpan: document.querySelector('#c p span')?.textContent ?? null,
    }));
    expect(cjk.mathSpan).toBeNull();
    expect(cjk.text).toBe('原價$199特價$340');

    // The currency pair must NOT have been lifted out as math.
    await render('小計 $618 與 $84');
    const prose = await page.evaluate(() => ({
      text: document.querySelector('#c p')?.textContent,
      mathSpan: document.querySelector('#c p span')?.textContent ?? null,
    }));
    expect(prose.mathSpan).toBeNull();
    expect(prose.text).toBe('小計 $618 與 $84');
  });

  it('renders embedded video and file links', async () => {
    const md = `[[video: /media/demo.mp4]]\n\n[[file: /media/12345678-report.pdf]]`;
    await render(md);
    const elements = await page.evaluate(() => {
      const video = document.querySelector('#c .msg-inline-media .video-file video');
      const file = document.querySelector('#c .msg-inline-media a.file-link');
      return {
        videoSrc: video?.getAttribute('src'),
        fileHref: file?.getAttribute('href'),
        fileText: file?.textContent,
      };
    });
    expect(elements.videoSrc).toBe('/media/demo.mp4');
    expect(elements.fileHref).toBe('/media/12345678-report.pdf');
    expect(elements.fileText).toBe('report.pdf');
  });
});
