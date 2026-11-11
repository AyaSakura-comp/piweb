import { describe, expect, it } from 'vitest';
import {
  bubbleChains,
  bubbleParts,
  bubblePath,
  drawingOf,
  FRAME_MS,
  keyframeFrames,
  lineSpans,
  partMotion,
  partPath,
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

// The bubble as parts that only move and scale (2026-11-11, 「120fps 泡泡看起來有點瑕疵」).
describe('selection bubble parts', () => {
  // Three lines: the middle one sticks out on the left, the last one on the
  // right; then a line far below, a bubble of its own.
  const lines = [
    { l: 120, r: 300, t: 100, b: 120 },
    { l: 10, r: 260, t: 124, b: 144 },
    { l: 60, r: 340, t: 148, b: 168 },
    { l: 40, r: 200, t: 260, b: 280 },
  ];
  const bands = bubbleChains(lines).flatMap((chain, c) =>
    chain.map((band, position) => ({ ...band, first: position === 0, last: position === chain.length - 1, c })),
  );
  const parts = bubbleParts(bands);
  const close = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

  it('rounds every corner exactly as the outline does', () => {
    // bubblePath writes each corner as `a Q p b`: from where the curve leaves
    // one edge, around the vertex, onto the next.
    const outline = bubblePath(bubbleChains(lines));
    const corners = [...outline.matchAll(/[ML]([\d.-]+) ([\d.-]+)Q([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g)].map((m) =>
      m.slice(1).map(Number),
    );
    const arcs = [...parts.values()].filter((part: any) => part.kind === 'arc' && part.r > 0.01);
    expect(arcs).toHaveLength(corners.length);
    for (const [ax, ay, px, py, bx, by] of corners) {
      const arc: any = arcs.find((part: any) => close([part.x, part.y], [px, py]));
      expect(arc).toBeTruthy();
      const ends = [
        [arc.x + arc.qx * arc.r, arc.y],
        [arc.x, arc.y + arc.qy * arc.r],
      ];
      // bubblePath rounds to 0.1px.
      for (const end of [[ax, ay], [bx, by]]) {
        expect(ends.some((e) => Math.hypot(e[0] - end[0], e[1] - end[1]) < 0.11)).toBe(true);
      }
    }
  });

  it('closes the rim: every end of a rim piece meets the next one', () => {
    const ends: number[][] = [];
    for (const part of parts.values() as Iterable<any>) {
      if (part.layer !== 'rim' || (part.kind === 'arc' && part.r <= 0.01)) continue;
      if (part.kind === 'hseg') ends.push([part.x0, part.y], [part.x1, part.y]);
      if (part.kind === 'vseg') ends.push([part.x, part.y0], [part.x, part.y1]);
      if (part.kind === 'arc') ends.push([part.x + part.qx * part.r, part.y], [part.x, part.y + part.qy * part.r]);
    }
    for (const [i, end] of ends.entries()) {
      expect(ends.some((other, j) => j !== i && close(other, end))).toBe(true);
    }
    // Two bubbles: one rim loop each, with no piece left over.
    expect(ends.length % 2).toBe(0);
  });

  it('draws inner corners as fillets and outer ones as rounded insides, one per corner', () => {
    const kinds = (key: string) => [...parts.entries()].filter(([k]) => k.startsWith(key)).map(([, p]: any) => p.kind);
    // The middle line sticks out on the left above and below: two outer corners.
    expect(kinds('1:ktl')).toEqual(['kept']);
    expect(kinds('1:kbl')).toEqual(['kept']);
    // The first line is narrower on the left: an inner corner where it meets the second.
    expect(kinds('0:fbl')).toEqual(['fillet']);
    // A fill path is one closed outline per part.
    for (const part of parts.values() as Iterable<any>) {
      if (part.layer !== 'fill') continue;
      const d = partPath(part);
      if (d) expect(d.match(/M/g)).toHaveLength(1);
    }
  });

  it('moves each part onto where it is now', () => {
    const map = (part: any, motion: any, x: number, y: number) => {
      const origin = part.kind === 'rect' ? { x: part.x0, y: part.y0 } : { x: part.x, y: part.y };
      return [origin.x + motion.dx + motion.sx * (x - origin.x), origin.y + motion.dy + motion.sy * (y - origin.y)];
    };
    const rect = { layer: 'fill', kind: 'rect', x0: 100, x1: 300, y0: 50, y1: 62 };
    const later = { ...rect, x0: 110, x1: 210, y0: 60, y1: 70 };
    const m = partMotion(rect, later);
    expect(map(rect, m, 100, 50)).toEqual([110, 60]);
    expect(map(rect, m, 300, 62).map((v) => +v.toFixed(6))).toEqual([210, 70]);
    // A corner grows evenly about its vertex, and an edge turning around
    // (an inner corner becoming an outer one, through nothing) mirrors it.
    const arc = { layer: 'rim', kind: 'arc', x: 300, y: 100, r: 11, qx: -1, qy: 1 };
    const turned = { ...arc, x: 320, r: 5.5, qx: 1 };
    const t = partMotion(arc, turned);
    expect(map(arc, t, 300 - 11, 100)).toEqual([320 + 5.5, 100]);
    expect(map(arc, t, 300, 111)).toEqual([320, 105.5]);
    // A part missing now is scaled to nothing.
    expect(partMotion(rect, null)).toMatchObject({ sx: 0, sy: 0 });
  });

  it('fades a line\'s glow as the line drains to nothing', () => {
    const glow = { layer: 'glow', kind: 'glow', side: 'm', l: 20, r: 300, t: 100, b: 126, a: 0.09 };
    const strength = (b: number) => partMotion(glow, { ...glow, b }).o;
    expect(strength(126)).toBeCloseTo(1, 6);
    expect(strength(110)).toBeLessThan(strength(120));
    expect(strength(100.5)).toBeLessThan(0.1);
  });

  it('draws a moving part as big as it gets, so it is only ever scaled down', () => {
    const at = (x1: number) => ({ layer: 'rim', kind: 'hseg', x0: 100, x1, y: 50 });
    // Growing to where it rests: drawn as it rests.
    const rest = at(300);
    expect(drawingOf(rest, [at(120), at(200), at(280)], undefined)).toBe(rest);
    // Shrinking to rest (the end of the selection pulled back): drawn at its
    // longest, not stretched 13 times from its rest length (the rim stuck out).
    const short = at(113);
    const drawn: any = drawingOf(short, [at(280), at(200), at(113)], undefined);
    expect(drawn.x1 - drawn.x0).toBe(180);
    expect(partMotion(drawn, at(113)).sx).toBeLessThanOrEqual(1);
    // Draining away (no rest): kept as drawn before while it is big enough.
    const before = at(290);
    expect(drawingOf(undefined, [at(250), at(150)], before)).toBe(before);
    expect(drawingOf(undefined, [], undefined)).toBe(null);
  });
});
