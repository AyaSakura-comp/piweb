/** Render completed Markdown once, then reveal it without moving the text. */
import { renderRich, whenRichReady } from './markdown.js';

const streams = new WeakMap();
// The transport trims completed replies. Canonicalize the leading edge from
// the first partial too, while retaining trailing newlines for block boundaries.
const normalize = (text) =>
  String(text || '')
    .replace(/\r\n?/g, '\n')
    .trimStart();
const REVEAL_FEATHER = 56;
const REVEAL_SPEED = 120;
const RATE_WINDOW_MS = 1200;
const RATE_SAMPLE_MS = 40;
const PACE_SMOOTHING_MS = 400;
const MIN_STREAM_SPEED = 24;
const MAX_STREAM_SPEED = 600;

export function createRevealPace() {
  return { samples: [], highWater: 0, speed: REVEAL_SPEED };
}

/** Sample positive source growth, even while its Markdown tail is unfinished. */
export function noteRevealArrival(pace, length, now) {
  if (length <= pace.highWater) return;
  pace.highWater = length;
  const last = pace.samples.at(-1);
  // Time-bucket rapid packets before bounding storage. Keep real timestamps,
  // so the 1200ms window never becomes a long-history average at high frequency.
  if (
    last &&
    (now <= last.at || Math.floor(now / RATE_SAMPLE_MS) === Math.floor(last.at / RATE_SAMPLE_MS))
  ) {
    last.count = length;
    last.at = Math.max(last.at, now);
  } else pace.samples.push({ at: now, count: length });
  // Keep an anchor before the window for interpolation, with bounded storage.
  while (pace.samples.length > 2 && pace.samples[1].at < now - RATE_WINDOW_MS) pace.samples.shift();
  if (pace.samples.length > 64) pace.samples.splice(1, pace.samples.length - 64);
}

function recentArrivalRate(pace, now) {
  const samples = pace.samples;
  if (samples.length < 2 || now - samples[0].at < 80) return null;
  const start = Math.max(samples[0].at, now - RATE_WINDOW_MS);
  let count = samples.at(-1).count;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].at < start) continue;
    const previous = samples[i - 1];
    const fraction = (start - previous.at) / (samples[i].at - previous.at);
    count = previous.count + (samples[i].count - previous.count) * fraction;
    break;
  }
  return ((pace.highWater - count) * 1000) / Math.max(1, now - start);
}

/** Follow arrival cadence in both directions; never snap the front or velocity. */
export function advanceRevealPace(
  pace,
  { now, elapsed, front, goal, pixelsPerChar = 0.75, catchupSpeed = 0, complete = false },
) {
  const rate = recentArrivalRate(pace, now);
  const incoming = rate === null ? REVEAL_SPEED : Math.min(MAX_STREAM_SPEED, rate * pixelsPerChar);
  const backlog = Math.max(0, goal - front);
  // A soft 450ms lookahead slows an almost-caught-up front without holding a
  // whole chunk or introducing another reveal timer. No ready data still waits.
  const buffered =
    rate !== null && !complete
      ? incoming * Math.min(1, backlog / Math.max(REVEAL_FEATHER, incoming * 0.45))
      : incoming;
  const target = Math.max(
    complete || rate === null ? REVEAL_SPEED : MIN_STREAM_SPEED,
    buffered,
    catchupSpeed,
  );
  const dt = Math.max(0, Math.min(48, elapsed));
  pace.speed += (target - pace.speed) * (1 - Math.exp(-dt / PACE_SMOOTHING_MS));
  return pace.speed;
}

/** Merge rendered inline rectangles into row bands without changing the DOM. */
export function buildRevealRows(rectangles, height) {
  const lines = [];
  for (const rect of [...rectangles]
    .filter((r) => r.bottom > r.top && r.right > r.left)
    .sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = lines.at(-1);
    if (last && rect.top < last.bottom - 0.5) {
      last.bottom = Math.max(last.bottom, rect.bottom);
      last.left = Math.min(last.left, rect.left);
      last.right = Math.max(last.right, rect.right);
      if (rect.kind === 'media') last.kind = 'media';
    } else lines.push({ ...rect, kind: rect.kind || 'text' });
  }
  return lines.map((row, i) => ({
    top: i ? (lines[i - 1].bottom + row.top) / 2 : 0,
    bottom: i + 1 < lines.length ? (row.bottom + lines[i + 1].top) / 2 : height,
    left: row.left,
    right: row.right,
    kind: row.kind,
  }));
}

/** Reading-order surface of the shared vertical-equivalent progress coordinate. */
export function revealRowAt(rows, front, lead = 0) {
  if (!rows.length || front >= rows.at(-1).bottom) return { mode: 'ready', index: rows.length };
  if (front < -lead) return { mode: 'hidden', index: -1 };
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (front >= rows[middle].bottom) low = middle + 1;
    else high = middle;
  }
  const row = rows[low];
  const start = low ? row.top : -lead;
  const progress = Math.max(0, Math.min(1, (front - start) / Math.max(1, row.bottom - start)));
  return {
    mode: row.kind === 'media' ? 'media' : 'rows',
    index: low,
    top: row.top,
    height: row.bottom - row.top,
    front: row.left - REVEAL_FEATHER + (row.right - row.left + REVEAL_FEATHER) * progress,
  };
}

const RICH_ATOMS =
  '.mermaid-chart, .katex-display, .katex, .msg-inline-media, img, video, iframe, svg, canvas';
function measureRevealRows(chunk, bounds) {
  const rectangles = [];
  const add = (rect, kind = 'text') => {
    const box = {
      top: Math.max(0, rect.top - bounds.top),
      bottom: Math.min(bounds.height, rect.bottom - bounds.top),
      left: Math.max(0, rect.left - bounds.left),
      right: Math.min(bounds.width, rect.right - bounds.left),
      kind,
    };
    if (box.bottom > box.top && box.right > box.left) rectangles.push(box);
  };
  const walker = document.createTreeWalker(chunk, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || node.parentElement.closest(RICH_ATOMS)) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) add(rect);
  }
  for (const atom of chunk.querySelectorAll(RICH_ATOMS)) {
    if (atom.parentElement.closest(RICH_ATOMS)) continue;
    add(
      atom.getBoundingClientRect(),
      atom.matches('.katex:not(.katex-display)') ? 'text' : 'media',
    );
  }
  if (!rectangles.length && bounds.height > 0)
    rectangles.push({ top: 0, bottom: bounds.height, left: 0, right: bounds.width, kind: 'media' });
  return buildRevealRows(rectangles, bounds.height);
}

/** One shared pixel coordinate; neither new blocks nor layout shrink rewind it. */
export function advanceRevealFront(front, goal, elapsed, speed = REVEAL_SPEED) {
  const step = (Math.max(0, Math.min(48, elapsed)) * speed) / 1000;
  return Math.max(front, Math.min(goal, front + step));
}

/** Last stable block boundary, before any transport-owned outbox tail. */
export function stableMarkdownBoundary(text) {
  // Delivery replaces local markers with URLs (or strips unpublished markers).
  // They and subsequent blocks are not stable source yet. Keep earlier blocks
  // visible and let EOF render this tail once, after publication is complete.
  const outbox = text.search(/\[\[(?:image|video|file)\s*:/i);
  if (outbox >= 0) text = text.slice(0, outbox);
  let boundary = 0;
  let offset = 0;
  let fence = null;
  let math = null;
  let list = false;
  let listBoundary = 0;
  for (const line of text.match(/[^\n]*(?:\n|$)/g) || []) {
    offset += line.length;
    if (!fence && !math) {
      // Match production parser indentation, excluding the line's final LF.
      const item = /^[^\S\n]*(?:[-*+]|\d+[.)])[^\S\n]+/.test(line);
      // Blank lines may precede another item or an indented continuation.
      // Wait for an outdented non-item (or finalization) before committing.
      const unfinishedMarker = !line.endsWith('\n') && /^[^\S\n]*(?:[-*+]|\d+[.)]?)$/.test(line);
      if (list && listBoundary && /^\S/.test(line) && !item && !unfinishedMarker) {
        boundary = listBoundary;
        list = false;
        listBoundary = 0;
      }
      if (item) list = true;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      continue;
    }
    if (marker && !math) {
      fence = marker[1];
      continue;
    }
    for (const match of line.matchAll(/(?<!\\)(\$\$|\\\[|\\\]|\\\(|\\\))/g)) {
      const token = match[0];
      if (math) {
        if (token === math) math = null;
      } else if (token === '$$') math = '$$';
      else if (token === '\\[') math = '\\]';
      else if (token === '\\(') math = '\\)';
    }
    if (!math && /^[ \t]*\n$/.test(line)) {
      if (list) listBoundary = offset;
      else boundary = offset;
    }
  }
  return boundary;
}

function reusableBoundary(stream, source, complete) {
  const prefix = stream.source.slice(0, stream.boundary);
  if (source.startsWith(prefix)) return stream.boundary;
  // EOF may remove only the accepted prefix's outer whitespace. Require exact
  // equality, not a looser startsWith that could hide a substantive rewrite.
  return complete && source === prefix.trimEnd() ? source.length : -1;
}

export function canReuseStreamingRich(target, text) {
  const stream = target && streams.get(target);
  return !!stream && reusableBoundary(stream, normalize(text), true) >= 0;
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function createRevealFlow(target) {
  target.classList.add('reply-flow');
  target.dataset.reveal = 'pending';
  target.style.setProperty('--reply-front', `${-REVEAL_FEATHER}px`);
  return {
    front: -REVEAL_FEATHER,
    goal: 0,
    pace: createRevealPace(),
    complete: false,
    preparedChars: 0,
    pixelsPerChar: 0.75,
    catchupSpeed: 0,
    items: [],
    frame: 0,
    clock: null,
    measure: true,
    observer: null,
    media: null,
    onMotion: null,
  };
}

function stopRevealFlow(flow) {
  cancelAnimationFrame(flow.frame);
  flow.frame = 0;
  flow.clock = null;
  // Retain a learned slow pace across idle gaps, but discard exceptional
  // backlog catch-up velocity before a later small continuation.
  flow.pace.speed = Math.min(REVEAL_SPEED, flow.pace.speed);
  flow.observer?.disconnect();
  flow.observer = null;
  flow.media?.removeEventListener('change', flow.onMotion);
  flow.media = null;
  flow.onMotion = null;
}

function measureRevealFlow(target, flow) {
  // Expanded thinking can scroll internally. Measure in target content space,
  // not viewport space, so scrollTop never becomes an unearned reveal advance.
  const origin = target.getBoundingClientRect().top - target.scrollTop;
  let floor = flow.front;
  flow.goal = 0;
  for (const item of flow.items) {
    const rect = item.chunk.getBoundingClientRect();
    const top = rect.top - origin;
    const changed =
      item.rows &&
      (Math.abs(item.width - rect.width) > 0.2 || Math.abs(item.height - rect.height) > 0.2);
    // Release an already-started chunk on reflow: previously read glyphs must
    // never become hidden because their line breaks changed. Future chunks wait.
    if (changed && flow.front > item.top - (item === flow.items[0] ? REVEAL_FEATHER : 0)) {
      floor = Math.max(floor, rect.bottom - origin);
    }
    item.top = top;
    item.end = rect.bottom - origin;
    if (item.chunk.dataset.reveal === 'ready') floor = Math.max(floor, item.end);
    else {
      item.chunk.style.setProperty('--chunk-top', `${top}px`);
      if (!item.rows || changed) {
        item.rows = measureRevealRows(item.chunk, rect);
        item.width = rect.width;
        item.height = rect.height;
        item.mask = null;
      }
    }
    flow.goal = Math.max(flow.goal, item.end);
  }
  // Preserve already exposed content when a responsive reflow changes offsets.
  flow.front = floor;
  // Calibrate visual density without inventing a source-arrival sample on resize.
  if (flow.preparedChars)
    flow.pixelsPerChar = Math.max(0.1, Math.min(8, flow.goal / flow.preparedChars));
  const backlog = Math.max(0, flow.goal - flow.front);
  // Cold starts, very large buffers and EOF need a bounded catch-up fallback.
  // Ordinary live streams can go BELOW 120px/s and slow down within an episode.
  flow.catchupSpeed =
    flow.complete || backlog > 800 || flow.pace.samples.length < 2 ? backlog / 3.2 : 0;
  flow.measure = false;
}

function paintRevealFlow(target, flow) {
  target.style.setProperty('--reply-front', `${flow.front.toFixed(2)}px`);
  target.style.setProperty('--reply-speed', `${flow.pace.speed.toFixed(2)}`);
  for (const item of flow.items) {
    const { chunk, end } = item;
    if (chunk.dataset.reveal === 'ready') continue;
    if (flow.front >= end) {
      chunk.dataset.reveal = 'ready';
      chunk.inert = false;
      chunk.removeAttribute('aria-hidden');
      delete chunk.dataset.revealMode;
      delete chunk.dataset.revealRow;
      for (const property of [
        '--chunk-top',
        '--reply-row-top',
        '--reply-row-height',
        '--reply-row-front',
      ])
        chunk.style.removeProperty(property);
      continue;
    }
    const mask = revealRowAt(
      item.rows,
      flow.front - item.top,
      item === flow.items[0] ? REVEAL_FEATHER : 0,
    );
    if (!item.mask || item.mask.mode !== mask.mode || item.mask.index !== mask.index) {
      chunk.dataset.revealMode = mask.mode;
      chunk.dataset.revealRow = String(mask.index);
      chunk.style.setProperty('--reply-row-top', `${(mask.top || 0).toFixed(2)}px`);
      chunk.style.setProperty('--reply-row-height', `${(mask.height || 0).toFixed(2)}px`);
    }
    if (mask.mode === 'rows')
      chunk.style.setProperty('--reply-row-front', `${mask.front.toFixed(2)}px`);
    item.mask = mask;
  }
  target.dataset.reveal = flow.front < flow.goal ? 'revealing' : 'ready';
}

function resumeRevealFlow(target, flow) {
  if (flow.frame) return;
  const current = () => streams.get(target)?.flow === flow && target.isConnected;
  measureRevealFlow(target, flow);
  const showAll = () => {
    if (!current()) return stopRevealFlow(flow);
    if (flow.measure) measureRevealFlow(target, flow);
    flow.front = Math.max(flow.front, flow.goal);
    paintRevealFlow(target, flow);
    stopRevealFlow(flow);
  };
  // Closed thinking disclosures have no visible geometry and need no animation.
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  if (media.matches || !target.getBoundingClientRect().height) return showAll();
  flow.media = media;
  flow.onMotion = () => {
    if (media.matches) showAll();
  };
  media.addEventListener('change', flow.onMotion);
  flow.observer = new ResizeObserver(() => {
    if (!current()) return stopRevealFlow(flow);
    flow.measure = true;
  });
  flow.observer.observe(target);
  const tick = (now) => {
    flow.frame = 0;
    if (!current()) return stopRevealFlow(flow);
    if (flow.measure) measureRevealFlow(target, flow);
    const elapsed = flow.clock === null ? 0 : now - flow.clock;
    flow.clock = now;
    const speed = advanceRevealPace(flow.pace, {
      now,
      elapsed,
      front: flow.front,
      goal: flow.goal,
      pixelsPerChar: flow.pixelsPerChar,
      catchupSpeed:
        flow.complete || flow.goal - flow.front > 800 || flow.pace.samples.length < 2
          ? flow.catchupSpeed
          : 0,
      complete: flow.complete,
    });
    flow.front = advanceRevealFront(flow.front, flow.goal, elapsed, speed);
    paintRevealFlow(target, flow);
    if (flow.front >= flow.goal) return stopRevealFlow(flow);
    flow.frame = requestAnimationFrame(tick);
  };
  paintRevealFlow(target, flow);
  flow.frame = requestAnimationFrame(tick);
}

/**
 * Buffer the unfinished tail. Only new, complete blocks enter the render queue.
 * Ready blocks are appended once; finalization flushes the tail into the same
 * target. Revisions and connection checks fence replaced/cancelled replies.
 */
export function updateStreamingRich(
  target,
  text,
  { complete = false, beforeAppend, afterAppend } = {},
) {
  const source = normalize(text);
  let stream = streams.get(target);
  if (!stream) {
    stream = {
      source: '',
      boundary: 0,
      revision: 0,
      queue: Promise.resolve(),
      flow: createRevealFlow(target),
    };
    streams.set(target, stream);
  }
  // A provider may revise its still-hidden tail. Preserve completed blocks
  // unless their own source changed, not merely the unfinished suffix.
  const reuseBoundary = reusableBoundary(stream, source, complete);
  if (reuseBoundary < 0) {
    stream.revision++;
    stream.boundary = 0;
    stream.queue = Promise.resolve();
    stopRevealFlow(stream.flow);
    target.replaceChildren();
    stream.flow = createRevealFlow(target);
  } else stream.boundary = reuseBoundary;
  stream.source = source;
  noteRevealArrival(stream.flow.pace, source.length, performance.now());
  if (complete && !stream.flow.complete) {
    stream.flow.complete = true;
    stream.flow.measure = true;
  }
  const boundary = complete ? source.length : stableMarkdownBoundary(source);
  if (boundary <= stream.boundary) return stream.queue;

  const delta = source.slice(stream.boundary, boundary);
  stream.boundary = boundary;
  if (!delta.trim()) return stream.queue;
  const revision = stream.revision;
  const current = () =>
    streams.get(target) === stream && stream.revision === revision && target.isConnected;
  stream.queue = stream.queue.then(async () => {
    if (!current()) return;
    const chunk = document.createElement('div');
    chunk.className = 'reply-chunk';
    chunk.dataset.reveal = 'pending';
    chunk.inert = true;
    chunk.setAttribute('aria-hidden', 'true');
    renderRich(chunk, delta);
    // No raw Mermaid source or unloaded image is exposed during preparation.
    await whenRichReady(chunk);
    if (!current()) return;
    const follow = beforeAppend?.();
    target.append(chunk);
    // Layout the fully rendered content while hidden; this also requests fonts.
    chunk.getBoundingClientRect();
    afterAppend?.(follow);
    await document.fonts?.ready;
    await nextPaint();
    if (!current()) return;
    chunk.dataset.reveal = 'revealing';
    stream.flow.items.push({ chunk, end: 0 });
    stream.flow.preparedChars += delta.length;
    // Measure once after readiness, not on every frame. Local masks all read
    // this target's shared front; chunks never own an animation or a timer.
    measureRevealFlow(target, stream.flow);
    paintRevealFlow(target, stream.flow);
    resumeRevealFlow(target, stream.flow);
  });
  return stream.queue;
}
