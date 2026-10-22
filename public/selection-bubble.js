/**
 * The transcript selection drawn as one soft, translucent bubble instead of a
 * stack of per-line boxes: lines join into a single rounded outline (paragraph
 * gaps included), and the outline follows the finger on a spring, so growing
 * or shrinking the selection flows rather than jumping from box to box.
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
const STEP = 1 / 120;
const SETTLE = 0.25;
const SIDES = ['l', 'r', 't', 'b'];
const SVG_NS = 'http://www.w3.org/2000/svg';

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
 * Pad the lines and fuse neighbours into chains: each chain is one bubble whose
 * lines meet edge to edge. Lines that are far apart or do not overlap
 * sideways start a new bubble.
 */
export function bubbleChains(lines, { padX = PAD_X, padY = PAD_Y, radius = RADIUS, maxGap = MAX_JOIN_GAP } = {}) {
  const padded = lines
    .filter((line) => line.b - line.t > 0.5 && line.r - line.l > 0.5)
    .map((line) => ({ l: line.l - padX, r: line.r + padX, t: line.t - padY, b: line.b + padY }))
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
 * Draw and animate the bubble in `container` (a fixed, full-viewport layer).
 * Positions are kept in the scroller's content coordinates, so scrolling moves
 * the bubble rigidly while only selection changes spring.
 */
export function createSelectionBubble(container, { window, scroller } = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElementNS) return { set() {}, clear() {} };

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sel-bubble-layer');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <defs>
      <linearGradient id="sel-bubble-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="sel-bubble-fill-top" />
        <stop offset="1" class="sel-bubble-fill-bottom" />
      </linearGradient>
      <linearGradient id="sel-bubble-rim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="sel-bubble-rim-top" />
        <stop offset="1" class="sel-bubble-rim-bottom" />
      </linearGradient>
    </defs>
    <path class="sel-bubble" fill="url(#sel-bubble-fill)" stroke="url(#sel-bubble-rim)" />`;
  const path = svg.querySelector('path');

  let lines = [];
  let frame = 0;
  let last = 0;
  let leaving = false;
  const reduceMotion = () => Boolean(window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const scrollTop = () => scroller?.scrollTop ?? 0;

  function attach() {
    if (svg.parentNode !== container) container.appendChild(svg);
  }

  function render() {
    const offset = scrollTop();
    const live = lines.map((line) => ({ l: line.l, r: line.r, t: line.t - offset, b: line.b - offset }));
    path.setAttribute('d', bubblePath(bubbleChains(live)));
  }

  function settled(line) {
    return SIDES.every((side) => Math.abs(line[side] - line.to[side]) < SETTLE && Math.abs(line.v[side]) < SETTLE * 10);
  }

  function snap() {
    for (const line of lines) {
      for (const side of SIDES) {
        line[side] = line.to[side];
        line.v[side] = 0;
      }
    }
    finish();
  }

  function finish() {
    lines = lines.filter((line) => !line.dying);
    if (leaving) {
      lines = [];
      leaving = false;
      svg.remove();
      container.dataset.bubble = 'gone';
      return;
    }
    render();
    container.dataset.bubble = 'settled';
  }

  function tick(now) {
    frame = 0;
    const elapsed = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    for (let t = 0; t < elapsed; t += STEP) {
      const dt = Math.min(STEP, elapsed - t);
      for (const line of lines) {
        for (const side of SIDES) {
          const force = STIFFNESS * (line.to[side] - line[side]) - DAMPING * line.v[side];
          line.v[side] += force * dt;
          line[side] += line.v[side] * dt;
        }
      }
    }
    if (lines.every(settled)) {
      snap();
      return;
    }
    render();
    frame = window.requestAnimationFrame(tick);
  }

  function animate() {
    if (!window?.requestAnimationFrame || reduceMotion()) {
      snap();
      return;
    }
    container.dataset.bubble = 'moving';
    if (!frame) {
      last = 0;
      frame = window.requestAnimationFrame(tick);
    }
  }

  function line(from, to) {
    return { ...from, to, v: { l: 0, r: 0, t: 0, b: 0 }, dying: false };
  }

  /** Point the bubble at the selection's client rects (viewport coordinates). */
  function set(rects) {
    const offset = scrollTop();
    const targets = lineSpans(rects).map((span) => ({ ...span, t: span.t + offset, b: span.b + offset }));
    if (!targets.length) {
      clear();
      return;
    }
    leaving = false;
    svg.classList.remove('leaving');
    attach();

    if (!lines.length) {
      // A fresh selection inflates from the middle of each line.
      lines = targets.map((to) => {
        const x = (to.l + to.r) / 2;
        const y = (to.t + to.b) / 2;
        const h = (to.b - to.t) * 0.3;
        return line({ l: x, r: x, t: y - h, b: y + h }, to);
      });
      animate();
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
        .filter((entry) => entry.l !== undefined)
        .reduce((a, b) => (!a || Math.abs(b.t - y) < Math.abs(a.t - y) ? b : a), null);

    // New lines pour out of their neighbour's edge instead of popping in.
    const grown = next.map((entry) => {
      if (entry.l !== undefined) return entry;
      const to = entry.to;
      const from = nearest(to.t);
      if (!from) {
        const y = (to.t + to.b) / 2;
        return line({ l: to.l, r: to.l, t: y, b: y }, to);
      }
      const edge = to.t >= from.t ? from.b : from.t;
      return line({ l: from.l, r: from.r, t: edge, b: edge }, to);
    });

    // Lines no longer selected drain into the nearest kept line, then go.
    for (const old of unclaimed) {
      const into = grown.reduce((a, b) => (Math.abs(b.to.t - old.to.t) < Math.abs(a.to.t - old.to.t) ? b : a));
      const edge = old.to.t >= into.to.t ? into.to.b : into.to.t;
      old.to = { l: into.to.l, r: into.to.r, t: edge, b: edge };
      old.dying = true;
      grown.push(old);
    }
    lines = grown;
    animate();
  }

  /** Let the bubble shrink back into itself and fade. */
  function clear() {
    if (!lines.length) {
      svg.remove();
      return;
    }
    leaving = true;
    svg.classList.add('leaving');
    for (const entry of lines) {
      const x = (entry.to.l + entry.to.r) / 2;
      const y = (entry.to.t + entry.to.b) / 2;
      entry.to = { l: x - 2, r: x + 2, t: y - 1, b: y + 1 };
      entry.dying = true;
    }
    animate();
  }

  return { set, clear };
}
