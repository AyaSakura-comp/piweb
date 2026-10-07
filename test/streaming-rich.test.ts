import { describe, expect, it } from 'vitest';
import {
  advanceRevealFront,
  advanceRevealPace,
  projectRevealRect,
  diagonalRevealAt,
  prepareRevealSurface,
  buildRevealRows,
  buildRevealSchedule,
  revealRowsAt,
  revealRowAt,
  createRevealPace,
  noteRevealArrival,
  stableMarkdownBoundary,
  readingGraphemes,
  readingFadeLevel,
  advanceReadingPace,
  plainStreamingTail,
} from '../public/streaming-rich.js';

describe('reading-order soft reveal contract', () => {
  it('uses whole graphemes for Chinese, combining marks and emoji', () => {
    expect(readingGraphemes('讀e\u0301👨‍👩‍👧‍👦🙂')).toEqual([0, 1, 3, 14, 16]);
  });
  it('limits softness to the latest eight graphemes without redimming older text', () => {
    expect(readingFadeLevel(20, 20)).toBe(0);
    expect(readingFadeLevel(20, 22)).toBe(1);
    expect(readingFadeLevel(20, 24)).toBe(2);
    expect(readingFadeLevel(20, 26)).toBe(3);
    expect(readingFadeLevel(20, 28)).toBe(4);
    expect(readingFadeLevel(0, 500)).toBe(4);
  });
  it('does not reset velocity or snap a large final packet into view', () => {
    const next = advanceReadingPace(80, 800, 16);
    expect(next).toBeGreaterThan(80);
    expect(next).toBeLessThan(130);
    expect(advanceReadingPace(80, 800, 30_000)).toBeLessThan(200);
  });
  it('allows open plain prose but holds markup, URLs, lists and publish-owned tails', () => {
    expect(plainStreamingTail('文字可以在段落尚未結束時出現。')).toBe(true);
    expect(plainStreamingTail('Hello world, still writing.')).toBe(true);
    for (const s of [
      '**未結束',
      'Hello **bold',
      '- item',
      '1. item',
      'Hello\nnext',
      '![image](/media/a.png)',
      '[[image: /tmp/a.png]]',
      'Visit https://example.test',
      '$$x',
      'text \\(',
      '| cell |',
      '',
    ])
      expect(plainStreamingTail(s), s).toBe(false);
  });
});

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

describe('diagonal rich-surface geometry', () => {
  const rect = { left: 20, top: 80, width: 300, height: 200 };

  it('projects all four content edges, not glyph or row counts', () => {
    const bounds = projectRevealRect(rect);
    expect(bounds.start).toBeCloseTo(100 / Math.SQRT2);
    expect(bounds.end).toBeCloseTo(600 / Math.SQRT2);
    expect(projectRevealRect({ ...rect, width: 600 }).end - bounds.end).toBeCloseTo(
      300 / Math.SQRT2,
    );
    expect(projectRevealRect({ ...rect, height: 500 }).end - bounds.end).toBeCloseTo(
      300 / Math.SQRT2,
    );
  });

  it('starts transparent before the upper-left corner and finishes at the lower-right corner', () => {
    const bounds = projectRevealRect(rect);
    expect(diagonalRevealAt(bounds, bounds.start - 56)).toMatchObject({ mode: 'hidden' });
    expect(diagonalRevealAt(bounds, bounds.start - 28)).toMatchObject({
      mode: 'diagonal',
      front: -28,
    });
    expect(diagonalRevealAt(bounds, bounds.end - 0.001).mode).toBe('diagonal');
    expect(diagonalRevealAt(bounds, bounds.end).mode).toBe('ready');
  });

  it('maps different chunk origins onto the same plane without resetting them', () => {
    const a = projectRevealRect(rect);
    const b = projectRevealRect({ ...rect, top: 180 });
    const front = 200;
    expect(diagonalRevealAt(a, front).front + a.start).toBeCloseTo(front);
    expect(diagonalRevealAt(b, front).front + b.start).toBeCloseTo(front);
    expect(diagonalRevealAt(a, front + 16).front - diagonalRevealAt(a, front).front).toBeCloseTo(
      16,
    );
  });

  it('lets prepared lower-left content start before the preceding upper-right finishes', () => {
    const a = projectRevealRect({ left: 0, top: 0, width: 360, height: 40 });
    const b = projectRevealRect({ left: 0, top: 60, width: 360, height: 80 });
    expect(diagonalRevealAt(a, 90).mode).toBe('diagonal');
    expect(diagonalRevealAt(b, 90).mode).toBe('diagonal');
    expect(a.end).toBeGreaterThan(90);
  });

  it('handles empty surfaces without holding reveal resources', () => {
    expect(
      diagonalRevealAt(projectRevealRect({ left: 0, top: 0, width: 0, height: 100 }), -56).mode,
    ).toBe('ready');
    expect(
      diagonalRevealAt(projectRevealRect({ left: 0, top: 0, width: 300, height: 0 }), -56).mode,
    ).toBe('ready');
  });

  it('accelerates for a larger prepared image surface using the same pacing state', () => {
    const small = createRevealPace();
    const big = createRevealPace();
    const a = projectRevealRect({ left: 0, top: 0, width: 100, height: 100 }).end;
    const b = projectRevealRect({ left: 0, top: 0, width: 300, height: 300 }).end;
    for (const pace of [small, big]) noteRevealArrival(pace, 100, 0);
    for (let now = 20; now <= 800; now += 20) {
      advanceRevealPace(small, {
        now,
        elapsed: 20,
        front: 0,
        goal: a,
        tailEnd: a,
        pixelsPerChar: 1,
      });
      advanceRevealPace(big, { now, elapsed: 20, front: 0, goal: b, tailEnd: b, pixelsPerChar: 1 });
    }
    expect(big.speed).toBeGreaterThan(small.speed * 2);
    expect(big.samples).toEqual(small.samples);
  });
});

describe('diagonal late-arrival and steady EOF regression', () => {
  it('keeps a late surface transparent instead of inheriting old revealed pixels', () => {
    const bounds = projectRevealRect({ left: 0, top: 40, width: 360, height: 30 });
    const prepared = prepareRevealSurface(bounds, 300, 0);
    expect(prepared.start).toBe(356);
    expect(diagonalRevealAt(prepared, 300).mode).toBe('hidden');
    expect(prepared.end - prepared.start).toBeCloseTo(bounds.end - bounds.start);
    expect(prepared.offset).toBeCloseTo(356 - bounds.start);
  });

  it('retains the cohort offset for early future surfaces without creating another clock', () => {
    const bounds = { start: 900, end: 1100 };
    expect(prepareRevealSurface(bounds, 400, 200)).toEqual({
      start: 1100,
      end: 1300,
      offset: 200,
    });
  });

  it('does not raise a steady EOF drain to 120px/s or backlog catch-up speed', () => {
    const pace = createRevealPace();
    pace.speed = 40;
    noteRevealArrival(pace, 100, 0);
    for (let now = 20; now <= 2000; now += 20) {
      expect(
        advanceRevealPace(pace, {
          now,
          elapsed: 20,
          front: 100,
          goal: 5000,
          complete: true,
          catchupSpeed: 1500,
          steadyDrain: true,
        }),
      ).toBeCloseTo(40);
    }
  });

  it('gives an almost-exhausted steady EOF drain a bounded 24px/s finish', () => {
    const pace = createRevealPace();
    pace.speed = 2;
    noteRevealArrival(pace, 100, 0);
    let front = 99;
    for (let now = 20; now <= 1000; now += 20) {
      const speed = advanceRevealPace(pace, {
        now,
        elapsed: 20,
        front,
        goal: 100,
        complete: true,
        steadyDrain: true,
      });
      expect(speed).toBeLessThanOrEqual(24);
      front = advanceRevealFront(front, 100, 20, speed);
    }
    expect(front).toBe(100);
  });
});

// Legacy exported pure helpers; production no longer schedules glyph rows.
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

describe('staggered overlapping row reveal', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    top: i * 20,
    bottom: (i + 1) * 20,
    left: 0,
    right: [200, 300, 80, 500][i % 4],
    kind: 'text',
  }));

  it('starts exactly five rows before the first completes', () => {
    const schedule = buildRevealSchedule(rows);
    const mask = revealRowsAt(
      schedule,
      schedule[4].start + (schedule[0].end - schedule[4].start) / 2,
    );
    expect(mask.mode).toBe('rows');
    expect(mask.bands.map((band) => band.index)).toEqual([0, 1, 2, 3, 4]);
    expect(mask.bands[0].progress).toBeLessThan(1);
    expect(mask.bands.at(-1)!.progress).toBeGreaterThan(0);
    expect(mask.bands.every((band, i, all) => !i || band.front < all[i - 1].front)).toBe(true);
  });

  it.each([8, 16])('keeps adjacent fronts 1.5 measured glyphs apart (%spx glyph)', (glyphWidth) => {
    const measured = rows.map((row) => ({ ...row, glyphWidth }));
    const schedule = buildRevealSchedule(measured);
    const front = schedule[4].start + (schedule[0].end - schedule[4].start) / 4;
    {
      const { bands } = revealRowsAt(schedule, front);
      expect(bands).toHaveLength(5);
      for (let i = 1; i < bands.length; i++)
        expect(bands[i - 1].front - bands[i].front).toBeCloseTo(glyphWidth * 1.5, 8);
    }
  });

  it('keeps one monotonic coordinate and ordered completion with near-parallel rows', () => {
    const schedule = buildRevealSchedule(rows, 56);
    const previous = new Map<number, number>();
    let first = 0;
    let maximum = 0;
    for (let front = -56; front < 200; front += 0.5) {
      const mask = revealRowsAt(schedule, front);
      maximum = Math.max(maximum, mask.bands.length);
      expect(mask.bands.length).toBeLessThanOrEqual(5);
      expect(mask.index).toBeGreaterThanOrEqual(first);
      first = mask.index;
      for (const band of mask.bands) {
        expect(band.progress).toBeGreaterThanOrEqual(previous.get(band.index) || 0);
        previous.set(band.index, band.progress);
      }
    }
    expect(maximum).toBe(5);
    expect(revealRowsAt(schedule, 200)).toMatchObject({ mode: 'ready', index: 10, bands: [] });
  });

  it('preserves relative X gaps and ordered release with unequal widths heights and indents', () => {
    const uneven = [
      { top: 0, bottom: 40, left: 0, right: 80, kind: 'text' },
      { top: 40, bottom: 60, left: 4, right: 400, kind: 'text' },
      { top: 60, bottom: 70, left: 2, right: 120, kind: 'text' },
    ];
    const schedule = buildRevealSchedule(uneven);
    const bands = revealRowsAt(schedule, schedule[2].start + 1).bands;
    expect(bands).toHaveLength(3);
    for (let i = 1; i < bands.length; i++) {
      const gap = bands[i - 1].front - uneven[i - 1].left - (bands[i].front - uneven[i].left);
      expect(gap).toBeCloseTo(24, 8);
      expect(schedule[i].end).toBeGreaterThanOrEqual(schedule[i - 1].end);
    }
    expect(revealRowsAt(schedule, schedule[0].end).bands.map((band) => band.index)).toEqual([1, 2]);
    expect(revealRowsAt(schedule, schedule.at(-1)!.end).mode).toBe('ready');
  });

  it('starts each replacement exactly at the fifth earlier row release', () => {
    const equal = rows.map((row) => ({ ...row, right: 320 }));
    const schedule = buildRevealSchedule(equal, 56);
    for (let i = 5; i < schedule.length; i++) {
      expect(schedule[i].start).toBe(schedule[i - 5].end);
      expect(
        revealRowsAt(schedule, schedule[i].start - 0.0001).bands.some((band) => band.index === i),
      ).toBe(false);
      const atRelease = revealRowsAt(schedule, schedule[i].start).bands;
      expect(atRelease.some((band) => band.index === i - 5)).toBe(false);
      expect(atRelease.find((band) => band.index === i)).toMatchObject({ progress: 0, front: -56 });
      expect(atRelease.length).toBeLessThanOrEqual(5);
    }
  });

  it('releases a short first row at its own right edge rather than the longest line travel', () => {
    const uneven = rows.map((row, i) => ({ ...row, right: i ? 320 : 80 }));
    const schedule = buildRevealSchedule(uneven);
    const justBefore = schedule[0].start + (schedule[0].end - schedule[0].start) * 0.999;
    expect(revealRowsAt(schedule, justBefore).bands[0].front).toBeLessThan(80);
    expect(revealRowsAt(schedule, justBefore).bands.some((band) => band.index === 5)).toBe(false);
    expect(schedule[5].start).toBe(schedule[0].end);
    expect(revealRowsAt(schedule, schedule[0].end).bands.map((band) => band.index)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('retains prepared glyph measurements when merging inline row rectangles', () => {
    const measured = buildRevealRows(
      [
        { top: 0, bottom: 20, left: 0, right: 100, glyphWidth: 8 },
        { top: 0, bottom: 20, left: 100, right: 200, glyphWidth: 16 },
        { top: 20, bottom: 40, left: 0, right: 200, glyphWidth: 16 },
      ],
      40,
    );
    expect(measured.map((row) => row.glyphWidth)).toEqual([16, 16]);
    const bands = revealRowsAt(buildRevealSchedule(measured), 20).bands;
    expect(bands[0].front - bands[1].front).toBeCloseTo(24, 8);
  });

  it('starts at the cold-start edge and completes inside the existing coordinate budget', () => {
    const schedule = buildRevealSchedule(rows, 56);
    expect(revealRowsAt(schedule, -57)).toMatchObject({ mode: 'hidden', bands: [] });
    expect(revealRowsAt(schedule, -56).bands[0]).toMatchObject({
      index: 0,
      front: -56,
      progress: 0,
    });
    expect(revealRowsAt(schedule, -28).bands[0].front).toBeGreaterThan(-56);
    expect(schedule.at(-1)!.end).toBe(200);
  });

  it('never reveals text across an unfinished media band', () => {
    const mixed = [...rows.slice(0, 3), { ...rows[3], kind: 'media' }, ...rows.slice(4, 7)];
    const schedule = buildRevealSchedule(mixed);
    expect(schedule[2].end).toBe(60);
    expect(schedule[4].start).toBe(80);
    // The already-scanned short third row stays opaque behind ordered release.
    expect(revealRowsAt(schedule, 59).bands.map((band) => band.index)).toEqual([1, 2]);
    expect(revealRowsAt(schedule, 70)).toMatchObject({ mode: 'media', index: 3, bands: [] });
    expect(revealRowsAt(schedule, 80).bands.map((band) => band.index)).toEqual([4]);
  });

  it('handles empty geometry and a single row without introducing a blank wait', () => {
    expect(revealRowsAt(buildRevealSchedule([]), 0)).toMatchObject({ mode: 'ready', bands: [] });
    const schedule = buildRevealSchedule(rows.slice(0, 1));
    expect(revealRowsAt(schedule, 10).bands[0]).toMatchObject({
      index: 0,
      progress: 0.5,
      front: 72,
    });
    expect(revealRowsAt(schedule, 20).mode).toBe('ready');
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

  it('bases tail braking on the last row scan edge rather than the full release goal', () => {
    const schedule = buildRevealSchedule(
      [400, 300, 20].map((right, i) => ({
        top: i * 20,
        bottom: (i + 1) * 20,
        left: 0,
        right,
        kind: 'text',
      })),
      56,
    );
    const tail = schedule.at(-1)!;
    expect(tail.scanEnd).toBeLessThan(tail.end);
    const near = createRevealPace();
    const far = createRevealPace();
    for (const pace of [near, far]) {
      noteRevealArrival(pace, 100, 0);
      noteRevealArrival(pace, 200, 1000);
    }
    for (let now = 1020; now <= 1800; now += 20) {
      if (now % 200 === 0)
        for (const pace of [near, far]) noteRevealArrival(pace, 100 + now / 10, now);
      const state = { now, elapsed: 20, front: tail.scanEnd - 8, goal: tail.end, pixelsPerChar: 1 };
      advanceRevealPace(near, { ...state, tailEnd: tail.scanEnd });
      advanceRevealPace(far, { ...state, tailEnd: tail.end });
    }
    expect(near.speed).toBeLessThan(far.speed / 2);
    expect(near.speed).toBeGreaterThan(0);
    expect(near.samples).toEqual(far.samples);
  });

  it('keeps a short last row moving between regular arrivals without exhausting its buffer', () => {
    const pace = createRevealPace();
    let length = 8;
    let front = -56;
    let goal = 24;
    noteRevealArrival(pace, length, 0);
    let stalled = 0;
    for (let now = 20; now <= 5400; now += 20) {
      if (now % 900 === 0) {
        goal += 36;
        noteRevealArrival(pace, (length += 8), now);
      }
      const speed = advanceRevealPace(pace, {
        now,
        elapsed: 20,
        front,
        goal,
        tailEnd: goal,
        pixelsPerChar: goal / length,
        catchupSpeed: pace.samples.length < 2 ? (goal - front) / 3.2 : 0,
      });
      const next = advanceRevealFront(front, goal, 20, speed);
      if (next === front) stalled++;
      expect(next).toBeGreaterThanOrEqual(front);
      front = next;
    }
    expect(stalled).toBe(0);
    expect(front).toBeGreaterThan(goal - 80);
    expect(front).toBeLessThan(goal);
  });

  it('does not let a cold-start or large-backlog catch-up override a live last-row buffer', () => {
    const pace = createRevealPace();
    noteRevealArrival(pace, 10_000, 0);
    const speed = advanceRevealPace(pace, {
      now: 16,
      elapsed: 16,
      front: 100,
      goal: 2000,
      tailEnd: 102,
      catchupSpeed: 600,
    });
    expect(speed).toBeLessThan(5);
    expect(advanceRevealFront(100, 2000, 48, speed)).toBeLessThan(102);
  });

  it('releases tail braking when arrivals go stale instead of holding an unfinished reply forever', () => {
    const pace = createRevealPace();
    noteRevealArrival(pace, 100, 0);
    let front = 99;
    for (let now = 20; now <= 3000; now += 20) {
      const speed = advanceRevealPace(pace, {
        now,
        elapsed: 20,
        front,
        goal: 100,
        tailEnd: 100,
      });
      front = advanceRevealFront(front, 100, 20, speed);
      if (now === 1000) expect(front).toBeLessThan(100);
    }
    expect(front).toBe(100);
  });

  it('drains a preserved last-row buffer after EOF', () => {
    const pace = createRevealPace();
    noteRevealArrival(pace, 100, 0);
    let front = 99;
    for (let now = 20; now <= 200; now += 20) {
      const speed = advanceRevealPace(pace, {
        now,
        elapsed: 20,
        front,
        goal: 100,
        tailEnd: 100,
      });
      front = advanceRevealFront(front, 100, 20, speed);
    }
    expect(front).toBeLessThan(100);
    for (let now = 220; now <= 800; now += 20) {
      const speed = advanceRevealPace(pace, {
        now,
        elapsed: 20,
        front,
        goal: 100,
        tailEnd: 100,
        complete: true,
      });
      front = advanceRevealFront(front, 100, 20, speed);
    }
    expect(front).toBe(100);
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
  ])('holds transport-owned media markers without invalidating earlier read blocks: %s', (marker) => {
    const prefix = '# 已讀內容\n\n';
    expect(stableMarkdownBoundary(prefix + marker + '\n\n之後的段落。\n\n')).toBe(prefix.length);
  });

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
