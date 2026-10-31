/**
 * Physics for the full-screen table / diagram viewer (DESIGN.md "Viewer
 * motion"): a fling glides on and slows like a scroll view, an edge pulls back
 * like a rubber band, and everything settles on a spring.
 *
 * Every motion after the finger lifts is computed up front as a function of
 * time and played as Web Animations keyframes on `transform` (and `opacity`)
 * alone. The compositor runs those at the display's refresh rate (120Hz on
 * ProMotion), and a busy main thread cannot make them stutter; a requestAnimationFrame
 * loop would be held to the page's frame rate and to every long task.
 */

/** Keyframes are sampled this often: one per frame on a 120Hz display. */
export const FRAME_MS = 1000 / 120;

/** Velocity kept per millisecond while gliding (UIScrollView's normal rate). */
export const DECELERATION = 0.998;
const LN_DECELERATION = Math.log(DECELERATION);
/** A fling faster than this (px/ms) is taken as this. */
export const MAX_FLING = 8;
/** Stiffness of the spring back from an edge (1/ms, critically damped). */
export const EDGE_OMEGA = 0.02;
/** Stiffness of a zoom (buttons, double tap, Reset, pinch release). */
export const ZOOM_OMEGA = 0.02;
/** Rubber band constant, iOS's 0.55: the further past the edge, the stiffer. */
const RUBBER = 0.55;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** How far content dragged `over` px past an edge actually moves. */
export function rubberband(over, dimension) {
  if (!over || dimension <= 0) return 0;
  const a = Math.abs(over);
  return Math.sign(over) * (1 - 1 / ((a * RUBBER) / dimension + 1)) * dimension;
}

/** The finger distance that `rubberband` turns into `shown` (its inverse). */
export function unrubberband(shown, dimension) {
  if (!shown || dimension <= 0) return 0;
  const a = Math.min(Math.abs(shown), dimension * 0.999);
  return (Math.sign(shown) * a) / (RUBBER * (1 - a / dimension));
}

/** Where a drag puts one axis: 1:1 inside [min, max], rubber-banded past it. */
export function dragAxis(raw, min, max, dimension) {
  if (raw < min) return min - rubberband(min - raw, dimension);
  if (raw > max) return max + rubberband(raw - max, dimension);
  return raw;
}

/** The raw finger position that `dragAxis` shows at `shown` (its inverse). */
export function undragAxis(shown, min, max, dimension) {
  if (shown < min) return min - unrubberband(min - shown, dimension);
  if (shown > max) return max + unrubberband(shown - max, dimension);
  return shown;
}

/** Critically damped spring: 0 at t = 0, settling on 1. */
export function springProgress(t, omega = ZOOM_OMEGA) {
  return 1 - (1 + omega * t) * Math.exp(-omega * t);
}

/** When `springProgress` is within 1/1000 of the end. */
export function springDuration(omega = ZOOM_OMEGA) {
  return 9.23 / omega;
}

/** Slightly underdamped spring (about 1.5% overshoot), for the viewer opening. */
export function bouncyProgress(t, omega = 0.024, zeta = 0.8) {
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}

export function bouncyDuration(omega = 0.024, zeta = 0.8) {
  return Math.log(1000) / (zeta * omega);
}

/**
 * A critically damped spring from `displacement` px off `rest`, moving at
 * `velocity` px/ms: the bounce off an edge, or the pull back from past one.
 */
function springBack(rest, displacement, velocity, omega = EDGE_OMEGA) {
  const c2 = velocity + omega * displacement;
  const at = (t) => rest + (displacement + c2 * t) * Math.exp(-omega * t);
  // Settled once both the offset and the speed are below what a pixel shows.
  let duration = 0;
  for (let t = FRAME_MS; t < 2000; t += FRAME_MS) {
    duration = t;
    const speed = Math.abs((c2 - omega * (displacement + c2 * t)) * Math.exp(-omega * t));
    if (Math.abs(at(t) - rest) < 0.25 && speed < 0.005) break;
  }
  return { at: (t) => (t >= duration ? rest : at(t)), end: rest, duration };
}

/**
 * One axis after the finger lifts at `x0` moving `v0` px/ms, inside the range
 * [min, max] (min === max when the content fits and has one place to rest):
 * a glide that slows by DECELERATION, bouncing off an edge it reaches; or,
 * from past an edge, the spring back to it.
 */
export function axisMotion(x0, v0, min, max) {
  const v = clamp(v0 || 0, -MAX_FLING, MAX_FLING);
  if (x0 < min) return springBack(min, x0 - min, v);
  if (x0 > max) return springBack(max, x0 - max, v);
  if (Math.abs(v) < 0.001) return { at: () => x0, end: x0, duration: 0 };
  const glide = (t) => x0 + (v * (DECELERATION ** t - 1)) / LN_DECELERATION;
  const rest = x0 - v / LN_DECELERATION; // where it would stop, given forever
  const edge = rest < min ? min : rest > max ? max : null;
  if (edge === null) {
    // Stops where it is once under half a pixel is left to go.
    const duration = Math.log(0.001 / Math.abs(v)) / LN_DECELERATION;
    const end = glide(duration);
    return { at: (t) => (t >= duration ? end : glide(t)), end, duration };
  }
  const reach = Math.log(1 + ((edge - x0) * LN_DECELERATION) / v) / LN_DECELERATION;
  const bounce = springBack(edge, 0, v * DECELERATION ** reach);
  return {
    at: (t) => (t < reach ? glide(t) : bounce.at(t - reach)),
    end: edge,
    duration: reach + bounce.duration,
  };
}

/**
 * The view (`{ scale, x, y }`, a `translate(x, y) scale(scale)` with origin 0 0)
 * part way, `p` from 0 to 1, between `from` and `to`. Scale moves evenly in
 * ratio, and the one content point both views put at the same place on screen
 * stays there throughout, so a zoom grows from where it is aimed instead of
 * sliding sideways as it grows.
 */
export function viewBetween(from, to, p) {
  if (Math.abs(from.scale - to.scale) < 1e-6) {
    return { scale: to.scale, x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p };
  }
  const scale = from.scale * (to.scale / from.scale) ** p;
  const k = (from.scale - scale) / (from.scale - to.scale);
  return { scale, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

/** `fn(t)` every FRAME_MS from 0 to `duration`, the last exactly at `duration`, with its offset. */
export function sampleFrames(duration, fn) {
  const frames = [];
  for (let i = 0; i * FRAME_MS < duration - 1e-6; i++) {
    const t = i * FRAME_MS;
    frames.push({ ...fn(t), offset: t / duration });
  }
  frames.push({ ...fn(duration), offset: 1 });
  return frames;
}

/**
 * Release velocity (px/ms) from `{ t, x, y }` samples, newest last: over the
 * last 100ms of movement. A finger that held still for 80ms before lifting
 * throws nothing.
 */
export function releaseVelocity(samples, now) {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > 80) return { x: 0, y: 0 };
  let first = last;
  for (let i = samples.length - 2; i >= 0 && last.t - samples[i].t <= 100; i--) first = samples[i];
  const dt = last.t - first.t;
  if (dt < 8) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}
