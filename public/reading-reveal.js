/** Native-text softness in reading order; rich surfaces never get a spatial wipe. */
const EDGE = 8;
const ATOM_MS = 160;
const ATOMS =
  'pre, .table-wrap, .msg-inline-media, .mermaid-wrap, .math-display, .katex, img, video, iframe, svg, canvas, hr';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const names = ['piweb-reply-hidden', 'piweb-reply-soft1', 'piweb-reply-soft2', 'piweb-reply-soft3'];

export function readingGraphemes(text) {
  return [...segmenter.segment(text)].map((part) => part.index).concat(text.length);
}

export function readingFadeLevel(index, front) {
  return Math.max(0, Math.min(4, Math.floor((front - index) / 2)));
}

export function advanceReadingPace(speed, backlog, elapsed) {
  const target = Math.max(80, Math.min(3200, backlog / 1.2));
  return speed + (target - speed) * (1 - Math.exp(-Math.max(0, Math.min(48, elapsed)) / 250));
}

/** Deliberately conservative: never guess at an open rich/structural construct. */
export function plainStreamingTail(text) {
  return (
    /^[\p{L}\p{N}]/u.test(text) &&
    !/[\n\r#*_[\]`~|><$\\!]/.test(text) &&
    !/^\d+[.)]\s/.test(text) &&
    !/(?:https?:|mailto:)/i.test(text)
  );
}

export function createReadingReveal(target, current) {
  const supported = !!globalThis.CSS?.highlights && typeof Highlight !== 'undefined';
  const layers = supported
    ? names.map((name) => {
        if (!CSS.highlights.has(name)) CSS.highlights.set(name, new Highlight());
        return CSS.highlights.get(name);
      })
    : [];
  const flow = {
    front: 0,
    goal: 0,
    speed: 80,
    items: [],
    frame: 0,
    clock: null,
    media: null,
    motion: null,
    owned: [],
  };
  target.classList.add('reply-flow');
  target.dataset.reveal = 'ready';
  target.dataset.revealStyle = 'reading';
  target.style.setProperty('--reply-front', '0');
  const clearRanges = () => {
    for (const [level, range] of flow.owned) layers[level].delete(range);
    flow.owned = [];
  };
  const addRange = (node, start, end, level) => {
    if (start >= end || level >= 4) return;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    layers[level].add(range);
    flow.owned.push([level, range]);
  };
  const clearStyle = (node, property) => {
    node.style.removeProperty(property);
    if (node.getAttribute('style') === '') node.removeAttribute('style');
  };
  const release = (item) => {
    item.chunk.dataset.reveal = 'ready';
    item.chunk.inert = false;
    item.chunk.removeAttribute('aria-hidden');
    delete item.chunk.dataset.revealMode;
    for (const block of item.blocks) clearStyle(block.node, 'visibility');
    for (const atom of item.atoms) {
      clearStyle(atom.node, 'opacity');
      delete atom.node.dataset.readingAtom;
    }
  };
  const stop = () => {
    cancelAnimationFrame(flow.frame);
    flow.frame = 0;
    flow.clock = null;
    flow.media?.removeEventListener('change', flow.motion);
    flow.media = null;
    clearRanges();
  };
  const paint = (now) => {
    clearRanges();
    let active = false;
    let visible = 0;
    for (const item of flow.items) {
      if (item.chunk.dataset.reveal === 'ready') {
        visible += item.count;
        continue;
      }
      for (const block of item.blocks) {
        if (flow.front > block.start || !supported) clearStyle(block.node, 'visibility');
        else block.node.style.visibility = 'hidden';
      }
      for (const run of item.runs) {
        const count = run.offsets.length - 1;
        visible += Math.max(0, Math.min(count, Math.floor(flow.front - run.start - EDGE)));
        if (!supported) continue;
        // Coalesce into at most five ranges per native text run, not per character.
        let begin = 0;
        let level = readingFadeLevel(run.start, flow.front);
        for (let i = 1; i <= count; i++) {
          const next = i === count ? -1 : readingFadeLevel(run.start + i, flow.front);
          if (next === level) continue;
          addRange(run.node, run.base + run.offsets[begin], run.base + run.offsets[i], level);
          begin = i;
          level = next;
        }
      }
      const atomsReady = item.atoms
        .map((atom) => {
          const alpha = Math.min(1, Math.max(0, (now - atom.born) / ATOM_MS));
          atom.node.style.opacity = String(alpha);
          return alpha >= 1;
        })
        .every(Boolean);
      if (flow.front >= item.end && atomsReady) release(item);
      else {
        active = true;
        item.chunk.dataset.revealMode = 'reading';
      }
    }
    target.style.setProperty('--reply-front', flow.front.toFixed(2));
    target.style.setProperty('--reply-speed', flow.speed.toFixed(2));
    target.dataset.readingVisible = String(visible);
    target.dataset.reveal = active ? 'revealing' : 'ready';
    return active;
  };
  const showAll = () => {
    flow.front = Math.max(flow.front, flow.goal);
    for (const item of flow.items) release(item);
    paint(performance.now());
    stop();
  };
  const resume = () => {
    if (flow.frame) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    if (!supported || media.matches || !target.getBoundingClientRect().height) {
      showAll();
      return;
    }
    flow.media = media;
    flow.motion = () => {
      if (media.matches) showAll();
    };
    media.addEventListener('change', flow.motion);
    const tick = (now) => {
      flow.frame = 0;
      if (!current() || !target.isConnected) return stop();
      const elapsed = flow.clock === null ? 0 : Math.max(0, Math.min(48, now - flow.clock));
      flow.clock = now;
      flow.speed = advanceReadingPace(flow.speed, flow.goal - flow.front, elapsed);
      flow.front = Math.max(
        flow.front,
        Math.min(flow.goal, flow.front + (elapsed * flow.speed) / 1000),
      );
      if (!paint(now)) {
        stop();
        flow.speed = 80;
        return;
      }
      flow.frame = requestAnimationFrame(tick);
    };
    flow.frame = requestAnimationFrame(tick);
  };
  const textRun = (item, node, base = 0) => {
    const offsets = readingGraphemes(node.data.slice(base));
    const count = offsets.length - 1;
    if (!count) return;
    item.runs.push({ node, base, offsets, start: flow.goal });
    item.count += count;
    flow.goal += count;
  };
  const collect = (item, node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      textRun(item, node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches(ATOMS)) {
      node.dataset.readingAtom = 'true';
      node.style.opacity = '0';
      item.atoms.push({ node, born: performance.now() });
      return;
    }
    for (const child of node.childNodes) collect(item, child);
  };
  const append = (chunk) => {
    const item = { chunk, runs: [], atoms: [], blocks: [], count: 0, end: 0 };
    for (const node of chunk.childNodes) {
      const start = flow.goal;
      collect(item, node);
      if (node.nodeType === Node.ELEMENT_NODE && !node.matches(ATOMS))
        item.blocks.push({ node, start });
    }
    if (item.count) flow.goal += EDGE;
    item.end = item.count ? flow.goal : flow.front;
    flow.items.push(item);
    chunk.dataset.reveal = 'revealing';
    chunk.inert = true;
    chunk.setAttribute('aria-hidden', 'true');
    paint(performance.now());
    resume();
    return item;
  };
  const extend = (item, node, suffix) => {
    const base = node.length;
    node.appendData(suffix);
    textRun(item, node, base);
    flow.goal += EDGE;
    item.end = flow.goal;
    item.chunk.dataset.reveal = 'revealing';
    item.chunk.inert = true;
    item.chunk.setAttribute('aria-hidden', 'true');
    paint(performance.now());
    resume();
  };
  const trim = (item, node, length) => {
    for (const run of item.runs) {
      if (run.node !== node) continue;
      const previousCount = run.offsets.length - 1;
      const end = Math.min(length, run.base + run.offsets.at(-1));
      run.offsets = readingGraphemes(run.base < length ? node.data.slice(run.base, end) : '');
      item.count -= previousCount - (run.offsets.length - 1);
    }
    node.deleteData(length, node.length - length);
    // Retain earned/queued coordinates; remove only the transport-owned whitespace.
    paint(performance.now());
  };
  const extendNodes = (item, parent, nodes) => {
    const before = item.count;
    for (const node of nodes) {
      parent.append(node);
      collect(item, node);
    }
    if (item.count > before) flow.goal += EDGE;
    item.end = flow.goal;
    item.chunk.dataset.reveal = 'revealing';
    item.chunk.inert = true;
    item.chunk.setAttribute('aria-hidden', 'true');
    paint(performance.now());
    resume();
  };
  const remove = (item) => {
    flow.items = flow.items.filter((other) => other !== item);
    flow.goal = Math.max(flow.front, ...flow.items.map((other) => other.end));
    item.chunk.remove();
    paint(performance.now());
  };
  return Object.assign(flow, { append, extend, trim, extendNodes, remove, stop });
}
