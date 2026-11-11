import { expect, test, type Page } from 'playwright/test';

// 「120fps 泡泡看起來有點瑕疵」 (iPhone recording, 2026-11-11): mid-spring,
// a line of the bubble moving on the compositor was cut out of the still
// drawing and moved as a strip. It showed seams, lost its rim and glow where it
// was cut, squashed its rounded ends, and kept the corners of where it would
// rest. Now the bubble is built from parts that only move and scale, and every
// frame of the spring must draw the outline the spring puts there. These checks
// freeze the compositor's animations on 120Hz frames and compare what is drawn
// with that outline (bubble.shapeAt), pixel by pixel.

const FRAME = 1000 / 120;
const START = ['p1', 13] as const;
type End = readonly [string, number];

// Down through every block, a few characters a frame.
const SWEEP: [number, End][] = [
  ...[30, 40, 50, 60].map((o): End => ['p1', o]),
  ...[1, 3, 5].map((o): End => ['h', o]),
  ...[10, 20, 30, 40, 50, 60].map((o): End => ['li1', o]),
  ...[8, 16, 24, 32, 40, 48, 56].map((o): End => ['li2', o]),
].map((end, i) => [1000 + i * 16.7, end]);
// Where the end of the selection goes, and when (ms on the bubble's clock).
// The last step is the one whose frames are compared; a step at least 500ms
// after the one before starts from a settled bubble.
const DRAGS: Record<string, [number, End][]> = {
  // As in the recording: up out of the list into the heading above it.
  'up out of the list into the heading': [
    [0, ['li1', 8]],
    [1000, ['li1', 0]],
    [1050, ['h', 5]],
  ],
  'down out of the heading into the list': [
    [0, ['h', 5]],
    [1000, ['li1', 4]],
    [1033, ['li1', 14]],
  ],
  'along a line, past the end of the line above': [
    [0, ['p1', 30]],
    [1000, ['p1', 44]],
    [1033, ['p1', 56]],
  ],
  'up past a shorter line': [
    [0, ['li1', 30]],
    [1000, ['p1', 55]],
  ],
  // A finger moving every frame: lines pour and drain while the end slides.
  'a drag across four lines, one move per frame': [
    [0, ['li1', 40]],
    ...Array.from({ length: 30 }, (_, i): [number, End] => {
      const ends: End[] = [
        ...[36, 30, 24, 18, 12, 6, 0].map((o): End => ['li1', o]),
        ...[5, 4, 3, 2, 1, 0].map((o): End => ['h', o]),
        ...Array.from({ length: 17 }, (_, k): End => ['p1', 56 - k * 2]),
      ];
      return [1000 + i * 16.7, ends[i]];
    }),
  ],
  // 「現在無敵卡」 (2026-11-11): a finger sweeping down a long selection puts
  // many lines in motion at once, and that motion is drawn frame by frame.
  'a sweep down the whole message, one move per frame': [[0, ['p1', 20]], ...SWEEP],
};
const FRAMES = [0, 1, 2, 3, 4, 6, 8, 10, 13, 17, 24, 32];

test.use({ viewport: { width: 430, height: 700 } });

/** Pixels the bubble covers that its outline does not, and the reverse, away from the outline's edge. */
async function mismatch(page: Page, shots: { base: Buffer; bubble: Buffer; outline: Buffer }) {
  return page.evaluate(
    async ({ base, bubble, outline }) => {
      const pixels = async (b64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [b, d, o] = await Promise.all([pixels(base), pixels(bubble), pixels(outline)]);
      const { width, height } = b;
      // Drawn: the fill shows over the page (the faint glow does not reach
      // the threshold). Inside: the outline, filled green.
      const drawn = new Uint8Array(width * height);
      const inside = new Uint8Array(width * height);
      for (let p = 0; p < width * height; p++) {
        let diff = 0;
        for (let c = 0; c < 3; c++) diff = Math.max(diff, Math.abs(d.data[p * 4 + c] - b.data[p * 4 + c]));
        drawn[p] = diff > 30 ? 1 : 0;
        inside[p] = o.data[p * 4 + 1] > 128 && o.data[p * 4] < 100 ? 1 : 0;
      }
      let off = 0;
      let covered = 0;
      // The first few, as x:y:drawn:inside, to say where a failure is.
      const where: number[][] = [];
      for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
          const p = y * width + x;
          covered += inside[p];
          // Within 2px of the outline, antialiasing and the rim decide.
          let edge = false;
          for (let dy = -2; dy <= 2 && !edge; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (inside[p + dy * width + dx] !== inside[p]) {
                edge = true;
                break;
              }
            }
          }
          if (!edge && drawn[p] !== inside[p]) {
            off += 1;
            if (where.length < 12) where.push([x, y, drawn[p], inside[p]]);
          }
        }
      }
      return { off, covered, where };
    },
    {
      base: shots.base.toString('base64'),
      bubble: shots.bubble.toString('base64'),
      outline: shots.outline.toString('base64'),
    },
  );
}

for (const [name, steps] of Object.entries(DRAGS)) {
  test(`every 120Hz frame draws the spring's outline: ${name}`, async ({ page }, info) => {
    await page.goto('/fixtures/selection-bubble-frames.html?theme=dark');
    await page.waitForFunction(() => (window as any).bubbleFramesReady);
    let last = 0;
    for (const [i, [time, end]] of steps.entries()) {
      await page.evaluate(
        ([t, from, to]) => {
          const frames = (window as any).bubbleFrames;
          frames.at(1000 + t);
          frames.set(from, to);
        },
        [time, START, end] as const,
      );
      last = 1000 + time;
      if (i < steps.length - 1 && steps[i + 1][0] - time >= 500) {
        await page.evaluate(() => (window as any).bubbleFrames.settle());
      }
    }
    await page.evaluate(() => {
      document.documentElement.classList.add('text-hidden');
      document.body.insertAdjacentHTML(
        'beforeend',
        '<svg id="outline" style="position:fixed;left:0;top:0;width:430px;height:700px;pointer-events:none;display:none"><path fill="#0f0" stroke="none" /></svg>',
      );
    });
    const clip = { x: 0, y: 0, width: 430, height: 160 };
    const layer = page.locator('.sel-bubble-layer');
    await layer.evaluate((element: HTMLElement) => (element.style.visibility = 'hidden'));
    const base = await page.screenshot({ clip });
    const results = [];
    for (const k of FRAMES) {
      const shape = await page.evaluate(
        ([at, ms]) => {
          const frames = (window as any).bubbleFrames;
          frames.freeze(at);
          return frames.shapeAt(ms) as string;
        },
        [last + k * FRAME, k * FRAME] as const,
      );
      await layer.evaluate((element: HTMLElement) => (element.style.visibility = ''));
      const bubble = await page.screenshot({ clip });
      await layer.evaluate((element: HTMLElement) => (element.style.visibility = 'hidden'));
      await page.evaluate((d) => {
        const svg = document.getElementById('outline')!;
        svg.style.display = '';
        svg.querySelector('path')!.setAttribute('d', d);
      }, shape);
      const outline = await page.screenshot({ clip });
      await page.evaluate(() => (document.getElementById('outline')!.style.display = 'none'));
      const { off, covered, where } = await mismatch(page, { base, bubble, outline });
      results.push({ frame: k, off, covered, where: where.map((w) => w.join(':')).join(' ') });
      if (off > 0) await info.attach(`frame-${k}.png`, { body: bubble, contentType: 'image/png' });
    }
    // The check can fail: the outline covers the selection on every frame.
    for (const { covered } of results) expect(covered).toBeGreaterThan(500);
    expect(results.filter(({ off }) => off > 0)).toEqual([]);
  });
}

/** The pieces in motion now, and when each started. */
async function running(page: Page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => (animation.effect as KeyframeEffect)?.target instanceof Element && ((animation.effect as KeyframeEffect).target as Element).matches('.sel-bubble-piece'))
      .map((animation) => Number(animation.startTime)),
  );
}

async function drag(page: Page, steps: [number, End][], each?: () => Promise<void>) {
  await page.goto('/fixtures/selection-bubble-frames.html?theme=dark');
  await page.waitForFunction(() => (window as any).bubbleFramesReady);
  for (const [i, [time, end]] of steps.entries()) {
    await page.evaluate(
      ([t, from, to]) => {
        const frames = (window as any).bubbleFrames;
        frames.at(1000 + t);
        frames.set(from, to);
      },
      [time, START, end] as const,
    );
    if (i === 0) await page.evaluate(() => (window as any).bubbleFrames.settle());
    else await each?.();
  }
}

test('a sweep down a long selection never puts more than a few lines of parts in motion', async ({ page }) => {
  // Every part of every moving line was planned and restarted on each move: on
  // a long selection a move cost 17ms on desktop and the phone fell far behind.
  let most = 0;
  await drag(page, DRAGS['a sweep down the whole message, one move per frame'], async () => {
    most = Math.max(most, (await running(page)).length);
  });
  expect(most).toBeLessThanOrEqual(40);
});

test('after a change mid-spring, every piece in motion starts again together', async ({ page }) => {
  // Parts only fit together while their animations run on one clock; one kept
  // playing from an earlier change could drift from a neighbour started now.
  const starts = new Set<number>();
  await drag(page, DRAGS['a drag across four lines, one move per frame'], async () => {
    const now = await running(page);
    if (now.length) starts.add(new Set(now).size);
  });
  expect([...starts]).toEqual([1]);
});

test('a fast drag down and back keeps every line inside the bubble on every frame', async ({ page }) => {
  // 「這個會閃爍」 (2026-11-12): a line poured out of its neighbour's edge while
  // that neighbour still grew was overrun by it. The band above was cut where
  // the line began, so the rest of that neighbour fell outside the outline: a
  // dark slit flashed through the bubble for a few frames.
  const ends: End[] = [
    ...[30, 45, 60].map((o): End => ['p1', o]),
    ...[2, 5].map((o): End => ['h', o]),
    ...[10, 25, 40, 55].map((o): End => ['li1', o]),
    ...[10, 25, 40, 56].map((o): End => ['li2', o]),
  ];
  const path = [...ends, ...[...ends].reverse().slice(1), ...ends.slice(1)];
  await page.goto('/fixtures/selection-bubble-frames.html?theme=dark');
  await page.waitForFunction(() => (window as any).bubbleFramesReady);
  const missed = await page.evaluate(
    ([path, start, frame]) => {
      const f = (window as any).bubbleFrames;
      f.at(1000);
      f.set(start, ['p1', 20]);
      f.settle();
      const context = new OffscreenCanvas(1, 1).getContext('2d')!;
      const found: string[] = [];
      path.forEach((end, i) => {
        f.at(2000 + i * (1000 / 60));
        f.set(start, end);
        for (let k = 0; k <= 12; k++) {
          const outline = new Path2D(f.shapeAt(k * frame));
          // Every line big enough to be drawn, a pixel in from its edges.
          for (const line of f.linesAt(k * frame) as { l: number; r: number; t: number; b: number }[]) {
            if (line.r - line.l < 4 || line.b - line.t < 4) continue;
            let out = 0;
            for (let y = line.t + 1; y <= line.b - 1; y += 1) {
              for (let x = line.l + 1; x <= line.r - 1; x += 2) if (!context.isPointInPath(outline, x, y)) out += 1;
            }
            if (out) found.push(`step ${i} frame ${k}: ${out} points of the line at ${Math.round(line.t)}-${Math.round(line.b)} outside`);
          }
        }
      });
      return found;
    },
    [path, START, FRAME] as const,
  );
  expect(missed).toEqual([]);
});
