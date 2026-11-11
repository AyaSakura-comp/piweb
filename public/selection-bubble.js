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
 * A compositor animation can only move and scale a drawing, never reshape it.
 * So the bubble is built from parts that each keep one shape (2026-11-11,
 * "120fps 泡泡看起來有點瑕疵"):
 * - straight pieces of fill and rim, which stretch along their length;
 * - rounded corners, outer ones and the inner fillets where two lines of
 *   different widths meet, which only move and grow or shrink evenly.
 * Every frame of the spring is worked out as the exact outline, the parts are
 * placed on it, and each part that moves plays its own `transform` keyframes on
 * a 120Hz grid (a frame is left out only where the compositor's straight line
 * between its neighbours stays within 0.1px). Parts that do not move are drawn
 * once, still.
 *
 * Whenever the selection changes, every part in motion starts its keyframes
 * again, all in the same update ("覺得泡泡沒有以前來的順暢…變成階梯",
 * 2026-11-11). Parts only fit together if their animations run on one clock,
 * and animations started in different updates are only as close as the engine
 * keeps their start times on the compositor (WebKit times one it hands to Core
 * Animation from when that update is committed). A part kept playing from an
 * earlier change beside a neighbour started now could drift apart from it by
 * pixels while the bubble moves fast, breaking the outline into steps; parts
 * started together cannot. A drag plans at most once a frame
 * (text-selection.js).
 *
 * Planning parts costs for every line in motion, so only a motion of a few
 * lines plays on the compositor (MAX_MOVING_LINES). A finger sweeping down a
 * long selection sets many lines moving at once: planning all their parts on
 * every move took 17ms a move on desktop (26ms in WebKit), and the phone fell
 * far behind ("現在無敵卡", 2026-11-11). Such a motion is drawn frame by frame
 * instead, as the outline was before it moved on the compositor: one path,
 * the same springs, at the page's frame rate (60Hz on iOS), with each line's
 * glow drawn once and only moved and faded.
 *
 * Lines in motion must not cut each other ("這個會閃爍", 2026-11-12): a new
 * line pours out of its neighbour's edge with that edge's speed, so the gap
 * between them only opens, and fuse() draws overlapping bands as their union.
 *
 * The parts overlap a little, so their edges never sit side by side (an edge
 * against an edge shows a hairline). Translucent parts would show every overlap
 * darker, so they are drawn opaque, the fill in one group and the rim in
 * another, and each group is made translucent once, as a whole, by a mask with
 * the bubble's top-to-bottom alpha. The first cut (f020396) moved strips of the
 * finished, translucent drawing instead: seams showed as lines, a line that
 * moved lost its rim and glow where it was cut, its rounded ends were squashed,
 * and its corners kept the shape of where it would rest.
 *
 * The glow (a soft shadow under the bubble) is faint enough that overlapping
 * parts simply add up: each line casts its own, blurred in CSS gradients, the
 * ends as fixed ramps and the middle stretched.
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
/** The rim's width (app.css strokes it this wide). */
const RIM = 1.25;
/** How far a part reaches past its inner edges into its neighbours. */
const SEAM = 0.75;
/**
 * At most this many lines move as parts on the compositor; a motion of more
 * lines is drawn frame by frame (createSelectionBubble's playFrames).
 */
const MAX_MOVING_LINES = 2;
/** How wide a line's end strip is: past its corners, into the stretching middle. */
const END = RADIUS + 2;
/** A rim piece runs on this far past its ends, under the next piece. */
const RIM_RUN = 0.75;
// The glow, per theme: the shadow the bubble always cast (a 0 6px 16px drop
// shadow of the fill, at this opacity), now cast by each line.
const GLOWS = {
  dark: { deviation: 8, color: [88, 101, 242], opacity: 0.3 },
  light: { deviation: 7, color: [63, 95, 111], opacity: 0.2 },
};
const GLOW_DY = 6;

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
      // Lines in motion can overlap, a line poured out of its neighbour's
      // edge while that neighbour still grows past it ("這個會閃爍",
      // 2026-11-11). Cut at the lower line's top, the band above lost its
      // lower part to the narrower line inside it, and a dark slit flashed
      // through the bubble for a few frames. The outline is the lines' union:
      // a line wholly within the band above adds nothing (its band is left
      // out); two bands meet halfway across the gap or the overlap between
      // them (the same rule either side, so a moving line never jumps where
      // its gap closes); and an overlap deeper than the padding (only ever in
      // motion) goes to the band that spans the other one sideways.
      if (line.b <= last.b) continue;
      const covers = (a, b) => a.l <= b.l && a.r >= b.r;
      let meet = (last.b + line.t) / 2;
      if (last.b - line.t > padY * 2 + 1) {
        if (covers(last, line)) meet = last.b;
        else if (covers(line, last)) meet = line.t;
      }
      meet = Math.max(last.t, meet);
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

// ---- the parts ----

/** A corner of a line: what kind of vertex sits there and how round it is. */
const NO_CORNER = { kind: '', r: 0 };
const corner = (kind, r) => (r > 0.01 ? { kind, r } : NO_CORNER);

/**
 * The bubble over `bands` (bandsOf) as parts that each keep one shape, keyed
 * by what they are: `<line id>:<part>` for a line's own, `<upper>/<lower>:<part>`
 * where two lines meet. Only lines in `only` (indices) and the meetings that
 * touch them are listed, when given.
 *
 * Fill parts (`layer: 'fill'`): `rect` {x0, x1, y0, y1}; `kept`, the inside of
 * a rounded outer corner, and `fillet`, the rounding added in an inner corner,
 * both {x, y, r, qx, qy}: the vertex, the radius, and the directions its two
 * edges leave it in. Rim parts (`layer: 'rim'`): `arc` {x, y, r, qx, qy},
 * `hseg` {x0, x1, y}, `vseg` {x, y0, y1}. Glow parts (`layer: 'glow'`): `glow`
 * {side: 'l' | 'm' | 'r', l, r, t, b, a}.
 *
 * The corners are rounded as bubblePath rounds them: a radius is at most half
 * of either edge beside it. (bubblePath measures a vertical edge across lines
 * that end flush; here it stops at the line, which only matters for a line
 * under 22px tall.)
 */
export function bubbleParts(bands, ids = bands.map((_, i) => i), only = null, glow = null) {
  const parts = new Map();
  const present = [];
  bands.forEach((band, i) => {
    if (!band) return;
    present.push({
      ...band,
      i,
      w: band.r - band.l,
      h: band.b - band.t,
      tl: NO_CORNER,
      tr: NO_CORNER,
      br: NO_CORNER,
      bl: NO_CORNER,
      up: null,
      down: null,
    });
  });
  present.sort((a, b) => a.t - b.t);
  for (let n = 0; n < present.length; n++) {
    const line = present[n];
    const next = present[n + 1];
    if (next && !next.first) {
      line.down = next;
      next.up = line;
    }
  }
  // Where two lines meet, the wider one turns an outer corner and the
  // narrower an inner one, on each side.
  for (const line of present) {
    const outer = Math.min(RADIUS, line.w / 2, line.h / 2);
    if (!line.up) line.tl = line.tr = corner('convex', outer);
    if (!line.down) line.bl = line.br = corner('convex', outer);
    const below = line.down;
    if (!below) continue;
    const right = Math.abs(below.r - line.r);
    const wider = line.r > below.r;
    line.br = corner(wider ? 'convex' : 'concave', Math.min(RADIUS, right / 2, line.h / 2));
    below.tr = corner(wider ? 'concave' : 'convex', Math.min(RADIUS, right / 2, below.h / 2));
    const left = Math.abs(below.l - line.l);
    const widerLeft = line.l < below.l;
    line.bl = corner(widerLeft ? 'convex' : 'concave', Math.min(RADIUS, left / 2, line.h / 2));
    below.tl = corner(widerLeft ? 'concave' : 'convex', Math.min(RADIUS, left / 2, below.h / 2));
  }

  const wanted = (line) => !only || only.has(line.i);
  for (const line of present) {
    const id = ids[line.i];
    if (wanted(line)) {
      const { l, r, t, b } = line;
      const cy = (t + b) / 2;
      const outer = (c) => (c.kind === 'convex' ? c.r : 0);
      const [tl, tr, br, bl] = [line.tl, line.tr, line.br, line.bl].map(outer);
      // The body: four overlapping rects, clear of the rounded outer corners.
      // The upper and lower halves stretch between the ends; each end's strip
      // keeps its width, so it slides with that end's corners as one piece.
      parts.set(`${id}:ht`, { layer: 'fill', kind: 'rect', x0: l + tl, x1: r - tr, y0: t, y1: cy + SEAM });
      parts.set(`${id}:hb`, { layer: 'fill', kind: 'rect', x0: l + bl, x1: r - br, y0: cy - SEAM, y1: b });
      parts.set(`${id}:vl`, { layer: 'fill', kind: 'rect', x0: l, x1: Math.min(r, l + END), y0: t + tl, y1: b - bl });
      parts.set(`${id}:vr`, { layer: 'fill', kind: 'rect', x0: Math.max(l, r - END), x1: r, y0: t + tr, y1: b - br });
      // Each corner: which way its edges leave it. A side runs along the
      // line; the other edge runs into the line (outer) or away from it (inner).
      const corners = [
        ['tl', l, t, 1, 1],
        ['tr', r, t, -1, 1],
        ['br', r, b, -1, -1],
        ['bl', l, b, 1, -1],
      ];
      for (const [name, x, y, inward, down] of corners) {
        const c = line[name];
        if (!c.kind) continue;
        const qx = c.kind === 'convex' ? inward : -inward;
        const shape = { x, y, r: c.r, qx, qy: down };
        parts.set(`${id}:${c.kind === 'convex' ? 'k' : 'f'}${name}`, {
          layer: 'fill',
          kind: c.kind === 'convex' ? 'kept' : 'fillet',
          ...shape,
        });
        parts.set(`${id}:a${name}`, { layer: 'rim', kind: 'arc', ...shape });
      }
      parts.set(`${id}:sl`, { layer: 'rim', kind: 'vseg', x: l, y0: t + line.tl.r, y1: b - line.bl.r });
      parts.set(`${id}:sr`, { layer: 'rim', kind: 'vseg', x: r, y0: t + line.tr.r, y1: b - line.br.r });
      if (!line.up) parts.set(`${id}:st`, { layer: 'rim', kind: 'hseg', x0: l + tl, x1: r - tr, y: t });
      if (!line.down) parts.set(`${id}:sb`, { layer: 'rim', kind: 'hseg', x0: l + bl, x1: r - br, y: b });
      if (glow) {
        const a = glow(line);
        for (const side of ['l', 'm', 'r']) parts.set(`${id}:g${side}`, { layer: 'glow', kind: 'glow', side, l, r, t, b, a });
      }
    }
    const below = line.down;
    if (!below || !(wanted(line) || wanted(below))) continue;
    // Where the two meet: the steps between their ends, and a bridge over the
    // edge they share, so the two bodies overlap instead of touching.
    const key = `${id}/${ids[below.i]}`;
    const meet = line.b;
    const steps = [
      ['sr', Math.min(line.r, below.r), Math.max(line.r, below.r), line.r < below.r ? [line.br, below.tr] : [below.tr, line.br]],
      ['sl', Math.min(line.l, below.l), Math.max(line.l, below.l), line.l < below.l ? [line.bl, below.tl] : [below.tl, line.bl]],
    ];
    for (const [name, from, to, [first, second]] of steps) {
      if (to - from > 0.01) parts.set(`${key}:${name}`, { layer: 'rim', kind: 'hseg', x0: from + first.r, x1: to - second.r, y: meet });
    }
    parts.set(`${key}:br`, {
      layer: 'fill',
      kind: 'rect',
      x0: Math.max(line.l, below.l),
      x1: Math.min(line.r, below.r),
      y0: meet - SEAM,
      y1: meet + SEAM,
    });
  }
  return parts;
}

/** A canonical corner (vertex at 0,0, edges along +x and +y) placed at a part. */
function placeCorner(part, segments) {
  const map = ([X, Y]) => [part.x + part.qx * X, part.y + part.qy * Y];
  let points = segments.map(([type, ...xy]) => [type, ...xy.flatMap((_, k) => (k % 2 ? [] : map([xy[k], xy[k + 1]])))]);
  // A mirror turns the outline around; fills keep one direction, so
  // overlapping ones add up under the nonzero rule instead of cancelling.
  if (part.qx * part.qy < 0 && segments[0][0] === 'M' && part.layer === 'fill') points = reverse(points);
  return points;
}

/** Reverse a closed path of M/L/Q segments. */
function reverse(segments) {
  const ends = segments.map((segment) => segment.slice(-2));
  const out = [['M', ...ends[ends.length - 1]]];
  for (let k = segments.length - 1; k >= 1; k--) {
    const [type, ...xy] = segments[k];
    out.push(type === 'Q' ? ['Q', xy[0], xy[1], ...ends[k - 1]] : ['L', ...ends[k - 1]]);
  }
  return out;
}

const pathOf = (segments, close) =>
  segments.map(([type, ...xy]) => `${type}${xy.map((v) => fixed(v, 2)).join(' ')}`).join('') + (close ? 'Z' : '');

/** The SVG path a fill or rim part draws, in content coordinates. */
export function partPath(part) {
  const r = part.r;
  const e = SEAM;
  switch (part.kind) {
    case 'rect': {
      const { x0, y0, x1, y1 } = part;
      if (!(x1 - x0 > 0.001 && y1 - y0 > 0.001)) return '';
      return `M${fixed(x0, 2)} ${fixed(y0, 2)}H${fixed(x1, 2)}V${fixed(y1, 2)}H${fixed(x0, 2)}Z`;
    }
    case 'kept':
      // The corner square without the cap the curve cuts off, reaching on
      // into the line along its two inner sides.
      return pathOf(
        placeCorner(part, [['M', r, 0], ['L', r + e, 0], ['L', r + e, r + e], ['L', 0, r + e], ['L', 0, r], ['Q', 0, 0, r, 0]]),
        true,
      );
    case 'fillet':
      // The cap between the vertex and the curve, reaching back into the two
      // lines that meet there.
      return pathOf(
        placeCorner(part, [['M', -e, -e], ['L', r, -e], ['L', r, 0], ['Q', 0, 0, 0, r], ['L', -e, r]]),
        true,
      );
    case 'arc':
      return pathOf(placeCorner(part, [['M', r + RIM_RUN, 0], ['L', r, 0], ['Q', 0, 0, 0, r], ['L', 0, r + RIM_RUN]]), false);
    case 'hseg':
      return `M${fixed(part.x0 - RIM_RUN, 2)} ${fixed(part.y, 2)}H${fixed(part.x1 + RIM_RUN, 2)}`;
    case 'vseg':
      return `M${fixed(part.x, 2)} ${fixed(part.y0 - RIM_RUN, 2)}V${fixed(part.y1 + RIM_RUN, 2)}`;
    default:
      return '';
  }
}

/** A glow column's reach past the line: three deviations of its blur. */
const glowReach = (glow) => glow.deviation * 3;

/** The box a part draws in (content coordinates), before any motion. */
function partBox(part, glow) {
  switch (part.kind) {
    case 'rect':
      return { x0: part.x0, y0: part.y0, x1: part.x1, y1: part.y1 };
    case 'kept':
    case 'fillet':
    case 'arc': {
      const reach = part.r + SEAM + RIM;
      const xs = [part.x - part.qx * SEAM * 2, part.x + part.qx * reach];
      const ys = [part.y - part.qy * SEAM * 2, part.y + part.qy * reach];
      return { x0: Math.min(...xs) - RIM, x1: Math.max(...xs) + RIM, y0: Math.min(...ys) - RIM, y1: Math.max(...ys) + RIM };
    }
    case 'hseg':
      return { x0: part.x0 - RIM_RUN - RIM, x1: part.x1 + RIM_RUN + RIM, y0: part.y - RIM, y1: part.y + RIM };
    case 'vseg':
      return { x0: part.x - RIM, x1: part.x + RIM, y0: part.y0 - RIM_RUN - RIM, y1: part.y1 + RIM_RUN + RIM };
    case 'glow': {
      const reach = glowReach(glow);
      const [x0, x1] =
        part.side === 'l'
          ? [part.l - reach, part.l + reach]
          : part.side === 'r'
            ? [part.r - reach, part.r + reach]
            : [part.l + reach, Math.max(part.l + reach + 1, part.r - reach)];
      return { x0, x1, y0: part.t + GLOW_DY - reach, y1: part.b + GLOW_DY + reach };
    }
    default:
      return null;
  }
}

/** A part's sizes that motion scales: none of them may be scaled up. */
function partSizes(part) {
  switch (part.kind) {
    case 'rect':
      return [part.x1 - part.x0, part.y1 - part.y0];
    case 'hseg':
      return [part.x1 - part.x0];
    case 'vseg':
      return [part.y1 - part.y0];
    case 'glow':
      return [part.r - part.l, part.b - part.t];
    default:
      return [part.r];
  }
}

/** `part` resized to `sizes` (partSizes order), anchored where it is. */
function resized(part, [a, b]) {
  switch (part.kind) {
    case 'rect':
      return { ...part, x1: part.x0 + a, y1: part.y0 + b };
    case 'hseg':
      return { ...part, x1: part.x0 + a };
    case 'vseg':
      return { ...part, y1: part.y0 + a };
    case 'glow':
      return { ...part, r: part.l + a, b: part.t + b };
    default:
      return { ...part, r: a };
  }
}

/**
 * How a moving part is drawn: as big as it gets in this motion, so the
 * compositor only ever scales it down. Scaled up, a part's soft edges and the
 * runs that tuck its ends under its neighbours (RIM_RUN) would grow with it:
 * a rim drawn short and stretched 13 times stuck out 10px past its corners.
 * Where it rests, when that is its biggest, so it ends exactly as the still
 * drawing that replaces it; as it was drawn before, while that is still big
 * enough, so a piece whose motion goes on keeps playing.
 */
export function drawingOf(rest, frames, before) {
  const present = frames.filter(Boolean);
  if (rest) present.push(rest);
  if (!present.length) return null;
  const sizes = partSizes(present[0]).map((_, i) => Math.max(...present.map((part) => partSizes(part)[i])));
  if (!(Math.min(...sizes) > 0.01)) return null;
  const fits = (part) => part && partSizes(part).every((size, i) => size >= sizes[i] - 0.01);
  if (fits(rest)) return rest;
  if (fits(before) && before.kind === present[0].kind) return before;
  return resized(rest ?? present[0], sizes);
}

/** Where a part's transform is anchored. */
function partOrigin(part, glow) {
  switch (part.kind) {
    case 'rect':
    case 'hseg':
      return { x: part.x0, y: part.kind === 'rect' ? part.y0 : part.y };
    case 'vseg':
      return { x: part.x, y: part.y0 };
    case 'glow': {
      const reach = glowReach(glow);
      const x = part.side === 'l' ? part.l : part.side === 'r' ? part.r : part.l + reach;
      return { x, y: part.t + GLOW_DY - reach };
    }
    default:
      return { x: part.x, y: part.y };
  }
}

/**
 * How a part drawn as `drawn` moves and scales to sit as `now`: translate
 * (dx, dy), then scale (sx, sy) about its origin. A part missing now is
 * scaled to nothing.
 */
export function partMotion(drawn, now, glow = GLOWS.dark) {
  if (!now) return drawn.kind === 'glow' ? { dx: 0, dy: 0, sx: 0, sy: 0, o: 0 } : { dx: 0, dy: 0, sx: 0, sy: 0 };
  const from = partOrigin(drawn, glow);
  const to = partOrigin(now, glow);
  const motion = { dx: to.x - from.x, dy: to.y - from.y, sx: 1, sy: 1 };
  const ratio = (a, b) => (b > 1e-6 ? Math.max(0, a) / b : 0);
  switch (drawn.kind) {
    case 'rect':
      motion.sx = ratio(now.x1 - now.x0, drawn.x1 - drawn.x0);
      motion.sy = ratio(now.y1 - now.y0, drawn.y1 - drawn.y0);
      break;
    case 'hseg':
      motion.sx = ratio(now.x1 - now.x0, drawn.x1 - drawn.x0);
      break;
    case 'vseg':
      motion.sy = ratio(now.y1 - now.y0, drawn.y1 - drawn.y0);
      break;
    case 'glow': {
      const reach = glowReach(glow);
      const box = (part) => partBox(part, glow);
      motion.sy = ratio(box(now).y1 - box(now).y0, box(drawn).y1 - box(drawn).y0);
      // A line narrower than its two ends' ramps squeezes them to meet.
      const squeeze = Math.min(1, Math.max(0, (now.r - now.l) / (2 * reach)));
      motion.sx = drawn.side === 'm' ? ratio(now.r - now.l - 2 * reach, box(drawn).x1 - box(drawn).x0) : squeeze;
      // A thin or short line casts a fainter shadow: the blur of a band
      // peaks lower the narrower the band. Squeezing the drawing alone would
      // leave a draining line's shadow at full strength.
      const peak = (size) => 2 * normalCdf(Math.max(0, size) / (2 * glow.deviation)) - 1;
      const drawnPeak = peak(drawn.b - drawn.t);
      motion.o = drawnPeak > 1e-6 ? (peak(now.r - now.l) * peak(now.b - now.t)) / drawnPeak : 0;
      break;
    }
    default:
      // A corner grows or shrinks evenly; an edge turning around (an inner
      // corner becoming an outer one, through nothing) mirrors it.
      motion.sx = (now.qx * now.r) / (drawn.qx * drawn.r);
      motion.sy = (now.qy * now.r) / (drawn.qy * drawn.r);
  }
  return motion;
}

const samePart = (a, b) => {
  if (!a || !b) return a === b;
  for (const key in a) {
    const x = a[key];
    if (typeof x === 'number' ? !near(x, b[key], 0.05) : x !== b[key]) return false;
  }
  return true;
};

/** The CSS transform for a motion; every keyframe has the same functions, so they interpolate. */
export function motionTransform({ dx, dy, sx, sy }) {
  return `translate(${fixed(dx, 2)}px, ${fixed(dy, 2)}px) scale(${fixed(sx, 4)}, ${fixed(sy, 4)})`;
}

/** Keyframes over `span` frames, the frames the compositor cannot interpolate kept. */
function keyframesOf(motions, box, span) {
  return keyframeFrames(motions, box.x1 - box.x0, box.y1 - box.y0).map((k) => {
    const frame = { offset: k / span, transform: motionTransform(motions[k]) };
    if (motions[k].o !== undefined) frame.opacity = String(fixed(motions[k].o, 3));
    return frame;
  });
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
      if (at.o !== undefined && off('o') > 0.01) return false;
    }
    return true;
  };
  // From each kept frame, the furthest the line still fits to: the reach
  // doubles while it fits, then halves between the last fit and the first
  // miss. Every line kept is checked frame by frame, so none strays.
  const kept = [0];
  const last = motions.length - 1;
  for (let i = 0; i < last; ) {
    let good = i + 1;
    let bad = 0;
    for (let step = 1; good < last; step *= 2) {
      const probe = Math.min(last, good + step);
      if (!fits(i, probe)) {
        bad = probe;
        break;
      }
      good = probe;
    }
    while (bad - good > 1) {
      const mid = (good + bad) >> 1;
      if (fits(i, mid)) good = mid;
      else bad = mid;
    }
    kept.push(good);
    i = good;
  }
  return kept;
}

/** The standard normal CDF (Abramowitz–Stegun 7.1.26, within 1.5e-7). */
function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** CSS gradient stops for `value(px)` over `size` px, every `step` px. */
function profile(size, step, value, color) {
  const stops = [];
  const count = Math.max(2, Math.ceil(size / step));
  for (let k = 0; k <= count; k++) {
    const px = (size * k) / count;
    stops.push(`${color(fixed(Math.max(0, Math.min(1, value(px))), 4))} ${fixed((100 * px) / size, 2)}%`);
  }
  return stops.join(', ');
}

// Gradient ids are per bubble: the chat, the Dashboard and the voice lasso each
// draw one, with gradients spanning their own selection.
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

  const layer = document.createElement('div');
  layer.className = 'sel-bubble-layer';
  layer.setAttribute?.('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'sel-bubble-content';
  layer.appendChild?.(content);

  // Under everything, each line's glow (the ones that hold still, then the
  // moving ones); then the fill and the rim, each an opaque drawing made
  // translucent once, as a group (app.css). Moving pieces come after anything
  // still, so only they need their own compositor layers.
  const glows = document.createElement('div');
  glows.className = 'sel-bubble-glows';
  const movingGlows = document.createElement('div');
  movingGlows.className = 'sel-bubble-glows';
  const groups = { fill: document.createElement('div'), rim: document.createElement('div') };
  groups.fill.className = 'sel-bubble-fills';
  groups.rim.className = 'sel-bubble-rims';
  content.appendChild?.(glows);
  content.appendChild?.(movingGlows);
  content.appendChild?.(groups.fill);
  content.appendChild?.(groups.rim);

  // The parts that hold still, drawn as one outline per group.
  const still = {};
  for (const name of ['fill', 'rim']) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sel-bubble-static');
    groups[name].appendChild?.(svg);
    still[name] = svg;
  }
  still.fill.innerHTML = `
    <defs>
      <linearGradient id="${fillId}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="sel-bubble-fill-top" />
        <stop offset="1" class="sel-bubble-fill-bottom" />
      </linearGradient>
      <linearGradient id="${rimId}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="sel-bubble-rim-top" />
        <stop offset="1" class="sel-bubble-rim-bottom" />
      </linearGradient>
    </defs>
    <path class="sel-bubble" fill="url(#${fillId})" stroke="none" />`;
  still.rim.innerHTML = `<path class="sel-bubble-rim" fill="none" stroke="url(#${rimId})" />`;
  const path = still.fill.querySelector('path.sel-bubble');
  const rimPath = still.rim.querySelector('path.sel-bubble-rim');
  const gradients = [still.fill.querySelector(`#${fillId}`), still.fill.querySelector(`#${rimId}`)];

  // Each line: its spring set off from x0 at speed v0 toward `to` when the
  // current motion began (`startedAt`, on the document timeline).
  let lines = [];
  let lineCount = 0;
  let startedAt = 0;
  let motionMs = 0;
  let leaving = false;
  let generation = 0;
  let finishTimer = 0;
  // Parts drawn on their own: every glow part, and the fill and rim parts in motion.
  const pieces = new Map();
  // How each moving part was drawn, so a part whose drawing still serves is not redrawn.
  let drawnBefore = new Map();
  let groupBox = null;

  const reduceMotion = () => Boolean(window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const canAnimate = () => typeof layer.animate === 'function' && !reduceMotion();
  const scrollTop = () => scroller?.scrollTop ?? 0;
  const clock = () =>
    Number(document.timeline?.currentTime ?? window?.performance?.now?.() ?? Date.now());
  const theme = () => (document.documentElement?.dataset?.theme === 'light' ? 'light' : 'dark');

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

  function setBox(element, box, origin = { x: 0, y: 0 }) {
    if (!element.style) return;
    element.style.left = `${box.x0 - origin.x}px`;
    element.style.top = `${box.y0 - origin.y}px`;
    element.style.width = `${Math.max(0, box.x1 - box.x0)}px`;
    element.style.height = `${Math.max(0, box.y1 - box.y0)}px`;
  }

  /** Whole pixels outward, so a part lands on the same pixel grid moving or still. */
  const pixelBox = (box) => ({
    x0: Math.floor(box.x0),
    y0: Math.floor(box.y0),
    x1: Math.ceil(box.x1),
    y1: Math.ceil(box.y1),
  });

  /**
   * The glow of one line: its shadow's alpha. The bubble always cast the
   * shadow of its fill, so it is as strong as the fill where the line sits.
   */
  function glowOf(top, bottom) {
    const glow = GLOWS[theme()];
    const [a0, a1] = alphaOf('fill');
    return (line) => {
      const f = bottom > top ? Math.min(1, Math.max(0, ((line.t + line.b) / 2 - top) / (bottom - top))) : 0;
      return fixed(glow.opacity * (a0 + (a1 - a0) * f), 4);
    };
  }

  /**
   * Paint a glow part: the line's blurred shadow, across this column, at the
   * theme's glow strength. How strong the line's own shadow is (`part.a`,
   * fainter toward the bottom of the bubble) is the piece's opacity: that
   * changes with the bubble's extent, and an opacity is not repainted.
   */
  function paintGlow(element, part, box, glow) {
    if (!element.style) return;
    const sigma = glow.deviation;
    const [red, green, blue] = glow.color;
    const color = (alpha) => `rgb(${red} ${green} ${blue} / ${fixed(glow.opacity * alpha, 4)})`;
    const width = box.x1 - box.x0;
    const across =
      part.side === 'm'
        ? `linear-gradient(${color(1)}, ${color(1)})`
        : `linear-gradient(to right, ${profile(width, sigma / 2, (px) => {
            const z = (box.x0 + px - (part.side === 'l' ? part.l : part.r)) / sigma;
            return part.side === 'l' ? normalCdf(z) : 1 - normalCdf(z);
          }, color)})`;
    const top = part.t + GLOW_DY;
    const bottom = part.b + GLOW_DY;
    const down = `linear-gradient(to bottom, ${profile(box.y1 - box.y0, sigma / 2, (px) => {
      const y = box.y0 + px;
      return normalCdf((y - top) / sigma) - normalCdf((y - bottom) / sigma);
    }, (alpha) => `rgb(0 0 0 / ${alpha})`)})`;
    element.style.backgroundImage = across;
    element.style.maskImage = down;
    element.style.webkitMaskImage = down;
  }

  /** A new element for a piece (parts drawn and moved as one). */
  function newPiece(layer) {
    const element = document.createElement('div');
    element.className = `sel-bubble-piece sel-bubble-${layer}-piece`;
    let shape = null;
    if (layer !== 'glow') {
      const drawing = document.createElementNS(SVG_NS, 'svg');
      drawing.setAttribute('preserveAspectRatio', 'none');
      shape = document.createElementNS(SVG_NS, 'path');
      if (layer === 'fill') {
        shape.setAttribute('fill', `url(#${fillId})`);
        shape.setAttribute('stroke', 'none');
      } else {
        shape.setAttribute('fill', 'none');
        shape.setAttribute('stroke', `url(#${rimId})`);
        shape.setAttribute('class', 'sel-bubble-rim');
      }
      drawing.appendChild(shape);
      element.appendChild(drawing);
    }
    return { element, shape, layer, look: null, at: null, animation: null };
  }

  function removePiece(piece) {
    piece.animation?.cancel?.();
    piece.element.remove?.();
  }

  /**
   * What a piece shows, apart from where its group sits. A glow's painting is
   * all relative to its box, so one that only moves keeps its painting.
   */
  const pieceLook = (plan, glow) => {
    const { box, origin, part } = plan;
    const size = `${fixed(box.x1 - box.x0, 2)},${fixed(box.y1 - box.y0, 2)}|${fixed(origin.x - box.x0, 2)},${fixed(origin.y - box.y0, 2)}`;
    if (plan.path !== undefined) return `${plan.path}|${box.x0},${box.y0}|${size}`;
    const edges = [part.l - box.x0, part.r - box.x0, part.t - box.y0, part.b - box.y0].map((v) => fixed(v, 2)).join(',');
    return `glow|${part.side}|${edges}|${size}|${glow.deviation}`;
  };
  /** How strong a glow part's line casts its shadow, as a share of the theme's glow. */
  const glowShare = (part, glow) => (glow.opacity > 0 ? part.a / glow.opacity : 0);

  /** Draw a piece (unless it already shows this), placed in its group. */
  function drawPiece(piece, plan, glow) {
    const { box, origin } = plan;
    piece.drawn = null;
    const parent = piece.layer === 'glow' ? (plan.motions ? movingGlows : glows) : groups[piece.layer];
    const offset = piece.layer === 'glow' ? { x: 0, y: 0 } : { x: groupBox.x0, y: groupBox.y0 };
    const look = pieceLook(plan, glow);
    if (piece.look !== look) {
      if (piece.element.style) piece.element.style.transformOrigin = `${fixed(origin.x - box.x0, 2)}px ${fixed(origin.y - box.y0, 2)}px`;
      if (piece.shape) {
        piece.shape.ownerSVGElement?.setAttribute?.('viewBox', `${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`);
        piece.shape.setAttribute('d', plan.path);
      } else {
        paintGlow(piece.element, plan.part, box, glow);
      }
      piece.look = look;
    }
    const at = `${box.x0 - offset.x},${box.y0 - offset.y},${box.x1 - box.x0},${box.y1 - box.y0}`;
    if (piece.at !== at) {
      setBox(piece.element, box, offset);
      piece.at = at;
    }
    if (piece.element.parentNode !== parent) parent.appendChild?.(piece.element);
  }

  /** A glow part as a piece: its column, anchored where partMotion anchors it. */
  const glowPlan = (part, glow) => ({ layer: 'glow', part, box: partBox(part, glow), origin: partOrigin(part, glow) });

  /**
   * Put the planned pieces on screen: still glows placed, and every moving
   * piece playing from `startedAt`, all started here together (see the top of
   * this file). An element no longer needed is handed to a planned piece of
   * its layer that has none, so a drag seldom makes or removes elements.
   */
  function showPieces(planned, glow) {
    const spare = { fill: [], rim: [], glow: [] };
    for (const [key, piece] of pieces) {
      if (planned.has(key)) continue;
      pieces.delete(key);
      spare[piece.layer].push(piece);
    }
    for (const [key, plan] of planned) {
      let piece = pieces.get(key);
      if (!piece) {
        piece = spare[plan.layer].pop() ?? newPiece(plan.layer);
        pieces.set(key, piece);
      }
      drawPiece(piece, plan, glow);
      if (!plan.motions) {
        piece.animation?.cancel?.();
        piece.animation = null;
        // A glow part at rest, placed as it rests (a narrow line's ends squeezed, its shadow fainter).
        const rest = partMotion(plan.part, plan.part, glow);
        const transform = motionTransform(rest);
        const opacity = String(fixed(rest.o * glowShare(plan.part, glow), 3));
        if (piece.element.style && (piece.element.style.transform !== transform || piece.element.style.opacity !== opacity)) {
          piece.element.style.transform = transform;
          piece.element.style.opacity = opacity;
        }
        continue;
      }
      if (piece.element.style) {
        if (piece.element.style.transform) piece.element.style.transform = '';
        if (piece.element.style.opacity) piece.element.style.opacity = '';
      }
      const keyframes = keyframesOf(plan.motions, plan.box, plan.span);
      const duration = plan.span * FRAME_MS;
      // A piece already animating takes the new keyframes in its animation
      // (cheaper than a new one); either way it starts again now.
      const effect = piece.animation?.effect;
      if (effect?.setKeyframes && effect.updateTiming) {
        effect.setKeyframes(keyframes);
        effect.updateTiming({ duration });
      } else {
        piece.animation?.cancel?.();
        piece.animation = piece.element.animate(keyframes, { duration, easing: 'linear', fill: 'forwards' });
      }
      // On the same clock as the spring: a change mid-motion reads where the
      // bubble is from the spring itself, and the pieces agree with it.
      piece.animation.startTime = startedAt;
    }
    for (const piece of [...spare.fill, ...spare.rim, ...spare.glow]) removePiece(piece);
  }

  // Each group's alpha at the top and bottom of the bubble, from app.css, read
  // once per theme.
  const alphas = new Map();
  function alphaOf(name) {
    const key = `${theme()}:${name}`;
    if (!alphas.has(key)) {
      const style = window?.getComputedStyle?.(groups[name]);
      const read = (property, fallback) => Number.parseFloat(style?.getPropertyValue?.(property)) || fallback;
      alphas.set(key, [read('--sel-alpha-top', 1), read('--sel-alpha-bottom', 1)]);
    }
    return alphas.get(key);
  }

  /** Shade the groups across the bubble at rest: fill and rim lighten toward its top. */
  let shaded = '';
  function shade(top, bottom) {
    const y1 = String(round(top));
    const y2 = String(round(bottom));
    const masks = Object.keys(groups).map((name) => {
      const [a0, a1] = alphaOf(name);
      return `linear-gradient(to bottom, rgb(0 0 0 / ${a0}) ${fixed(top - groupBox.y0, 2)}px, rgb(0 0 0 / ${a1}) ${fixed(bottom - groupBox.y0, 2)}px)`;
    });
    // Written only when they change: a write restyles everything in the group.
    const sig = `${y1},${y2},${masks.join()}`;
    if (sig === shaded) return;
    shaded = sig;
    for (const gradient of gradients) {
      gradient?.setAttribute('y1', y1);
      gradient?.setAttribute('y2', y2);
    }
    Object.values(groups).forEach((group, i) => {
      if (!group.style) return;
      group.style.maskImage = masks[i];
      group.style.webkitMaskImage = masks[i];
    });
  }

  /**
   * Where the groups sit: around every part drawn in this motion, on a coarse
   * grid, so a drag seldom moves them (moving one moves every piece in it).
   */
  function placeGroups(boxes) {
    const grid = 64;
    const box = {
      x0: Math.floor((Math.min(...boxes.map((b) => b.x0)) - 2) / grid) * grid,
      y0: Math.floor((Math.min(...boxes.map((b) => b.y0)) - 2) / grid) * grid,
      x1: Math.ceil((Math.max(...boxes.map((b) => b.x1)) + 2) / grid) * grid,
      y1: Math.ceil((Math.max(...boxes.map((b) => b.y1)) + 2) / grid) * grid,
    };
    if (groupBox && ['x0', 'y0', 'x1', 'y1'].every((side) => groupBox[side] === box[side])) return;
    groupBox = box;
    shaded = '';
    for (const group of Object.values(groups)) setBox(group, box);
    for (const svg of Object.values(still)) {
      setBox(svg, { x0: 0, y0: 0, x1: box.x1 - box.x0, y1: box.y1 - box.y0 });
      svg.setAttribute('viewBox', `${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`);
    }
  }

  /** Draw the parts that hold still as the still outline of each group. */
  function drawStill(parts) {
    let fill = '';
    let rim = '';
    for (const part of parts) {
      if (part.layer === 'fill') fill += partPath(part);
      else if (part.layer === 'rim') rim += partPath(part);
    }
    if (path.getAttribute?.('d') !== fill) path.setAttribute('d', fill);
    if (rimPath.getAttribute?.('d') !== rim) rimPath.setAttribute('d', rim);
  }

  /** The bubble's top and bottom at rest, which its shading spans. */
  function extent(bands) {
    const drawn = bands.filter(Boolean);
    if (!drawn.length) return { top: 0, bottom: 1 };
    return { top: Math.min(...drawn.map((band) => band.t)), bottom: Math.max(...drawn.map((band) => band.b)) };
  }

  /** Play the springs from `startedAt`: the parts in motion on their own, the rest drawn still. */
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
    const ids = lines.map((line) => line.id);
    const restBands = bandsOf(lines.map((line) => (line.dying ? null : line.to)));
    // Where every line is at each frame: all of them fused, the draining ones too.
    const samples = [];
    for (let k = 0; k <= frames; k++) samples.push(bandsOf(lines.map((_, i) => positionAt(i, k))));

    // The lines whose band moves, and with them their neighbours, whose
    // corners round against them.
    const moving = new Set();
    lines.forEach((_, i) => {
      if (samples.some((bands) => !samePart(bands[i], restBands[i]))) moving.add(i);
    });
    const active = new Set();
    for (const i of moving) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) active.add(j);

    // Many lines at once (a finger sweeping down a long message) are drawn
    // frame by frame instead: planning all their parts on every move took
    // 17ms a move on desktop, and the phone fell far behind ("現在無敵卡").
    if (moving.size > MAX_MOVING_LINES && window?.requestAnimationFrame) {
      playFrames(restBands, samples, token);
      return;
    }
    stopFrames();

    const glow = GLOWS[theme()];
    const { top, bottom } = extent(restBands);
    const glowAlpha = glowOf(top, bottom);
    const rest = bubbleParts(restBands, ids, null, glowAlpha);
    const series = new Map();
    samples.forEach((bands, k) => {
      for (const [key, part] of bubbleParts(bands, ids, active, glowAlpha)) {
        if (!series.has(key)) series.set(key, []);
        series.get(key)[k] = part;
      }
    });
    // A part listed at rest but never during the motion is gone during it.
    for (const [key] of rest) {
      const owner = key.split(':')[0].split('/');
      if (!series.has(key) && owner.some((id) => active.has(ids.indexOf(Number(id))))) series.set(key, []);
    }

    const frameKeys = [...Array(frames + 1).keys()];
    const drawnNow = new Map();
    const stillParts = [];
    const planned = new Map();
    // Fill and rim parts that move as one (the same map from where they are
    // drawn to where they are, frame after frame) share a piece: the rounded
    // end of a line, its corners and edge, slide as one layer.
    const shared = new Map();
    // Found by a hash of the maps (scales to 1e-4, offsets to 0.01px), then
    // compared at that precision, so a coincidence never merges two motions.
    const sharedFor = (layer, span, maps) => {
      const rounded = new Int32Array(maps.length * 4);
      let hash = 2166136261;
      maps.forEach((map, k) => {
        for (let c = 0; c < 4; c++) {
          const value = Math.round(map[c] * (c % 2 ? 100 : 1e4));
          rounded[k * 4 + c] = value;
          hash = Math.imul(hash ^ value, 16777619);
        }
      });
      const base = `${layer}|${span}|${hash >>> 0}`;
      for (let n = 0; ; n++) {
        const key = `${base}|${n}`;
        const group = shared.get(key);
        if (!group) {
          const made = { layer, keys: [], parts: [], maps, rounded, span };
          shared.set(key, made);
          return made;
        }
        if (group.rounded.length === rounded.length && group.rounded.every((value, i) => value === rounded[i])) return group;
      }
    };
    // The groups hold every fill and rim part of this motion, still or moving.
    const boxes = [];
    let endsAt = startedAt;
    for (const [key, part] of rest) {
      const frameParts = series.get(key);
      if (frameParts && !frameKeys.every((k) => samePart(frameParts[k], part))) continue;
      if (part.layer === 'glow') planned.set(key, glowPlan(part, glow));
      else {
        stillParts.push(part);
        boxes.push(partBox(part, glow));
      }
    }
    for (const [key, frameParts] of series) {
      if (planned.has(key)) continue;
      const restPart = rest.get(key);
      if (restPart && frameKeys.every((k) => samePart(frameParts[k], restPart))) continue;
      const drawn = drawingOf(restPart, frameParts, drawnBefore.get(key));
      if (!drawn) continue;
      drawnNow.set(key, drawn);
      // The last frame on which the part is not where it rests.
      let last = 0;
      for (let k = frames; k >= 0; k--) {
        if (!samePart(frameParts[k], restPart)) {
          last = k;
          break;
        }
      }
      const span = Math.max(1, Math.min(frames, last + 1));
      const motions = [];
      for (let k = 0; k <= span; k++) {
        const now = frameParts[Math.min(k, frames)];
        const motion = now ? partMotion(drawn, now, glow) : null;
        if (motion && drawn.kind === 'glow') motion.o *= glowShare(now, glow);
        motions.push(motion);
      }
      // While a part is missing it is scaled to nothing where it next shows
      // (or where it was last seen), so it grows and shrinks in place.
      const gone = (at) => ({ dx: at?.dx ?? 0, dy: at?.dy ?? 0, sx: 0, sy: 0, ...(drawn.kind === 'glow' ? { o: 0 } : {}) });
      let next = null;
      for (let k = motions.length - 1; k >= 0; k--) {
        if (motions[k]) next = motions[k];
        else if (next) motions[k] = gone(next);
      }
      let seen = null;
      for (let k = 0; k < motions.length; k++) {
        if (motions[k]) seen = motions[k];
        else motions[k] = gone(seen);
      }
      endsAt = Math.max(endsAt, startedAt + span * FRAME_MS);
      if (drawn.layer === 'glow') {
        const plan = glowPlan(drawn, glow);
        planned.set(key, { ...plan, motions, span });
        continue;
      }
      // Each frame as a map of the content: x -> ax x + bx, y -> ay y + by.
      const origin = partOrigin(drawn, glow);
      const maps = motions.map(({ dx, dy, sx, sy }) => [sx, origin.x + dx - sx * origin.x, sy, origin.y + dy - sy * origin.y]);
      const group = sharedFor(drawn.layer, span, maps);
      group.keys.push(key);
      group.parts.push(drawn);
    }
    for (const { layer, keys, parts, maps, span } of shared.values()) {
      const drawnBoxes = parts.map((part) => partBox(part, glow));
      const box = pixelBox({
        x0: Math.min(...drawnBoxes.map((b) => b.x0)),
        y0: Math.min(...drawnBoxes.map((b) => b.y0)),
        x1: Math.max(...drawnBoxes.map((b) => b.x1)),
        y1: Math.max(...drawnBoxes.map((b) => b.y1)),
      });
      const origin = { x: box.x0, y: box.y0 };
      const motions = maps.map(([ax, bx, ay, by]) => ({
        dx: ax * origin.x + bx - origin.x,
        dy: ay * origin.y + by - origin.y,
        sx: ax,
        sy: ay,
      }));
      planned.set(`${layer}:${keys.join(',')}`, {
        layer,
        path: parts.map(partPath).join(''),
        box,
        origin,
        motions,
        span,
      });
      for (const [ax, bx, ay, by] of maps) {
        const xs = [box.x0, box.x1].map((x) => ax * x + bx);
        const ys = [box.y0, box.y1].map((y) => ay * y + by);
        boxes.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
      }
    }
    if (!boxes.length) boxes.push({ x0: 0, y0: top, x1: 1, y1: bottom });
    placeGroups(boxes);
    shade(top, bottom);
    drawStill(stillParts);
    showPieces(planned, glow);
    drawnBefore = drawnNow;
    container.dataset.bubble = 'moving';
    finishTimer = window.setTimeout(() => {
      if (token === generation) settle();
    }, Math.max(0, endsAt - clock()) + 30);
  }

  // ---- a big motion, drawn frame by frame ----

  let frameLoop = 0;
  // Each line's glow column as drawn for the motion, by key.
  let frameGlows = null;

  function stopFrames() {
    if (frameLoop) window?.cancelAnimationFrame?.(frameLoop);
    frameLoop = 0;
    frameGlows = null;
  }

  /**
   * Play the springs by redrawing the outline every frame, as the bubble did
   * before it moved on the compositor: one path, so the work per move does not
   * grow with the lines in motion. iOS draws it at the page's 60Hz.
   */
  function playFrames(restBands, samples, token) {
    const glow = GLOWS[theme()];
    const { top, bottom } = extent(restBands);
    const glowAlpha = glowOf(top, bottom);
    // The groups hold the bubble wherever the motion takes it.
    const span = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const bands of samples) {
      for (const band of bands) {
        if (!band) continue;
        span.x0 = Math.min(span.x0, band.l);
        span.y0 = Math.min(span.y0, band.t);
        span.x1 = Math.max(span.x1, band.r);
        span.y1 = Math.max(span.y1, band.b);
      }
    }
    const reach = RIM + RIM_RUN + 1;
    placeGroups(
      Number.isFinite(span.x0)
        ? [{ x0: span.x0 - reach, y0: span.y0 - reach, x1: span.x1 + reach, y1: span.y1 + reach }]
        : [{ x0: 0, y0: top, x1: 1, y1: bottom }],
    );
    shade(top, bottom);
    // Each line's glow is drawn once, as big as the line gets (or kept as it
    // was drawn, while that is big enough), and moved and faded every frame: a
    // glow repainted every frame would cost far more.
    const planned = new Map();
    const before = frameGlows;
    frameGlows = new Map();
    lines.forEach((line, i) => {
      let base = restBands[i];
      let width = 0;
      let height = 0;
      for (const bands of samples) {
        const band = bands[i];
        if (!band) continue;
        base ??= band;
        width = Math.max(width, band.r - band.l);
        height = Math.max(height, band.b - band.t);
      }
      if (!base || !(width > 0.01 && height > 0.01)) return;
      const a = glowAlpha(base);
      for (const side of ['l', 'm', 'r']) {
        const key = `${line.id}:g${side}`;
        const old = before?.get(key);
        const drawn =
          old && old.r - old.l >= width && old.b - old.t >= height
            ? old
            : { layer: 'glow', kind: 'glow', side, l: base.l, r: base.l + width, t: base.t, b: base.t + height, a };
        planned.set(key, drawn);
        frameGlows.set(key, drawn);
      }
    });
    placeFrameGlows(planned, glow);
    drawnBefore = new Map();
    container.dataset.bubble = 'moving';
    drawFrame(glow, glowAlpha);
    const tick = () => {
      frameLoop = 0;
      if (token !== generation) return;
      drawFrame(glow, glowAlpha);
      if (clock() - startedAt < motionMs) frameLoop = window.requestAnimationFrame(tick);
    };
    if (frameLoop) window.cancelAnimationFrame?.(frameLoop);
    frameLoop = window.requestAnimationFrame(tick);
    finishTimer = window.setTimeout(() => {
      if (token === generation) settle();
    }, Math.max(0, startedAt + motionMs - clock()) + 30);
  }

  /**
   * Put each line's glow drawing in place for a motion drawn frame by frame:
   * the fill and rim pieces go (the outline is one path now), and a glow whose
   * drawing still serves is left as it is; drawFrame moves it.
   */
  function placeFrameGlows(planned, glow) {
    const spare = [];
    for (const [key, piece] of pieces) {
      if (planned.has(key)) continue;
      pieces.delete(key);
      if (piece.layer === 'glow') spare.push(piece);
      else removePiece(piece);
    }
    for (const [key, drawn] of planned) {
      let piece = pieces.get(key);
      if (!piece) {
        piece = spare.pop() ?? newPiece('glow');
        pieces.set(key, piece);
      }
      if (piece.animation) {
        piece.animation.cancel?.();
        piece.animation = null;
      }
      if (piece.drawn === drawn) continue;
      drawPiece(piece, glowPlan(drawn, glow), glow);
      piece.drawn = drawn;
    }
    for (const piece of spare) removePiece(piece);
  }

  /** The outline where the springs are now, and every line's glow under it. */
  function drawFrame(glow, glowAlpha) {
    const ms = Math.max(0, Math.min(clock() - startedAt, motionMs));
    const at = lines.map((line) => lineAt(line, ms).at);
    const outline = bubblePath(bubbleChains(at));
    if (path.getAttribute?.('d') !== outline) path.setAttribute('d', outline);
    if (rimPath.getAttribute?.('d') !== outline) rimPath.setAttribute('d', outline);
    const bands = bandsOf(at);
    lines.forEach((line, i) => {
      const band = bands[i];
      for (const side of ['l', 'm', 'r']) {
        const key = `${line.id}:g${side}`;
        const piece = pieces.get(key);
        const drawn = frameGlows?.get(key);
        if (!piece?.element.style || !drawn) continue;
        const now = band ? { ...drawn, l: band.l, r: band.r, t: band.t, b: band.b, a: glowAlpha(band) } : null;
        const motion = partMotion(drawn, now, glow);
        const transform = motionTransform(motion);
        const opacity = String(fixed(motion.o * (now ? glowShare(now, glow) : 0), 3));
        if (piece.element.style.transform !== transform) piece.element.style.transform = transform;
        if (piece.element.style.opacity !== opacity) piece.element.style.opacity = opacity;
      }
    });
  }

  /** Everything at rest: the still drawing alone, or nothing once it has left. */
  function settle() {
    generation += 1;
    window?.clearTimeout?.(finishTimer);
    stopFrames();
    lines = lines.filter((line) => !line.dying);
    for (const line of lines) {
      line.x0 = { ...line.to };
      line.v0 = { l: 0, r: 0, t: 0, b: 0 };
    }
    if (leaving) {
      for (const piece of pieces.values()) removePiece(piece);
      pieces.clear();
      lines = [];
      leaving = false;
      detach();
      container.dataset.bubble = 'gone';
      return;
    }
    const bands = bandsOf(lines.map((line) => line.to));
    const glow = GLOWS[theme()];
    const { top, bottom } = extent(bands);
    const parts = bubbleParts(bands, lines.map((line) => line.id), null, glowOf(top, bottom));
    const drawnStill = [];
    const glowParts = new Map();
    for (const [key, part] of parts) {
      if (part.layer === 'glow') glowParts.set(key, part);
      else drawnStill.push(part);
    }
    placeGroups(drawnStill.length ? drawnStill.map((part) => partBox(part, glow)) : [{ x0: 0, y0: top, x1: 1, y1: bottom }]);
    shade(top, bottom);
    drawStill(drawnStill);
    const planned = new Map();
    for (const [key, part] of glowParts) planned.set(key, glowPlan(part, glow));
    showPieces(planned, glow);
    container.dataset.bubble = 'settled';
  }

  /** Every line's position and speed now, and the clock it was read at. */
  function readNow() {
    const time = clock();
    const elapsed = time - startedAt;
    return { time, states: lines.map((line) => lineAt(line, Math.min(elapsed, motionMs))) };
  }

  function newLine(from, to, speed = { l: 0, r: 0, t: 0, b: 0 }) {
    lineCount += 1;
    return { id: lineCount, x0: { ...from }, v0: { ...speed }, to, dying: false };
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

    // New lines pour out of their neighbour's edge instead of popping in,
    // moving as that edge moves: on the same spring, the gap between them then
    // only ever opens, so a neighbour still growing never runs over the line
    // poured out of it (a dark slit flashed through the bubble where it did).
    const grown = next.map((entry) => {
      if (entry.x0) return entry;
      const to = entry.to;
      const neighbour = nearest(to.t);
      const from = neighbour?.x0;
      if (!from) {
        const y = (to.t + to.b) / 2;
        return newLine({ l: to.l, r: to.l, t: y, b: y }, to);
      }
      const side = to.t >= from.t ? 'b' : 't';
      const edge = from[side];
      const v = neighbour.v0;
      return newLine({ l: from.l, r: from.r, t: edge, b: edge }, to, { l: v.l, r: v.r, t: v[side], b: v[side] });
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

  /** The exact outline `ms` into the current motion (tests compare the parts with it). */
  function shapeAt(ms) {
    return bubblePath(bubbleChains(linesAt(ms)));
  }

  /** Where every line's spring is `ms` into the current motion (tests check the outline holds them). */
  function linesAt(ms) {
    return lines.map((line) => lineAt(line, Math.min(ms, motionMs)).at);
  }

  return { set, clear, shapeAt, linesAt };
}
