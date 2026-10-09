/**
 * Persistent streaming player for transcript video and audio.
 *
 * One dock above the composer plays every chat/gallery video and audio file.
 * It streams through the media route's HTTP Range support (nothing is fetched
 * as a whole blob), keeps playing while the transcript scrolls, the drawer
 * opens or another session is selected, and walks a playlist of the session's
 * media with previous/next and auto-advance. Lock-screen / headset controls go
 * through the Media Session API where the browser has it.
 */

import { bindMediaSave, downloadNameFromMediaUrl, safeSameOriginMediaUrl } from './media-files.js';

const SVG = 'http://www.w3.org/2000/svg';
const ICONS = {
  play: ['M8 5v14l11-7z'],
  pause: ['M7 5h3v14H7z', 'M14 5h3v14h-3z'],
  prev: ['M6 5v14', 'M19 5L9 12l10 7z'],
  next: ['M18 5v14', 'M5 5l10 7-10 7z'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  expand: ['M6 15l6-6 6 6'],
  collapse: ['M6 9l6 6 6-6'],
  fullscreen: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  note: ['M9 18V5l11-2v13', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
};
const FILLED = new Set(['play', 'pause', 'prev', 'next']);
const RESTART_THRESHOLD_S = 3;
const SEEK_STEP_S = 10;

function icon(doc, kind) {
  const create = (tag) =>
    typeof doc.createElementNS === 'function' ? doc.createElementNS(SVG, tag) : doc.createElement(tag);
  const svg = create('svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', FILLED.has(kind) ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', FILLED.has(kind) ? '1' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ICONS[kind]) {
    const path = create('path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Normalise and de-duplicate playable items, preserving order. */
export function playableQueue(items, doc) {
  const seen = new Set();
  const queue = [];
  for (const item of items ?? []) {
    if (item?.type !== 'video' && item?.type !== 'audio') continue;
    const url = safeSameOriginMediaUrl(item.url, doc);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    queue.push({ type: item.type, url, name: item.name || downloadNameFromMediaUrl(url) });
  }
  return queue;
}

export function createStreamPlayer(doc = document, runtime = globalThis) {
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, kind, label) => {
    const node = el('button', `sp-btn ${className}`);
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.append(icon(doc, kind));
    return node;
  };
  const setIcon = (node, kind, label) => {
    node.replaceChildren(icon(doc, kind));
    node.setAttribute('aria-label', label);
    node.title = label;
  };

  const root = el('section', 'stream-player');
  root.hidden = true;
  root.setAttribute('aria-label', 'Media player');

  const stage = el('div', 'sp-stage');
  const video = el('video', 'sp-video');
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'metadata';
  const art = el('div', 'sp-art');
  art.append(icon(doc, 'note'));
  const audio = el('audio', 'sp-audio');
  audio.preload = 'metadata';
  stage.append(video, art, audio);

  const info = el('button', 'sp-info');
  info.type = 'button';
  info.setAttribute('aria-expanded', 'false');
  const title = el('span', 'sp-title');
  const meta = el('span', 'sp-meta');
  info.append(title, meta);

  const prev = button('sp-prev', 'prev', 'Previous');
  const toggle = button('sp-toggle', 'play', 'Play');
  const next = button('sp-next', 'next', 'Next');
  const close = button('sp-close', 'close', 'Close player');
  const controls = el('div', 'sp-controls');
  controls.append(prev, toggle, next, close);

  const head = el('div', 'sp-head');
  head.append(stage, info, controls);

  const seek = el('input', 'sp-seek');
  seek.type = 'range';
  seek.min = '0';
  seek.max = '1000';
  seek.step = '1';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Seek');

  const iosHomeScreen = runtime.navigator?.standalone === true;
  const download = el(iosHomeScreen ? 'button' : 'a', 'sp-btn sp-download');
  if (iosHomeScreen) download.type = 'button';
  download.append(icon(doc, 'download'));
  const fullscreen = button('sp-fullscreen', 'fullscreen', 'Full screen');
  const position = el('span', 'sp-position');
  const expand = button('sp-expand', 'expand', 'Expand player');
  const extra = el('div', 'sp-extra');
  extra.append(position, download, fullscreen, expand);

  root.append(head, seek, extra);

  let queue = [];
  let index = -1;
  let seeking = false;
  let failed = false;
  const listeners = new Set();
  const current = () => (index >= 0 ? queue[index] : undefined);
  const player = () => (current()?.type === 'video' ? video : audio);

  function notify() {
    const item = current();
    const state = item ? { url: item.url, type: item.type, playing: !player().paused } : null;
    for (const listener of listeners) listener(state);
  }

  function release(media) {
    media.pause();
    media.removeAttribute('src');
    media.load();
  }

  function render() {
    const item = current();
    if (!item) return;
    const media = player();
    const duration = media.duration;
    const known = Number.isFinite(duration) && duration > 0;
    if (!seeking) seek.value = known ? String(Math.round((media.currentTime / duration) * 1000)) : '0';
    seek.disabled = !known;
    let buffered = 0;
    if (known) {
      for (let i = 0; i < media.buffered.length; i++) {
        if (media.buffered.start(i) <= media.currentTime + 0.5) buffered = media.buffered.end(i);
      }
    }
    seek.style.setProperty('--sp-played', `${known ? (Number(seek.value) / 10).toFixed(1) : 0}%`);
    seek.style.setProperty('--sp-buffered', `${known ? ((buffered / duration) * 100).toFixed(1) : 0}%`);
    const time = `${formatMediaTime(media.currentTime)} / ${formatMediaTime(known ? duration : NaN)}`;
    const waiting = !media.paused && media.readyState < 3;
    meta.textContent = failed ? '無法播放此檔案' : waiting ? `${time} · 緩衝中…` : time;
    root.dataset.state = failed ? 'error' : media.paused ? 'paused' : waiting ? 'buffering' : 'playing';
    setIcon(toggle, media.paused ? 'play' : 'pause', media.paused ? 'Play' : 'Pause');
    prev.disabled = false;
    next.disabled = index >= queue.length - 1;
    position.textContent = queue.length > 1 ? `${index + 1} / ${queue.length}` : '';
    updatePositionState(media);
  }

  const session = () => runtime.navigator?.mediaSession;
  function updatePositionState(media) {
    const ms = session();
    if (!ms?.setPositionState) return;
    try {
      if (Number.isFinite(media.duration) && media.duration > 0) {
        ms.setPositionState({
          duration: media.duration,
          position: Math.min(media.currentTime, media.duration),
          playbackRate: media.playbackRate || 1,
        });
      }
    } catch {
      /* Some engines reject a transiently inconsistent position. */
    }
  }

  function updateMediaSession() {
    const ms = session();
    const item = current();
    if (!ms || !item) return;
    try {
      if (typeof runtime.MediaMetadata === 'function') {
        ms.metadata = new runtime.MediaMetadata({
          title: item.name,
          artist: 'Piweb',
          album: item.type === 'video' ? 'Video' : 'Audio',
          artwork: [{ src: '/icons/piweb/icon-512.png', sizes: '512x512', type: 'image/png' }],
        });
      }
    } catch {
      /* Metadata is cosmetic. */
    }
  }

  function bindMediaSession() {
    const ms = session();
    if (!ms?.setActionHandler) return;
    const handlers = {
      play: () => player().play().catch(() => undefined),
      pause: () => player().pause(),
      previoustrack: () => previous(),
      nexttrack: () => advance(),
      seekbackward: (d) => seekBy(-(d?.seekOffset || SEEK_STEP_S)),
      seekforward: (d) => seekBy(d?.seekOffset || SEEK_STEP_S),
      seekto: (d) => {
        if (Number.isFinite(d?.seekTime)) player().currentTime = d.seekTime;
      },
      stop: () => stop(),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* Unsupported action on this engine. */
      }
    }
  }

  function seekBy(delta) {
    const media = player();
    if (!Number.isFinite(media.duration)) return;
    media.currentTime = Math.max(0, Math.min(media.duration, media.currentTime + delta));
  }

  function load(nextIndex, autoplay = true) {
    const item = queue[nextIndex];
    if (!item) return;
    const previousMedia = index >= 0 ? player() : undefined;
    index = nextIndex;
    failed = false;
    const media = player();
    if (previousMedia && previousMedia !== media) release(previousMedia);
    root.dataset.type = item.type;
    video.hidden = item.type !== 'video';
    art.hidden = item.type === 'video';
    fullscreen.hidden = item.type !== 'video';
    title.textContent = item.name;
    if (!iosHomeScreen) {
      download.href = item.url;
      download.download = item.name;
    } else {
      download.removeAttribute('data-ready');
    }
    download.title = `Download ${item.name}`;
    download.setAttribute('aria-label', `Download ${item.type} ${item.name}`);
    // Streams by Range request; `auto` lets the engine read ahead while playing
    // without first downloading the whole file.
    media.preload = 'auto';
    media.src = item.url;
    root.hidden = false;
    updateMediaSession();
    render();
    if (autoplay) {
      media.play().catch(() => {
        // Autoplay without a gesture (e.g. advancing in a background tab) may
        // be refused; leave it ready with a play button rather than an error.
        render();
        notify();
      });
    }
    notify();
  }

  function advance() {
    if (index < queue.length - 1) load(index + 1);
  }

  function previous() {
    const media = player();
    if (media.currentTime > RESTART_THRESHOLD_S || index === 0) media.currentTime = 0;
    else load(index - 1);
  }

  function stop() {
    if (root.hidden) return;
    release(video);
    release(audio);
    queue = [];
    index = -1;
    root.hidden = true;
    setExpanded(false);
    const ms = session();
    if (ms) {
      try {
        ms.metadata = null;
        ms.playbackState = 'none';
      } catch {
        /* ignore */
      }
    }
    notify();
  }

  function setExpanded(open) {
    root.classList.toggle('expanded', open);
    info.setAttribute('aria-expanded', String(open));
    setIcon(expand, open ? 'collapse' : 'expand', open ? 'Collapse player' : 'Expand player');
  }

  /**
   * Play `item`, with `items` as the playlist it belongs to (oldest first).
   * Tapping the item that is already loaded toggles play/pause instead of
   * restarting it.
   */
  function play(item, items = [item]) {
    const list = playableQueue(items, doc);
    const target = playableQueue([item], doc)[0];
    if (!target) return false;
    const same = current()?.url === target.url;
    if (same) {
      const media = player();
      queue = list.some((entry) => entry.url === target.url) ? list : queue;
      index = queue.findIndex((entry) => entry.url === target.url);
      if (media.paused) media.play().catch(() => undefined);
      else media.pause();
      render();
      return true;
    }
    queue = list.some((entry) => entry.url === target.url) ? list : [target];
    load(queue.findIndex((entry) => entry.url === target.url));
    return true;
  }

  for (const media of [video, audio]) {
    for (const type of ['timeupdate', 'progress', 'durationchange', 'loadedmetadata', 'waiting', 'canplay']) {
      media.addEventListener(type, () => {
        if (media === player() && index >= 0) render();
      });
    }
    for (const type of ['play', 'pause', 'playing']) {
      media.addEventListener(type, () => {
        if (media !== player() || index < 0) return;
        const ms = session();
        if (ms) {
          try {
            ms.playbackState = media.paused ? 'paused' : 'playing';
          } catch {
            /* ignore */
          }
        }
        render();
        notify();
      });
    }
    media.addEventListener('ended', () => {
      if (media !== player() || index < 0) return;
      if (index < queue.length - 1) load(index + 1);
      else render();
    });
    media.addEventListener('error', () => {
      if (media !== player() || index < 0 || !media.getAttribute('src')) return;
      failed = true;
      render();
      notify();
    });
  }

  toggle.addEventListener('click', () => {
    const media = player();
    if (failed) return load(index);
    if (media.paused) media.play().catch(() => undefined);
    else media.pause();
  });
  prev.addEventListener('click', previous);
  next.addEventListener('click', advance);
  close.addEventListener('click', stop);
  info.addEventListener('click', () => setExpanded(!root.classList.contains('expanded')));
  expand.addEventListener('click', () => setExpanded(!root.classList.contains('expanded')));
  video.addEventListener('click', () => {
    if (!root.classList.contains('expanded')) setExpanded(true);
  });
  art.addEventListener('click', () => setExpanded(!root.classList.contains('expanded')));
  fullscreen.addEventListener('click', () => {
    if (typeof video.requestFullscreen === 'function') {
      video.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
    } else {
      video.webkitEnterFullscreen?.();
    }
  });
  seek.addEventListener('input', () => {
    seeking = true;
    const media = player();
    if (Number.isFinite(media.duration)) {
      seek.style.setProperty('--sp-played', `${(Number(seek.value) / 10).toFixed(1)}%`);
      meta.textContent = `${formatMediaTime((Number(seek.value) / 1000) * media.duration)} / ${formatMediaTime(media.duration)}`;
    }
  });
  seek.addEventListener('change', () => {
    const media = player();
    if (Number.isFinite(media.duration)) media.currentTime = (Number(seek.value) / 1000) * media.duration;
    seeking = false;
    render();
  });
  if (iosHomeScreen) bindMediaSave(download, () => current(), runtime);
  bindMediaSession();

  return {
    element: root,
    play,
    stop,
    current: () => {
      const item = current();
      return item ? { ...item, playing: !player().paused } : null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
