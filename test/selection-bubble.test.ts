import { describe, expect, it } from 'vitest';
import {
  bubbleChains,
  bubblePath,
  FRAME_MS,
  keyframeFrames,
  lineSpans,
  pieceMotion,
  springAt,
} from '../public/selection-bubble.js';

const rect = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

describe('selection bubble geometry', () => {
  it('merges the rects of one visual line into one span', () => {
    expect(
      lineSpans([rect(40, 100, 90, 120), rect(10, 101, 38, 119), rect(10, 124, 200, 144), rect(0, 0, 0, 10)]),
    ).toEqual([
      { l: 10, r: 90, t: 100, b: 120 },
      { l: 10, r: 200, t: 124, b: 144 },
    ]);
  });

  it('joins neighbouring lines, paragraph gaps included, into one bubble', () => {
    const chains = bubbleChains(
      [
        { l: 120, r: 300, t: 100, b: 120 },
        { l: 10, r: 300, t: 124, b: 144 },
        { l: 10, r: 150, t: 160, b: 180 },
      ],
      { padX: 5, padY: 2, radius: 10, maxGap: 48 },
    );
    expect(chains).toHaveLength(1);
    const [lines] = chains;
    // Each line meets the next edge to edge: no seams between them.
    expect(lines[0].b).toBe(lines[1].t);
    expect(lines[1].b).toBe(lines[2].t);
    expect(lines[0].t).toBe(98);
    expect(lines[2].b).toBe(182);
  });

  it('keeps far-apart or side-by-side-less lines as separate bubbles', () => {
    const far = bubbleChains([
      { l: 10, r: 300, t: 100, b: 120 },
      { l: 10, r: 300, t: 200, b: 220 },
    ]);
    expect(far).toHaveLength(2);
    // A line ending left of where the next one starts would only touch at a point.
    const disjoint = bubbleChains([
      { l: 250, r: 300, t: 100, b: 120 },
      { l: 10, r: 60, t: 124, b: 144 },
    ]);
    expect(disjoint).toHaveLength(2);
  });

  it('draws one closed, rounded outline per bubble', () => {
    const one = bubblePath(
      bubbleChains([
        { l: 120, r: 300, t: 100, b: 120 },
        { l: 10, r: 300, t: 124, b: 144 },
      ]),
    );
    expect(one.match(/M/g)).toHaveLength(1);
    expect(one.endsWith('Z')).toBe(true);
    // Every corner is a curve, never a hard right angle.
    expect(one.match(/Q/g)!.length).toBe(one.match(/L/g)!.length + 1);

    const two = bubblePath(
      bubbleChains([
        { l: 10, r: 300, t: 100, b: 120 },
        { l: 10, r: 300, t: 200, b: 220 },
      ]),
    );
    expect(two.match(/M/g)).toHaveLength(2);
    expect(bubblePath([])).toBe('');
  });
});

describe('selection bubble motion', () => {
  // The spring the outline always used: stiffness 340, damping 25, stepped at
  // 1/120 s by the old requestAnimationFrame loop. The closed form must trace
  // the same curve, so moving it to compositor keyframes changed no motion.
  it('solves the same spring the frame-by-frame loop stepped', () => {
    let x = 0;
    let v = 0;
    const target = 300;
    const dt = 1 / 4000;
    for (let step = 1; step <= 4000 * 0.6; step++) {
      v += (340 * (target - x) - 25 * v) * dt;
      x += v * dt;
      if (step % 200 === 0) {
        const solved = springAt(0, 0, target, step * dt);
        expect(Math.abs(solved.x - x)).toBeLessThan(0.5);
        expect(Math.abs(solved.v - v)).toBeLessThan(15);
      }
    }
    const start = springAt(12, 34, 300, 0);
    expect(start.x).toBeCloseTo(12, 9);
    expect(start.v).toBeCloseTo(34, 9);
    // Slightly under-damped: it overshoots a touch, then rests on the target.
    const peak = Math.max(...Array.from({ length: 60 }, (_, k) => springAt(0, 0, 300, (k * FRAME_MS) / 1000).x));
    expect(peak).toBeGreaterThan(300);
    expect(peak).toBeLessThan(320);
    expect(Math.abs(springAt(0, 0, 300, 1.2).x - 300)).toBeLessThan(0.25);
  });

  const drawn = { l: 100, r: 400, t: 50, b: 74 };
  const place = (part: string, motion: { dx: number; dy: number; sx: number; sy: number }, x: number, y: number) => {
    // transform-origin is where the piece is anchored: its left edge for the
    // start and the whole line, its right edge for the end, past the start's
    // cap for the middle.
    const ox = part === 'end' ? drawn.r : part === 'middle' ? drawn.l + 13 : drawn.l;
    return { x: ox + motion.dx + motion.sx * (x - ox), y: drawn.t + motion.dy + motion.sy * (y - drawn.t) };
  };

  it('moves each piece of a line onto where the line is now', () => {
    const now = { l: 90, r: 250, t: 60, b: 80 };
    const start = place('start', pieceMotion('start', drawn, now), drawn.l, drawn.t);
    expect(start.x).toBeCloseTo(now.l);
    expect(start.y).toBeCloseTo(now.t);
    // The rounded ends only move: never squashed while the line is long enough.
    expect(pieceMotion('start', drawn, now).sx).toBe(1);
    expect(pieceMotion('end', drawn, now).sx).toBe(1);
    const end = place('end', pieceMotion('end', drawn, now), drawn.r, drawn.b);
    expect(end.x).toBeCloseTo(now.r);
    expect(end.y).toBeCloseTo(now.b);
    // The middle stretches to meet both ends.
    const middle = pieceMotion('middle', drawn, now);
    expect(place('middle', middle, drawn.l + 13, drawn.t).x).toBeCloseTo(now.l + 13);
    expect(place('middle', middle, drawn.r - 13, drawn.t).x).toBeCloseTo(now.r - 13);
    // At rest every piece sits exactly where it was drawn.
    for (const part of ['start', 'middle', 'end', 'whole']) {
      expect(pieceMotion(part, drawn, drawn)).toEqual({ dx: 0, dy: 0, sx: 1, sy: 1 });
    }
  });

  it('narrows the ends of a line shorter than its two ends, and hides one too small to draw', () => {
    const tiny = { l: 200, r: 210, t: 60, b: 70 };
    const start = pieceMotion('start', drawn, tiny);
    const end = pieceMotion('end', drawn, tiny);
    expect(start.sx).toBeCloseTo(10 / 26);
    expect(place('start', start, drawn.l + 13, drawn.t).x).toBeCloseTo(205);
    expect(place('end', end, drawn.r - 13, drawn.t).x).toBeCloseTo(205);
    expect(pieceMotion('middle', drawn, tiny).sx).toBe(0);
    expect(pieceMotion('start', drawn, null)).toEqual({ dx: 0, dy: 0, sx: 0, sy: 0 });
  });

  it('keeps a keyframe wherever leaving it out would move the line', () => {
    const frames = Array.from({ length: 61 }, (_, k) => springAt(0, 0, 300, (k * FRAME_MS) / 1000).x);
    const motions = frames.map((x) => ({ dx: x - 300, dy: 0, sx: 1, sy: 1 }));
    const kept = keyframeFrames(motions, 40, 24, 0.1);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(motions.length - 1);
    // Between kept frames the compositor draws a straight line; every frame
    // left out is within the tolerance of it.
    for (let n = 0; n < kept.length - 1; n++) {
      const [a, b] = [kept[n], kept[n + 1]];
      for (let k = a + 1; k < b; k++) {
        const lerp = motions[a].dx + ((motions[b].dx - motions[a].dx) * (k - a)) / (b - a);
        expect(Math.abs(lerp - motions[k].dx)).toBeLessThanOrEqual(0.1);
      }
    }
    // The spring's long, gentle tail needs few of them.
    expect(kept.length).toBeLessThan(motions.length * 0.7);
  });
});
