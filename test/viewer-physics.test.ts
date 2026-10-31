import { describe, expect, it } from 'vitest';
import {
  axisMotion,
  bouncyDuration,
  bouncyProgress,
  dragAxis,
  FRAME_MS,
  MAX_FLING,
  releaseVelocity,
  rubberband,
  sampleFrames,
  springDuration,
  springProgress,
  undragAxis,
  unrubberband,
  viewBetween,
} from '../public/viewer-physics.js';

const steps = (m: { at: (t: number) => number; duration: number }) => {
  const xs: number[] = [];
  for (let t = 0; t <= m.duration; t += FRAME_MS) xs.push(m.at(t));
  xs.push(m.at(m.duration));
  return xs;
};

describe('glide after a fling', () => {
  it('slows steadily and comes to rest where the deceleration says, inside the range', () => {
    const m = axisMotion(0, -2, -5000, 0);
    // 2 px/ms at 0.998 per ms travels 2 / -ln(0.998) ≈ 999px.
    expect(m.end).toBeCloseTo(-999, 0);
    const xs = steps(m);
    const moves = xs.slice(1).map((x, i) => x - xs[i]);
    expect(moves.every((d) => d <= 0)).toBe(true);
    // Each frame covers no more ground than the one before it.
    for (let i = 1; i < moves.length; i++) expect(Math.abs(moves[i])).toBeLessThanOrEqual(Math.abs(moves[i - 1]) + 1e-9);
    // The first frame moves at the release speed (2 px/ms × 8.33ms).
    expect(Math.abs(moves[0])).toBeCloseTo(2 * FRAME_MS, 0);
    // It stops where it is with under half a pixel left to go: no last jump.
    expect(Math.abs(m.at(m.duration - FRAME_MS) - m.end)).toBeLessThan(0.02);
    expect(m.at(m.duration + 500)).toBe(m.end);
  });

  it('reaching an edge, it runs a little past and springs back onto it', () => {
    const m = axisMotion(-100, 3, -1000, 0);
    expect(m.end).toBe(0);
    const xs = steps(m);
    const peak = Math.max(...xs);
    expect(peak).toBeGreaterThan(5); // a visible bounce
    expect(peak).toBeLessThan(120); // not a fly-away
    expect(xs[xs.length - 1]).toBe(0);
    // No jump anywhere: the edge is crossed at the speed it was reached.
    const moves = xs.slice(1).map((x, i) => Math.abs(x - xs[i]));
    expect(Math.max(...moves)).toBeLessThanOrEqual(3 * FRAME_MS + 1e-6);
  });

  it('from past an edge it springs back without overshooting, carrying the throw', () => {
    const m = axisMotion(60, 0, -500, 0);
    const xs = steps(m);
    expect(xs.every((x) => x >= -0.01)).toBe(true);
    expect(xs[xs.length - 1]).toBe(0);
    expect(m.duration).toBeLessThan(800);
    // Content that fits has one place to rest: min === max.
    const fit = axisMotion(-40, -1, 12, 12);
    expect(fit.end).toBe(12);
    expect(steps(fit).at(-1)).toBe(12);
  });

  it('a still release does not move, and a wild throw is capped', () => {
    expect(axisMotion(-30, 0, -100, 0).duration).toBe(0);
    const capped = axisMotion(0, -100, -1e6, 0);
    expect(capped.end).toBeCloseTo(axisMotion(0, -MAX_FLING, -1e6, 0).end, 6);
  });
});

describe('rubber band', () => {
  it('gives way less the further it is pulled, never past the viewer size', () => {
    expect(rubberband(0, 400)).toBe(0);
    expect(rubberband(100, 400)).toBeLessThan(100);
    expect(rubberband(100, 400)).toBeGreaterThan(30);
    expect(rubberband(200, 400) - rubberband(100, 400)).toBeLessThan(rubberband(100, 400));
    expect(rubberband(1e6, 400)).toBeLessThan(400);
    expect(rubberband(-100, 400)).toBe(-rubberband(100, 400));
  });

  it('inverts, so a drag back from past an edge comes back 1:1', () => {
    for (const over of [3, 50, 180, -70]) expect(unrubberband(rubberband(over, 390), 390)).toBeCloseTo(over, 6);
    expect(dragAxis(-20, 0, 100, 390)).toBe(-rubberband(20, 390));
    expect(dragAxis(40, 0, 100, 390)).toBe(40);
    for (const raw of [-200, -5, 50, 130]) expect(undragAxis(dragAxis(raw, 0, 100, 390), 0, 100, 390)).toBeCloseTo(raw, 6);
  });
});

describe('springs', () => {
  it('a zoom spring settles on 1 without overshoot', () => {
    const d = springDuration();
    let last = 0;
    for (let t = 0; t <= d; t += FRAME_MS) {
      const p = springProgress(t);
      expect(p).toBeGreaterThanOrEqual(last - 1e-12);
      expect(p).toBeLessThanOrEqual(1);
      last = p;
    }
    expect(1 - springProgress(d)).toBeLessThan(0.0011);
  });

  it('the opening spring overshoots a little, then settles', () => {
    const d = bouncyDuration();
    let peak = 0;
    for (let t = 0; t <= d; t += FRAME_MS) peak = Math.max(peak, bouncyProgress(t));
    expect(peak).toBeGreaterThan(1.005);
    expect(peak).toBeLessThan(1.03);
    expect(Math.abs(1 - bouncyProgress(d))).toBeLessThan(0.002);
  });
});

describe('zoom path', () => {
  it('keeps the content point the two views share fixed, and scale moves evenly in ratio', () => {
    const from = { scale: 1, x: 0, y: 0 };
    const to = { scale: 4, x: -300, y: -150 }; // zoom 4× about content point (100, 50)
    for (const p of [0, 0.25, 0.5, 0.9, 1]) {
      const v = viewBetween(from, to, p);
      expect(v.x + v.scale * 100).toBeCloseTo(100, 9);
      expect(v.y + v.scale * 50).toBeCloseTo(50, 9);
    }
    expect(viewBetween(from, to, 0.5).scale).toBeCloseTo(2, 9);
    expect(viewBetween(from, to, 1)).toEqual(to);
    // Same scale: a straight slide.
    expect(viewBetween({ scale: 2, x: 0, y: 0 }, { scale: 2, x: 10, y: -20 }, 0.5)).toEqual({ scale: 2, x: 5, y: -10 });
  });
});

describe('keyframes and release speed', () => {
  it('samples one keyframe per 120Hz frame, ending exactly at the end', () => {
    const frames = sampleFrames(100, (t) => ({ v: t }));
    expect(frames.length).toBe(Math.ceil(100 / FRAME_MS) + 1);
    expect(frames[0]).toEqual({ v: 0, offset: 0 });
    expect(frames.at(-1)).toEqual({ v: 100, offset: 1 });
  });

  it('reads the last 100ms of movement, and nothing after a pause', () => {
    const samples = [0, 16, 32, 48, 64, 80, 96, 112].map((t) => ({ t, x: -t * 1.5, y: 0 }));
    expect(releaseVelocity(samples, 120).x).toBeCloseTo(-1.5, 6);
    expect(releaseVelocity(samples, 112 + 81)).toEqual({ x: 0, y: 0 });
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }], 2)).toEqual({ x: 0, y: 0 });
  });
});
