import { describe, expect, it } from 'vitest';
import {
  advanceRevealFront,
  advanceRevealPace,
  buildRevealRows,
  revealRowAt,
  createRevealPace,
  noteRevealArrival,
  stableMarkdownBoundary,
} from '../public/streaming-rich.js';

function exercisePace(phases: { duration: number; growth: number }[]) {
  const pace = createRevealPace();
  noteRevealArrival(pace, 100, 0);
  let length = 100;
  let now = 0;
  const results: number[] = [];
  for (const phase of phases) {
    for (let time = 0; time < phase.duration; time += 20) {
      now += 20;
      if (now % 200 === 0) noteRevealArrival(pace, (length += phase.growth), now);
      advanceRevealPace(pace, { now, elapsed: 20, front: 100, goal: 400, pixelsPerChar: 1 });
    }
    results.push(pace.speed);
  }
  return { pace, results, now };
}

describe('reading-order row geometry', () => {
  it('merges inline pieces into real rows without character wrappers', () => {
    const rows = buildRevealRows(
      [
        { top: 2, bottom: 20, left: 5, right: 100 },
        { top: 3, bottom: 20, left: 100, right: 180 },
        { top: 26, bottom: 44, left: 5, right: 290 },
      ],
      48,
    );
    expect(rows).toEqual([
      { top: 0, bottom: 23, left: 5, right: 180, kind: 'text' },
      { top: 23, bottom: 48, left: 5, right: 290, kind: 'text' },
    ]);
  });

  it('scans X within a row before moving to the next row', () => {
    const rows = buildRevealRows(
      [
        { top: 0, bottom: 20, left: 0, right: 200 },
        { top: 20, bottom: 40, left: 0, right: 300 },
      ],
      40,
    );
    const early = revealRowAt(rows, 5);
    const later = revealRowAt(rows, 15);
    expect(early.index).toBe(0);
    expect(later.index).toBe(0);
    expect(later.front).toBeGreaterThan(early.front);
    expect(later.top).toBe(0);
    expect(later.height).toBe(20);
    expect(revealRowAt(rows, 20)).toMatchObject({ index: 1, top: 20, front: -56 });
    expect(revealRowAt(rows, -1).mode).toBe('hidden');
    expect(revealRowAt(rows, 40).mode).toBe('ready');
  });

  it('spends cold-start feather distance inside the first horizontal row', () => {
    const rows = buildRevealRows([{ top: 0, bottom: 20, left: 0, right: 200 }], 20);
    expect(revealRowAt(rows, -56, 56)).toMatchObject({ mode: 'rows', index: 0, front: -56 });
    expect(revealRowAt(rows, -28, 56).front).toBeGreaterThan(-56);
    expect(revealRowAt(rows, 20, 56).mode).toBe('ready');
  });

  it('keeps a media region distinct from text and handles empty geometry', () => {
    const rows = buildRevealRows(
      [
        { top: 0, bottom: 20, left: 0, right: 100 },
        { top: 30, bottom: 130, left: 0, right: 320, kind: 'media' },
        { top: 140, bottom: 160, left: 0, right: 200 },
      ],
      160,
    );
    expect(revealRowAt(rows, 80)).toMatchObject({ mode: 'media', index: 1, top: 25, height: 110 });
    expect(revealRowAt([], 0).mode).toBe('ready');
    expect(buildRevealRows([{ top: 0, bottom: 0, left: 0, right: 0 }], 0)).toEqual([]);
  });
});

describe('adaptive text-arrival pacing', () => {
  it('accelerates and decelerates for slow → fast → slow → fast at equal backlog', () => {
    expect(createRevealPace).toBeTypeOf('function');
    const { results } = exercisePace([
      { duration: 1800, growth: 8 },
      { duration: 2400, growth: 80 },
      { duration: 3000, growth: 8 },
      { duration: 2400, growth: 80 },
    ]);
    const [slow, fast, slowed, faster] = results;
    expect(slow).toBeLessThan(80);
    expect(fast).toBeGreaterThan(slow * 3);
    expect(slowed).toBeLessThan(fast / 2);
    expect(faster).toBeGreaterThan(slowed * 3);
  });

  it('smooths a speed change instead of snapping to the newest arrival rate', () => {
    expect(createRevealPace).toBeTypeOf('function');
    const pace = createRevealPace();
    noteRevealArrival(pace, 100, 0);
    noteRevealArrival(pace, 300, 200);
    const next = advanceRevealPace(pace, {
      now: 200,
      elapsed: 16,
      front: 0,
      goal: 500,
      pixelsPerChar: 1,
    });
    expect(next).toBeGreaterThan(120);
    expect(next).toBeLessThan(150);
  });

  it('does not infer an infinite decode rate from the initial snapshot', () => {
    expect(createRevealPace).toBeTypeOf('function');
    const pace = createRevealPace();
    noteRevealArrival(pace, 10_000, 0);
    expect(
      advanceRevealPace(pace, {
        now: 16,
        elapsed: 16,
        front: 0,
        goal: 300,
        pixelsPerChar: 1,
      }),
    ).toBe(120);
  });

  it('ignores duplicates and shrink/regrow revisions instead of faking new input', () => {
    expect(createRevealPace).toBeTypeOf('function');
    const normal = createRevealPace();
    const revised = createRevealPace();
    for (const pace of [normal, revised]) {
      noteRevealArrival(pace, 100, 0);
      noteRevealArrival(pace, 200, 1000);
    }
    noteRevealArrival(revised, 200, 1100);
    noteRevealArrival(revised, 150, 1200);
    noteRevealArrival(revised, 200, 1300);
    const state = { now: 1400, elapsed: 16, front: 0, goal: 300, pixelsPerChar: 1 };
    expect(advanceRevealPace(revised, state)).toBe(advanceRevealPace(normal, state));
  });

  it('slows during an input pause but drains normally after finalization', () => {
    expect(createRevealPace).toBeTypeOf('function');
    const { pace, now } = exercisePace([{ duration: 2400, growth: 80 }]);
    const fast = pace.speed;
    for (let time = now + 20; time <= now + 3000; time += 20)
      advanceRevealPace(pace, { now: time, elapsed: 20, front: 100, goal: 400, pixelsPerChar: 1 });
    expect(pace.speed).toBeLessThan(fast / 2);
    for (let time = now + 3020; time <= now + 4500; time += 20)
      advanceRevealPace(pace, {
        now: time,
        elapsed: 20,
        front: 100,
        goal: 400,
        pixelsPerChar: 1,
        complete: true,
      });
    expect(pace.speed).toBeGreaterThan(115);
  });

  it('calibrates visual density without adding any fictitious source arrival', () => {
    expect(createRevealPace).toBeTypeOf('function');
    const compact = createRevealPace();
    const tall = createRevealPace();
    for (const pace of [compact, tall]) {
      noteRevealArrival(pace, 100, 0);
      noteRevealArrival(pace, 200, 1000);
    }
    for (let now = 1000; now <= 1500; now += 20) {
      advanceRevealPace(compact, { now, elapsed: 20, front: 0, goal: 500, pixelsPerChar: 1 });
      advanceRevealPace(tall, { now, elapsed: 20, front: 0, goal: 500, pixelsPerChar: 2 });
    }
    expect(tall.speed).toBeGreaterThan(compact.speed * 1.4);
    expect(tall.samples).toEqual(compact.samples);
  });

  it('keeps recent acceleration accurate above the retained-sample frequency', () => {
    const pace = createRevealPace();
    let length = 100;
    noteRevealArrival(pace, length, 0);
    for (let now = 5; now <= 11_000; now += 5) {
      length += now <= 10_000 ? 1 : 5;
      noteRevealArrival(pace, length, now);
      advanceRevealPace(pace, { now, elapsed: 5, front: 0, goal: 500, pixelsPerChar: 0.1 });
    }
    // The recent 1200ms, not the preceding ten seconds of slow history.
    expect(pace.speed).toBeGreaterThan(55);
    expect(pace.samples.length).toBeLessThanOrEqual(64);
  });

  it('coalesces zero-time bursts and bounds retained samples', () => {
    expect(createRevealPace).toBeTypeOf('function');
    const pace = createRevealPace();
    noteRevealArrival(pace, 100, 0);
    noteRevealArrival(pace, 200, 0);
    expect(advanceRevealPace(pace, { now: 16, elapsed: 16, front: 0, goal: 300 })).toBe(120);
    for (let now = 1; now <= 1000; now++) noteRevealArrival(pace, 200 + now, now);
    expect(pace.samples.length).toBeLessThanOrEqual(64);
    expect(
      Number.isFinite(advanceRevealPace(pace, { now: 1000, elapsed: 16, front: 0, goal: 300 })),
    ).toBe(true);
  });
});

describe('one continuous reveal frontier', () => {
  it('advances in pixels without restarting when prepared content extends the goal', () => {
    const first = advanceRevealFront(120, 240, 16, 120);
    expect(first).toBeCloseTo(121.92);
    expect(advanceRevealFront(first, 600, 16, 120)).toBeCloseTo(123.84);
  });

  it('never rewinds when responsive layout shortens the goal', () => {
    expect(advanceRevealFront(240, 180, 16, 120)).toBe(240);
    expect(advanceRevealFront(240, 300, -16, 120)).toBe(240);
  });

  it('caps suspended-tab gaps instead of jumping across unseen content', () => {
    expect(advanceRevealFront(120, 600, 30_000, 120)).toBeCloseTo(125.76);
    expect(advanceRevealFront(238, 240, 48, 120)).toBe(240);
  });
});

describe('stable streaming Markdown boundary', () => {
  it('buffers an unfinished paragraph and releases completed blocks', () => {
    expect(stableMarkdownBoundary('**尚未完成')).toBe(0);
    const prefix = '# 已完成\n\n';
    expect(stableMarkdownBoundary(`${prefix}還在寫`)).toBe(prefix.length);
    expect(stableMarkdownBoundary('一段\n \t\n下一段')).toBe('一段\n \t\n'.length);
  });

  it.each([
    '[[image: /tmp/chart.png]]',
    '圖片：[[video: /tmp/clip.mp4]] 下面還有說明。',
    '[[file: "relative/report.pdf"]]',
    '[[IMAGE : https://example.org/chart.png]]',
    '[[image: /media/already-published.png]]',
    '[[image: /tmp/unclosed.png\n\n',
  ])(
    'holds transport-owned media markers without invalidating earlier read blocks: %s',
    (marker) => {
      const prefix = '# 已讀內容\n\n';
      expect(stableMarkdownBoundary(prefix + marker + '\n\n之後的段落。\n\n')).toBe(prefix.length);
    },
  );

  it('keeps ordinary Markdown images streamable before reply delivery', () => {
    const source = '# 已讀內容\n\n![chart](/media/chart.png)\n\n後面的段落。\n\n';
    expect(stableMarkdownBoundary(source)).toBe(source.length);
  });

  it('does not split blank lines inside a fenced block', () => {
    const prefix = '完成\n\n';
    const code = '```typescript\nconst n = 1;\n\nconst m = 2;\n';
    expect(stableMarkdownBoundary(prefix + code)).toBe(prefix.length);
    const closed = `${prefix}${code}\x60\x60\x60\n\n`;
    expect(stableMarkdownBoundary(closed + '後續')).toBe(closed.length);
  });

  it('does not treat inline backticks or code dollar signs as open blocks', () => {
    expect(stableMarkdownBoundary('提到 `\x60\x60\x60` 符號\n\n')).toBe(
      '提到 `\x60\x60\x60` 符號\n\n'.length,
    );
    const text = '```sh\necho "$$"\n\x60\x60\x60\n\n';
    expect(stableMarkdownBoundary(text)).toBe(text.length);
  });

  it.each([
    ['$$\na^2\n\n+b^2\n', '$$'],
    ['\\[\na^2\n\n+b^2\n', '\\]'],
    ['\\(a\n\n+b', '\\)'],
  ])('waits for a complete multiline formula: %s', (formula, close) => {
    const prefix = '公式：\n\n';
    expect(stableMarkdownBoundary(prefix + formula)).toBe(prefix.length);
    const text = `${prefix}${formula}${close}\n\n`;
    expect(stableMarkdownBoundary(text)).toBe(text.length);
  });

  it('buffers a list through blank-line continuations until it is closed', () => {
    const prefix = '# 清單\n\n';
    const first = '- 第一項\n\n';
    expect(stableMarkdownBoundary(prefix + first)).toBe(prefix.length);
    const list = first + '  補充說明\n  - 子項\n\n- 第二項\n\n';
    expect(stableMarkdownBoundary(prefix + list)).toBe(prefix.length);
    expect(stableMarkdownBoundary(prefix + list + '下一段')).toBe((prefix + list).length);
  });

  it.each(['-', '*', '+', '1.', '12)', '123.'])(
    'buffers every unfinished next-marker prefix: %s',
    (marker) => {
      const prefix = '- one\n\n';
      for (let length = 1; length <= marker.length; length++) {
        expect(stableMarkdownBoundary(prefix + marker.slice(0, length))).toBe(0);
      }
    },
  );

  it.each(['    ', '\t', '  \t'])('buffers production-parser list indentation: %j', (indent) => {
    const heading = '# Heading\n\n';
    const first = indent + '- one\n\n';
    expect(stableMarkdownBoundary(heading + first)).toBe(heading.length);
    for (const fragment of ['-', '12', '12.']) {
      expect(stableMarkdownBoundary(heading + first + indent + fragment)).toBe(heading.length);
    }
    const complete = heading + first + indent + '- two\n\n';
    expect(stableMarkdownBoundary(complete + 'After')).toBe(complete.length);
  });

  it('still closes a list at a completed non-item line', () => {
    const prefix = '- one\n\n';
    for (const tail of ['After', '-\n', '12.\n'])
      expect(stableMarkdownBoundary(prefix + tail)).toBe(prefix.length);
  });

  it('allows complete inline display math and ignores escaped dollar signs', () => {
    const text = '結果 $$a+b$$，價格 \\$$100\n\n';
    expect(stableMarkdownBoundary(text)).toBe(text.length);
  });
});
