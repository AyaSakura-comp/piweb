import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from 'playwright/test';

const event = (
  id: number,
  content: string,
  role = 'assistant',
  kind = 'message',
  files: string[] = [],
) => ({
  id,
  content,
  role,
  kind,
  createdAt: '2026-10-06T12:00:00Z',
  files,
});

async function setup(page: Page, history: ReturnType<typeof event>[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const session = {
    jid: 'web:lobe',
    name: 'LobeHub Streamdown',
    kind: 'standard',
    deleted: false,
    busy: false,
  };
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.autoScroll', 'false');
    const host = window as any;
    host.EventSource = class extends EventTarget {
      closed = false;
      constructor() {
        super();
        host.__lobeStream = this;
      }
      close() {
        this.closed = true;
      }
    };
    host.__lobeEmit = (type: string, data: unknown) => {
      host.__lobeStream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    };
  });
  const events = [...history];
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/media'))
      return route.fulfill({ json: { items: [{ type: 'image', url: '/media/lobe.svg' }] } });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events,
          session,
          busy: false,
          partial: null,
          hasMoreOlder: false,
          hasMoreNewer: false,
        },
      });
    if (path.endsWith('/messages')) {
      const row = event(events.length + 1, route.request().postDataJSON().text, 'user');
      events.push(row);
      return route.fulfill({ json: { ok: true, eventId: row.id } });
    }
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.route('**/media/lobe.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#82b5aa"/><circle cx="150" cy="100" r="65" fill="#f3dbc0"/></svg>',
    }),
  );
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await expect.poll(() => page.evaluate(() => !!(window as any).__lobeStream)).toBe(true);
  return { errors, events };
}

async function emit(page: Page, type: string, data: unknown) {
  await page.evaluate(({ type, data }) => (window as any).__lobeEmit(type, data), { type, data });
}
const partial = (page: Page, content: string, thinking = '') =>
  emit(page, 'partial', { content, thinking });

for (const [name, source, selector, count] of [
  ['blank-line display math', 'Prefix.\n\n$$\nx^2\n\n+y^2\n$$\n\nEnd.', '.katex-display', 1],
  [
    'cross-block reference',
    'Prefix.\n\n[reference][ref]\n\n[ref]: https://example.test\n\nEnd.',
    'a[href="https://example.test"]',
    1,
  ],
] as const) {
  test(`LobeHub document context preserves ${name} through chunks EOF and reload`, async ({
    page,
  }, info) => {
    const { errors, events } = await setup(page, [event(40, source)]);
    await partial(page, 'Prefix.');
    await expect(page.locator('#partial-msg p')).toHaveText('Prefix.');
    await page.evaluate(() => {
      const w = window as any;
      w.__contextBody = document.querySelector('#partial-msg .msg-text');
      w.__contextRoot = w.__contextBody.querySelector('.streamdown-animated');
      w.__contextPrefix = w.__contextBody.querySelector('p');
    });
    for (const end of [source.indexOf('\n\n', 10) + 2, source.length]) {
      await partial(page, source.slice(0, end));
      await page.waitForTimeout(250);
    }
    events.push(event(41, source));
    await emit(page, 'event', events.at(-1));
    await partial(page, '');
    const body = page.locator('.msg[data-event-id="41"] .msg-text');
    await expect(body).toContainText('End.');
    await expect(body.locator(selector)).toHaveCount(count);
    if (name === 'blank-line display math') {
      await expect(body.locator('.katex')).toHaveCount(1);
      await expect(body.locator('annotation')).toHaveText(/x\^2\s*\+y\^2/);
    }
    expect(
      await body.evaluate((n) => {
        const w = window as any;
        return (
          n === w.__contextBody &&
          n.querySelector('p') === w.__contextPrefix &&
          n.querySelector('.streamdown-animated') === w.__contextRoot
        );
      }),
    ).toBe(true);
    await expect
      .poll(() =>
        body.evaluate(
          (n) =>
            n
              .getAnimations({ subtree: true })
              .filter(
                (a) =>
                  (a as CSSAnimation).animationName === 'streamdown-fade-in' &&
                  a.playState === 'running',
              ).length,
        ),
      )
      .toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('document-context-dark.png') });
    await page.reload();
    await expect(body.locator(selector)).toHaveCount(count);
    await page.locator('#btn-menu').click();
    await page.locator('#btn-settings').click();
    await page.locator('#btn-theme').click();
    await page.locator('#btn-settings-close').click();
    await expect(body.locator(selector)).toHaveCount(count);
    await page.screenshot({ path: info.outputPath('document-context-light.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await partial(page, source);
    await expect(page.locator('#partial-msg').locator(selector)).toHaveCount(count);
    expect(errors).toEqual([]);
  });
}

test.describe('document-context desktop selection', () => {
  test.use({ isMobile: false, hasTouch: false });
  test('LobeHub document definitions preserve normalized references images precedence and URL safety', async ({
    page,
  }) => {
    const source =
      'Prefix.\n\n[full][  Mixed   Case ] [mixed case][] [mixed case] ![image][picture] [unsafe][bad]\n\n' +
      '[Mixed Case]: https://example.test/first "First"\n\n[Mixed Case]: https://example.test/second\n\n' +
      '[picture]: /media/lobe.svg\n\n[bad]: javascript:alert(1)\n\n' +
      '`[mixed case]`\n\n```text\n$$\nx^2\n\n+y^2\n$$\n```\n\nEnd.';
    const { errors, events } = await setup(page, [event(42, source)]);
    await partial(page, 'Prefix.');
    await expect(page.locator('#partial-msg p')).toHaveText('Prefix.');
    await partial(page, source.slice(0, source.indexOf('[Mixed Case]:') - 1));
    await expect(page.locator('#partial-msg .msg-text')).toContainText('unsafe');
    await expect
      .poll(() =>
        page
          .locator('#partial-msg .msg-text')
          .evaluate(
            (n) =>
              n
                .getAnimations({ subtree: true })
                .filter(
                  (a) =>
                    (a as CSSAnimation).animationName === 'streamdown-fade-in' &&
                    a.playState === 'running',
                ).length,
          ),
      )
      .toBe(0);
    await partial(page, source.slice(0, source.indexOf('[Mixed Case]:')));
    await expect(page.locator('#partial-msg p').first().locator('.stream-char')).toHaveCount(0);
    await page.evaluate(() => {
      const n = document.querySelector('#partial-msg p')!;
      const range = document.createRange();
      range.selectNodeContents(n);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      (window as any).__referencePrefix = n;
      (window as any).__referenceText = n.firstChild;
      (window as any).__referenceTop = document.getElementById('messages')!.scrollTop;
    });
    await partial(page, source);
    await expect(page.locator('#partial-msg a[href="https://example.test/first"]')).toHaveCount(3);
    expect(
      await page.evaluate(() => ({
        selected: getSelection()!.toString(),
        sameText:
          document.querySelector('#partial-msg p')!.firstChild === (window as any).__referenceText,
        samePrefix: document.querySelector('#partial-msg p') === (window as any).__referencePrefix,
      })),
      'selection before EOF',
    ).toEqual({ selected: 'Prefix.', sameText: true, samePrefix: true });
    events.push(event(43, source));
    await emit(page, 'event', events.at(-1));
    await partial(page, '');
    const verify = async (selector: string) => {
      const body = page.locator(selector);
      await expect(body).toContainText('End.');
      await expect(body.locator('a[href="https://example.test/first"]')).toHaveCount(3);
      await expect(
        body.locator(
          'a[href="https://example.test/second"], [href^="javascript:"], [src^="javascript:"]',
        ),
      ).toHaveCount(0);
      await expect(body.locator('img')).toHaveAttribute('src', '/media/lobe.svg');
      await expect(body.locator('p code')).toHaveText('[mixed case]');
      await expect(body.locator('pre code')).toHaveText('$$\nx^2\n\n+y^2\n$$');
      await expect(body.locator('.katex')).toHaveCount(0);
    };
    await verify('.msg[data-event-id="43"] .msg-text');
    expect(
      await page.evaluate(() => {
        const w = window as any;
        return {
          samePrefix: document.querySelector('.msg[data-event-id="43"] p') === w.__referencePrefix,
          drift: Math.abs(document.getElementById('messages')!.scrollTop - w.__referenceTop),
        };
      }),
    ).toEqual({ samePrefix: true, drift: 0 });
    await page.reload();
    await verify('.msg[data-event-id="43"] .msg-text');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await partial(page, source);
    await verify('#partial-msg .msg-text');
    expect(errors).toEqual([]);
  });
});

test('LobeHub malformed formula EOF releases the guard without replacing its prefix', async ({
  page,
}, info) => {
  const source = 'Visible prefix.\n\n$\\unknowncommand';
  const { errors, events } = await setup(page);
  await partial(page, 'Visible prefix.');
  await expect(page.locator('#partial-msg p')).toHaveText('Visible prefix.');
  await page.evaluate(() => {
    const w = window as any;
    w.__formulaBody = document.querySelector('#partial-msg .msg-text');
    w.__formulaRoot = w.__formulaBody.querySelector('.streamdown-animated');
    w.__formulaPrefix = w.__formulaBody.querySelector('p');
  });
  await partial(page, source);
  await expect(page.locator('#partial-msg .msg-text')).not.toContainText('unknowncommand');
  events.push(event(31, source));
  await emit(page, 'event', events.at(-1));
  await partial(page, '');
  const body = page.locator('.msg[data-event-id="31"] .msg-text');
  await expect(body).toContainText('unknowncommand');
  expect(
    await body.evaluate((n) => {
      const w = window as any;
      return (
        n === w.__formulaBody &&
        n.querySelector('p') === w.__formulaPrefix &&
        n.querySelector('.streamdown-animated') === w.__formulaRoot
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath('malformed-eof.png') });
  await page.reload();
  await expect(body).toContainText('unknowncommand');
  expect(errors).toEqual([]);
});

for (const surface of [
  'assistant history',
  'thinking history',
  'assistant live',
  'thinking live',
]) {
  test(`LobeHub YouTube leaf preserves open replace close and modified clicks in ${surface}`, async ({
    page,
  }, info) => {
    const source =
      '[First video](https://www.youtube.com/watch?v=dQw4w9WgXcQ) and [Second video](https://youtu.be/9bZkp7q19f0)';
    const requests: string[] = [];
    await page
      .context()
      .route('https://www.youtube.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>External fixture</title>' }),
      );
    await page.route('https://www.youtube-nocookie.com/embed/**', (route) => {
      requests.push(route.request().url());
      return route.fulfill({
        contentType: 'text/html',
        body: '<title>Embed fixture</title><p>Local video fixture</p>',
      });
    });
    const thinking = surface.startsWith('thinking');
    const live = surface.endsWith('live');
    const row = event(32, source, 'assistant', thinking ? 'thinking' : 'message');
    const { errors } = await setup(page, live ? [] : [row]);
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            (window as any).__linkCopied = true;
          },
        },
      }),
    );
    if (live) await partial(page, thinking ? '' : source, thinking ? source : '');
    const container = page.locator(
      live
        ? thinking
          ? '#partial-thinking'
          : '#partial-msg'
        : thinking
          ? '.event[data-event-id="32"]'
          : '.msg[data-event-id="32"]',
    );
    if (thinking) await container.locator('summary').click();
    const links = container.locator('a.youtube-inline-link');
    await expect(links).toHaveCount(2);
    await expect.poll(() => links.first().evaluate((n) => n.inert)).toBe(false);
    expect(requests).toEqual([]);
    const modified = await links.first().evaluate((n) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
      // Cancel navigation only after the production leaf has processed it.
      const cancel = (event: Event) => event.preventDefault();
      window.addEventListener('click', cancel, { once: true });
      const allowed = n.dispatchEvent(e);
      window.removeEventListener('click', cancel);
      return allowed;
    });
    expect(modified).toBe(true);
    expect(await page.evaluate(() => (window as any).__linkCopied)).toBeUndefined();
    await links.first().click();
    const player = container.locator('.youtube-inline-player');
    await expect(player.locator('iframe')).toHaveAttribute(
      'src',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1&rel=0',
    );
    await expect.poll(() => requests.length).toBe(1);
    if (live) {
      await partial(
        page,
        thinking ? '' : source + '\n\nMore text.',
        thinking ? source + '\n\nMore text.' : '',
      );
      await expect(player).toHaveCount(1);
    }
    await links.last().click();
    await expect(player).toHaveCount(1);
    await expect(player.locator('iframe')).toHaveAttribute('src', /embed\/9bZkp7q19f0\?/);
    await expect(links.first()).toHaveAttribute('aria-expanded', 'false');
    await expect(player.locator('iframe')).toHaveAttribute(
      'referrerpolicy',
      'strict-origin-when-cross-origin',
    );
    await page.screenshot({ path: info.outputPath('youtube-replaced.png') });
    await player.getByRole('button', { name: 'Close video' }).click();
    await expect(player).toHaveCount(0);
    await expect(links.last()).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => (window as any).__linkCopied)).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
}

test('LobeHub published video retains real native 180ms opacity animation and control guard', async ({
  page,
}) => {
  await page.route('**/media/lobe.webm', (route) =>
    route.fulfill({ contentType: 'video/webm', body: '' }),
  );
  await setup(page);
  await partial(page, 'Video prefix.');
  await expect(page.locator('#partial-msg p')).toHaveText('Video prefix.');
  await emit(
    page,
    'event',
    event(33, 'Video prefix.\n\n[[video: /media/lobe.webm]]\n\nAfter video.'),
  );
  const video = page.locator('.msg[data-event-id="33"] video');
  await expect(video).toHaveCount(1);
  const sample = await video.evaluate((n) => {
    let target: HTMLElement | null = n;
    let animation: Animation | undefined;
    while (target && !animation) {
      animation = target
        .getAnimations()
        .find((a) => (a as CSSAnimation).animationName === 'streamdown-fade-in');
      if (!animation) target = target.parentElement;
    }
    if (!animation || !target) return null;
    animation.pause();
    const duration = animation.effect!.getTiming().duration;
    animation.currentTime = 0;
    const start = Number(getComputedStyle(target).opacity);
    animation.currentTime = 90;
    const middle = Number(getComputedStyle(target).opacity);
    animation.currentTime = 180;
    const end = Number(getComputedStyle(target).opacity);
    const inert = n.inert;
    animation.play();
    return { duration, start, middle, end, inert };
  });
  expect(sample).not.toBeNull();
  expect(sample!.duration).toBe(180);
  expect(sample!.start).toBeLessThan(sample!.middle);
  expect(sample!.middle).toBeLessThan(sample!.end);
  expect(sample!.end).toBe(1);
  expect(sample!.inert).toBe(true);
  await expect.poll(() => video.evaluate((n) => n.inert)).toBe(false);
});

const prose =
  '這次直接使用 LobeHub 的原生效果，文字隨串流逐漸出現。已經讀過的段落不再重新播放，中文、English、🙂 都能接著讀。';
const rich =
  '\n\n## 用真正的套件\n\n**粗體**、`行內程式`與 [來源](https://example.com)。\n\n```js\nconst answer = 42;\nconsole.log(answer);\n```\n\n| 項目 | 結果 |\n| --- | --- |\n| 中文 | 平滑 |\n\n![示範圖片](/media/lobe.svg)\n\n公式：$x^2 + y^2 = z^2$。';

// Asserts the actual library DOM/CSS, not an adapter label or a fake animation.
test('LobeHub owns character reveal and durable EOF keeps the same reply root', async ({
  page,
}) => {
  const { errors } = await setup(page);
  await partial(page, prose.slice(0, 20));
  await expect(page.locator('#partial-msg .streamdown-animated')).toHaveCount(1);
  await expect(page.locator('#partial-msg .stream-char').first()).toHaveCSS(
    'animation-name',
    'streamdown-fade-in',
  );
  await page.evaluate(() => {
    const host = window as any;
    host.__body = document.querySelector('#partial-msg .msg-text');
    host.__paragraph = host.__body.querySelector('p');
  });
  await partial(page, prose);
  await expect(page.locator('#partial-msg p')).toHaveText(prose);
  await emit(page, 'event', event(21, prose));
  await partial(page, '');
  const body = page.locator('.msg[data-event-id="21"] .msg-text');
  await expect(body).toHaveText(prose);
  expect(
    await body.evaluate(
      (n) => n === (window as any).__body && n.querySelector('p') === (window as any).__paragraph,
    ),
  ).toBe(true);
  expect(await body.locator('[style*="mask"], .reply-chunk').count()).toBe(0);
  expect(await page.evaluate(() => CSS.highlights.has('piweb-reply-hidden'))).toBe(false);
  expect(errors).toEqual([]);
});

for (const source of [
  '# Heading\n\n    ```js\nconst a = 1;\n\nconst b = 2;\n    ```\n\nAfter',
  'Intro\n\n- first\n\n- second\n  - nested\n\nEnd',
  'Start\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nEnd',
]) {
  test(`LobeHub live and history agree for ${source.includes('nested') ? 'loose nested list' : source.includes('    ```') ? 'indented fence' : 'blank lines in fence'}`, async ({
    page,
  }) => {
    const { errors } = await setup(page, [event(1, source)]);
    await partial(page, source.slice(0, source.lastIndexOf('\n\n')));
    await partial(page, source);
    await emit(page, 'event', event(2, source));
    await partial(page, '');
    await expect(page.locator('.msg[data-event-id="2"] .msg-text')).toContainText(
      source.endsWith('After') ? 'After' : 'End',
    );
    const shape = (id: number) =>
      page.locator(`.msg[data-event-id="${id}"] .msg-text`).evaluate((n) => ({
        blocks: [...n.querySelectorAll('h1, p, pre, ul, ol, li')].map((e) => ({
          tag: e.tagName,
          text: e.textContent,
        })),
      }));
    await expect
      .poll(async () => JSON.stringify(await shape(2)))
      .toBe(JSON.stringify(await shape(1)));
    expect(errors).toEqual([]);
  });
}

test('LobeHub never exposes unpublished local outbox paths and keeps the prefix at publication', async ({
  page,
}) => {
  const { errors } = await setup(page);
  await partial(page, '保留已讀的文字。\n\n[[image: /home/private/image.png]]\n\n尚未公開');
  await expect(page.locator('#partial-msg')).toContainText('保留已讀的文字。');
  await expect(page.locator('#partial-msg')).not.toContainText('/home/private');
  await page.evaluate(() => ((window as any).__prefix = document.querySelector('#partial-msg p')));
  await expect(page.locator('#partial-msg')).toContainText('尚未公開');
  await emit(page, 'event', event(4, '保留已讀的文字。\n\n[[image: /media/lobe.svg]]\n\n尚未公開'));
  await partial(page, '');
  await expect(page.locator('.msg[data-event-id="4"] img')).toBeVisible();
  expect(
    await page
      .locator('.msg[data-event-id="4"] p')
      .first()
      .evaluate((n) => n === (window as any).__prefix),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('LobeHub embedded file images survive publication viewer and history', async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const { errors, events } = await setup(page);
  const urls = ['/media/lobe-used.png', '/media/lobe-cache.png'];
  for (const url of urls)
    await page.route(`**${url}`, (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160"><rect width="300" height="160" fill="#82b5aa"/><text x="20" y="85" font-size="24">Memory chart</text></svg>',
      }),
    );
  await page.route('**/api/sessions/web%3Alobe/media', (route) =>
    route.fulfill({ json: { items: urls.map((url) => ({ type: 'image', url })) } }),
  );
  const prefix = '我用 390px 手機寬度截圖看過兩種狀態。';
  const source = `${prefix}\n\n[[file: ${urls[0]}]]\n\n[[file: ${urls[1]}]]\n\n圖片之後仍可閱讀。`;
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') {
      await page.locator('#btn-menu').click();
      await page.locator('#btn-settings').click();
      await page.locator('#btn-theme').click();
      await page.locator('#btn-settings-close').click();
    }
    await page.locator('#input').fill(`${theme}：顯示嵌入圖片`);
    await page.locator('#btn-send').click();
    await expect(page.locator('#messages')).not.toHaveAttribute(
      'data-prompt-motion',
      /waiting|moving/,
    );
    await emit(page, 'event', events.at(-1));
    await partial(
      page,
      `${prefix}\n\n[[file: /home/private/mem-used.png]]\n\n[[file: /home/private/mem-cache.png]]\n\n圖片之後仍可閱讀。`,
    );
    await expect(page.locator('#partial-msg p')).toHaveText([prefix, '圖片之後仍可閱讀。']);
    await expect(page.locator('#partial-msg')).not.toContainText('/home/private');
    await expect(page.locator('#partial-msg img')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${theme}-01-private-preview.png`) });
    await page.evaluate(() => {
      (window as any).__embeddedBody = document.querySelector('#partial-msg .msg-text');
      (window as any).__embeddedPrefix = document.querySelector('#partial-msg p');
    });
    const id = events.at(-1)!.id + 1;
    const row = event(id, source, 'assistant', 'message', urls);
    events.push(row);
    await emit(page, 'event', row);
    await partial(page, '');
    const body = page.locator(`.msg[data-event-id="${id}"] .msg-text`);
    await expect(body.locator('img.msg-inline-img')).toHaveCount(2);
    await expect(body).not.toContainText('[[file:');
    expect(
      await body.evaluate(
        (n) =>
          n === (window as any).__embeddedBody &&
          n.querySelector('p') === (window as any).__embeddedPrefix,
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        body
          .locator('img')
          .evaluateAll((nodes) =>
            nodes.every(
              (n) =>
                (n as HTMLImageElement).complete &&
                (n as HTMLImageElement).naturalWidth > 0 &&
                !(n as HTMLElement).inert,
            ),
          ),
      )
      .toBe(true);
    await expect(page.locator(`.msg[data-event-id="${id}"] .msg-files`)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${theme}-02-published-images.png`) });
    await body.locator('img').first().click();
    await expect(page.locator('#lightbox')).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('#lb-img')
          .evaluate(
            (n) => (n as HTMLImageElement).complete && (n as HTMLImageElement).naturalWidth > 0,
          ),
      )
      .toBe(true);
    await page.screenshot({ path: info.outputPath(`${theme}-03-viewer.png`) });
    await page.locator('#lb-close').click();
    await page.reload();
    const history = page.locator(`.msg[data-event-id="${id}"] .msg-text`);
    await expect(history.locator('img.msg-inline-img')).toHaveCount(2);
    await expect(history).not.toContainText('[[file:');
    await expect(history.locator('.stream-char')).toHaveCount(0);
    await history.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        history
          .locator('img')
          .evaluateAll((nodes) =>
            nodes.every(
              (n) => (n as HTMLImageElement).complete && (n as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`${theme}-04-history.png`) });
  }
  expect(errors).toEqual([]);
});

test('LobeHub published markers preserve inline media downloads code and safe URLs', async ({
  page,
}) => {
  const remote = 'https://media.example.test/lobe.svg';
  await page.route(remote, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#82b5aa"/></svg>',
    }),
  );
  const marker = '[[file: /media/lobe.svg]]';
  const source = `Inline ${marker} after.\n\n- Nested [[IMAGE: ${remote}]]\n\n[[file: /media/12345678-report.pdf]]\n\n\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\`\n\n[[image: javascript:alert(1)]]\n\n[[file: /home/private/chart.png]]`;
  const { errors } = await setup(page, [event(1, source)]);
  const body = page.locator('.msg[data-event-id="1"] .msg-text');
  await expect(body.locator('img.msg-inline-img')).toHaveCount(2);
  await expect(body.locator('a.file-link')).toHaveAttribute('href', '/media/12345678-report.pdf');
  await expect(body.locator('a.file-link')).toHaveText('report.pdf');
  await expect(body.locator('code').first()).toHaveText(marker);
  await expect(body.locator('pre code')).toContainText(marker);
  await expect(
    body.locator('[src^="javascript:"], [href^="javascript:"], [src^="/home/"]'),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('LobeHub block spacing does not turn Markdown separators into blank lines', async ({
  page,
}, info) => {
  const source =
    '**之前其實沒打到。** 原本的設定讓 pi 只告訴 Strata「思考開／關」，你選 low、medium 還是 high，Strata 收到的都只是「開」，然後用它的預設等級 xhigh（最高）在想。現在已經修好。\n\n**原本的問題**\n\n- pi 設定裡的 `thinkingFormat: "qwen-chat-template"`，只會送 `chat_template_kwargs: {enable_thinking: true/false}`，等級資訊在這一步就丟了。\n\n- 我設定 Strata 時沿用了 qwen-mtp 的寫法，沒注意到這點。\n\n**修正後**：改用 OpenAI 標準的 `reasoning_effort` 欄位，加上等級對照表。\n\n| pi 的等級 | pi 送出 | Strata 實際用 |\n| --- | --- | --- |\n| off | `none` | 不思考 |\n\n```js\nfunction sample() {\n  return 42;\n}\n```\n\n行內程式 `keep  two spaces`。\n\n最後一段\n保留換行。';
  const code = 'function sample() {\n  return 42;\n}';
  const user = '使用者保留  兩個空格\n與原始換行。';
  const { errors, events } = await setup(page, [event(1, source), event(2, user, 'user')]);
  const metrics: unknown[] = [];
  for (const mode of ['history', 'streaming', 'durable', 'reduced-motion']) {
    if (mode === 'streaming') {
      await page.locator('#input').fill('檢查段落和清單間距');
      const reachable = await page.locator('#btn-send').evaluate((n) => {
        const r = n.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === n || n.contains(hit);
      });
      expect(reachable).toBe(true);
      await page.locator('#btn-send').click();
      await emit(page, 'event', events.at(-1));
      await expect(page.locator('#messages')).not.toHaveAttribute(
        'data-prompt-motion',
        /waiting|moving/,
      );
    }
    if (mode === 'streaming' || mode === 'reduced-motion') {
      if (mode === 'reduced-motion') await page.emulateMedia({ reducedMotion: 'reduce' });
      await partial(page, source);
    }
    if (mode === 'durable') {
      await emit(page, 'event', event(4, source));
      await partial(page, '');
    }
    const body = page.locator(
      mode === 'history'
        ? '.msg[data-event-id="1"] .msg-text'
        : mode === 'durable'
          ? '.msg[data-event-id="4"] .msg-text'
          : '#partial-msg .msg-text',
    );
    await expect(body).toContainText('保留換行。');
    await expect(body.locator('pre code.hljs')).toHaveCount(1);
    await expect(body.locator('pre code')).toHaveText(code);
    await expect(body.locator('pre code')).toHaveCSS('white-space', 'pre');
    await expect(body.locator('p code').filter({ hasText: 'keep  two spaces' })).toHaveCSS(
      'white-space',
      'pre-wrap',
    );
    await expect(body.locator('p').filter({ hasText: '最後一段' }).locator('br')).toHaveCount(1);
    const measured = await body.evaluate((element) => {
      const root = element.querySelector(':scope > .streamdown-animated') || element;
      const rect = (n: Element) => n.getBoundingClientRect();
      const edgeMargin = (node: Element, edge: 'Top' | 'Bottom') => {
        let margin = 0;
        let current: Element | null = node;
        // Nested code/table leaves can expose their child's native margins.
        // Count those too; reject only extra whitespace line boxes, not CSS margins.
        while (current) {
          margin = Math.max(margin, parseFloat(getComputedStyle(current)[`margin${edge}`]));
          current = edge === 'Top' ? current.firstElementChild : current.lastElementChild;
        }
        return margin;
      };
      const gaps = (nodes: Element[]) =>
        nodes.slice(1).map((next, index) => {
          const previous = nodes[index];
          const margin = edgeMargin(previous, 'Bottom') + edgeMargin(next, 'Top');
          return {
            previous: previous.tagName,
            next: next.tagName,
            actual: rect(next).top - rect(previous).bottom,
            allowed: margin + 1,
          };
        });
      return {
        whiteSpace: getComputedStyle(element).whiteSpace,
        lineHeight: getComputedStyle(element).lineHeight,
        height: rect(element).height,
        rootTextNodes: [...root.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent),
        blockGaps: gaps(
          [...root.children].filter((n) => ['P', 'UL', 'OL', 'H2', 'DIV'].includes(n.tagName)),
        ),
        listGaps: [...root.querySelectorAll('ul, ol')].flatMap((n) =>
          gaps([...n.children].filter((c) => c.tagName === 'LI')),
        ),
      };
    });
    if (mode === 'streaming')
      await body.evaluate((n) => {
        (window as any).__spacingBody = n;
        (window as any).__spacingPrefix = n.querySelector('p');
      });
    if (mode === 'durable')
      expect(
        await body.evaluate(
          (n) =>
            n === (window as any).__spacingBody &&
            n.querySelector('p') === (window as any).__spacingPrefix,
        ),
      ).toBe(true);
    metrics.push({ mode, ...measured });
    await writeFile(info.outputPath('spacing.json'), JSON.stringify(metrics, null, 2));
    for (const gap of [...measured.blockGaps, ...measured.listGaps])
      expect(gap.actual, `${mode}: ${gap.previous} → ${gap.next}`).toBeLessThanOrEqual(gap.allowed);
    await body.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${mode}.png`) });
  }
  await expect(page.locator('.msg[data-event-id="2"] .msg-text')).toHaveCSS(
    'white-space',
    'pre-wrap',
  );
  await expect(page.locator('.msg[data-event-id="2"] .msg-text')).toHaveText(user, {
    useInnerText: true,
  });
  expect(errors).toEqual([]);
});

test('LobeHub screenshot layout walkthrough keeps prose lists and copy usable', async ({
  page,
}, info) => {
  // Opt-in diagnostic replay uses captured deployed assets, not a DOM/CSS patch.
  // The maintained default exercises the current production source assets.
  if (process.env.PIWEB_LAYOUT_DEPLOYED_ASSETS === '1') {
    for (const [name, contentType] of [
      ['app.css', 'text/css'],
      ['lobehub-rich.js', 'text/javascript'],
    ]) {
      await page.route(`**/${name}*`, async (route) =>
        route.fulfill({
          contentType,
          body: await readFile(`artifacts/lobehub-layout-audit/runtime/${name}`, 'utf8'),
        }),
      );
    }
  }
  const code = '{ "browserMode": "intent", "crawlGuards": false }';
  const source =
    'The crawl setting now lives in the config file, the docs are updated, and two commits are pushed to `AyaSakura-comp/pi-nodriver-browser` (`main`, `4eda73d..569554c`).\n\n' +
    '**Config file:** `~/.pi/agent/browser-config.json` now has:\n\n```json\n' +
    code +
    '\n```\n\n' +
    '- `crawlGuards` defaults to `true` in the repo, so other installs keep the guards. Only this machine turns them off.\n\n' +
    '- The env var switch from last time is gone; this key replaces it.\n\n' +
    "- To restore the limits, change it to `true` or delete the key, then `/reload` pi or restart it. Pi only auto-reloads when the extension's code changes, not when this config file changes.\n\n" +
    '**Commits:**\n\n1. `4eda73d` — configuration support.\n2. `569554c` — documentation.\n\nEnd of layout fixture.';
  const raw = 'Raw user  spaces\nand newline.';
  const { errors, events } = await setup(page, [event(1, source), event(2, raw, 'user')]);
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__layoutCopied = text;
        },
      },
    }),
  );
  const metrics: unknown[] = [];
  const measure = async (selector: string, stage: string) => {
    const body = page.locator(selector);
    await expect(body).toContainText('End of layout fixture.');
    await expect(body.locator('pre code')).toHaveText(code);
    const geometry = await body.evaluate((n) => {
      const root = n.querySelector(':scope > .streamdown-animated') || n;
      const edge = (el: Element, side: 'Top' | 'Bottom') => {
        let margin = 0;
        let current: Element | null = el;
        while (current) {
          margin = Math.max(margin, parseFloat(getComputedStyle(current)[`margin${side}`]) || 0);
          current = side === 'Top' ? current.firstElementChild : current.lastElementChild;
        }
        return margin;
      };
      const gaps = (nodes: Element[]) =>
        nodes.slice(1).map((next, i) => ({
          previous: nodes[i].tagName,
          next: next.tagName,
          actual: next.getBoundingClientRect().top - nodes[i].getBoundingClientRect().bottom,
          allowed: edge(nodes[i], 'Bottom') + edge(next, 'Top') + 1,
        }));
      return {
        whiteSpace: getComputedStyle(n).whiteSpace,
        height: n.getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        blockGaps: gaps([...root.children]),
        listGaps: [...root.querySelectorAll('ul, ol')].flatMap((el) => gaps([...el.children])),
      };
    });
    metrics.push({ stage, ...geometry });
    await writeFile(info.outputPath('layout-metrics.json'), JSON.stringify(metrics, null, 2));
    await body.locator('p').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${stage}-top.png`) });
    await body.locator('ul').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${stage}-list.png`) });
    expect(geometry.overflow).toBe(false);
    for (const gap of [...geometry.blockGaps, ...geometry.listGaps]) {
      expect(gap.actual, `${stage}: ${gap.previous} → ${gap.next}`).toBeLessThanOrEqual(
        gap.allowed,
      );
    }
    await expect(body).toHaveCSS('white-space', 'normal');
    await expect(body.locator('pre code')).toHaveCSS('white-space', 'pre');
    return body;
  };
  const reachable = async (selector: string) => {
    const control = page.locator(selector);
    await control.scrollIntoViewIfNeeded();
    const hit = await control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { reachable: target === el || el.contains(target), width: r.width, height: r.height };
    });
    expect(hit.reachable).toBe(true);
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    await control.click();
  };
  await measure('.msg[data-event-id="1"] .msg-text', '01-history');
  // Code text remains tap-to-copy, but is no longer a toolbar button.
  // Keep the 44px control contract below for Send, not for plain text.
  await page.locator('.msg[data-event-id="1"] pre code').click();
  await expect.poll(() => page.evaluate(() => (window as any).__layoutCopied)).toBe(code);
  await page.screenshot({ path: info.outputPath('02-copy.png') });
  await page.locator('#input').fill('重現截圖中的段落、清單和程式碼排版');
  await reachable('#btn-send');
  await emit(page, 'event', events.at(-1));
  await expect(page.locator('#messages')).not.toHaveAttribute(
    'data-prompt-motion',
    /waiting|moving/,
  );
  const prefix = source.slice(0, source.indexOf('\n\n'));
  await partial(page, prefix);
  await expect(page.locator('#partial-msg p')).toHaveText(prefix.replaceAll('`', ''));
  await page.screenshot({ path: info.outputPath('03-stream-prefix.png') });
  // Deliberate arrival cadence gives the native animation overlapping chunks.
  for (const end of [source.indexOf('- The env'), source.indexOf('**Commits:**'), source.length]) {
    await partial(page, source.slice(0, end));
    await page.waitForTimeout(200);
  }
  const streaming = await measure('#partial-msg .msg-text', '04-streaming');
  await streaming.evaluate((n) => {
    (window as any).__layoutBody = n;
  });
  events.push(event(4, source));
  await emit(page, 'event', events.at(-1));
  await partial(page, '');
  const durable = await measure('.msg[data-event-id="4"] .msg-text', '05-durable');
  expect(await durable.evaluate((n) => n === (window as any).__layoutBody)).toBe(true);
  await page.reload();
  await expect(page.locator('.msg[data-event-id="4"] .msg-text')).toContainText(
    'End of layout fixture.',
  );
  await measure('.msg[data-event-id="4"] .msg-text', '06-reloaded');
  await page.locator('#btn-menu').click();
  await page.locator('#btn-settings').click();
  await page.locator('#btn-theme').click();
  await page.locator('#btn-settings-close').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await measure('.msg[data-event-id="4"] .msg-text', '07-light');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await partial(page, source);
  await measure('#partial-msg .msg-text', '08-reduced-motion');
  await expect(page.locator('.msg[data-event-id="2"] .msg-text')).toHaveCSS(
    'white-space',
    'pre-wrap',
  );
  await expect(page.locator('.msg[data-event-id="2"] .msg-text')).toHaveText(raw, {
    useInnerText: true,
  });
  expect(errors).toEqual([]);
});

test('LobeHub code blocks have no inline copy button or reserved toolbar space', async ({
  page,
}, info) => {
  const source =
    '影片轉向量流程：\n\n```text\n整支影片\n  ↓ 每 20 秒切一段\n43 個片段\n  ↓ 每段抽取畫面\n768 維向量\n```\n';
  const { errors, events } = await setup(page, [
    event(1, source),
    event(2, source, 'assistant', 'thinking'),
  ]);
  const check = async (selector: string) => {
    const body = page.locator(selector);
    await expect(body.locator('pre code')).toContainText('768 維向量');
    await expect(body.locator('.lobe-code-copy')).toHaveCount(0);
    await expect(body.locator('.lobe-code button')).toHaveCount(0);
    expect(
      await body.locator('pre').evaluate((el) => parseFloat(getComputedStyle(el).paddingTop)),
    ).toBeLessThan(44);
  };
  await check('.msg[data-event-id="1"] .msg-text');
  await check('[data-event-id="2"] .event-body');
  await partial(page, source, source);
  await check('#partial-msg .msg-text');
  await check('#partial-thinking .event-body');
  events.push(event(3, source));
  await emit(page, 'event', events.at(-1));
  await partial(page, '');
  await check('.msg[data-event-id="3"] .msg-text');
  await page.reload();
  await check('.msg[data-event-id="3"] .msg-text');
  await page.locator('.msg[data-event-id="3"] pre').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('code-without-copy.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await partial(page, source);
  await check('#partial-msg .msg-text');
  expect(errors).toEqual([]);
});

test('LobeHub history and reduced motion are readable without animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { errors } = await setup(page, [event(1, prose + rich)]);
  await expect(page.locator('.msg[data-event-id="1"] .msg-text')).toContainText(prose);
  await partial(page, prose + rich);
  await expect(page.locator('#partial-msg .msg-text')).toContainText(prose);
  expect(
    await page
      .locator('.msg-text')
      .evaluateAll((nodes) => nodes.flatMap((n) => n.getAnimations({ subtree: true })).length),
  ).toBe(0);
  expect(errors).toEqual([]);
});

test('LobeHub rich surfaces retain table scrolling media math syntax and copy controls', async ({
  page,
}) => {
  const { errors } = await setup(page);
  await page.addInitScript(() => {
    (window as any).__copied = '';
  });
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copied = text;
        },
      },
    }),
  );
  await partial(page, prose + rich + '\n\n```mermaid\ngraph LR\nA --> B\n```\n');
  await expect(page.locator('#partial-msg .table-wrap table')).toBeVisible();
  await expect(page.locator('#partial-msg .katex')).toHaveCount(1);
  await expect(page.locator('#partial-msg pre code.hljs')).toHaveCount(1);
  await expect(page.locator('#partial-msg .mermaid-chart svg')).toHaveCount(1);
  await page.locator('#partial-msg pre code.hljs').click();
  expect(await page.evaluate(() => (window as any).__copied)).toContain('const answer = 42;');
  await page.locator('#partial-msg img').click();
  await expect(page.locator('#lightbox')).toBeVisible();
  await page.locator('#lb-close').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('LobeHub fading controls cannot receive focus until the upstream fade finishes', async ({
  page,
}) => {
  const { errors } = await setup(page);
  await partial(page, '[暫時還在淡入的連結](https://example.com)');
  const link = page.locator('#partial-msg a');
  await expect(link).toHaveCount(1);
  const initial = await link.evaluate((n) => ({
    inert: n.inert,
    animated: n.getAnimations({ subtree: true }).some((a) => a.playState !== 'finished'),
  }));
  expect(initial.animated).toBe(true);
  expect(initial.inert).toBe(true);
  await expect.poll(() => link.evaluate((n) => n.inert)).toBe(false);
  await link.focus();
  await expect(link).toBeFocused();
  expect(errors).toEqual([]);
});

test.describe('desktop selection', () => {
  test.use({ isMobile: false, hasTouch: false });
  test('LobeHub finished characters remain natively selectable without needing another packet', async ({
    page,
  }) => {
    const { errors } = await setup(page);
    const source = '中文 e\u0301 👨‍👩‍👧‍👦 🙂';
    await partial(page, source);
    await expect(page.locator('#partial-msg p')).toHaveText(source);
    await expect
      .poll(() =>
        page
          .locator('#partial-msg .msg-text')
          .evaluate(
            (n) =>
              n
                .getAnimations({ subtree: true })
                .filter(
                  (a) =>
                    (a as CSSAnimation).animationName === 'streamdown-fade-in' &&
                    a.playState === 'running',
                ).length,
          ),
      )
      .toBe(0);
    expect(
      await page
        .locator('#partial-msg .stream-char')
        .evaluateAll((nodes) => nodes.every((n) => getComputedStyle(n).userSelect !== 'none')),
    ).toBe(true);
    const selected = await page.locator('#partial-msg p').evaluate((n) => {
      const range = document.createRange();
      range.selectNodeContents(n);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    expect(selected).toBe(source);
    expect(errors).toEqual([]);
  });
});

test('LobeHub completed surfaces do not replay their native fade at EOF', async ({
  page,
}, info) => {
  await setup(page);
  await partial(page, prose + rich);
  await expect(page.locator('#partial-msg img')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('#partial-msg .msg-text')
        .evaluate(
          (body) =>
            body
              .getAnimations({ subtree: true })
              .filter(
                (a) =>
                  (a as CSSAnimation).animationName === 'streamdown-fade-in' &&
                  a.playState === 'running',
              ).length,
        ),
    )
    .toBe(0);
  await page.evaluate(() => {
    (window as any).__eofBody = document.querySelector('#partial-msg .msg-text');
  });
  await page.evaluate(
    (e) => {
      const w = window as any;
      w.__eofSamples = [];
      const sample = () => {
        const body = w.__eofBody;
        w.__eofSamples.push({
          time: performance.now(),
          animations: body
            .getAnimations({ subtree: true })
            .filter(
              (a: CSSAnimation) =>
                a.animationName === 'streamdown-fade-in' && a.playState === 'running',
            ).length,
        });
        if (w.__eofSamples.length < 25) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      w.__lobeEmit('event', e);
      w.__lobeEmit('partial', { text: '' });
    },
    event(7, prose + rich),
  );
  await expect.poll(() => page.evaluate(() => (window as any).__eofSamples.length)).toBe(25);
  const result = await page.evaluate(() => ({
    samples: (window as any).__eofSamples,
    pencil: document.elementFromPoint(370, 385)?.outerHTML,
  }));
  await writeFile(info.outputPath('eof-fades.json'), JSON.stringify(result, null, 2));
  expect(Math.max(...result.samples.map((s: any) => s.animations))).toBe(0);
});

test('LobeHub source revision and cancellation cannot resurrect detached output', async ({
  page,
}) => {
  const { errors } = await setup(page);
  await partial(page, '先前的文字'.repeat(12));
  await expect(page.locator('#partial-msg .streamdown-animated')).toHaveCount(1);
  await partial(page, '修訂後的文字。');
  await expect(page.locator('#partial-msg .msg-text')).toHaveText('修訂後的文字。');
  await partial(page, '');
  await expect(page.locator('#partial-msg')).toHaveCount(0);
  await partial(page, '下一輪🙂');
  await expect(page.locator('#partial-msg .msg-text')).toHaveText('下一輪🙂');
  expect(errors).toEqual([]);
});

test('LobeHub continuous video uses real Send dark light upstream streaming final and history', async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const { errors, events } = await setup(page);
  await page.screenshot({ path: info.outputPath('01-launch.png') });
  const samples: unknown[] = [];
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') {
      await page.locator('#btn-menu').click();
      await page.locator('#btn-settings').click();
      await page.locator('#btn-theme').click();
      await page.locator('#btn-settings-close').click();
    }
    await page.locator('#input').fill(`${theme}：使用 LobeHub 原生效果`);
    const hit = await page.locator('#btn-send').evaluate((n) => {
      const r = n.getBoundingClientRect(),
        h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { width: r.width, height: r.height, receives: h === n || n.contains(h) };
    });
    expect(hit.receives).toBe(true);
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    await page.locator('#btn-send').click();
    await expect(page.locator('#messages')).not.toHaveAttribute(
      'data-prompt-motion',
      /waiting|moving/,
    );
    await emit(page, 'event', events.at(-1));
    const id = events.at(-1)!.id + 1;
    // Timers are independent of screenshots, assertions and polling.
    await page.evaluate(
      ({ prose, rich, id }) => {
        const host = window as any;
        host.__lobeSamples = [];
        host.__lobeRecording = true;
        const collect = (time: number) => {
          const body =
            document.querySelector('#partial-msg .msg-text') ||
            document.querySelector(`.msg[data-event-id="${id}"] .msg-text`);
          const p = body?.querySelector('p'),
            root = document.getElementById('messages')!;
          host.__lobeSamples.push({
            time,
            text: p?.textContent,
            scrollTop: root.scrollTop,
            relativeY: p ? p.getBoundingClientRect().top - root.getBoundingClientRect().top : null,
            characters: body?.querySelectorAll('.stream-char').length,
            animations: body
              ?.getAnimations({ subtree: true })
              .filter(
                (a) =>
                  (a as CSSAnimation).animationName === 'streamdown-fade-in' &&
                  a.playState === 'running',
              ).length,
            overflow: document.documentElement.scrollWidth > innerWidth,
            error: !!document.querySelector('.notice:not(:empty), .msg-error, .event.error'),
          });
          if (host.__lobeRecording) requestAnimationFrame(collect);
        };
        requestAnimationFrame(collect);
        host.__lobeEmit('busy', { busy: true });
        for (let i = 1; i <= 10; i++)
          setTimeout(
            () =>
              host.__lobeEmit('partial', {
                content: prose.slice(0, Math.ceil((prose.length * i) / 10)),
                thinking: '',
              }),
            (i - 1) * 200,
          );
        setTimeout(() => host.__lobeEmit('partial', { content: prose + rich, thinking: '' }), 2300);
        setTimeout(() => {
          host.__lobeEmit('event', {
            id,
            kind: 'message',
            role: 'assistant',
            content: prose + rich,
            files: [],
            createdAt: '2026-10-06T12:00:00Z',
          });
          host.__lobeEmit('partial', { content: '', thinking: '' });
          host.__lobeEmit('busy', { busy: false });
        }, 4100);
      },
      { prose, rich, id },
    );
    await expect(page.locator('#partial-msg .streamdown-animated')).toHaveCount(1);
    await expect(page.locator('#partial-msg p').first()).toContainText('LobeHub');
    await page.screenshot({ path: info.outputPath(`${theme}-02-streaming.png`) });
    await expect(page.locator('#partial-msg .table-wrap')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`${theme}-03-rich.png`) });
    await expect(page.locator(`.msg[data-event-id="${id}"] .msg-text`)).toContainText('公式：');
    await page.screenshot({ path: info.outputPath(`${theme}-04-final.png`) });
    samples.push(
      await page.evaluate((theme) => {
        const h = window as any;
        h.__lobeRecording = false;
        return { theme, samples: h.__lobeSamples };
      }, theme),
    );
    events.push(event(id, prose + rich));
    await page.locator(`.msg[data-event-id="${id}"] img`).click();
    await expect(page.locator('#lightbox')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${theme}-05-image-viewer.png`) });
    await page.locator('#lb-close').click();
    await expect(page.locator('#input')).toBeEnabled();
  }
  await page.reload();
  await expect(page.locator(`.msg[data-event-id="${events.at(-1)!.id}"] .msg-text`)).toContainText(
    prose,
  );
  expect(await page.locator('.msg-text .stream-char').count()).toBe(0);
  await page.screenshot({ path: info.outputPath('05-static-history.png') });
  await writeFile(info.outputPath('samples.json'), JSON.stringify({ samples, errors }, null, 2));
  expect(errors).toEqual([]);
});

test('LobeHub keeps NT$ currency tables as tables in history and streaming', async ({
  page,
}, info) => {
  const table = (name: string) =>
    `### ${name}\n\n| 型號 | 美國售價 (USD) | 台灣售價 (NT$) | 匯率換算 (NT$) | 差價 |\n|---|---|---|---|---|\n| **${name} A** | ~$2,600 | 139,900 | ~82,000 | 台灣貴 5.8 萬 |\n| **${name} B** | **$4,999** | 約 16 萬 | ~157,000 | 相近 |`;
  const source = `三、完整價格對比表（USD vs NT$）\n\n${table('筆電')}\n\n${table('桌上型')}\n\nEnd of currency fixture.`;
  const { errors } = await setup(page, [event(60, source)]);
  const history = page
    .locator('.msg-text:not(#partial-msg .msg-text)')
    .filter({ hasText: 'End of currency fixture.' });
  await expect(history.locator('table')).toHaveCount(2);
  await expect(history.locator('.katex')).toHaveCount(0);
  await expect(history.locator('th').nth(3)).toHaveText('匯率換算 (NT$)');
  await expect(history).not.toContainText('| 型號 |');
  await expect(history).not.toContainText('\\');
  await expect(history.locator('td').nth(1)).toHaveText('~$2,600');

  await partial(page, source);
  const live = page.locator('#partial-msg .msg-text');
  await expect(live.locator('table')).toHaveCount(2, { timeout: 15000 });
  await expect(live.locator('.katex')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
  await history.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('currency-tables.png') });
  expect(errors).toEqual([]);
});

test('LobeHub keeps streaming text after an image marker and inserts the image without replay', async ({
  page,
}, info) => {
  const { errors, events } = await setup(page);
  const before = '第一段文字，在圖片之前。';
  const after = '圖片之後的文字也要邊串流邊顯示。';
  await partial(page, `${before}\n\n[[image: /home/u/.pi-outbox/lobe.png]]\n\n`);
  await expect(page.locator('#partial-msg .msg-text')).toContainText(before);
  await page.evaluate(() => {
    const w = window as any;
    w.__imgBody = document.querySelector('#partial-msg .msg-text');
    w.__imgFirst = w.__imgBody.querySelector('p');
  });
  // An unfinished marker at the tail stays hidden, not printed as raw text.
  await partial(page, `${before}\n\n[[image: /home/u/.pi-outbox/lobe.png]]\n\n${after}\n\n[[ima`);
  const live = page.locator('#partial-msg .msg-text');
  await expect(live).toContainText(after);
  await expect(live).not.toContainText('[[');
  await expect(live).not.toContainText('pi-outbox');
  await page.screenshot({ path: info.outputPath('streaming-after-image.png') });
  // The last partial is the whole reply, still naming the local file.
  await partial(page, `${before}\n\n[[image: /home/u/.pi-outbox/lobe.png]]\n\n${after}`);
  await page.waitForTimeout(1500);

  events.push(event(70, `${before}\n\n[[image: /media/lobe.svg]]\n\n${after}`));
  await emit(page, 'event', events.at(-1));
  await partial(page, '');
  const body = page.locator('.msg[data-event-id="70"] .msg-text');
  // Sampled right at publication: only the new image may animate, not text.
  const running = await body.evaluate((n) =>
    n
      .getAnimations({ subtree: true })
      .filter(
        (a) =>
          (a as CSSAnimation).animationName === 'streamdown-fade-in' &&
          a.playState === 'running' &&
          !!((a.effect as KeyframeEffect).target as Element).textContent?.trim(),
      )
      .map((a) => ((a.effect as KeyframeEffect).target as Element).textContent),
  );
  await expect(body.locator('img.msg-inline-img')).toHaveCount(1);
  await expect(body).toContainText(after);
  // Same island and paragraph nodes: the image slots in; already-read text
  // is neither remounted nor faded in a second time.
  expect(
    await body.evaluate((n) => {
      const w = window as any;
      return n === w.__imgBody && n.querySelector('p') === w.__imgFirst;
    }),
  ).toBe(true);
  expect(running).toEqual([]);
  await expect
    .poll(() => body.evaluate((n) => (n.querySelector('img') as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('final-with-image.png') });
  expect(errors).toEqual([]);
});
