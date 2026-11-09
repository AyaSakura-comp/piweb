/**
 * The transcript selection drawn as one soft, translucent bubble instead of a
 * stack of per-line boxes: lines join into a single rounded outline (paragraph
 * gaps included), and the outline follows the finger on a spring, so growing
 * or shrinking the selection flows rather than jumping from box to box.
 *
 * The spring runs on the browser's compositor, at the screen's own rate (120Hz
 * on ProMotion). A `requestAnimationFrame` loop redrawing the outline is held to
 * the page's frame rate, which iOS keeps at 60Hz ("Prefer Page Rendering
 * Updates near 60fps", on by default). The user reported "這個沒有120hz" while
 * dragging a selection on 2026-11-09.
 *
 * So the bubble at rest is one SVG outline, drawn once per selection change.
 * Each line that moves is cut out of that drawing and drawn again as up to
 * three pieces:
 * - two rounded ends, which only move;
 * - the middle, which also stretches sideways and has no corners to squash.
 * The pieces play the spring as `transform` keyframes on a 120Hz grid. A frame
 * is left out only where the compositor's straight line between its neighbours
 * stays within 0.1px of the spring. The glow is cast once, by the outline where
 * it will rest, and is never cut: pieces casting their own showed seams.
 */

const PAD_X = 5;
const PAD_Y = 2;
const RADIUS = 11;
// Paragraph breaks stay inside one bubble; lines further apart than this (the
// next message) get their own.
const MAX_JOIN_GAP = 48;
// Slightly under-damped: the outline overshoots a touch and settles, like a bubble.
const STIFFNESS = 340;
const DAMPING = 25;
const SETTLE = 0.25;
const SIDES = ['l', 'r', 't', 'b'];
const SVG_NS = 'http://www.w3.org/2000/svg';

const OMEGA = Math.sqrt(STIFFNESS);
const ZETA = DAMPING / (2 * OMEGA);
const OMEGA_D = OMEGA * Math.sqrt(1 - ZETA * ZETA);

/** One keyframe per 120Hz frame; the compositor plays them at the screen's rate. */
export const FRAME_MS = 1000 / 120;
const MAX_MOTION_MS = 1500;
/** A rounded end piece: the corner radius plus the rim. It moves but never stretches. */
const CAP = RADIUS + 2;
// How far the glow reaches past the outline (a 0 6px 16px shadow, so further
// down than up), and the rim's half-width plus antialiasing.
const GLOW_X = 26;
const GLOW_UP = 20;
const GLOW_DOWN = 32;
const RIM = 2;
/** A line is drawn once it is this tall (padding included). */
const POUR_MIN = 6;
// The glow, per theme: the shadow the bubble always cast (drop-shadow 0 6px 16px
// / 0 6px 14px), as an SVG filter that draws the shadow alone.
const GLOWS = {
  dark: { deviation: 8, color: 'rgb(88 101 242)', opacity: 0.3 },
  light: { deviation: 7, color: 'rgb(63 95 111)', opacity: 0.2 },
};
// A piece draws the outline of the lines within this distance of it, so its
// junction corners and glow come out as in the whole bubble.
const NEIGHBOURHOOD = 56;

/** Merge the range's client rects into one span per visual line, top to bottom. */
export function lineSpans(rects) {
  const sorted = [...rects]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const rect of sorted) {
    const line = lines.find((candidate) => {
      const overlap = Math.min(candidate.b, rect.bottom) - Math.max(candidate.t, rect.top);
      return overlap > Math.min(candidate.b - candidate.t, rect.height) / 2;
    });
    if (line) {
      line.l = Math.min(line.l, rect.left);
      line.r = Math.max(line.r, rect.right);
      line.t = Math.min(line.t, rect.top);
      line.b = Math.max(line.b, rect.bottom);
    } else {
      lines.push({ l: rect.left, r: rect.right, t: rect.top, b: rect.bottom });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

/**
 * bubbleChains, with each fused line remembering `i`, its index in `lines`
 * (lines too small to draw are left out).
 */
function fuse(lines, { padX = PAD_X, padY = PAD_Y, radius = RADIUS, maxGap = MAX_JOIN_GAP } = {}) {
  const padded = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line && line.b - line.t > 0.5 && line.r - line.l > 0.5)
    .map(({ line, i }) => ({ l: line.l - padX, r: line.r + padX, t: line.t - padY, b: line.b + padY, i }))
    .sort((a, b) => a.t - b.t);
  const chains = [];
  let chain = null;
  for (const line of padded) {
    const last = chain?.[chain.length - 1];
    const joins =
      last &&
      line.t - last.b < maxGap &&
      Math.min(last.r, line.r) - Math.max(last.l, line.l) >= radius * 2;
    if (joins) {
      const meet = line.t > last.b ? (last.b + line.t) / 2 : Math.max(last.t, Math.min(last.b, line.t));
      last.b = meet;
      line.t = Math.min(meet, line.b);
      chain.push(line);
    } else {
      chain = [line];
      chains.push(chain);
    }
  }
  return chains;
}

/**
 * Pad the lines and fuse neighbours into chains: each chain is one bubble whose
 * lines meet edge to edge. Lines that are far apart or do not overlap
 * sideways start a new bubble.
 */
export function bubbleChains(lines, options) {
  return fuse(lines, options).map((chain) => chain.map(({ l, r, t, b }) => ({ l, r, t, b })));
}

/** The outline of a chain: down its right edge, back up its left edge. */
function chainVertices(chain) {
  const points = [];
  for (const line of chain) points.push([line.r, line.t], [line.r, line.b]);
  for (let i = chain.length - 1; i >= 0; i--) points.push([chain[i].l, chain[i].b], [chain[i].l, chain[i].t]);
  // Drop repeated points and points in the middle of a straight edge.
  const unique = points.filter(
    (p, i) => {
      const prev = points[(i - 1 + points.length) % points.length];
      return Math.abs(p[0] - prev[0]) > 0.01 || Math.abs(p[1] - prev[1]) > 0.01;
    },
  );
  return unique.filter((p, i) => {
    const prev = unique[(i - 1 + unique.length) % unique.length];
    const next = unique[(i + 1) % unique.length];
    const vertical = Math.abs(prev[0] - p[0]) < 0.01 && Math.abs(next[0] - p[0]) < 0.01;
    const horizontal = Math.abs(prev[1] - p[1]) < 0.01 && Math.abs(next[1] - p[1]) < 0.01;
    return !vertical && !horizontal;
  });
}

const round = (value) => Math.round(value * 10) / 10;

/** An SVG path for the chains with every corner, inner and outer, rounded. */
export function bubblePath(chains, radius = RADIUS) {
  let d = '';
  for (const chain of chains) {
    const points = chainVertices(chain);
    if (points.length < 3) continue;
    const corners = points.map((p, i) => {
      const prev = points[(i - 1 + points.length) % points.length];
      const next = points[(i + 1) % points.length];
      const toPrev = Math.hypot(prev[0] - p[0], prev[1] - p[1]);
      const toNext = Math.hypot(next[0] - p[0], next[1] - p[1]);
      const r = Math.min(radius, toPrev / 2, toNext / 2);
      return {
        p,
        a: [p[0] + ((prev[0] - p[0]) / toPrev) * r, p[1] + ((prev[1] - p[1]) / toPrev) * r],
        b: [p[0] + ((next[0] - p[0]) / toNext) * r, p[1] + ((next[1] - p[1]) / toNext) * r],
      };
    });
    corners.forEach(({ p, a, b }, i) => {
      d += `${i ? 'L' : 'M'}${round(a[0])} ${round(a[1])}Q${round(p[0])} ${round(p[1])} ${round(b[0])} ${round(b[1])}`;
    });
    d += 'Z';
  }
  return d;
}

/**
 * The spring, solved: where one edge is and how fast it moves `seconds` after
 * it set off from `x0` at speed `v0` toward `x1`. It is the stiffness 340 /
 * damping 25 spring the outline always used, without stepping it frame by frame.
 */
export function springAt(x0, v0, x1, seconds) {
  const a = x0 - x1;
  const b = (v0 + ZETA * OMEGA * a) / OMEGA_D;
  const decay = Math.exp(-ZETA * OMEGA * seconds);
  const cos = Math.cos(OMEGA_D * seconds);
  const sin = Math.sin(OMEGA_D * seconds);
  return {
    x: x1 + decay * (a * cos + b * sin),
    v: decay * ((b * OMEGA_D - ZETA * OMEGA * a) * cos - (a * OMEGA_D + ZETA * OMEGA * b) * sin),
  };
}

/** Where a line is, and how fast it moves, `ms` into its motion. */
function lineAt(line, ms) {
  const at = {};
  const speed = {};
  for (const side of SIDES) {
    const { x, v } = springAt(line.x0[side], line.v0[side], line.to[side], Math.max(0, ms) / 1000);
    at[side] = x;
    speed[side] = v;
  }
  return { at, speed };
}

/** Each fused band, by the index of its line; null for a line too small to draw. */
function bandsOf(lines) {
  const bands = lines.map(() => null);
  for (const chain of fuse(lines)) {
    chain.forEach((band, position) => {
      bands[band.i] = { ...band, first: position === 0, last: position === chain.length - 1 };
    });
  }
  return bands;
}

const near = (a, b, epsilon) => Math.abs(a - b) < epsilon;
const fixed = (value, digits) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/**
 * How a piece drawn for band `drawn` must move to sit where band `now` is:
 * translate (dx, dy), then scale (sx, sy) about its anchor. `part` is 'start'
 * or 'end' (a rounded end: moves, narrowed only when the line is shorter than
 * its two ends), 'middle' (stretches between the ends) or 'whole' (a short
 * line, scaled as one). A line too small to draw (`now` null) scales to 0.
 */
export function pieceMotion(part, drawn, now) {
  if (!now) return { dx: 0, dy: 0, sx: 0, sy: 0 };
  const width = now.r - now.l;
  const sy = (now.b - now.t) / (drawn.b - drawn.t);
  const dy = now.t - drawn.t;
  if (part === 'whole') return { dx: now.l - drawn.l, dy, sx: width / (drawn.r - drawn.l), sy };
  const squeeze = Math.min(1, Math.max(0, width / (2 * CAP)));
  if (part === 'start') return { dx: now.l - drawn.l, dy, sx: squeeze, sy };
  if (part === 'end') return { dx: now.r - drawn.r, dy, sx: squeeze, sy };
  return {
    dx: now.l + CAP * squeeze - (drawn.l + CAP),
    dy,
    sx: Math.max(0, width - 2 * CAP * squeeze) / (drawn.r - drawn.l - 2 * CAP),
    sy,
  };
}

/**
 * A piece's motion over `bands`, one per frame. While the line is too small to
 * draw (a null band) the piece is scaled to nothing where it next appears, so it
 * grows in place instead of flying in from where it was drawn.
 */
export function motionsOf(part, drawn, bands) {
  // A line pouring out starts as a sliver; squashed that thin, its whole drawing
  // (both rims and the fill) would read as one bright line. It shows once it
  // is a few pixels tall, as the outline always did.
  bands = bands.map((band) => (band && band.b - band.t >= POUR_MIN ? band : null));
  const motions = bands.map((band) => pieceMotion(part, drawn, band));
  let next = null;
  for (let k = bands.length - 1; k >= 0; k--) {
    if (bands[k]) next = motions[k];
    else if (next) motions[k] = { dx: next.dx, dy: next.dy, sx: 0, sy: 0 };
  }
  // A line draining away ends as nothing where it was last seen.
  const lastShown = bands.findLastIndex(Boolean);
  for (let k = lastShown + 1; lastShown >= 0 && k < bands.length; k++) {
    motions[k] = { dx: motions[lastShown].dx, dy: motions[lastShown].dy, sx: 0, sy: 0 };
  }
  return motions;
}

/** The CSS transform for a pieceMotion; every keyframe has the same functions, so they interpolate. */
export function motionTransform({ dx, dy, sx, sy }) {
  return `translate(${fixed(dx, 2)}px, ${fixed(dy, 2)}px) scale(${fixed(sx, 4)}, ${fixed(sy, 4)})`;
}

/**
 * The frames worth a keyframe. The compositor interpolates linearly between
 * keyframes, so a frame is left out only when that line passes within
 * `tolerance` px of where the spring puts it (a piece `width` × `height` px).
 * The spring curves hard at first and barely later, so most of its tail goes.
 */
export function keyframeFrames(motions, width, height, tolerance = 0.1) {
  const fits = (a, b) => {
    const from = motions[a];
    const to = motions[b];
    for (let k = a + 1; k < b; k++) {
      const at = motions[k];
      const f = (k - a) / (b - a);
      const off = (key) => Math.abs(from[key] + (to[key] - from[key]) * f - at[key]);
      if (off('dx') > tolerance || off('dy') > tolerance) return false;
      if (off('sx') * width > tolerance || off('sy') * height > tolerance) return false;
    }
    return true;
  };
  const kept = [0];
  for (let i = 0; i < motions.length - 1; ) {
    let j = i + 1;
    while (j < motions.length - 1 && fits(i, j + 1)) j++;
    kept.push(j);
    i = j;
  }
  return kept;
}

/** Where a piece's transform is anchored, in layer coordinates. */
function pieceOrigin(part, drawn) {
  if (part === 'end') return { x: drawn.r, y: drawn.t };
  if (part === 'middle') return { x: drawn.l + CAP, y: drawn.t };
  return { x: drawn.l, y: drawn.t };
}

/** The columns a moving line is cut into, between x0 and x1. */
function pieceColumns(drawn, x0, x1) {
  if (drawn.r - drawn.l < 2 * CAP + 2) return [{ part: 'whole', x0, x1 }];
  return [
    { part: 'start', x0, x1: drawn.l + CAP },
    { part: 'middle', x0: drawn.l + CAP, x1: drawn.r - CAP },
    { part: 'end', x0: drawn.r - CAP, x1 },
  ];
}

/** The outline of the bands within [top, bottom], each chain cut to its lines there. */
function outlineNear(bands, top, bottom) {
  const chains = [];
  let chain = null;
  let previous = null;
  for (const band of [...bands].filter(Boolean).sort((a, b) => a.t - b.t)) {
    const inside = band.b >= top && band.t <= bottom;
    if (!inside) {
      chain = null;
      previous = band;
      continue;
    }
    if (!chain || band.first || previous?.last) {
      chain = [];
      chains.push(chain);
    }
    chain.push(band);
    previous = band;
  }
  return bubblePath(chains);
}

// Gradient, clip and filter ids are per bubble: the chat, the Dashboard and the
// voice lasso each draw one, with gradients spanning their own selection.
let bubbleCount = 0;

/**
 * Draw and animate the bubble in `container` (a fixed, full-viewport layer).
 * Positions are kept in the scroller's content coordinates, so scrolling moves
 * the bubble rigidly while only selection changes spring.
 */
export function createSelectionBubble(container, { window, scroller, clip } = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElementNS || !document.createElement) return { set() {}, clear() {} };

  bubbleCount += 1;
  const fillId = `sel-bubble-fill-${bubbleCount}`;
  const rimId = `sel-bubble-rim-${bubbleCount}`;
  const clipId = `sel-bubble-clip-${bubbleCount}`;
  const glowId = `sel-bubble-glow-${bubbleCount}`;

  const layer = document.createElement('div');
  layer.className = 'sel-bubble-layer';
  layer.setAttribute?.('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'sel-bubble-content';
  layer.appendChild?.(content);

  // The bubble at rest: the whole outline, minus the strips of lines in motion.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sel-bubble-static');
  svg.innerHTML = `
    <defs>
      <linearGradient id="${fillId}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="sel-bubble-fill-top" />
        <stop offset="1" class="sel-bubble-fill-bottom" />
      </linearGradient>
      <linearGradient id="${rimId}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="sel-bubble-rim-top" />
        <stop offset="1" class="sel-bubble-rim-bottom" />
      </linearGradient>
      <clipPath id="${clipId}"><path class="sel-bubble-clip" clip-rule="evenodd" /></clipPath>
      ${Object.entries(GLOWS)
        .map(
          ([theme, glow]) => `
      <filter id="${glowId}-${theme}" class="sel-bubble-glow-filter" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceAlpha" stdDeviation="${glow.deviation}" />
        <feOffset dy="6" result="shadow" />
        <feFlood flood-color="${glow.color}" flood-opacity="${glow.opacity}" />
        <feComposite in2="shadow" operator="in" />
      </filter>`,
        )
        .join('')}
    </defs>
    <path class="sel-bubble-glow" fill="url(#${fillId})" stroke="url(#${rimId})" />
    <g class="sel-bubble-rest"><path class="sel-bubble" fill="url(#${fillId})" stroke="url(#${rimId})" /></g>`;
  const path = svg.querySelector('path.sel-bubble');
  // The glow is cast once, by the whole bubble where it rests, and never cut
  // into pieces: moving pieces each casting their own would show seams in it.
  const glowPath = svg.querySelector('path.sel-bubble-glow');
  const glowFilters = [...(svg.querySelectorAll?.('filter.sel-bubble-glow-filter') ?? [])];
  const clipShape = svg.querySelector('path.sel-bubble-clip');
  const rest = svg.querySelector('g.sel-bubble-rest');
  const gradients = [svg.querySelector(`#${fillId}`), svg.querySelector(`#${rimId}`)];
  content.appendChild?.(svg);

  // Each line: its spring set off from x0 at speed v0 toward `to` when the
  // current motion began (`startedAt`, on the document timeline).
  let lines = [];
  let startedAt = 0;
  let motionMs = 0;
  let leaving = false;
  let generation = 0;
  let finishTimer = 0;

  const reduceMotion = () => Boolean(window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const canAnimate = () => typeof layer.animate === 'function' && !reduceMotion();
  const scrollTop = () => scroller?.scrollTop ?? 0;
  const clock = () =>
    Number(document.timeline?.currentTime ?? window?.performance?.now?.() ?? Date.now());

  function attach() {
    if (layer.parentNode !== container) container.appendChild(layer);
  }

  function detach() {
    layer.remove?.();
  }

  /** Scroll the content with the transcript and clip it to the transcript. */
  let placed = { transform: null, clipPath: null };
  function place() {
    const transform = `translate3d(0, ${fixed(-scrollTop(), 2)}px, 0)`;
    // The layer covers the whole window; text scrolled out of its transcript
    // (under the header or the message box) must not be drawn over them.
    const box = clip?.();
    const clipPath =
      box && box.width > 0 && box.height > 0
        ? `inset(${box.top}px ${window.innerWidth - box.right}px ${window.innerHeight - box.bottom}px ${box.left}px)`
        : '';
    // Unchanged values are not written again: a drag calls this every move.
    if (content.style && transform !== placed.transform) content.style.transform = transform;
    if (layer.style && clipPath !== placed.clipPath) layer.style.clipPath = clipPath;
    placed = { transform, clipPath };
  }

  function setBox(element, x0, y0, x1, y1) {
    if (!element.style) return;
    element.style.left = `${x0}px`;
    element.style.top = `${y0}px`;
    element.style.width = `${Math.max(0, x1 - x0)}px`;
    element.style.height = `${Math.max(0, y1 - y0)}px`;
  }

  /** Draw `bands` as the bubble at rest, leaving out the `cut` strips. */
  function drawRest(bands, cut) {
    const drawn = bands.filter(Boolean);
    if (!drawn.length) {
      path.setAttribute('d', '');
      glowPath?.setAttribute('d', '');
      return;
    }
    // Whole pixels, so the outline lands on the pixel grid as it always did.
    const x0 = Math.floor(Math.min(...drawn.map((band) => band.l)) - GLOW_X);
    const x1 = Math.ceil(Math.max(...drawn.map((band) => band.r)) + GLOW_X);
    const y0 = Math.floor(Math.min(...drawn.map((band) => band.t)) - GLOW_UP);
    const y1 = Math.ceil(Math.max(...drawn.map((band) => band.b)) + GLOW_DOWN);
    setBox(svg, x0, y0, x1, y1);
    svg.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
    for (const filter of glowFilters) {
      filter.setAttribute('x', String(x0));
      filter.setAttribute('y', String(y0));
      filter.setAttribute('width', String(x1 - x0));
      filter.setAttribute('height', String(y1 - y0));
    }
    // The fill and rim shade top to bottom across the whole bubble.
    const top = Math.min(...drawn.map((band) => band.t));
    const bottom = Math.max(...drawn.map((band) => band.b));
    for (const gradient of gradients) {
      gradient?.setAttribute('y1', String(round(top)));
      gradient?.setAttribute('y2', String(round(bottom)));
    }
    const outline = bubblePath(fuseFromBands(drawn));
    path.setAttribute('d', outline);
    if (glowPath) {
      glowPath.setAttribute('d', outline);
      const theme = document.documentElement?.dataset?.theme === 'light' ? 'light' : 'dark';
      glowPath.setAttribute('filter', `url(#${glowId}-${theme})`);
    }
    if (cut.length) {
      const strips = cut
        .map((s) => ({ ...s, x0: Math.max(s.x0, x0), x1: Math.min(s.x1, x1) }))
        .filter((s) => s.x1 > s.x0)
        .map((s) => `M${s.x0} ${s.y0}H${s.x1}V${s.y1}H${s.x0}Z`)
        .join('');
      clipShape.setAttribute('d', `M${x0} ${y0}H${x1}V${y1}H${x0}Z${strips}`);
      rest.setAttribute('clip-path', `url(#${clipId})`);
    } else {
      rest.removeAttribute?.('clip-path');
    }
  }

  /** Bands back into chains, in order. */
  function fuseFromBands(bands) {
    const chains = [];
    for (const band of [...bands].sort((a, b) => a.t - b.t)) {
      if (band.first || !chains.length) chains.push([]);
      chains[chains.length - 1].push(band);
    }
    return chains;
  }

  function dropPieces(line) {
    for (const piece of line.pieces ?? []) {
      piece.animation?.cancel?.();
      piece.element.remove?.();
    }
    line.pieces = [];
    line.sig = '';
  }

  /** Draw `column` of a moving line and play its keyframes, reusing `piece` when there is one. */
  function placePiece(piece, column, box, drawn, outline, keyframes, duration) {
    let element = piece?.element;
    let drawing;
    let shape;
    if (element) {
      piece.animation?.cancel?.();
      drawing = element.firstChild;
      shape = drawing.firstChild;
    } else {
      element = document.createElement('div');
      element.className = 'sel-bubble-piece';
      drawing = document.createElementNS(SVG_NS, 'svg');
      drawing.setAttribute('preserveAspectRatio', 'none');
      shape = document.createElementNS(SVG_NS, 'path');
      shape.setAttribute('class', 'sel-bubble-moving');
      shape.setAttribute('fill', `url(#${fillId})`);
      shape.setAttribute('stroke', `url(#${rimId})`);
      drawing.appendChild(shape);
      element.appendChild(drawing);
      content.appendChild(element);
    }
    setBox(element, column.x0, box.y0, column.x1, box.y1);
    const origin = pieceOrigin(column.part, drawn);
    if (element.style) element.style.transformOrigin = `${fixed(origin.x - column.x0, 2)}px ${fixed(origin.y - box.y0, 2)}px`;
    drawing.setAttribute('viewBox', `${column.x0} ${box.y0} ${column.x1 - column.x0} ${box.y1 - box.y0}`);
    shape.setAttribute('d', outline);
    const animation = element.animate(keyframes, { duration, easing: 'linear', fill: 'forwards' });
    // On the same clock as the spring: a change mid-motion reads where the
    // bubble is from the spring itself, and the pieces agree with it.
    animation.startTime = startedAt;
    return { element, animation, part: column.part };
  }

  /** The strip a moving line occupies: from band to band, plus the rim at a bubble's ends. */
  function stripOf(band, all) {
    let ceiling = -Infinity;
    let floor = Infinity;
    for (const other of all) {
      if (other === band) continue;
      if (other.b <= band.t + 0.01) ceiling = Math.max(ceiling, other.b);
      if (other.t >= band.b - 0.01) floor = Math.min(floor, other.t);
    }
    return {
      y0: Math.max(band.t - (band.first ? RIM : 0), ceiling),
      y1: Math.min(band.b + (band.last ? RIM : 0), floor),
    };
  }

  /**
   * What a line's pieces depend on: its own target and its neighbours' (their
   * springs are time-invariant, so unchanged targets mean unchanged motion).
   * Pieces whose signature still matches keep playing; a drag re-plans on
   * every move, and most lines' motion has not changed.
   */
  function signatureOf(i) {
    const line = lines[i];
    const own = `${line.dying ? 'd' : 'l'}${leaving ? '!' : ''}${round(line.to.l)},${round(line.to.r)},${round(line.to.t)},${round(line.to.b)}`;
    // A neighbour shapes this line's band through its top and bottom (where the
    // two meet), and through whether the two are wide enough side by side to
    // fuse, at rest and now. Its left and right edges do not move this band.
    const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) >= 2 * (RADIUS - PAD_X);
    const neighbour = (other) =>
      other
        ? `${other.dying ? 'd' : ''}${round(other.to.t)},${round(other.to.b)}` +
          `${overlap(other.to, line.to) ? 'J' : 'j'}${overlap(other.x0, line.x0) ? 'J' : 'j'}`
        : '-';
    return `${own}|${neighbour(lines[i - 1])}|${neighbour(lines[i + 1])}`;
  }

  /** Play the springs from `startedAt`: the moving lines as pieces, the rest drawn still. */
  function play() {
    generation += 1;
    const token = generation;
    window?.clearTimeout?.(finishTimer);

    if (!canAnimate()) {
      settle();
      return;
    }

    // Every line set off at `startedAt`, so the spring's time terms are shared:
    // per frame one exp, cos and sin for all lines, then a multiply-add per edge.
    const maxFrames = Math.ceil(MAX_MOTION_MS / FRAME_MS);
    const decay = [];
    const cos = [];
    const sin = [];
    for (let k = 0; k <= maxFrames; k++) {
      const seconds = (k * FRAME_MS) / 1000;
      decay.push(Math.exp(-ZETA * OMEGA * seconds));
      cos.push(Math.cos(OMEGA_D * seconds));
      sin.push(Math.sin(OMEGA_D * seconds));
    }
    const terms = lines.map((line) =>
      SIDES.map((side) => {
        const a = line.x0[side] - line.to[side];
        return { a, b: (line.v0[side] + ZETA * OMEGA * a) / OMEGA_D };
      }),
    );
    const resting = terms.map((sides) => sides.every(({ a, b }) => Math.abs(a) < 1e-6 && Math.abs(b) < 1e-6));
    const positionAt = (i, k) => {
      if (resting[i]) return lines[i].to;
      const to = lines[i].to;
      const [l, r, t, b] = terms[i].map(({ a, b: c }) => decay[k] * (a * cos[k] + c * sin[k]));
      return { l: to.l + l, r: to.r + r, t: to.t + t, b: to.b + b };
    };
    const restsBy = (i) => {
      if (resting[i]) return 0;
      for (let k = 0; k <= maxFrames; k++) {
        const still = terms[i].every(({ a, b }) => {
          const off = decay[k] * (a * cos[k] + b * sin[k]);
          const speed = decay[k] * ((b * OMEGA_D - ZETA * OMEGA * a) * cos[k] - (a * OMEGA_D + ZETA * OMEGA * b) * sin[k]);
          return Math.abs(off) < SETTLE && Math.abs(speed) < SETTLE * 10;
        });
        if (still) return k;
      }
      return maxFrames;
    };
    const frames = Math.max(1, ...lines.map((_, i) => restsBy(i)));
    motionMs = frames * FRAME_MS;
    const restBands = bandsOf(lines.map((line) => (line.dying ? null : line.to)));
    // Where every line is at each frame: all of them fused, the draining ones too.
    const samples = [];
    for (let k = 0; k <= frames; k++) samples.push(bandsOf(lines.map((_, i) => positionAt(i, k))));
    const nowBands = samples[0];
    const allRest = restBands.filter(Boolean);
    const allNow = nowBands.filter(Boolean);

    const cut = [];
    let endsAt = startedAt;
    lines.forEach((line, i) => {
      // A line still selected is drawn where it will rest; one draining away
      // is drawn where it is now.
      const drawn = line.dying ? nowBands[i] : restBands[i];
      // The last frame on which the line is not where it is drawn.
      let last = -1;
      if (drawn) {
        for (let k = frames; k >= 0; k--) {
          const now = samples[k][i];
          if (!now || SIDES.some((side) => !near(now[side], drawn[side], 0.05))) {
            last = k;
            break;
          }
        }
      }
      if (last < 0) {
        dropPieces(line);
        return;
      }
      const sig = signatureOf(i);
      if (!line.pieces?.length || line.sig !== sig) {
        const bands = line.dying ? allNow : allRest;
        const strip = stripOf(drawn, bands);
        // The line's own ends, with room for an inner corner beside them. Past
        // that, a neighbour's edge belongs to the still drawing: carried along
        // by this line's end, it would trail across the screen as a stray line.
        const box = {
          x0: Math.floor(drawn.l - RADIUS - RIM),
          x1: Math.ceil(drawn.r + RADIUS + RIM),
          ...strip,
        };
        const outline = outlineNear(bands, strip.y0 - NEIGHBOURHOOD, strip.y1 + NEIGHBOURHOOD);
        // Each piece plays only until its line comes to rest.
        const span = Math.max(1, Math.min(frames, last + 1));
        const duration = span * FRAME_MS;
        const frameBands = [];
        for (let k = 0; k <= span; k++) frameBands.push(samples[Math.min(k, frames)][i]);
        // A line moving only up or down is one piece: it never stretches sideways.
        const sidewaysStill = frameBands.every(
          (band) => band && near(band.l, drawn.l, 0.05) && near(band.r, drawn.r, 0.05),
        );
        const columns = sidewaysStill ? [{ part: 'whole', x0: box.x0, x1: box.x1 }] : pieceColumns(drawn, box.x0, box.x1);
        const height = box.y1 - box.y0;
        // An end that never moves (the start of a line growing to the right)
        // stays in the still drawing.
        const planned = columns
          .map((column) => ({ column, motions: motionsOf(column.part, drawn, frameBands) }))
          .filter(({ column, motions }) =>
            motions.some(
              (m) =>
                Math.abs(m.dx) > 0.05 ||
                Math.abs(m.dy) > 0.05 ||
                Math.abs(m.sx - 1) * (column.x1 - column.x0) > 0.05 ||
                Math.abs(m.sy - 1) * height > 0.05,
            ),
          );
        const spare = [...(line.pieces ?? [])];
        line.pieces = planned.map(({ column, motions }) => {
          const keyframes = keyframeFrames(motions, column.x1 - column.x0, height).map((k) => ({
            offset: k / span,
            transform: motionTransform(motions[k]),
          }));
          const reuse = spare.findIndex((piece) => piece.part === column.part);
          const piece = reuse >= 0 ? spare.splice(reuse, 1)[0] : null;
          return placePiece(piece, column, box, drawn, outline, keyframes, duration);
        });
        for (const piece of spare) {
          piece.animation?.cancel?.();
          piece.element.remove?.();
        }
        // The still drawing gives up the whole strip but the ends that do not
        // move: what the pieces do not carry (a neighbour's edge beyond this
        // line's ends) waits for the rest instead of showing ahead of the line.
        const kept = columns.filter((column) => !planned.some((entry) => entry.column === column));
        const edges = [-1e6, ...kept.flatMap((column) => [column.x0, column.x1]), 1e6].sort((a, b) => a - b);
        line.cut = [];
        for (let k = 0; k < edges.length; k += 2) {
          if (edges[k + 1] > edges[k]) line.cut.push({ x0: edges[k], x1: edges[k + 1], y0: box.y0, y1: box.y1 });
        }
        line.sig = sig;
        line.endsAt = startedAt + duration;
      }
      if (!line.pieces.length) {
        dropPieces(line);
        return;
      }
      if (!line.dying) cut.push(...line.cut);
      endsAt = Math.max(endsAt, line.endsAt);
    });

    drawRest(restBands, cut);
    container.dataset.bubble = 'moving';
    finishTimer = window.setTimeout(() => {
      if (token === generation) settle();
    }, Math.max(0, endsAt - clock()) + 30);
  }

  /** Everything at rest: the still drawing alone, or nothing once it has left. */
  function settle() {
    generation += 1;
    window?.clearTimeout?.(finishTimer);
    for (const line of lines) dropPieces(line);
    lines = lines.filter((line) => !line.dying);
    for (const line of lines) {
      line.x0 = { ...line.to };
      line.v0 = { l: 0, r: 0, t: 0, b: 0 };
    }
    if (leaving) {
      lines = [];
      leaving = false;
      detach();
      container.dataset.bubble = 'gone';
      return;
    }
    drawRest(bandsOf(lines.map((line) => line.to)), []);
    container.dataset.bubble = 'settled';
  }

  /** Every line's position and speed now, and the clock it was read at. */
  function readNow() {
    const time = clock();
    const elapsed = time - startedAt;
    return { time, states: lines.map((line) => lineAt(line, Math.min(elapsed, motionMs))) };
  }

  function newLine(from, to) {
    return { x0: { ...from }, v0: { l: 0, r: 0, t: 0, b: 0 }, to, dying: false, pieces: [], sig: '' };
  }

  function sameTargets(targets) {
    const live = lines.filter((entry) => !entry.dying);
    return (
      live.length === targets.length &&
      live.every((entry, i) => SIDES.every((side) => near(entry.to[side], targets[i][side], 0.01)))
    );
  }

  /** Point the bubble at the selection's client rects (viewport coordinates). */
  function set(rects) {
    const offset = scrollTop();
    const targets = lineSpans(rects).map((span) => ({ ...span, t: span.t + offset, b: span.b + offset }));
    if (!targets.length) {
      clear();
      return;
    }
    const wasLeaving = leaving;
    leaving = false;
    layer.classList?.remove('leaving');
    attach();
    place();
    // A scroll: the content moved with it, and nothing about the bubble changed.
    if (!wasLeaving && lines.length && sameTargets(targets)) return;

    const { time, states } = readNow();
    lines.forEach((entry, i) => {
      entry.x0 = states[i].at;
      entry.v0 = states[i].speed;
    });

    if (!lines.length) {
      // A fresh selection inflates from the middle of each line.
      lines = targets.map((to) => {
        const x = (to.l + to.r) / 2;
        const y = (to.t + to.b) / 2;
        const h = (to.b - to.t) * 0.3;
        return newLine({ l: x, r: x, t: y - h, b: y + h }, to);
      });
      startedAt = time;
      play();
      return;
    }

    // Keep each line that is still selected; match by vertical position.
    const unclaimed = new Set(lines);
    const next = targets.map((to) => {
      let best = null;
      let bestDistance = (to.b - to.t) * 0.6;
      for (const candidate of unclaimed) {
        const distance = Math.abs(candidate.to.t - to.t);
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
      if (!best) return { to };
      unclaimed.delete(best);
      best.to = to;
      best.dying = false;
      return best;
    });

    const nearest = (y) =>
      next
        .filter((entry) => entry.x0)
        .reduce((a, b) => (!a || Math.abs(b.x0.t - y) < Math.abs(a.x0.t - y) ? b : a), null);

    // New lines pour out of their neighbour's edge instead of popping in.
    const grown = next.map((entry) => {
      if (entry.x0) return entry;
      const to = entry.to;
      const from = nearest(to.t)?.x0;
      if (!from) {
        const y = (to.t + to.b) / 2;
        return newLine({ l: to.l, r: to.l, t: y, b: y }, to);
      }
      const edge = to.t >= from.t ? from.b : from.t;
      return newLine({ l: from.l, r: from.r, t: edge, b: edge }, to);
    });

    // Lines no longer selected drain into the nearest kept line, then go.
    for (const old of unclaimed) {
      const into = grown.reduce((a, b) => (Math.abs(b.to.t - old.to.t) < Math.abs(a.to.t - old.to.t) ? b : a));
      const edge = old.to.t >= into.to.t ? into.to.b : into.to.t;
      old.to = { l: into.to.l, r: into.to.r, t: edge, b: edge };
      old.dying = true;
      grown.push(old);
    }
    lines = grown.sort((a, b) => a.to.t - b.to.t);
    startedAt = time;
    play();
  }

  /** Let the bubble shrink back into itself and fade. */
  function clear() {
    if (!lines.length) {
      detach();
      return;
    }
    const { time, states } = readNow();
    lines.forEach((entry, i) => {
      entry.x0 = states[i].at;
      entry.v0 = states[i].speed;
      const x = (entry.to.l + entry.to.r) / 2;
      const y = (entry.to.t + entry.to.b) / 2;
      entry.to = { l: x - 2, r: x + 2, t: y - 1, b: y + 1 };
      entry.dying = true;
    });
    leaving = true;
    layer.classList?.add('leaving');
    place();
    startedAt = time;
    play();
  }

  return { set, clear };
}
