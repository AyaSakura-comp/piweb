/** Legacy pure reveal helpers and the LobeHub reply-island boundary. */
export {
  readingGraphemes,
  readingFadeLevel,
  advanceReadingPace,
  plainStreamingTail,
} from './reading-reveal.js';

const streams = new WeakMap();
// The transport trims completed replies. Canonicalize the leading edge from
// the first partial too, while retaining trailing newlines for block boundaries.
const normalize = (text) =>
  String(text || '')
    .replace(/\r\n?/g, '\n')
    .trimStart();
const REVEAL_FEATHER = 56;
const REVEAL_SPEED = 120;
const ROW_LAG_GLYPHS = 1.5;
const MAX_ACTIVE_ROWS = 5;
const RATE_WINDOW_MS = 1200;
const RATE_SAMPLE_MS = 40;
const PACE_SMOOTHING_MS = 400;
const TAIL_LOOKAHEAD_MS = RATE_WINDOW_MS;
const MIN_STREAM_SPEED = 24;
const MAX_STREAM_SPEED = 600;

export function createRevealPace() {
  return { samples: [], highWater: 0, speed: REVEAL_SPEED };
}

/** Sample positive cumulative input; production supplies prepared geometric extent. */
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

/** Smooth measured arrivals, braking against the prepared surface boundary. */
export function advanceRevealPace(
  pace,
  {
    now,
    elapsed,
    front,
    goal,
    tailEnd = null,
    pixelsPerChar = 0.75,
    catchupSpeed = 0,
    complete = false,
    steadyDrain = false,
  },
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
  let target = Math.max(
    complete || rate === null ? REVEAL_SPEED : MIN_STREAM_SPEED,
    buffered,
    catchupSpeed,
  );
  const liveTail =
    Number.isFinite(tailEnd) &&
    tailEnd > front &&
    !complete &&
    now - pace.samples.at(-1)?.at <= RATE_WINDOW_MS;
  const remaining = liveTail ? tailEnd - front : Infinity;
  // Retain a little ready runway instead of exhausting every short arrival.
  // Production passes geometric surface extents, never glyph/source counts.
  // EOF or stale preparation still releases the buffer normally.
  if (liveTail) {
    // Tail distance corrects packet-rate aliasing in BOTH directions: a growing
    // runway accelerates; nearing the ready corner slows below the usual floor.
    target = Math.min(
      Math.max(MAX_STREAM_SPEED, catchupSpeed),
      (remaining * 1000) / TAIL_LOOKAHEAD_MS,
    );
  }
  // Production EOF keeps the velocity the reader just saw, not a 120px/s
  // reset or a backlog-dependent deadline. The floor only drains near-zero tails.
  if (complete && steadyDrain) {
    pace.drainSpeed ??= Math.max(MIN_STREAM_SPEED, Math.min(MAX_STREAM_SPEED, pace.speed));
    target = pace.drainSpeed;
  }
  const dt = Math.max(0, Math.min(48, elapsed));
  pace.speed += (target - pace.speed) * (1 - Math.exp(-dt / PACE_SMOOTHING_MS));
  // Braking must also bound inherited/catch-up inertia. With capped frame gaps,
  // this cannot consume the entire live tail in one step. New data accelerates
  // through the same smoother; there is no separate block timer or held surface.
  if (liveTail) pace.speed = Math.min(pace.speed, (remaining * 1000) / (2 * PACE_SMOOTHING_MS));
  return pace.speed;
}

// Legacy pure geometry/pace helpers remain exported for compatibility.
// Production now uses native-text reading-order softness and brief rich-atom fades.
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
      if (rect.glyphWidth > 0) last.glyphWidth = Math.max(last.glyphWidth || 0, rect.glyphWidth);
    } else lines.push({ ...rect, kind: rect.kind || 'text' });
  }
  return lines.map((row, i) => ({
    top: i ? (lines[i - 1].bottom + row.top) / 2 : 0,
    bottom: i + 1 < lines.length ? (row.bottom + lines[i + 1].top) / 2 : height,
    left: row.left,
    right: row.right,
    kind: row.kind,
    ...(row.glyphWidth > 0 ? { glyphWidth: row.glyphWidth } : {}),
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

/** Cache a staggered schedule within each text run; media remains a barrier. */
export function buildRevealSchedule(rows, lead = 0) {
  const schedule = rows.map((row) => ({ ...row, start: row.top, end: row.bottom }));
  for (let first = 0; first < schedule.length; ) {
    const start = schedule[first].top - (first ? 0 : lead);
    if (schedule[first].kind === 'media') {
      schedule[first++].start = start;
      continue;
    }
    let last = first + 1;
    while (last < schedule.length && schedule[last].kind !== 'media') last++;
    const run = schedule.slice(first, last);
    const glyphs = run
      .map((row) => row.glyphWidth)
      .filter((width) => Number.isFinite(width) && width > 0)
      .sort((a, b) => a - b);
    const lag = ROW_LAG_GLYPHS * (glyphs[Math.floor(glyphs.length / 2)] || 16);
    const starts = [];
    const scans = [];
    const releases = [];
    for (let i = 0; i < run.length; i++) {
      // Row six waits for row one's slot, seven for two, etc. Newly starting
      // neighbours retain the small glyph stagger, not a whole five-row batch.
      starts[i] = Math.max(
        i ? starts[i - 1] + lag : 0,
        i >= MAX_ACTIVE_ROWS ? releases[i - MAX_ACTIVE_ROWS] : 0,
      );
      scans[i] = starts[i] + run[i].right - run[i].left + REVEAL_FEATHER;
      // Short lower rows can finish early, but never release out of order or
      // remask read text. The first row frees its slot at its own glyph edge.
      releases[i] = Math.max(i ? releases[i - 1] : 0, scans[i]);
    }
    const scale = (schedule[last - 1].bottom - start) / releases.at(-1);
    for (let i = first; i < last; i++) {
      const local = i - first;
      schedule[i].start = start + starts[local] * scale;
      schedule[i].scanEnd = start + scans[local] * scale;
      schedule[i].end = start + releases[local] * scale;
      schedule[i].travel = run[local].right - run[local].left + REVEAL_FEATHER;
    }
    // Avoid floating-point residue delaying release at the measured run boundary.
    schedule[last - 1].end = schedule[last - 1].bottom;
    first = last;
  }
  return schedule;
}

/** Near-parallel horizontal bands from one shared, monotonically advancing front. */
export function revealRowsAt(schedule, front) {
  if (!schedule.length || front >= schedule.at(-1).end)
    return { mode: 'ready', index: schedule.length, bands: [] };
  if (front < schedule[0].start) return { mode: 'hidden', index: -1, bands: [] };
  let low = 0;
  let high = schedule.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (front >= schedule[middle].end) low = middle + 1;
    else high = middle;
  }
  const row = schedule[low];
  const bands = [];
  if (row.kind !== 'media') {
    for (let i = low; i < Math.min(schedule.length, low + MAX_ACTIVE_ROWS); i++) {
      const next = schedule[i];
      if (next.kind === 'media' || front < next.start) break;
      const progress = Math.max(
        0,
        Math.min(1, (front - next.start) / Math.max(0.001, next.scanEnd - next.start)),
      );
      bands.push({
        index: i,
        top: next.top,
        height: next.bottom - next.top,
        progress,
        front: next.left - REVEAL_FEATHER + next.travel * progress,
      });
    }
  }
  return {
    mode: row.kind === 'media' ? 'media' : 'rows',
    index: low,
    top: row.top,
    height: row.bottom - row.top,
    bands,
  };
}

/** Project a whole rich surface onto the top-left → bottom-right unit vector. */
export function projectRevealRect({ left = 0, top = 0, width, height }) {
  const start = (left + top) / Math.SQRT2;
  return {
    start,
    end: width > 0 && height > 0 ? start + (width + height) / Math.SQRT2 : start,
  };
}

/** Put late-ready pixels ahead of the plane without moving or remasking old DOM. */
export function prepareRevealSurface(bounds, front, previousOffset = 0) {
  const offset = Math.max(previousOffset, front + REVEAL_FEATHER - bounds.start);
  return { start: bounds.start + offset, end: bounds.end + offset, offset };
}

/** Pixel stops, not percentages: adding content never stretches an old mask. */
export function diagonalRevealAt(bounds, front) {
  return {
    mode:
      bounds.end <= bounds.start || front >= bounds.end
        ? 'ready'
        : front <= bounds.start - REVEAL_FEATHER
          ? 'hidden'
          : 'diagonal',
    front: front - bounds.start,
  };
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
  return !!stream && normalize(text).startsWith(stream.source.trimEnd());
}

/** Source/connection fencing only; parsing, smoothing and fades are upstream. */
export function updateStreamingRich(target, text, options = {}) {
  let source = normalize(text);
  if (!options.complete) {
    const marker = source.search(/\[\[(?:image|video|file)\s*:/i);
    if (marker >= 0) source = source.slice(0, marker);
  }
  const record = streams.get(target) || { source: '', revision: 0 };
  record.source = source;
  const revision = ++record.revision;
  streams.set(target, record);
  return import('./lobehub-rich.js').then(({ updateLobehubRich }) => {
    if (streams.get(target) !== record || record.revision !== revision || !target.isConnected) return;
    return updateLobehubRich(target, source, options);
  });
}
