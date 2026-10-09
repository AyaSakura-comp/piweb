import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from 'playwright/test';
import { embedOutboxMediaUrls, parseOutboxMarkers } from '../../src/agent/outbox.js';

type ReplyEvent = {
  id: number;
  kind: string;
  role: string;
  content: string;
  createdAt: string;
  files: never[];
};

async function setup(page: Page, history: ReplyEvent[] = [], autoScroll?: boolean) {
  const events = [...history];
  const session = {
    jid: 'web:render-reveal',
    name: '漸層顯示測試',
    kind: 'standard',
    deleted: false,
    busy: false,
    model: '',
    provider: '',
    lastReplyId: 0,
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((autoScroll) => {
    localStorage.setItem('piweb.mode', 'sessions');
    if (autoScroll !== undefined) localStorage.setItem('piweb.autoScroll', String(autoScroll));
    const host = window as any;
    class Stream extends EventTarget {
      closed = false;
      constructor(public url: string) {
        super();
        host.__replyStream = this;
      }
      close() {
        this.closed = true;
      }
    }
    host.EventSource = Stream;
    host.__emitReply = (type: string, data: unknown) => {
      const stream = host.__replyStream;
      if (!stream || stream.closed) throw new Error('No live fixture stream');
      stream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    };
  }, autoScroll);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({
        json: {
          events,
          session,
          busy: session.busy,
          partial: null,
          hasMoreOlder: false,
          hasMoreNewer: false,
        },
      });
    if (path.endsWith('/messages')) {
      const content = route.request().postDataJSON().text;
      const event = replyEvent(events.length + 1, content, 'user');
      events.push(event);
      return route.fulfill({ json: { ok: true, eventId: event.id } });
    }
    return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await expect.poll(() => page.evaluate(() => !!(window as any).__replyStream)).toBe(true);
  return { events, errors, session };
}

async function keyboardBoundary(page: Page) {
  await page.addInitScript(() => {
    const host = window as any;
    const viewport = Object.assign(new EventTarget(), {
      height: innerHeight,
      width: innerWidth,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport });
    host.__keyboardReports = [];
    host.__setKeyboard = (height: number, top = 0) => {
      viewport.height = height;
      viewport.offsetTop = top;
      host.__keyboardReports.push({ time: performance.now(), height, top });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    };
  });
}

async function startPromptMotionSamples(page: Page) {
  await page.evaluate(() => {
    const host = window as any;
    host.__promptMotionSamples = [];
    host.__recordPromptMotion = true;
    const loop = (time: number) => {
      const root = document.getElementById('messages')!;
      host.__promptMotionSamples.push({
        time,
        top: root.scrollTop,
        phase: root.dataset.promptMotion,
        height: root.clientHeight,
      });
      if (host.__recordPromptMotion) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

async function finishPromptMotionSamples(page: Page) {
  return page.evaluate(() => {
    const host = window as any;
    host.__recordPromptMotion = false;
    return { samples: host.__promptMotionSamples, keyboard: host.__keyboardReports || [] };
  });
}

function replyEvent(id: number, content: string, role = 'assistant', kind = 'message'): ReplyEvent {
  return { id, kind, role, content, createdAt: '2026-10-03T00:00:00Z', files: [] };
}

async function emit(page: Page, type: string, data: unknown) {
  await page.evaluate(({ type, data }) => (window as any).__emitReply(type, data), { type, data });
}

async function partial(page: Page, content: string, thinking = '') {
  await emit(page, 'partial', { content, thinking });
}

async function ready(page: Page) {
  await expect(
    page.locator('.reply-chunk[data-reveal="pending"], .reply-chunk[data-reveal="revealing"]'),
    // Adaptive slow streams may take longer than the old fixed-speed 5s budget.
  ).toHaveCount(0, { timeout: 10_000 });
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(name) });
}

async function recordSamples(info: TestInfo, name: string, samples: unknown) {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(samples, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}

test('reading-order masks advance left to right on wrapped text before the next row', async ({
  page,
}, info) => {
  const { errors } = await setup(page);
  const source = '## 逐行漸層\n\n' + '讀'.repeat(92) + '\n\n';
  await partial(page, source);
  const chunk = page.locator('#partial-msg .reply-chunk');
  await expect(chunk).toHaveAttribute('data-reveal-mode', 'rows');
  const samples = await chunk.evaluate(async (node) => {
    const original = node.querySelector('p')!.firstChild;
    const samples = [];
    for (let i = 0; i < 75; i++) {
      await new Promise(requestAnimationFrame);
      const el = node as HTMLElement;
      const css = getComputedStyle(el);
      samples.push({
        mode: el.dataset.revealMode,
        row: Number(el.dataset.revealRow),
        x: Number.parseFloat(el.style.getPropertyValue('--reply-row-front')),
        top: Number.parseFloat(el.style.getPropertyValue('--reply-row-top')),
        height: Number.parseFloat(el.style.getPropertyValue('--reply-row-height')),
        mask: css.maskImage,
        size: css.maskSize,
        animation: css.animationName,
        opacity: css.opacity,
        sameNode: node.querySelector('p')!.firstChild === original,
      });
    }
    return samples;
  });
  const scans = samples.filter(
    (s, i) =>
      i > 0 &&
      s.mode === 'rows' &&
      samples[i - 1].mode === 'rows' &&
      s.row === samples[i - 1].row &&
      s.x > samples[i - 1].x,
  );
  expect(scans.length).toBeGreaterThan(8);
  expect(
    scans.every(
      (s) => s.mask.includes('90deg') && s.animation === 'none' && s.opacity === '1' && s.sameNode,
    ),
  ).toBe(true);
  expect(
    samples
      .filter((s) => s.mode === 'rows')
      .every((s, i, all) => i === 0 || s.row >= all[i - 1].row),
  ).toBe(true);
  expect(new Set(scans.map((s) => s.row)).size).toBeGreaterThan(1);
  await recordSamples(info, 'reading-order-row-samples', samples);
  await shot(page, info, 'rows-scan.png');
  await ready(page);
  await expect(chunk).toHaveCSS('mask-image', 'none');
  expect(errors).toEqual([]);
});

test('reading-order pixels show the left glyphs while right and following rows stay hidden', async ({
  page,
}, info) => {
  const { errors } = await setup(page);
  await partial(page, '讀'.repeat(120) + '\n\n');
  const chunk = page.locator('#partial-msg .reply-chunk');
  await expect(chunk).toHaveAttribute('data-reveal-mode', 'rows');
  await chunk.evaluate(async (node) => {
    const el = node as HTMLElement;
    for (let i = 0; i < 60; i++) {
      await new Promise(requestAnimationFrame);
      const x = Number.parseFloat(el.style.getPropertyValue('--reply-row-front'));
      if (Number(el.dataset.revealRow) === 0 && x >= 80 && x <= 160) return;
    }
    throw new Error('Did not capture the first row mid-scan');
  });
  const buffer = await chunk
    .locator('p')
    .screenshot({ path: info.outputPath('rows-left-visible-right-hidden.png') });
  const pixels = await page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const base = [data[0], data[1], data[2]];
      const contrast = (x0: number, x1: number, y0: number, y1: number) => {
        let maximum = 0;
        for (let y = y0; y < Math.min(y1, bitmap.height); y++)
          for (let x = x0; x < x1; x++) {
            const offset = (y * bitmap.width + x) * 4;
            for (let c = 0; c < 3; c++)
              maximum = Math.max(maximum, Math.abs(data[offset + c] - base[c]));
          }
        return maximum;
      };
      const result = {
        left: contrast(0, 60, 0, 20),
        right: contrast(Math.floor(bitmap.width * 0.9), bitmap.width, 0, 20),
        next: contrast(0, bitmap.width, 26, 44),
      };
      bitmap.close();
      return result;
    },
    [...buffer],
  );
  expect(pixels.left).toBeGreaterThan(90);
  expect(pixels.right).toBeLessThan(4);
  expect(pixels.next).toBeLessThan(4);
  await recordSamples(info, 'reading-order-pixel-contrast', pixels);
  expect(errors).toEqual([]);
});

test('reading-order reflow releases already-started text instead of remasking read glyphs', async ({
  page,
}) => {
  const { errors } = await setup(page);
  await partial(
    page,
    '## 已讀內容不再變暗\n\n' +
      '這段文字在變窄之後重新換行，已經讀到的位置仍保持清楚。'.repeat(30) +
      '\n\n',
  );
  const flow = page.locator('#partial-msg .reply-flow');
  const chunk = flow.locator('.reply-chunk');
  await expect(chunk).toHaveAttribute('data-reveal-mode', 'rows');
  await expect
    .poll(() =>
      flow.evaluate((node) => Number.parseFloat(node.style.getPropertyValue('--reply-front'))),
    )
    .toBeGreaterThan(0);
  const previous = await flow.evaluate((node) => {
    (window as any).__rowReflowHeading = node.querySelector('h2');
    return Number.parseFloat(node.style.getPropertyValue('--reply-front'));
  });
  await page.setViewportSize({ width: 280, height: 844 });
  await expect(chunk).toHaveAttribute('data-reveal', 'ready');
  await expect(chunk).toHaveCSS('mask-image', 'none');
  expect(
    await flow.evaluate((node) => node.querySelector('h2') === (window as any).__rowReflowHeading),
  ).toBe(true);
  expect(
    await flow.evaluate((node) => Number.parseFloat(node.style.getPropertyValue('--reply-front'))),
  ).toBeGreaterThanOrEqual(previous);
  expect(errors).toEqual([]);
});

test('unfinished slow text lowers velocity before another Markdown block is ready', async ({
  page,
}) => {
  const { errors } = await setup(page);
  const seed =
    '## 已排版緩衝\n\n' + '這段已經完成排版，後續尚未結束的文字也會影響速度。'.repeat(9) + '\n\n';
  await partial(page, seed);
  const flow = page.locator('#partial-msg .reply-flow');
  await expect(flow).toHaveAttribute('data-reveal', 'revealing');
  await page.evaluate(
    ({ seed }) => {
      const host = window as any;
      for (let index = 1; index <= 8; index++) {
        setTimeout(
          () =>
            host.__emitReply('partial', {
              content: seed + '還在寫。'.repeat(index),
              thinking: '',
            }),
          index * 200,
        );
      }
    },
    { seed },
  );
  await expect
    .poll(() => flow.evaluate((node) => Number(node.style.getPropertyValue('--reply-speed'))), {
      timeout: 2500,
    })
    .toBeLessThan(80);
  await expect(flow.locator('.reply-chunk')).toHaveCount(1);
  await expect(flow).toHaveAttribute('data-reveal', 'revealing');
  await partial(page, '');
  expect(errors).toEqual([]);
});

test('a slow learned pace survives an idle frontier without a 120px/s restart', async ({
  page,
}) => {
  const { errors } = await setup(page);
  const seed = '## 先讀這段\n\n' + '這一段已完成排版。'.repeat(2) + '\n\n';
  await partial(page, seed);
  await page.evaluate(
    ({ seed }) => {
      const host = window as any;
      for (let i = 1; i <= 8; i++)
        setTimeout(
          () =>
            host.__emitReply('partial', {
              content: seed + '還在寫。'.repeat(i),
              thinking: '',
            }),
          i * 200,
        );
    },
    { seed },
  );
  const flow = page.locator('#partial-msg .reply-flow');
  await expect
    .poll(() => flow.evaluate((node) => Number(node.style.getPropertyValue('--reply-speed'))))
    .toBeLessThan(60);
  await ready(page);
  const previous = await flow.evaluate((node) =>
    Number(node.style.getPropertyValue('--reply-speed')),
  );
  await partial(page, seed + '還在寫。'.repeat(8) + '結束。\n\n');
  const resumed = await flow.evaluate(async (node) => {
    for (let i = 0; i < 30; i++) {
      await new Promise(requestAnimationFrame);
      if (
        node.querySelector('.reply-chunk:last-child')!.getAttribute('data-reveal') === 'revealing'
      )
        return Number(node.style.getPropertyValue('--reply-speed'));
    }
    throw new Error('Continuation never entered reveal');
  });
  expect(resumed).toBeLessThan(previous + 25);
  await ready(page);
  expect(errors).toEqual([]);
});

test('adaptive shared front walkthrough follows slow fast slow fast arrivals', async ({
  page,
}, info) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const { events, errors, session } = await setup(page);
  await page.locator('#input').fill('請讓每排文字從左到右，以漸層接著顯示下一排。');
  const reachable = await page.locator('#btn-send').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return node.contains(
      document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
    );
  });
  expect(reachable).toBe(true);
  await page.locator('#btn-send').click();
  await expect.poll(() => events.length).toBe(1);
  await emit(page, 'event', events[0]);
  session.busy = true;
  await emit(page, 'busy', { busy: true });
  await shot(page, info, 'adaptive-01-sent.png');

  const seed =
    '## 速度跟著串流，逐行向右\n\n' +
    '每一行從左到右，用柔和的漸層帶出文字，再接著顯示下一行。字的位置與排版不變，已經讀過的內容不會重播。\n\n';
  const phases = [
    {
      name: 'slow',
      duration: 2200,
      steps: 11,
      text: '慢速串流時，前緣會放慢，讓準備好的文字留一點緩衝，而不是立刻衝到最下面再停住。\n\n',
    },
    {
      name: 'fast',
      duration: 1800,
      steps: 12,
      text:
        '串流變快時，前緣會平滑加速。\n\n'.repeat(6) +
        '速度不是突然跳到另一個數字，也不是每個段落各自重播動畫。\n\n',
    },
    {
      name: 'slower',
      duration: 2600,
      steps: 13,
      text: '後續文字又變慢，動畫也會降速。同一道前緣持續往下，不會把已經清楚的內容再次變暗。\n\n',
    },
    {
      name: 'faster',
      duration: 1800,
      steps: 12,
      text:
        '文字再次加快，前緣也能重新加速。\n\n'.repeat(5) +
        '完成後可以繼續輸入，重新開啟則顯示靜態歷史。\n\n',
    },
  ];
  const content = seed + phases.map((phase) => phase.text).join('') + '完成。';
  const final = replyEvent(2, content);
  await page.exposeFunction('__persistAdaptiveFinal', () => {
    events.push(final);
    session.busy = false;
  });
  await page.evaluate(
    ({ seed, phases, final }) => {
      const host = window as any;
      host.__adaptiveSamples = [];
      host.__adaptiveDone = false;
      const start = performance.now();
      let prefix = seed;
      let offset = 0;
      host.__emitReply('partial', { content: seed, thinking: '' });
      for (const phase of phases) {
        const before = prefix;
        for (let i = 1; i <= phase.steps; i++) {
          const text =
            before + phase.text.slice(0, Math.ceil((phase.text.length * i) / phase.steps));
          setTimeout(
            () => host.__emitReply('partial', { content: text, thinking: '' }),
            offset + (phase.duration * i) / phase.steps,
          );
        }
        prefix += phase.text;
        offset += phase.duration;
      }
      setTimeout(async () => {
        await host.__persistAdaptiveFinal();
        host.__emitReply('event', final);
        host.__emitReply('partial', { content: '', thinking: '' });
        host.__emitReply('busy', { busy: false });
        host.__adaptiveDone = true;
      }, offset + 300);
      const capture = () => {
        const elapsed = performance.now() - start;
        const node = document.querySelector(
          '.msg:not(.msg-user) .reply-flow',
        ) as HTMLElement | null;
        if (node)
          host.__adaptiveSamples.push({
            time: elapsed,
            speed: Number(node.style.getPropertyValue('--reply-speed')),
            front: Number.parseFloat(node.style.getPropertyValue('--reply-front')),
            active: node.dataset.reveal === 'revealing',
            chunks: node.querySelectorAll('.reply-chunk').length,
          });
        if (elapsed < offset + 400) requestAnimationFrame(capture);
        else host.__adaptiveSamplingDone = true;
      };
      requestAnimationFrame(capture);
    },
    { seed, phases, final },
  );

  const flow = page.locator('.msg:not(.msg-user) .reply-flow');
  await expect(flow).toHaveCount(1);
  await expect(flow).toHaveAttribute('data-reveal', 'revealing');
  await flow.evaluate((node) => ((window as any).__adaptiveFlow = node));
  // Milestone capture only: the transport and sampler keep their own clocks.
  for (const [at, name] of [
    [1800, 'adaptive-02-slow.png'],
    [3700, 'adaptive-03-fast.png'],
    [6200, 'adaptive-04-slower.png'],
    [8100, 'adaptive-05-faster.png'],
  ] as const) {
    await expect
      .poll(() => page.evaluate(() => (window as any).__adaptiveSamples.at(-1)?.time ?? 0), {
        timeout: 5000,
      })
      .toBeGreaterThan(at);
    await shot(page, info, name);
  }
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__adaptiveSamplingDone), { timeout: 12_000 })
    .toBe(true);
  const samples = await page.evaluate(
    () =>
      (window as any).__adaptiveSamples as {
        time: number;
        speed: number;
        front: number;
        active: boolean;
        chunks: number;
      }[],
  );
  expect(samples.every((sample, i) => i === 0 || sample.front >= samples[i - 1].front)).toBe(true);
  const average = (start: number, end: number) => {
    const window = samples.filter(
      (sample) => sample.active && sample.time >= start && sample.time <= end,
    );
    expect(window.length).toBeGreaterThan(5);
    return window.reduce((sum, sample) => sum + sample.speed, 0) / window.length;
  };
  const slow = average(1200, 2000);
  const fast = average(3300, 3900);
  const slower = average(5800, 6500);
  const faster = average(7700, 8300);
  expect(fast).toBeGreaterThan(slow * 1.3);
  expect(slower).toBeLessThan(fast * 0.85);
  expect(faster).toBeGreaterThan(slower * 1.3);
  await recordSamples(info, 'adaptive-front-samples', { slow, fast, slower, faster, samples });
  await expect(page.locator('#partial-msg')).toHaveCount(0);
  expect(await flow.evaluate((node) => node === (window as any).__adaptiveFlow)).toBe(true);
  await ready(page);
  await expect(flow).toContainText('完成。');
  await expect(page.locator('.grow-tail, .ink')).toHaveCount(0);
  await shot(page, info, 'adaptive-06-final.png');
  await page.locator('#input').fill('速度會自動適應，現在也能繼續輸入。');
  await expect(page.locator('#input')).toHaveValue('速度會自動適應，現在也能繼續輸入。');
  await shot(page, info, 'adaptive-07-composer.png');
  await page.reload();
  await expect(page.locator('.msg:not(.msg-user) h2')).toHaveText('速度跟著串流，逐行向右');
  await expect(page.locator('.reply-flow, .reply-chunk')).toHaveCount(0);
  await shot(page, info, 'adaptive-08-history.png');
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('one continuous shared front walkthrough joins new content without restarting', async ({
  page,
}, info) => {
  const { events, errors, session } = await setup(page);
  await page.locator('#input').fill('請用同一道漸層，連續顯示排版好的回答。');
  await page.locator('#btn-send').click();
  await expect.poll(() => events.length).toBe(1);
  await emit(page, 'event', events[0]);
  session.busy = true;
  await emit(page, 'busy', { busy: true });
  await shot(page, info, 'continuous-01-sent.png');

  const first =
    '## 同一道漸層，連續往下\n\n' +
    '先完成排版，再讓文字從柔和的前緣逐漸變清楚。**文字留在原位**，不會一塊一塊重新淡入。\n\n' +
    '後面準備好的內容會接上同一道前緣。已經讀過的段落保持清楚，不會再次變暗。\n\n';
  const second = first + '```typescript\nconst front = "持續往下";\nconsole.log(front);\n```\n\n';
  const third = second + '段落與程式碼共用同一個位置，不因收到新內容而從零開始。\n\n';
  const content =
    third +
    '- 先排版，再顯示\n- 新內容接上同一道前緣\n- 完成回覆也不重播\n\n完成，現在可以繼續輸入。';
  const final = replyEvent(2, content);
  events.push(final);
  // Arrival cadence is transport-only and runs independently of screenshots,
  // assertions and readiness. No wait-until-ready pauses between paragraphs.
  await page.evaluate(
    ({ first, second, third, final }) => {
      const host = window as any;
      host.__emitReply('partial', { content: first + '**尚未完成', thinking: '' });
      setTimeout(() => host.__emitReply('partial', { content: second, thinking: '' }), 180);
      setTimeout(() => host.__emitReply('partial', { content: third, thinking: '' }), 360);
      setTimeout(() => {
        host.__emitReply('event', final);
        host.__emitReply('partial', { content: '', thinking: '' });
        host.__emitReply('busy', { busy: false });
      }, 540);
    },
    { first, second, third, final },
  );

  const flow = page.locator('.msg:not(.msg-user) .msg-text.reply-flow');
  await expect(flow).toHaveCount(1);
  await expect(flow).toHaveAttribute('data-reveal', 'revealing');
  const firstFront = await flow.evaluate((node) => {
    const host = window as any;
    host.__sharedFlow = node;
    host.__sharedHeading = node.querySelector('h2');
    return parseFloat(node.style.getPropertyValue('--reply-front'));
  });
  await expect(page.locator('.reply-chunk').first()).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.reply-chunk').first()).toHaveCSS('opacity', '1');
  await shot(page, info, 'continuous-02-shared-gradient.png');
  await expect(page.locator('#partial-msg')).toHaveCount(0);
  session.busy = false;
  await expect(page.locator('.msg:not(.msg-user) li')).toHaveCount(3);
  expect(await flow.evaluate((node) => node === (window as any).__sharedFlow)).toBe(true);
  expect(
    await flow.locator('h2').evaluate((node) => node === (window as any).__sharedHeading),
  ).toBe(true);
  expect(
    await flow.evaluate((node) => parseFloat(node.style.getPropertyValue('--reply-front'))),
  ).toBeGreaterThanOrEqual(firstFront);

  const samples = await flow.evaluate(async (node) => {
    const samples = [];
    for (let i = 0; i < 90; i++) {
      await new Promise(requestAnimationFrame);
      const rect = node.querySelector('h2')!.getBoundingClientRect();
      samples.push({
        time: performance.now(),
        front: parseFloat(node.style.getPropertyValue('--reply-front')),
        y: rect.y,
        x: rect.x,
        width: rect.width,
        active: [...node.querySelectorAll('.reply-chunk[data-reveal="revealing"]')].map(
          (chunk) => ({
            top: parseFloat((chunk as HTMLElement).style.getPropertyValue('--chunk-top')),
            mode: (chunk as HTMLElement).dataset.revealMode,
            rowTop: parseFloat((chunk as HTMLElement).style.getPropertyValue('--reply-row-top')),
            rowHeight: parseFloat(
              (chunk as HTMLElement).style.getPropertyValue('--reply-row-height'),
            ),
            rowFront: parseFloat(
              (chunk as HTMLElement).style.getPropertyValue('--reply-row-front'),
            ),
            mask: getComputedStyle(chunk).maskImage,
            animation: getComputedStyle(chunk).animationName,
            opacity: getComputedStyle(chunk).opacity,
          }),
        ),
      });
    }
    return samples;
  });
  expect(samples.every((sample, i) => i === 0 || sample.front >= samples[i - 1].front)).toBe(true);
  expect(
    samples.filter((sample, i) => i > 0 && sample.front > samples[i - 1].front).length,
  ).toBeGreaterThan(8);
  expect(
    samples
      .flatMap((sample) => sample.active)
      .every(
        (chunk) =>
          chunk.animation === 'none' && chunk.opacity === '1' && Number.isFinite(chunk.top),
      ),
  ).toBe(true);
  for (const sample of samples) {
    for (const chunk of sample.active) {
      const stops = [...chunk.mask.matchAll(/\)\s(-?[\d.]+)px/g)].map((match) => Number(match[1]));
      if (chunk.mode === 'hidden') {
        expect(stops).toHaveLength(0);
        continue;
      }
      expect(stops).toHaveLength(2);
      if (chunk.mode === 'rows') {
        expect(chunk.mask).toContain('90deg');
        expect(Math.abs(stops[0] - chunk.rowFront)).toBeLessThan(0.05);
        expect(chunk.rowHeight).toBeGreaterThan(0);
      } else {
        expect(chunk.mode).toBe('media');
        expect(Math.abs(stops[0] + chunk.top + chunk.rowTop - sample.front)).toBeLessThan(0.05);
      }
      expect(Math.abs(stops[1] - stops[0] - 56)).toBeLessThan(0.05);
    }
  }
  expect(
    Math.max(...samples.map((sample) => sample.y)) - Math.min(...samples.map((sample) => sample.y)),
  ).toBeLessThan(0.2);
  await recordSamples(info, 'continuous-front-samples', samples);
  await shot(page, info, 'continuous-03-crossing-blocks.png');
  await ready(page);
  await expect(flow).toHaveAttribute('data-reveal', 'ready');
  await expect(flow.locator('.reply-chunk').first()).toHaveCSS('mask-image', 'none');
  await expect(flow.locator('h2')).toHaveText('同一道漸層，連續往下');
  await expect(page.locator('.grow-tail, .ink')).toHaveCount(0);
  await shot(page, info, 'continuous-04-complete.png');
  await page.locator('#input').fill('現在可以正常繼續輸入。');
  await expect(page.locator('#input')).toHaveValue('現在可以正常繼續輸入。');
  await shot(page, info, 'continuous-05-composer.png');
  await page.reload();
  await expect(page.locator('.msg:not(.msg-user) h2')).toHaveText('同一道漸層，連續往下');
  await expect(page.locator('.reply-flow, .reply-chunk')).toHaveCount(0);
  await shot(page, info, 'continuous-06-history.png');
  expect(errors).toEqual([]);
});

// Transport is deterministic, but every node, Markdown renderer, control and style
// comes from the production app. No replacement UI and no real agent conversation.
test('mobile ready blocks reveal in place and survive finalization without replay', async ({
  page,
}, info) => {
  const { events, errors, session } = await setup(page);
  await page.locator('#input').fill('請示範排版完成後，柔和地顯示回答。');
  await page.locator('#btn-send').click();
  await expect.poll(() => events.length).toBe(1);
  await emit(page, 'event', events[0]);
  // Send explicitly navigates the transcript. Measure the stationary reveal
  // after that navigation; the dedicated motion tests inspect the tween itself.
  await expect(page.locator('#messages')).toHaveAttribute('data-prompt-turn', 'active');
  await expect(page.locator('#messages')).not.toHaveAttribute('data-prompt-motion', /.+/);
  session.busy = true;
  await emit(page, 'busy', { busy: true });
  await shot(page, info, '01-request.png');

  const heading = '## 先排版，再柔和顯示\n\n';
  const paragraph =
    '文字保持原位，**不會先跳出 Markdown 原始符號**，也不會每次更新就重畫舊內容。\n\n';
  await partial(page, heading + '**尚未完成');
  await expect(page.locator('#partial-msg h2')).toHaveText('先排版，再柔和顯示');
  await expect(page.locator('#partial-msg .grow-tail, #partial-msg .ink')).toHaveCount(0);
  await expect(page.locator('#partial-msg')).not.toContainText('尚未完成');
  await expect(page.locator('#partial-msg')).not.toContainText('##');
  await expect(page.locator('#partial-msg')).toHaveCSS('transform', 'none');
  const chunk = page.locator('#partial-msg .reply-chunk').first();
  await expect(chunk).toHaveAttribute('data-reveal', 'revealing');
  await expect(chunk).toHaveCSS('animation-name', 'none');
  await expect(chunk).toHaveCSS('transform', 'none');
  await shot(page, info, '02-gradient-reveal.png');
  const mobileFrames = await chunk.evaluate(async (node) => {
    const samples = [];
    let previous = performance.now();
    for (let i = 0; i < 36; i++) {
      await new Promise(requestAnimationFrame);
      const heading = node.querySelector('h2')!.getBoundingClientRect();
      const now = performance.now();
      const style = getComputedStyle(node);
      samples.push({
        x: heading.x,
        y: heading.y,
        width: heading.width,
        gap: now - previous,
        mask: style.maskImage,
        opacity: style.opacity,
      });
      previous = now;
    }
    return samples;
  });
  expect(
    Math.max(...mobileFrames.map((frame) => frame.y)) -
      Math.min(...mobileFrames.map((frame) => frame.y)),
  ).toBeLessThan(0.2);
  expect(new Set(mobileFrames.map((frame) => frame.mask)).size).toBeGreaterThan(2);
  await recordSamples(info, 'mobile-reveal-frame-samples', mobileFrames);
  await ready(page);

  await page.evaluate(() => {
    const host = window as any;
    host.__firstHeading = document.querySelector('#partial-msg h2');
    host.__firstChunk = host.__firstHeading.closest('.reply-chunk');
    host.__firstOffset =
      host.__firstHeading.getBoundingClientRect().top -
      document.querySelector('#partial-msg .msg-text')!.getBoundingClientRect().top;
  });
  await partial(page, heading + paragraph);
  await expect(page.locator('#partial-msg strong')).toHaveText('不會先跳出 Markdown 原始符號');
  await ready(page);
  await shot(page, info, '03-formatted-paragraph.png');

  const code = '```typescript\nconst message = "已完成排版";\n\nconsole.log(message);\n';
  await partial(page, heading + paragraph + code);
  await expect(page.locator('#partial-msg pre')).toHaveCount(0);
  await expect(page.locator('#partial-msg')).not.toContainText('```');
  const closedCode = code + '```\n\n';
  await partial(page, heading + paragraph + closedCode);
  await expect(page.locator('#partial-msg pre code')).toContainText('console.log(message);');
  await expect(page.locator('#partial-msg pre code .hljs-keyword').first()).toHaveText('const');
  await ready(page);
  await shot(page, info, '04-code-ready.png');

  const diagram = '```mermaid\nflowchart LR\n A[完成排版] --> B[柔和顯示]\n```\n\n';
  const prefix = heading + paragraph + closedCode + diagram;
  await partial(page, prefix);
  await expect(page.locator('#partial-msg .mermaid-chart svg')).toBeVisible();
  await expect(page.locator('#partial-msg pre code.lang-mermaid')).toHaveCount(0);
  await ready(page);
  await shot(page, info, '05-diagram-ready.png');

  const list = '- 段落完成才顯示\n- 已顯示內容不重播\n- 完成回覆不重複插入\n\n';
  const finalTail = '完成。現在可以選取、複製，或繼續輸入下一個問題。';
  const finalContent = prefix + list + finalTail;
  await partial(page, prefix + list + '完成。現在可');
  await expect(page.locator('#partial-msg li')).toHaveCount(3);
  await ready(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = window as any;
        const first = document.querySelector('#partial-msg h2');
        const offset =
          first!.getBoundingClientRect().top -
          document.querySelector('#partial-msg .msg-text')!.getBoundingClientRect().top;
        return (
          first === host.__firstHeading &&
          first!.closest('.reply-chunk') === host.__firstChunk &&
          Math.abs(offset - host.__firstOffset) < 0.1 &&
          getComputedStyle(host.__firstChunk).animationName === 'none'
        );
      }),
    )
    .toBe(true);

  const final = replyEvent(2, finalContent);
  events.push(final);
  await emit(page, 'event', final);
  // There is deliberately no partial-clear event yet: finalization must consume it.
  await expect(page.locator('#partial-msg')).toHaveCount(0);
  await expect(page.locator('.msg:not(.msg-user) h2')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector('.msg:not(.msg-user) h2') === (window as any).__firstHeading,
      ),
    )
    .toBe(true);
  await expect(page.locator('.msg:not(.msg-user)')).toHaveCSS('transform', 'none');
  await emit(page, 'partial', { content: '', thinking: '' });
  session.busy = false;
  await emit(page, 'busy', { busy: false });
  await expect(page.locator('.msg:not(.msg-user)')).toContainText(finalTail);
  await ready(page);
  await shot(page, info, '06-final-no-replay.png');
  await page.locator('#input').fill('下一個問題仍然可以正常輸入。');
  await expect(page.locator('#input')).toHaveValue('下一個問題仍然可以正常輸入。');
  const hit = await page.locator('#btn-send').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return node.contains(
      document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
    );
  });
  expect(hit).toBe(true);
  await shot(page, info, '07-composer-usable.png');
  const layout = () =>
    page.locator('.msg:not(.msg-user) .msg-text').evaluate((node) => {
      const top = node.getBoundingClientRect().top;
      return ['h2', 'p', 'pre', '.mermaid-wrap', 'ul'].map((selector) => {
        const rect = node.querySelector(selector)!.getBoundingClientRect();
        return { top: rect.top - top, width: rect.width, height: rect.height };
      });
    });
  const finalLayout = await layout();

  await page.reload();
  await expect(page.locator('.msg:not(.msg-user) h2')).toHaveCount(1);
  await expect(page.locator('.msg:not(.msg-user)')).toContainText(finalTail);
  await expect(page.locator('.reply-chunk')).toHaveCount(0);
  await expect(page.locator('.mermaid-chart svg')).toBeVisible();
  await expect(page.locator('pre code.lang-mermaid')).toHaveCount(0);
  const reloadedLayout = await layout();
  for (let i = 0; i < finalLayout.length; i++) {
    expect(Math.abs(reloadedLayout[i].top - finalLayout[i].top)).toBeLessThan(0.2);
    expect(Math.abs(reloadedLayout[i].width - finalLayout[i].width)).toBeLessThan(0.2);
    expect(Math.abs(reloadedLayout[i].height - finalLayout[i].height)).toBeLessThan(0.2);
  }
  await shot(page, info, '08-reloaded-history.png');
  expect(errors).toEqual([]);
});

test('a paused frontier resumes without fading previously read content again', async ({ page }) => {
  const { errors } = await setup(page);
  const first = '## 已讀內容\n\n';
  await partial(page, first);
  await expect(page.locator('#partial-msg h2')).toHaveText('已讀內容');
  await ready(page);
  const flow = page.locator('#partial-msg .reply-flow');
  const previous = await flow.evaluate((node) => {
    (window as any).__readHeading = node.querySelector('h2');
    return parseFloat(node.style.getPropertyValue('--reply-front'));
  });
  await partial(page, first + '後續準備好的段落會接上原來的位置，不會重播已經讀過的標題。\n\n');
  const last = flow.locator('.reply-chunk').last();
  await expect(last).toHaveAttribute('data-reveal', 'revealing');
  expect(
    await flow.evaluate((node) => parseFloat(node.style.getPropertyValue('--reply-front'))),
  ).toBeGreaterThanOrEqual(previous);
  await expect(flow.locator('.reply-chunk').first()).toHaveCSS('mask-image', 'none');
  await expect(flow.locator('.reply-chunk').first()).not.toHaveAttribute('inert', '');
  expect(await flow.locator('h2').evaluate((node) => node === (window as any).__readHeading)).toBe(
    true,
  );
  await ready(page);
  expect(errors).toEqual([]);
});

test('a small continuation stays gradual after a large backlog has finished', async ({ page }) => {
  const { errors } = await setup(page);
  const first =
    '## 很長的已讀回覆\n\n' + '大量內容先排版，再沿同一個前緣往下顯示。'.repeat(480) + '\n\n';
  await partial(page, first);
  await expect(page.locator('#partial-msg h2')).toHaveText('很長的已讀回覆');
  await ready(page);
  const flow = page.locator('#partial-msg .reply-flow');
  const previous = await flow.evaluate((node) =>
    parseFloat(node.style.getPropertyValue('--reply-front')),
  );
  expect(previous).toBeGreaterThan(3000);
  await partial(page, first + '小段續文仍然柔和地接上，不會繼承大量內容的高速追趕而瞬間跳出。\n\n');
  await expect(flow.locator('.reply-chunk')).toHaveCount(2);
  const samples = await flow.evaluate(async (node) => {
    const samples = [];
    for (let i = 0; i < 18; i++) {
      await new Promise(requestAnimationFrame);
      samples.push({
        front: parseFloat(node.style.getPropertyValue('--reply-front')),
        state: node.querySelector('.reply-chunk:last-child')!.getAttribute('data-reveal'),
      });
    }
    return samples;
  });
  expect(samples.every((sample) => sample.front >= previous)).toBe(true);
  expect(samples.filter((sample) => sample.state === 'revealing').length).toBeGreaterThan(10);
  await ready(page);
  expect(errors).toEqual([]);
});

test('responsive reflow keeps read blocks opaque and never rewinds the active front', async ({
  page,
}) => {
  const { errors } = await setup(page);
  const first = '## 已讀過的標題，改變寬度也不會再淡入\n\n';
  await partial(page, first);
  await expect(page.locator('#partial-msg h2')).toHaveText('已讀過的標題，改變寬度也不會再淡入');
  await ready(page);
  await partial(
    page,
    first + '接上的段落要用同一個漸層位置，已讀內容始終保持清楚。'.repeat(12) + '\n\n',
  );
  const flow = page.locator('#partial-msg .reply-flow');
  await expect(flow).toHaveAttribute('data-reveal', 'revealing');
  const previous = await flow.evaluate((node) =>
    parseFloat(node.style.getPropertyValue('--reply-front')),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(flow.locator('.reply-chunk').first()).toHaveCSS('mask-image', 'none');
  await expect
    .poll(() =>
      flow.evaluate((node) => {
        const floor =
          node.querySelector('.reply-chunk')!.getBoundingClientRect().bottom -
          node.getBoundingClientRect().top;
        return parseFloat(node.style.getPropertyValue('--reply-front')) >= floor;
      }),
    )
    .toBe(true);
  expect(
    await flow.evaluate((node) => parseFloat(node.style.getPropertyValue('--reply-front'))),
  ).toBeGreaterThanOrEqual(previous);
  await ready(page);
  expect(errors).toEqual([]);
});

test('changing reduced motion during reveal immediately releases prepared content', async ({
  page,
}) => {
  const { errors } = await setup(page);
  await partial(
    page,
    '## 動態減少動畫\n\n' + '已排版的內容保持原位，可以直接閱讀。'.repeat(18) + '\n\n',
  );
  const flow = page.locator('#partial-msg .reply-flow');
  await expect(flow).toHaveAttribute('data-reveal', 'revealing');
  await expect(flow.locator('.reply-chunk')).toHaveAttribute('inert', '');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(flow).toHaveAttribute('data-reveal', 'ready');
  await expect(flow.locator('.reply-chunk')).not.toHaveAttribute('inert', '');
  const settled = await flow.evaluate((node) => node.style.getPropertyValue('--reply-front'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForTimeout(100);
  expect(await flow.evaluate((node) => node.style.getPropertyValue('--reply-front'))).toBe(settled);
  await expect(flow.locator('.reply-chunk')).toHaveCSS('mask-image', 'none');
  expect(errors).toEqual([]);
});

test('removing an active reveal stops writes from its abandoned controller', async ({ page }) => {
  const { errors } = await setup(page);
  await partial(page, '## 舊回覆\n\n' + '舊回覆的漸層尚未完成。'.repeat(24) + '\n\n');
  const flow = page.locator('#partial-msg .reply-flow');
  await expect(flow).toHaveAttribute('data-reveal', 'revealing');
  await flow.evaluate((node) => ((window as any).__abandonedFlow = node));
  await partial(page, '');
  await expect(page.locator('#partial-msg')).toHaveCount(0);
  const unchanged = await page.evaluate(async () => {
    const node = (window as any).__abandonedFlow;
    const before = node.style.getPropertyValue('--reply-front');
    for (let i = 0; i < 15; i++) await new Promise(requestAnimationFrame);
    return !node.isConnected && node.style.getPropertyValue('--reply-front') === before;
  });
  expect(unchanged).toBe(true);
  await partial(page, '## 新回覆\n\n');
  await expect(page.locator('#partial-msg h2')).toHaveText('新回覆');
  await ready(page);
  expect(errors).toEqual([]);
});

test('Mermaid is an SVG before the live reply becomes visible', async ({ page }, info) => {
  const { errors } = await setup(page);
  await partial(page, '```mermaid\nflowchart LR\n A[完成排版] --> B[漸層顯示]\n```\n\n');
  await expect(page.locator('#partial-msg .mermaid-chart svg')).toBeVisible();
  await expect(page.locator('#partial-msg pre')).toHaveCount(0);
  await expect(page.locator('#partial-msg .reply-chunk')).toHaveAttribute(
    'data-reveal',
    /revealing|ready/,
  );
  await ready(page);
  await shot(page, info, 'mermaid-ready.png');
  expect(errors).toEqual([]);
});

test('historical Mermaid does not flash its raw source while loading', async ({ page }) => {
  let release!: () => void;
  let requested = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/vendor/mermaid/mermaid.min.js', async (route) => {
    requested = true;
    await held;
    await route.continue();
  });
  const { errors } = await setup(page, [
    replyEvent(1, '```mermaid\nflowchart LR\n A[Ready] --> B[Visible]\n```'),
  ]);
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator('.mermaid-wrap')).toBeHidden();
  release();
  await expect(page.locator('.mermaid-chart svg')).toBeVisible();
  await expect(page.locator('.mermaid-wrap pre')).toHaveCount(0);
  await expect(page.locator('.reply-chunk')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('finalization during pending image preparation retains the queue once', async ({ page }) => {
  const { errors } = await setup(page);
  let release!: () => void;
  let requested = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/media/reveal-final.svg', async (route) => {
    requested = true;
    await held;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#465b73"/></svg>',
    });
  });
  const prefix = '## 準備中完成回覆\n\n![圖片](/media/reveal-final.svg)\n\n';
  await partial(page, prefix);
  await expect.poll(() => requested).toBe(true);
  await emit(page, 'event', replyEvent(1, prefix + '最後一段。'));
  await expect(page.locator('#partial-msg')).toHaveCount(0);
  await expect(page.locator('.msg:not(.msg-user) img')).toHaveCount(0);
  release();
  await expect(page.locator('.msg:not(.msg-user) h2')).toHaveCount(1);
  await expect(page.locator('.msg:not(.msg-user) img')).toHaveCount(1);
  await expect(page.locator('.msg:not(.msg-user)')).toContainText('最後一段。');
  await ready(page);
  expect(
    await page
      .locator('.msg:not(.msg-user) img')
      .evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth === 100),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('a replaced or removed stream discards delayed image preparation', async ({ page }) => {
  const { errors } = await setup(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/media/reveal-delayed.png', async (route) => {
    requested = true;
    await held;
    await route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await partial(page, '![延遲圖片](/media/reveal-delayed.png)\n\n');
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator('#partial-msg img')).toHaveCount(0);
  await partial(page, '## 新內容\n\n');
  await expect(page.locator('#partial-msg h2')).toHaveText('新內容');
  await partial(page, '');
  release();
  await page.waitForTimeout(300);
  await expect(page.locator('#partial-msg, .msg:not(.msg-user) img, .reply-chunk')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('reduced motion shows only ready content immediately and no reveal animation', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { errors } = await setup(page);
  await partial(page, '## 安靜顯示\n\n**已完成**。\n\n');
  await expect(page.locator('#partial-msg strong')).toHaveText('已完成');
  await expect(page.locator('#partial-msg .reply-chunk')).toHaveAttribute('data-reveal', 'ready');
  await expect(page.locator('#partial-msg .reply-chunk')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('#partial-msg .reply-chunk')).toHaveCSS('opacity', '1');
  await expect(page.locator('#partial-msg')).toHaveCSS('transform', 'none');
  await shot(page, info, 'reduced-motion.png');
  expect(errors).toEqual([]);
});

for (const kind of ['assistant', 'thinking']) {
  for (const [name, leading, trailing] of [
    ['trailing blank line', '', '\n\n'],
    ['leading whitespace', ' \n\n', ''],
    ['outer whitespace', ' \n\n', '\n\n'],
  ]) {
    test(`transport-trimmed ${kind} final preserves its body and frontier: ${name}`, async ({
      page,
    }) => {
      const { errors } = await setup(page);
      const source = leading + '## 保留已讀內容\n\n先準備文字，再接著顯示。' + trailing;
      const isThinking = kind === 'thinking';
      await partial(page, isThinking ? '' : source, isThinking ? source : '');
      if (isThinking)
        await page
          .locator('#partial-thinking')
          .evaluate((node) => ((node as HTMLDetailsElement).open = true));
      await ready(page);
      const bodySelector = isThinking ? '#partial-thinking .event-body' : '#partial-msg .msg-text';
      const front = await page.locator(bodySelector).evaluate((node) => {
        (window as any).__trimBody = node;
        (window as any).__trimHeading = node.querySelector('h2');
        return Number.parseFloat((node as HTMLElement).style.getPropertyValue('--reply-front'));
      });
      await emit(
        page,
        'event',
        replyEvent(
          1,
          source.trim(),
          isThinking ? '' : 'assistant',
          isThinking ? 'thinking' : 'message',
        ),
      );
      const final = page.locator(
        isThinking ? '.event.thinking .event-body' : '.msg:not(.msg-user) .msg-text',
      );
      expect(await final.evaluate((node) => node === (window as any).__trimBody)).toBe(true);
      expect(
        await final.evaluate((node) => node.querySelector('h2') === (window as any).__trimHeading),
      ).toBe(true);
      expect(
        await final.evaluate((node) =>
          Number.parseFloat((node as HTMLElement).style.getPropertyValue('--reply-front')),
        ),
      ).toBeGreaterThanOrEqual(front);
      await ready(page);
      if (isThinking) await expect(page.locator('.event.thinking')).toHaveAttribute('open', '');
      expect(errors).toEqual([]);
    });
  }
}

test('final delivery continuous video walkthrough retains read text through whitespace and media handoff', async ({
  page,
}, info) => {
  const consoleErrors: string[] = [];
  const dialogs: string[] = [];
  const requestFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  page.on('requestfailed', (request) =>
    requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`),
  );
  const { events, errors, session } = await setup(page, [], false);
  await page.evaluate(() => {
    const host = window as any;
    host.__deliveryRecording = true;
    host.__deliveryPhase = 'launch';
    host.__deliveryWatch = null;
    host.__deliverySamples = [];
    const sample = (time: number) => {
      const watch = host.__deliveryWatch;
      const visibleAlerts = [...document.querySelectorAll('.event.error, [role="alert"], .toast')]
        .filter((node) => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return (
            box.width > 0 &&
            box.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          );
        })
        .map((node) => node.textContent);
      host.__deliverySamples.push({
        time,
        phase: host.__deliveryPhase,
        watched: !!watch,
        bodyConnected: watch ? watch.body.isConnected : true,
        anchorsRetained: watch
          ? watch.anchors.every((node: Element) => node.isConnected && watch.body.contains(node))
          : true,
        oldBlocksReady: watch
          ? watch.chunks.every(
              (node: HTMLElement) => node.dataset.reveal === 'ready' && !node.inert,
            )
          : true,
        front: watch ? Number.parseFloat(watch.body.style.getPropertyValue('--reply-front')) : null,
        initialFront: watch?.front ?? null,
        headingDrift: watch ? watch.anchors[0].getBoundingClientRect().top - watch.top : 0,
        scrollTop: document.getElementById('messages')!.scrollTop,
        scrollerHeight: document.getElementById('messages')!.clientHeight,
        reservation: (document.getElementById('messages') as HTMLElement).style.getPropertyValue(
          '--prompt-turn-space',
        ),
        busy: document.getElementById('app')!.classList.contains('agent-busy'),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        visibleAlerts,
      });
      if (host.__deliveryRecording) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await shot(page, info, 'delivery-video-01-launch.png');

  async function sendQuestion(text: string, phase: string) {
    await page.evaluate((phase) => {
      (window as any).__deliveryWatch = null;
      (window as any).__deliveryPhase = phase;
    }, phase);
    await page.locator('#input').fill(text);
    const send = page.locator('#btn-send');
    const hit = await send.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        reachable: target === node || node.contains(target),
        width: box.width,
        height: box.height,
      };
    });
    expect(hit.reachable).toBe(true);
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    const count = events.length;
    await send.click();
    await expect.poll(() => events.length).toBe(count + 1);
    await emit(page, 'event', events.at(-1));
    await expect(page.locator('#messages')).toHaveAttribute('data-prompt-turn', 'active');
    await expect(page.locator('#messages')).not.toHaveAttribute('data-prompt-motion', /.+/);
    session.busy = true;
    await emit(page, 'busy', { busy: true });
    return hit;
  }

  async function watchReadBody(phase: string) {
    await ready(page);
    await page.locator('#partial-msg .msg-text').evaluate((body, phase) => {
      const anchors = [...body.querySelectorAll('h2, p')];
      const host = window as any;
      host.__deliveryPhase = phase;
      host.__deliveryWatch = {
        body,
        anchors,
        chunks: [...body.querySelectorAll('.reply-chunk')],
        top: anchors[0].getBoundingClientRect().top,
        front: Number.parseFloat((body as HTMLElement).style.getPropertyValue('--reply-front')),
      };
    }, phase);
  }

  async function finalHandoff(content: string, phase: string) {
    const final = replyEvent(events.at(-1)!.id + 1, content);
    events.push(final);
    await page.evaluate((phase) => ((window as any).__deliveryPhase = phase), phase);
    await emit(page, 'event', final);
    await page.evaluate(() => {
      const host = window as any;
      host.__deliverySteps ??= [];
      const root = document.getElementById('messages')!;
      host.__deliverySteps.push({
        phase: host.__deliveryPhase,
        step: 'after-event',
        top: root.scrollTop,
        height: root.clientHeight,
        space: (root as HTMLElement).style.getPropertyValue('--prompt-turn-space'),
      });
    });
    await emit(page, 'partial', null);
    await page.evaluate(() => {
      const host = window as any;
      const root = document.getElementById('messages')!;
      host.__deliverySteps.push({
        phase: host.__deliveryPhase,
        step: 'after-clear',
        top: root.scrollTop,
        height: root.clientHeight,
        space: (root as HTMLElement).style.getPropertyValue('--prompt-turn-space'),
      });
    });
    session.busy = false;
    await emit(page, 'busy', { busy: false });
    await expect(page.locator('#partial-msg, #partial-thinking')).toHaveCount(0);
    await ready(page);
    // Observe a deliberate post-EOF interval, not just an instantaneous DOM check.
    await page.waitForTimeout(800);
    const retained = await page.evaluate(() => {
      const watch = (window as any).__deliveryWatch;
      return watch.anchors.every((node: Element) => watch.body.contains(node) && node.isConnected);
    });
    expect(retained).toBe(true);
  }

  const textSend = await sendQuestion('檢查文字完成時，已顯示的內容是否重畫。', 'text-send');
  await shot(page, info, 'delivery-video-02-text-question.png');
  const first = '## 檢查一：文字完成\n\n\n**這段已顯示，不應重新播放。**\n\n\n';
  await partial(page, first);
  await watchReadBody('text-ready');
  await shot(page, info, 'delivery-video-03-text-ready.png');
  const source = first + '完成時只接上尾段，保留原本內容。\n\n';
  await partial(page, source);
  await ready(page);
  await finalHandoff(parseOutboxMarkers(source).text, 'text-final');
  await shot(page, info, 'delivery-video-04-text-final.png');

  const mediaSend = await sendQuestion('檢查圖片發布後，前面的文字是否仍留在原位。', 'media-send');
  await shot(page, info, 'delivery-video-05-media-question.png');
  const thought = '先保留已顯示文字，再等待圖片發布。\n\n';
  const prefix = '## 檢查二：圖片交接\n\n**這段文字不應被清空。**\n\n';
  await partial(page, prefix, thought);
  const summary = page.locator('#partial-thinking summary');
  expect(
    await summary.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === node || node.contains(hit);
    }),
  ).toBe(true);
  await summary.click();
  await expect(page.locator('#partial-thinking')).toHaveAttribute('open', '');
  const thoughtFinal = replyEvent(events.at(-1)!.id + 1, thought.trim(), '', 'thinking');
  events.push(thoughtFinal);
  await emit(page, 'event', thoughtFinal);
  await partial(page, prefix);
  await expect(page.locator('.event.thinking')).toHaveAttribute('open', '');
  await watchReadBody('media-ready');
  await shot(page, info, 'delivery-video-06-media-prefix-ready.png');
  const mediaSource =
    prefix + '[[image: /tmp/video-proof-chart.svg]]\n\n圖片已發布，這段說明接在圖片後面。\n\n';
  await partial(page, mediaSource);
  await page.waitForTimeout(650);
  // Text after an unpublished image keeps streaming; the local marker never shows.
  await expect(page.locator('#partial-msg')).toContainText('圖片已發布');
  await expect(page.locator('#partial-msg')).not.toContainText('[[image');
  await shot(page, info, 'delivery-video-07-media-tail-pending.png');
  await page.route('**/media/video-proof-chart.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="100"><rect width="280" height="100" rx="8" fill="#465b73"/><path d="M24 80L72 54L120 64L168 32L216 42L256 18" stroke="#a9d9c9" stroke-width="4" fill="none"/></svg>',
    }),
  );
  await finalHandoff(
    embedOutboxMediaUrls(
      mediaSource,
      new Map([['/tmp/video-proof-chart.svg', '/media/video-proof-chart.svg']]),
    ),
    'media-final',
  );
  await expect(page.locator('.msg:not(.msg-user) img')).toHaveCount(1);
  await shot(page, info, 'delivery-video-08-media-final.png');

  const samples = await page.evaluate(() => {
    (window as any).__deliveryRecording = false;
    return (window as any).__deliverySamples as {
      phase: string;
      watched: boolean;
      bodyConnected: boolean;
      anchorsRetained: boolean;
      oldBlocksReady: boolean;
      front: number;
      initialFront: number;
      headingDrift: number;
      overflow: boolean;
      visibleAlerts: string[];
    }[];
  });
  await recordSamples(info, 'delivery-video-metrics', {
    samples,
    textSend,
    mediaSend,
    errors,
    consoleErrors,
    dialogs,
    requestFailures,
    viewport: page.viewportSize(),
    browser: info.project.name,
    handoffSteps: await page.evaluate(() => (window as any).__deliverySteps),
  });
  const watched = samples.filter((sample) => sample.watched);
  expect(watched.length).toBeGreaterThan(40);
  expect(
    watched.filter(
      (sample) => !sample.bodyConnected || !sample.anchorsRetained || !sample.oldBlocksReady,
    ),
  ).toEqual([]);
  expect(watched.filter((sample) => sample.front < sample.initialFront)).toEqual([]);
  expect(Math.max(...watched.map((sample) => Math.abs(sample.headingDrift)))).toBeLessThanOrEqual(
    0.2,
  );
  expect(samples.filter((sample) => sample.overflow || sample.visibleAlerts.length)).toEqual([]);
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(requestFailures).toEqual([]);
});

test('outbox finalization preserves rendered content when delivery collapses extra blank lines', async ({
  page,
}, info) => {
  const { errors } = await setup(page);
  const source = '## 已經讀完的內容\n\n\n**這段不能重播。**\n\n\n\n結尾。\n\n';
  await partial(page, source);
  await ready(page);
  await page.locator('#partial-msg .msg-text').evaluate((node) => {
    const host = window as any;
    host.__deliveryBody = node;
    host.__deliveryHeading = node.querySelector('h2');
    host.__deliveryParagraph = node.querySelector('p');
    host.__deliveryFront = Number.parseFloat(
      (node as HTMLElement).style.getPropertyValue('--reply-front'),
    );
  });
  await emit(page, 'event', replyEvent(1, parseOutboxMarkers(source).text));
  const body = page.locator('.msg:not(.msg-user) .msg-text');
  expect(await body.evaluate((node) => node === (window as any).__deliveryBody)).toBe(true);
  expect(
    await body.evaluate((node) => node.querySelector('h2') === (window as any).__deliveryHeading),
  ).toBe(true);
  expect(
    await body.evaluate((node) => node.querySelector('p') === (window as any).__deliveryParagraph),
  ).toBe(true);
  expect(
    await body.evaluate(
      (node) =>
        Number.parseFloat((node as HTMLElement).style.getPropertyValue('--reply-front')) >=
        (window as any).__deliveryFront,
    ),
  ).toBe(true);
  await expect(body.locator('.reply-chunk:not([data-reveal="ready"])')).toHaveCount(0);
  await shot(page, info, 'delivery-blank-lines-no-replay.png');
  expect(errors).toEqual([]);
});

for (const inline of [false, true]) {
  test(`outbox finalization preserves read blocks when publishing ${inline ? 'inline' : 'standalone'} media markers`, async ({
    page,
  }, info) => {
    const { errors } = await setup(page);
    const prefix = '## 保留上方已讀內容\n\n**文字不能清空重播。**\n\n';
    await partial(page, prefix);
    await ready(page);
    await page.locator('#partial-msg .msg-text').evaluate((node) => {
      const host = window as any;
      host.__deliveryBody = node;
      host.__deliveryHeading = node.querySelector('h2');
      host.__deliveryParagraph = node.querySelector('p');
      host.__deliveryFront = Number.parseFloat(
        (node as HTMLElement).style.getPropertyValue('--reply-front'),
      );
    });
    const marker = '[[image: /tmp/piweb-delivery-chart.svg]]';
    const source =
      prefix + (inline ? `這是圖：${marker}，接著往下讀。` : marker) + '\n\n圖片後的說明。\n\n';
    await partial(page, source);
    await ready(page);
    await page.route('**/media/delivery-chart.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#465b73"/></svg>',
      }),
    );
    const final = embedOutboxMediaUrls(
      source,
      new Map([['/tmp/piweb-delivery-chart.svg', '/media/delivery-chart.svg']]),
    );
    await emit(page, 'event', replyEvent(1, final));
    const body = page.locator('.msg:not(.msg-user) .msg-text');
    expect(await body.evaluate((node) => node === (window as any).__deliveryBody)).toBe(true);
    expect(
      await body.evaluate((node) => node.querySelector('h2') === (window as any).__deliveryHeading),
    ).toBe(true);
    expect(
      await body.evaluate(
        (node) => node.querySelector('p') === (window as any).__deliveryParagraph,
      ),
    ).toBe(true);
    expect(
      await body.evaluate(
        (node) =>
          Number.parseFloat((node as HTMLElement).style.getPropertyValue('--reply-front')) >=
          (window as any).__deliveryFront,
      ),
    ).toBe(true);
    await ready(page);
    await expect(body.locator('img')).toHaveCount(1);
    await expect(body).toContainText('圖片後的說明。');
    await expect(body).not.toContainText('/tmp/piweb-delivery-chart.svg');
    await shot(page, info, `delivery-${inline ? 'inline' : 'standalone'}-media-no-replay.png`);
    expect(errors).toEqual([]);
  });
}

test('transport whitespace compatibility does not accept a substantive prefix rewrite', async ({
  page,
}) => {
  await setup(page);
  await partial(page, '## Original\n\nOriginal paragraph.\n\n');
  await ready(page);
  await page
    .locator('#partial-msg .msg-text')
    .evaluate((node) => ((window as any).__oldRewriteBody = node));
  await emit(page, 'event', replyEvent(1, '## Replacement\n\nReplacement paragraph.'));
  const body = page.locator('.msg:not(.msg-user) .msg-text');
  expect(await body.evaluate((node) => node === (window as any).__oldRewriteBody)).toBe(false);
  await ready(page);
  await expect(body.locator('h2')).toHaveText('Replacement');
});

for (const [first, fragment, rest, tag, name] of [
  ['- one\n\n', '-', '- two\n\nAfter', 'ul', 'ul'],
  ['1. one\n\n', '12', '12. two\n\nAfter', 'ol', 'ol'],
  ['# Heading\n\n    - one\n\n', '    -', '    - two\n\nAfter', 'ul', 'indented ul'],
  ['# Heading\n\n\t- one\n\n', '\t-', '\t- two\n\nAfter', 'ul', 'tab-indented ul'],
  ['# Heading\n\n    1. one\n\n', '    12', '    12. two\n\nAfter', 'ol', 'indented ol'],
]) {
  test(`unfinished ${name} marker preserves the same list hierarchy as static Markdown`, async ({
    page,
  }) => {
    const { errors } = await setup(page);
    await partial(page, first + fragment);
    await expect(page.locator('#partial-msg li')).toHaveCount(0);
    const source = first + rest;
    await partial(page, source);
    await expect(page.locator(`#partial-msg ${tag}`)).toHaveCount(1);
    await expect(page.locator('#partial-msg li')).toHaveCount(2);
    await emit(page, 'event', replyEvent(1, source.trim()));
    await ready(page);
    const same = await page
      .locator('.msg:not(.msg-user) .msg-text')
      .evaluate(async (node, source) => {
        const { renderRich } = await import('/markdown.js');
        const expected = document.createElement('div');
        renderRich(expected, source);
        const actual = node.cloneNode(true) as HTMLElement;
        for (const chunk of actual.querySelectorAll('.reply-chunk'))
          chunk.replaceWith(...chunk.childNodes);
        return actual.innerHTML === expected.innerHTML;
      }, source.trim());
    expect(same).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('internally scrolled thinking keeps content-coordinate progress when another chunk joins', async ({
  page,
}, info) => {
  const { errors } = await setup(page);
  const source =
    '## 思考內容\n\n' +
    '這一段很長，內部捲動只改變閱讀視窗，不應跳過還沒顯示的文字。'.repeat(80) +
    '\n\n';
  await partial(page, '', source);
  await page
    .locator('#partial-thinking')
    .evaluate((node) => ((node as HTMLDetailsElement).open = true));
  const body = page.locator('#partial-thinking .event-body');
  await expect.poll(() => body.evaluate((node) => node.clientHeight)).toBeGreaterThan(375);
  const first = body.locator('.reply-chunk').first();
  await expect(first).toHaveAttribute('data-reveal', 'revealing');
  const before = await body.evaluate((node) => {
    const chunk = node.querySelector('.reply-chunk') as HTMLElement;
    const result = {
      front: Number.parseFloat((node as HTMLElement).style.getPropertyValue('--reply-front')),
      top: Number.parseFloat(chunk.style.getPropertyValue('--chunk-top')),
    };
    node.scrollTop = 150;
    return { ...result, scrollTop: node.scrollTop };
  });
  expect(before.scrollTop).toBeGreaterThan(100);
  await partial(page, '', source + '追加下一段內容。\n\n');
  await expect(body.locator('.reply-chunk')).toHaveCount(2);
  await expect(first).toHaveAttribute('data-reveal', 'revealing');
  const after = await body.evaluate((node) => ({
    front: Number.parseFloat((node as HTMLElement).style.getPropertyValue('--reply-front')),
    top: Number.parseFloat(
      (node.querySelector('.reply-chunk') as HTMLElement).style.getPropertyValue('--chunk-top'),
    ),
    scrollTop: node.scrollTop,
  }));
  expect(Math.abs(after.top - before.top)).toBeLessThan(0.1);
  expect(
    Math.abs(after.front - after.top - (before.front - before.top) - (after.front - before.front)),
  ).toBeLessThan(0.1);
  await recordSamples(info, 'thinking-scroll-content-coordinates', { before, after });
  expect(errors).toEqual([]);
});

test('thinking order keeps a late reasoning preview before its current streaming reply', async ({
  page,
}, info) => {
  const { errors } = await setup(page, [replyEvent(1, '上一輪的回覆，不應被重新排列。')], false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const answer = '## 正在輸出的回覆\n\n已經開始顯示正文。\n\n';
  const thought = '**這一輪的思考**，應在正文前面。\n\n';
  await partial(page, answer);
  await ready(page);
  await shot(page, info, 'thinking-order-01-answer-preview.png');
  for (let i = 1; i <= 3; i++) {
    await partial(page, answer + '後續正文。\n\n'.repeat(i), thought);
    await ready(page);
    await expect(page.locator('#partial-thinking')).toHaveCount(1);
    expect(
      await page.evaluate(() => {
        const thought = document.getElementById('partial-thinking')!;
        const answer = document.getElementById('partial-msg')!;
        const previous = document.querySelector('#messages > .msg:not(.partial)')!;
        return (
          Boolean(previous.compareDocumentPosition(thought) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          Boolean(thought.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }),
    ).toBe(true);
  }
  await shot(page, info, 'thinking-order-02-thought-before-answer.png');
  expect(errors).toEqual([]);
});

test('thinking order final handoff preserves the existing preview slot and body', async ({
  page,
}, info) => {
  const { errors } = await setup(page, [], false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const thought = '**原位思考**，完成後仍在正文前面。\n\n';
  const answer = '## 正文\n\n不讓 thinking 交接到最下面。\n\n';
  await partial(page, '', thought);
  await page.locator('#partial-thinking summary').click();
  await partial(page, answer, thought);
  await ready(page);
  const before = await page.locator('#partial-thinking summary').boundingBox();
  await page.evaluate(() => {
    (window as any).__orderedThoughtBody = document.querySelector('#partial-thinking .event-body');
    (window as any).__orderedAnswerBody = document.querySelector('#partial-msg .msg-text');
  });
  await emit(page, 'event', replyEvent(1, thought.trim(), '', 'thinking'));
  await expect(page.locator('#partial-thinking')).toHaveCount(0);
  await expect(page.locator('.event.thinking')).toHaveAttribute('open', '');
  expect(
    await page.evaluate(() => {
      const thought = document.querySelector('.event.thinking')!;
      const answer = document.getElementById('partial-msg')!;
      return (
        Boolean(thought.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        thought.querySelector('.event-body') === (window as any).__orderedThoughtBody &&
        answer.querySelector('.msg-text') === (window as any).__orderedAnswerBody
      );
    }),
  ).toBe(true);
  // The streaming caret disappears at EOF; the disclosure header stays in
  // its original slot even if that legitimately shortens its expanded body.
  expect((await page.locator('.event.thinking summary').boundingBox())!.y).toBeCloseTo(
    before!.y,
    0,
  );
  await shot(page, info, 'thinking-order-03-thought-final-in-place.png');
  await partial(page, answer, '');
  await emit(page, 'event', replyEvent(2, answer.trim()));
  await partial(page, '');
  await ready(page);
  expect(
    await page
      .locator('#messages > .event, #messages > .msg')
      .evaluateAll((nodes) =>
        nodes.map((node) => (node.classList.contains('thinking') ? 'thinking' : 'answer')),
      ),
  ).toEqual(['thinking', 'answer']);
  await shot(page, info, 'thinking-order-04-both-final.png');
  expect(errors).toEqual([]);
});

test('thinking order handles a durable thought whose short preview was missed', async ({
  page,
}, info) => {
  const { errors } = await setup(page, [replyEvent(1, '上一輪正文。')], false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await partial(page, '## 這一輪正文\n\n正文先被 SSE 取樣看到。\n\n');
  await emit(page, 'event', replyEvent(2, '短思考已完成，前端沒收到預覽。', '', 'thinking'));
  await ready(page);
  expect(
    await page
      .locator('#messages > .event, #messages > .msg')
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          node.classList.contains('thinking')
            ? 'thinking'
            : node.id === 'partial-msg'
              ? 'preview'
              : 'previous',
        ),
      ),
  ).toEqual(['previous', 'thinking', 'preview']);
  await shot(page, info, 'thinking-order-05-missed-preview.png');
  expect(errors).toEqual([]);
});

test('completed thinking keeps its rendered nodes and expanded state', async ({ page }) => {
  const { errors } = await setup(page);
  const content = '**先整理重點**。\n\n';
  await partial(page, '', content);
  await page.locator('#partial-thinking summary').click();
  await expect(page.locator('#partial-thinking strong')).toHaveText('先整理重點');
  await ready(page);
  await page.evaluate(
    () => ((window as any).__thought = document.querySelector('#partial-thinking strong')),
  );
  await emit(page, 'event', replyEvent(1, content.trim(), '', 'thinking'));
  await expect(page.locator('#partial-thinking')).toHaveCount(0);
  await expect(page.locator('.event.thinking')).toHaveAttribute('open', '');
  expect(
    await page.evaluate(
      () => document.querySelector('.event.thinking strong') === (window as any).__thought,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('list continuations and CRLF have the same final hierarchy as normal Markdown', async ({
  page,
}) => {
  const { errors } = await setup(page);
  const heading = '## 清單\r\n\r\n';
  await partial(page, heading + '- 第一項\r\n\r\n');
  await expect(page.locator('#partial-msg h2')).toHaveText('清單');
  await expect(page.locator('#partial-msg li')).toHaveCount(0);
  const list = '- 第一項\r\n\r\n  補充說明\r\n  - 子項\r\n\r\n- 第二項\r\n\r\n';
  const content = heading + list + '下一段';
  await partial(page, content);
  await expect(page.locator('#partial-msg li')).toHaveCount(3);
  await expect(page.locator('#partial-msg ul ul li')).toHaveText('子項');
  await emit(page, 'event', replyEvent(1, content));
  await ready(page);
  const same = await page
    .locator('.msg:not(.msg-user) .msg-text')
    .evaluate(async (node, content) => {
      const { renderRich } = await import('/markdown.js');
      const expected = document.createElement('div');
      renderRich(expected, content);
      const clone = node.cloneNode(true) as HTMLElement;
      for (const chunk of clone.querySelectorAll('.reply-chunk'))
        chunk.replaceWith(...chunk.childNodes);
      return clone.innerHTML === expected.innerHTML;
    }, content);
  expect(same).toBe(true);
  expect(errors).toEqual([]);
});

test('async asset completion respects scrolling up instead of dragging the reader down', async ({
  page,
}, info) => {
  const history = Array.from({ length: 22 }, (_, index) =>
    replyEvent(
      index + 1,
      `## 先前訊息 ${index + 1}\n\n這是用來檢查閱讀位置的歷史段落。閱讀上方內容時，新回覆不應把畫面拉走。`,
    ),
  );
  const { errors } = await setup(page, history, true);
  let release!: () => void;
  let requested = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/media/reveal-scroll.svg', async (route) => {
    requested = true;
    await held;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="288"><rect width="512" height="288" fill="#34465e"/><text x="32" y="140" fill="white" font-size="24">Ready before reveal</text></svg>',
    });
  });
  await partial(page, '## 已完成準備\n\n![完成的圖片](/media/reveal-scroll.svg)\n\n');
  await expect.poll(() => requested).toBe(true);
  await page.locator('#messages').hover();
  await page.mouse.wheel(0, -380);
  await expect(page.locator('#jump-live')).toHaveClass(/visible/);
  const top = await page.locator('#messages').evaluate((node) => node.scrollTop);
  release();
  await expect(page.locator('#partial-msg img')).toBeAttached();
  await ready(page);
  const after = await page.locator('#messages').evaluate((node) => node.scrollTop);
  expect(Math.abs(after - top)).toBeLessThan(2);
  await expect(page.locator('#jump-live')).toHaveClass(/visible/);
  await shot(page, info, 'reader-position-preserved.png');
  await page.locator('#jump-live').click();
  await expect
    .poll(() =>
      page
        .locator('#messages')
        .evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
    )
    .toBeLessThan(3);
  await expect(page.locator('#partial-msg h2')).toBeVisible();
  await expect(page.locator('#jump-live')).not.toHaveClass(/visible/);
  await expect(page.locator('#jump-live')).toHaveCSS('opacity', '0');
  await shot(page, info, 'reader-jumped-to-latest.png');
  expect(errors).toEqual([]);
});

test('light-theme formulas finish layout and font preparation before reveal', async ({
  page,
}, info) => {
  await page.addInitScript(() => localStorage.setItem('piweb.theme', 'light'));
  const { errors } = await setup(page);
  const heading = '## 淺色主題也先排版\n\n';
  const formula = '$$\na^2\n\n+b^2=c^2\n';
  await partial(page, heading + formula);
  await expect(page.locator('#partial-msg h2')).toHaveText('淺色主題也先排版');
  await expect(page.locator('#partial-msg .katex')).toHaveCount(0);
  await partial(page, heading + formula + '$$\n\n');
  await expect(page.locator('#partial-msg .katex')).toHaveCount(1);
  await expect(page.locator('#partial-msg .reply-chunk').last()).toHaveAttribute(
    'data-reveal',
    /revealing|ready/,
  );
  expect(await page.evaluate(() => document.fonts.status)).toBe('loaded');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await ready(page);
  await shot(page, info, 'light-theme-ready-formula.png');
  expect(errors).toEqual([]);
});

test('hidden future rows cannot open touch-selection actions during reveal', async ({
  page,
}, info) => {
  const { errors } = await setup(page);
  await partial(page, 'FUTUREHIDDEN '.repeat(100) + '\n\n');
  const chunk = page.locator('#partial-msg .reply-chunk');
  await expect(chunk).toHaveAttribute('data-reveal', 'revealing');
  const point = await chunk.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node.querySelector('p')!);
    const bounds = node.getBoundingClientRect();
    const rowTop = Number.parseFloat(
      (node as HTMLElement).style.getPropertyValue('--reply-row-top'),
    );
    const messages = document.getElementById('messages')!.getBoundingClientRect();
    const rect = [...range.getClientRects()].find(
      (rect) =>
        rect.top > bounds.top + rowTop + 150 &&
        rect.top > messages.top + 40 &&
        rect.bottom < messages.bottom - 40,
    );
    if (!rect) throw new Error('No on-screen invisible future row');
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      band: rect.top - bounds.top,
    };
  });
  await page.evaluate(() => {
    document.addEventListener(
      'touchstart',
      (event) => {
        const target = event.target as HTMLElement;
        (window as any).__actualRevealTouch = {
          id: target.id,
          className: target.className,
          inBody: !!target.closest('.msg-text, .event-body'),
        };
      },
      { once: true, capture: true },
    );
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y }],
  });
  await page.waitForTimeout(360);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(chunk).toHaveAttribute('data-reveal', 'revealing');
  expect(
    await chunk.evaluate((node) =>
      Number.parseFloat((node as HTMLElement).style.getPropertyValue('--reply-row-top')),
    ),
  ).toBeLessThan(point.band);
  await shot(page, info, 'hidden-row-after-real-touch.png');
  await expect(page.locator('#selection-actions')).toBeHidden();
  await expect(page.locator('#custom-selection-overlay')).toBeHidden();
  await recordSamples(
    info,
    'hidden-row-touch-target',
    await page.evaluate(() => (window as any).__actualRevealTouch),
  );
  await ready(page);
  const readable = await chunk.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node.querySelector('p')!);
    const messages = document.getElementById('messages')!.getBoundingClientRect();
    const rect = [...range.getClientRects()].find(
      (rect) => rect.top > messages.top + 40 && rect.bottom < messages.bottom - 40,
    )!;
    return { x: rect.left + 8, y: rect.top + rect.height / 2 };
  });
  const readyTouch = await page.context().newCDPSession(page);
  await readyTouch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [readable],
  });
  await page.waitForTimeout(360);
  await readyTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await readyTouch.detach();
  await expect(page.locator('#selection-actions')).toBeVisible();
  expect(errors).toEqual([]);
});

test('revealing content cannot steal keyboard focus before it is ready', async ({ page }) => {
  const { errors } = await setup(page);
  await partial(page, '[已完成的連結](https://example.test/reveal)\n\n');
  const chunk = page.locator('#partial-msg .reply-chunk');
  await expect(chunk).toHaveAttribute('data-reveal', 'revealing');
  await expect(chunk).toHaveAttribute('inert', '');
  await expect(chunk).toHaveAttribute('aria-hidden', 'true');
  expect(
    await chunk.evaluate((node) => {
      const link = node.querySelector('a')!;
      link.focus();
      return document.activeElement === link;
    }),
  ).toBe(false);
  await ready(page);
  await expect(chunk).not.toHaveAttribute('inert', '');
  await expect(chunk).not.toHaveAttribute('aria-hidden', 'true');
  expect(
    await chunk.evaluate((node) => {
      const link = node.querySelector('a')!;
      link.focus();
      const rect = link.getBoundingClientRect();
      return (
        document.activeElement === link &&
        link.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      );
    }),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('desktop layout stays stationary through a soft reveal', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { errors } = await setup(page);
  await partial(page, '## 桌面也先完成排版\n\n第一段 **已完成排版**，沒有垂直滑動。\n\n');
  await expect(page.locator('#partial-msg .reply-chunk')).toHaveAttribute(
    'data-reveal',
    'revealing',
  );
  const samples = await page.locator('#partial-msg h2').evaluate(async (node) => {
    const samples: { x: number; y: number; width: number; transform: string; gap: number }[] = [];
    let previous = performance.now();
    for (let i = 0; i < 45; i++) {
      await new Promise(requestAnimationFrame);
      const rect = node.getBoundingClientRect();
      const now = performance.now();
      samples.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        transform: getComputedStyle(node.closest('.reply-chunk')!).transform,
        gap: now - previous,
      });
      previous = now;
    }
    return samples;
  });
  expect(
    Math.max(...samples.map((sample) => sample.y)) - Math.min(...samples.map((sample) => sample.y)),
  ).toBeLessThan(0.2);
  expect(samples.every((sample) => sample.transform === 'none')).toBe(true);
  await recordSamples(info, 'desktop-reveal-frame-samples', samples);
  await ready(page);
  await shot(page, info, 'desktop-ready.png');
  expect(errors).toEqual([]);
});

async function openScrollSettings(page: Page) {
  await page.locator('#btn-menu').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page
    .locator('#settings-dialog')
    .evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished)));
  return page.getByRole('switch', { name: /自動捲動/ });
}

async function scrollPosition(page: Page) {
  return page.locator('#messages').evaluate((node) => node.scrollTop);
}

function scrollHistory() {
  return Array.from({ length: 22 }, (_, i) =>
    replyEvent(i + 1, `## 歷史 ${i + 1}\n\n${'閱讀位置不應被新訊息拉走。'.repeat(8)}`),
  );
}

test('auto-scroll is OFF by default and updates preserve the submitted prompt position', async ({
  page,
}, info) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const original = Element.prototype.scrollTo;
    (window as any).__liveScrollCalls = [];
    Element.prototype.scrollTo = function (...args: any[]) {
      if ((this as HTMLElement).id === 'messages') (window as any).__liveScrollCalls.push(args);
      return original.apply(this, args as any);
    };
  });
  const { errors, events } = await setup(page, scrollHistory());
  const toggle = await openScrollSettings(page);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const box = await toggle.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      width: rect.width,
      height: rect.height,
      reachable: hit === node || node.contains(hit),
    };
  });
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.reachable).toBe(true);
  await shot(page, info, 'scroll-01-default-off.png');
  await page.locator('#btn-settings-close').click();
  await page.locator('#input').fill('不要自動捲動');
  await page.locator('#btn-send').click();
  await expect(page.locator('#input')).toHaveValue('');
  await emit(page, 'event', events.at(-1));
  await expect
    .poll(() =>
      page
        .locator('.msg-user')
        .last()
        .evaluate(
          (node) =>
            node.getBoundingClientRect().top -
            document.getElementById('messages')!.getBoundingClientRect().top,
        ),
    )
    .toBeCloseTo(12, 0);
  const before = await scrollPosition(page);
  await page.evaluate(() => {
    (window as any).__liveScrollCalls = [];
  });
  const content = '## 保留已讀文字\n\n' + '逐行閱讀，不要在最後重播。'.repeat(80) + '\n\n';
  await emit(page, 'busy', { busy: true });
  await partial(page, content);
  await ready(page);
  await expect(page.locator('#messages')).toHaveAttribute('data-prompt-turn', 'active');
  const front = await page.locator('#partial-msg .msg-text').evaluate((node) => {
    (window as any).__heldBody = node;
    (window as any).__heldHeading = node.querySelector('h2');
    return Number.parseFloat((node as HTMLElement).style.getPropertyValue('--reply-front'));
  });
  const saved = replyEvent(24, content.trim());
  events.push(saved);
  await emit(page, 'event', saved);
  await partial(page, '');
  await emit(page, 'busy', { busy: false });
  await ready(page);
  expect(await scrollPosition(page)).toBeCloseTo(before, 0);
  const corrections = await page.evaluate(() => (window as any).__liveScrollCalls);
  expect(
    corrections.every(
      ([call]: any[]) => Math.abs(call.top - before) < 1 && call.behavior === 'auto',
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => {
      const node = (window as any).__heldBody;
      return node.isConnected && node.querySelector('h2') === (window as any).__heldHeading;
    }),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      Number.parseFloat((window as any).__heldBody.style.getPropertyValue('--reply-front')),
    ),
  ).toBeGreaterThanOrEqual(front);
  await shot(page, info, 'scroll-02-position-held.png');
  await page.locator('#jump-live').click();
  await expect
    .poll(() =>
      page
        .locator('#messages')
        .evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
    )
    .toBeLessThan(3);
  await shot(page, info, 'scroll-03-manual-jump.png');
  const enabled = await openScrollSettings(page);
  await enabled.click();
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() =>
      enabled
        .locator('.settings-toggle')
        .evaluate((node) => getComputedStyle(node, '::after').transform),
    )
    .toBe('matrix(1, 0, 0, 1, 18, 0)');
  await shot(page, info, 'scroll-04-enable-follow.png');
  await page.locator('#btn-settings-close').click();
  const nextContent =
    '## 選擇跟隨最新回覆\n\n' + '只有開啟設定，而且位於底部，才會跟隨串流。'.repeat(12) + '\n\n';
  await partial(page, nextContent);
  await ready(page);
  await expect
    .poll(() =>
      page
        .locator('#messages')
        .evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
    )
    .toBeLessThan(3);
  await emit(page, 'event', replyEvent(25, nextContent.trim()));
  await partial(page, '');
  await ready(page);
  await shot(page, info, 'scroll-05-following-enabled.png');
  const disabled = await openScrollSettings(page);
  await disabled.click();
  await expect(disabled).toHaveAttribute('aria-checked', 'false');
  await page.locator('#btn-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect
    .poll(() =>
      disabled
        .locator('.settings-toggle')
        .evaluate((node) => getComputedStyle(node, '::after').transform),
    )
    .toBe('none');
  await shot(page, info, 'scroll-06-off-light.png');
  await page.locator('#btn-settings-close').click();
  const frozenTop = await scrollPosition(page);
  const callsBefore = await page.evaluate(() => (window as any).__liveScrollCalls.length);
  const frozenGeometry = await page.locator('#messages').evaluate((node) => ({
    top: node.scrollTop,
    height: node.scrollHeight,
    client: node.clientHeight,
    anchor: node.lastElementChild?.getBoundingClientRect().top,
    active: (document.activeElement as HTMLElement)?.id,
  }));
  await partial(page, '## 再次關閉\n\n' + '停留原位，由讀者控制。'.repeat(12) + '\n\n');
  await ready(page);
  await recordSamples(info, 'off-update-geometry', {
    before: frozenGeometry,
    after: await page.locator('#messages').evaluate((node) => ({
      top: node.scrollTop,
      height: node.scrollHeight,
      client: node.clientHeight,
      active: (document.activeElement as HTMLElement)?.id,
    })),
    scrollCalls: await page.evaluate(
      (n) => (window as any).__liveScrollCalls.slice(n),
      callsBefore,
    ),
  });
  expect(await scrollPosition(page)).toBeCloseTo(frozenTop, 0);
  await shot(page, info, 'scroll-07-off-preserved.png');
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('prompt turn submission raises the new question and reserves the answer viewport', async ({
  page,
}, info) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const { events, errors } = await setup(page, scrollHistory());
  const countBefore = await page.locator('.msg-user').count();
  const previousPosition = await scrollPosition(page);
  await page.locator('#input').fill('像影片一樣從這一輪開始讀');
  expect(await scrollPosition(page)).toBe(previousPosition);
  const send = page.locator('#btn-send');
  expect(
    await send.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === node || node.contains(hit);
    }),
  ).toBe(true);
  await send.click();
  await expect(page.locator('#input')).toHaveValue('');
  await emit(page, 'event', events.at(-1));
  const prompt = page.locator('.msg-user').last();
  await expect
    .poll(() =>
      prompt.evaluate(
        (node) =>
          node.getBoundingClientRect().top -
          document.getElementById('messages')!.getBoundingClientRect().top,
      ),
    )
    .toBeCloseTo(12, 0);
  expect(await page.locator('.msg-user').count()).toBe(countBefore + 1);
  const initial = await page.locator('#messages').evaluate((node) => ({
    top: node.scrollTop,
    height: node.clientHeight,
    space: Number.parseFloat((node as HTMLElement).style.getPropertyValue('--prompt-turn-space')),
  }));
  expect(initial.space).toBeGreaterThan(initial.height * 0.7);
  await recordSamples(info, 'prompt-initial-geometry', initial);
  await shot(page, info, 'prompt-01-question-at-top.png');
  const short = '## 從提問下面開始回答\n\n先留白，慢慢長出回覆。\n\n';
  await partial(page, short);
  await ready(page);
  expect(await scrollPosition(page)).toBeCloseTo(initial.top, 0);
  const remaining = await page
    .locator('#messages')
    .evaluate((node) =>
      Number.parseFloat((node as HTMLElement).style.getPropertyValue('--prompt-turn-space')),
    );
  expect(remaining).toBeLessThan(initial.space);
  expect(remaining).toBeGreaterThan(0);
  await shot(page, info, 'prompt-02-short-reply.png');
  const long = short + '內容變長也不強迫移動閱讀位置。'.repeat(120) + '\n\n';
  await partial(page, long);
  const savedLong = replyEvent(24, long.trim());
  events.push(savedLong);
  await emit(page, 'event', savedLong);
  await partial(page, '');
  await ready(page);
  expect(await scrollPosition(page)).toBeCloseTo(initial.top, 0);
  await expect(page.locator('#jump-live')).toHaveClass(/visible/);
  await shot(page, info, 'prompt-03-long-reply-held.png');
  await page.locator('#jump-live').click();
  await expect
    .poll(() =>
      page
        .locator('#messages')
        .evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
    )
    .toBeLessThan(3);
  await shot(page, info, 'prompt-04-manual-latest.png');
  await openScrollSettings(page);
  await page.locator('#btn-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#btn-settings-close').click();
  await page.locator('#input').fill('下一輪也從上面開始');
  await send.click();
  await emit(page, 'event', events.at(-1));
  await expect
    .poll(() =>
      page
        .locator('.msg-user')
        .last()
        .evaluate(
          (node) =>
            node.getBoundingClientRect().top -
            document.getElementById('messages')!.getBoundingClientRect().top,
        ),
    )
    .toBeCloseTo(12, 0);
  await shot(page, info, 'prompt-05-next-turn.png');
  await page.setViewportSize({ width: 390, height: 550 });
  await expect
    .poll(() =>
      page
        .locator('.msg-user')
        .last()
        .evaluate(
          (node) =>
            node.getBoundingClientRect().top -
            document.getElementById('messages')!.getBoundingClientRect().top,
        ),
    )
    .toBeCloseTo(12, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator('.msg-user')
        .last()
        .evaluate(
          (node) =>
            node.getBoundingClientRect().top -
            document.getElementById('messages')!.getBoundingClientRect().top,
        ),
    )
    .toBeCloseTo(12, 0);
  await page.locator('#messages').hover();
  await page.mouse.wheel(0, -280);
  await expect
    .poll(() =>
      page
        .locator('.msg-user')
        .last()
        .evaluate(
          (node) =>
            node.getBoundingClientRect().top -
            document.getElementById('messages')!.getBoundingClientRect().top,
        ),
    )
    .toBeGreaterThan(100);
  const readerTop = await scrollPosition(page);
  await partial(page, '## 讀者已往上看歷史\n\n不搶回視窗。\n\n');
  await ready(page);
  expect(await scrollPosition(page)).toBeCloseTo(readerTop, 0);
  await shot(page, info, 'prompt-06-history-still-accessible.png');
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

async function thinkingDisclosureWalkthrough(page: Page, info: TestInfo) {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const { events, errors } = await setup(page, scrollHistory(), false);
  await page.locator('#input').fill('展開 thinking 後收合，保持這一輪的位置');
  await page.locator('#btn-send').click();
  await emit(page, 'event', events.at(-1));
  const messages = page.locator('#messages');
  await expect(messages).toHaveAttribute('data-prompt-turn', 'active');
  await expect(messages).not.toHaveAttribute('data-prompt-motion', /.+/);
  await emit(page, 'busy', { busy: true });
  const thought = '先確認問題，再保留閱讀位置。\n\n'.repeat(5);
  await partial(page, '## 回覆仍在進行\n\n不移動提問。\n\n', thought);
  await expect(page.locator('#partial-thinking .event-body p')).toHaveCount(5);
  await shot(page, info, 'thinking-toggle-01-collapsed.png');
  const top = await scrollPosition(page);
  const samples: unknown[] = [];
  for (const stage of ['partial', 'durable']) {
    if (stage === 'durable') {
      const saved = replyEvent(24, thought.trim(), '', 'thinking');
      events.push(saved);
      await emit(page, 'event', saved);
    }
    const detail = page
      .locator(stage === 'partial' ? '#partial-thinking' : '.event.thinking:not(.partial)')
      .last();
    const summary = detail.locator('summary');
    const baseline = (await summary.boundingBox())!.y;
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(
        await summary.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return hit === node || node.contains(hit);
        }),
      ).toBe(true);
      await summary.click();
      await expect(detail).toHaveAttribute('open', '');
      await ready(page);
      expect(await scrollPosition(page)).toBeCloseTo(top, 0);
      expect((await summary.boundingBox())!.y).toBeCloseTo(baseline, 0);
      if (cycle === 0) await shot(page, info, `thinking-toggle-${stage}-expanded.png`);
      await summary.click();
      await expect(detail).not.toHaveAttribute('open', '');
      const after = await messages.evaluate(async (node) => {
        const samples = [];
        for (let i = 0; i < 8; i++) {
          await new Promise(requestAnimationFrame);
          samples.push({
            top: node.scrollTop,
            space: (node as HTMLElement).style.getPropertyValue('--prompt-turn-space'),
          });
        }
        return samples;
      });
      samples.push({ stage, cycle, after });
      expect(after.every((sample) => Math.abs(sample.top - top) <= 1)).toBe(true);
      expect((await summary.boundingBox())!.y).toBeCloseTo(baseline, 0);
      await expect(page.locator('#jump-live')).not.toHaveClass(/visible/);
      if (cycle === 0) await shot(page, info, `thinking-toggle-${stage}-collapsed.png`);
    }
    // Keyboard activation must preserve the same disclosure geometry too.
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(detail).toHaveAttribute('open', '');
    await page.keyboard.press('Space');
    await expect(detail).not.toHaveAttribute('open', '');
    await expect.poll(() => scrollPosition(page)).toBeCloseTo(top, 0);
  }
  await recordSamples(info, 'thinking-disclosure-geometry', samples);
  // A genuine history-reading gesture still releases the prompt anchor.
  await messages.hover();
  await page.mouse.wheel(0, -240);
  await expect.poll(() => scrollPosition(page)).toBeLessThan(top - 100);
  const readerTop = await scrollPosition(page);
  await partial(page, '## 仍繼續回覆\n\n不搶回已選擇的歷史位置。\n\n');
  await ready(page);
  expect(await scrollPosition(page)).toBeCloseTo(readerTop, 0);
  await shot(page, info, 'thinking-toggle-06-reader-history.png');
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
}

test('prompt turn thinking disclosure stays in place through repeated expand and collapse', async ({
  page,
}, info) => {
  await thinkingDisclosureWalkthrough(page, info);
});

test('prompt turn thinking disclosure stays in place on tablet', async ({
  browser,
  baseURL,
}, info) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1024, height: 768 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    recordVideo: { dir: info.outputPath('tablet-video'), size: { width: 1024, height: 768 } },
  });
  try {
    await thinkingDisclosureWalkthrough(await context.newPage(), info);
  } finally {
    await context.close();
  }
});

test('prompt turn late acknowledgement cannot drag a reader who chose older history', async ({
  page,
}) => {
  const { events } = await setup(page, scrollHistory());
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/messages', async (route) => {
    const event = replyEvent(23, route.request().postDataJSON().text, 'user');
    events.push(event);
    await gate;
    await route.fulfill({ json: { ok: true, eventId: event.id } });
  });
  await page.locator('#input').fill('延後確認的 prompt');
  await page.locator('#btn-send').click();
  await expect.poll(() => events.length).toBe(23);
  await emit(page, 'event', events.at(-1));
  await page.locator('#messages').hover();
  const before = await scrollPosition(page);
  await page.mouse.wheel(0, -260);
  await expect.poll(() => scrollPosition(page)).toBeLessThan(before - 100);
  const chosen = await scrollPosition(page);
  release();
  await expect
    .poll(() =>
      page.evaluate(() =>
        performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('/messages')),
      ),
    )
    .toBe(true);
  await expect(page.locator('#messages')).not.toHaveAttribute('data-prompt-turn', 'active');
  expect(await scrollPosition(page)).toBeCloseTo(chosen, 0);
});

test('prompt turn follows overflow only when auto-scroll is enabled', async ({ page }) => {
  const { events } = await setup(page, scrollHistory(), true);
  await page.locator('#input').fill('啟用跟隨仍先把提問置頂');
  await page.locator('#btn-send').click();
  await emit(page, 'event', events.at(-1));
  await expect
    .poll(() =>
      page
        .locator('.msg-user')
        .last()
        .evaluate(
          (node) =>
            node.getBoundingClientRect().top -
            document.getElementById('messages')!.getBoundingClientRect().top,
        ),
    )
    .toBeCloseTo(12, 0);
  await partial(page, '## 開啟跟隨\n\n' + '回覆超過一頁後可以繼續跟隨。'.repeat(120) + '\n\n');
  await ready(page);
  await expect
    .poll(() =>
      page
        .locator('#messages')
        .evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
    )
    .toBeLessThan(3);
});

test('auto-scroll setting persists and turning it OFF fences pending image completion', async ({
  page,
}, info) => {
  const { errors } = await setup(page, scrollHistory());
  let toggle = await openScrollSettings(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => localStorage.getItem('piweb.autoScroll'))).toBe('true');
  await shot(page, info, 'scroll-04-enabled.png');
  await page.locator('#btn-settings-close').click();
  await page.reload();
  await expect(page.locator('#session-name')).toHaveText('漸層顯示測試');
  toggle = await openScrollSettings(page);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.locator('#btn-settings-close').click();
  let release!: () => void;
  let requested = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/media/scroll-setting.svg', async (route) => {
    requested = true;
    await held;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#365e84"/></svg>',
    });
  });
  await partial(page, '## 圖片準備中\n\n![等待圖片](/media/scroll-setting.svg)\n\n');
  await expect.poll(() => requested).toBe(true);
  toggle = await openScrollSettings(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.locator('#btn-settings-close').click();
  const before = await scrollPosition(page);
  release();
  await expect(page.locator('#partial-msg img')).toBeAttached();
  await ready(page);
  expect(await scrollPosition(page)).toBeCloseTo(before, 0);
  await shot(page, info, 'scroll-05-pending-image-held.png');
  expect(errors).toEqual([]);
});

test('prompt turn waits for keyboard viewport quiet and scrolls upward smoothly', async ({
  page,
}, info) => {
  await keyboardBoundary(page);
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  const { events, errors } = await setup(page, scrollHistory());
  await page.evaluate(() => (window as any).__setKeyboard(500));
  await page.locator('#input').fill('等 iPhone 鍵盤收好，再平滑帶到這輪提問');
  await startPromptMotionSamples(page);
  const before = await scrollPosition(page);
  await page.locator('#btn-send').click();
  await emit(page, 'event', events.at(-1));
  await page.evaluate(() => {
    const host = window as any;
    setTimeout(() => host.__setKeyboard(650, 20), 130);
    setTimeout(() => host.__setKeyboard(800, 10), 280);
    setTimeout(() => host.__setKeyboard(844, 4), 410);
    setTimeout(() => host.__setKeyboard(844, 0), 500);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__keyboardReports.at(-1).height))
    .toBe(844);
  await expect(page.locator('#messages')).not.toHaveAttribute('data-prompt-motion', /.+/);
  await expect
    .poll(() =>
      page
        .locator('.msg-user')
        .last()
        .evaluate(
          (node) =>
            node.getBoundingClientRect().top -
            document.getElementById('messages')!.getBoundingClientRect().top,
        ),
    )
    .toBeCloseTo(12, 0);
  const data = await finishPromptMotionSamples(page);
  const lastReport = data.keyboard.at(-1).time;
  const moving = data.samples.filter((s: any) => s.top > before + 2);
  expect(moving[0].time).toBeGreaterThanOrEqual(lastReport + 100);
  const steps = data.samples.filter(
    (s: any, i: number, all: any[]) => i && s.top > all[i - 1].top + 1,
  );
  expect(steps.length).toBeGreaterThan(10);
  expect(
    data.samples.every((s: any, i: number, all: any[]) => !i || s.top >= all[i - 1].top - 1),
  ).toBe(true);
  expect(
    Math.max(...steps.map((s: any) => s.top - data.samples[data.samples.indexOf(s) - 1].top)),
  ).toBeLessThan(120);
  await recordSamples(info, 'keyboard-smooth-scroll', data);
  // Clearing a two-line draft legitimately resizes the composer once. The
  // simulated visualViewport reports themselves must not resize the layout shell.
  const closingStart = data.keyboard.find((r: any) => r.height === 650).time;
  expect(
    new Set(data.samples.filter((s: any) => s.time >= closingStart).map((s: any) => s.height)).size,
  ).toBe(1);
  await shot(page, info, 'motion-01-keyboard-settled-prompt-at-top.png');
  await partial(page, '## 從這輪下面開始\n\n鍵盤收合後，平滑向上。不搶讀者的位置。\n\n');
  await ready(page);
  await shot(page, info, 'motion-02-ready-reply.png');
  await openScrollSettings(page);
  await page.locator('#btn-theme').click();
  await page.locator('#btn-settings-close').click();
  await page.locator('#input').fill('淺色也平滑開始下一輪');
  await page.locator('#btn-send').click();
  await emit(page, 'event', events.at(-1));
  // A negative motion attribute can already be true before the HTTP ack.
  // Correlate this new row and its final geometry before declaring it settled.
  await expect(page.locator('.msg-user').last()).toContainText('淺色也平滑開始下一輪');
  await expect
    .poll(() =>
      page
        .locator('.msg-user')
        .last()
        .evaluate(
          (node) =>
            node.getBoundingClientRect().top -
            document.getElementById('messages')!.getBoundingClientRect().top,
        ),
    )
    .toBeCloseTo(12, 0);
  await expect(page.locator('#messages')).not.toHaveAttribute('data-prompt-motion', /.+/);
  await shot(page, info, 'motion-03-light-next-turn.png');
  const beforeWheel = await scrollPosition(page);
  await page.locator('#messages').hover();
  await page.mouse.wheel(0, -220);
  await expect.poll(() => scrollPosition(page)).toBeLessThan(beforeWheel - 100);
  const readerTop = await scrollPosition(page);
  await partial(page, '## 讀者自己向上看\n\n不把讀者拉回。\n\n');
  await ready(page);
  expect(await scrollPosition(page)).toBeCloseTo(readerTop, 0);
  await shot(page, info, 'motion-04-reader-keeps-control.png');
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('prompt turn enabled following cannot snap or interrupt its send animation', async ({
  page,
}, info) => {
  const { events } = await setup(page, scrollHistory(), true);
  await page.locator('#input').fill('跟隨開啟也不能把送出動畫直接跳完');
  await startPromptMotionSamples(page);
  const before = await scrollPosition(page);
  await page.locator('#btn-send').click();
  await emit(page, 'event', events.at(-1));
  await partial(page, '送出動畫進行時到達的短回覆。\n\n');
  await expect(page.locator('#messages')).not.toHaveAttribute('data-prompt-motion', /.+/);
  const data = await finishPromptMotionSamples(page);
  const steps = data.samples.filter(
    (s: any, i: number, all: any[]) => i && s.top > all[i - 1].top + 1,
  );
  expect(steps.length).toBeGreaterThan(8);
  expect(
    Math.max(...steps.map((s: any) => s.top - data.samples[data.samples.indexOf(s) - 1].top)),
  ).toBeLessThan(120);
  expect(await scrollPosition(page)).toBeGreaterThan(before + 300);
  await recordSamples(info, 'enabled-follow-send-motion', data);
});

test('prompt turn composer refocus cancels the in-flight send animation', async ({ page }) => {
  const { events } = await setup(page, scrollHistory());
  await page.locator('#input').fill('送出後再點輸入框，不能繼續搶捲動');
  await page.locator('#btn-send').click();
  await emit(page, 'event', events.at(-1));
  await expect(page.locator('#messages')).toHaveAttribute('data-prompt-motion', 'moving');
  await page.locator('#input').focus();
  expect(await page.locator('#messages').getAttribute('data-prompt-motion')).toBeNull();
  const chosen = await scrollPosition(page);
  await partial(page, '下一個草稿由讀者接手，停止舊動畫。\n\n');
  await ready(page);
  expect(await scrollPosition(page)).toBeCloseTo(chosen, 0);
});

test('prompt turn reduced motion waits for the keyboard without autonomous scrolling frames', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await keyboardBoundary(page);
  const { events } = await setup(page, scrollHistory());
  await page.evaluate(() => (window as any).__setKeyboard(500));
  await page.locator('#input').fill('減少動態效果仍等待鍵盤收合');
  await startPromptMotionSamples(page);
  await page.locator('#btn-send').click();
  await emit(page, 'event', events.at(-1));
  await page.evaluate(() => {
    setTimeout(() => (window as any).__setKeyboard(844), 350);
  });
  await expect(page.locator('#messages')).not.toHaveAttribute('data-prompt-motion', /.+/);
  const data = await finishPromptMotionSamples(page);
  const steps = data.samples.filter(
    (s: any, i: number, all: any[]) => i && s.top > all[i - 1].top + 1,
  );
  expect(steps.length).toBe(1);
  expect(steps[0].time).toBeGreaterThanOrEqual(data.keyboard.at(-1).time + 100);
  await recordSamples(info, 'reduced-keyboard-placement', data);
});
