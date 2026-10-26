/**
 * Responsive Multi-Session 2D Tiling Dashboard
 *
 * Supports both horizontal (left/right columns) and vertical (top/bottom rows)
 * automatic alignment and directional drop zones (left, right, top, bottom),
 * with independent draggable vertical AND horizontal resize splitters.
 */

import { shouldLoadOlderHistory } from './session-ui.js';

const DASHBOARD_STORAGE_KEY = 'piweb.dashboard';
const PANE_PAGE_SIZE = 50;
const MIN_PANE_WIDTH_PX = 140;
const MIN_PANE_HEIGHT_PX = 95;
const COMPOSER_PANE_KEY = 'piweb.dashboard.composer';
/** Taps on these keep their own job instead of opening the pane's keyboard. */
const PANE_TAP_KEEPS_FOCUS =
  'a, button, input, textarea, select, summary, label, img, video, audio, [role="button"], [contenteditable], .stream-player';
/** Same rule as viewport-shell.js: a visual viewport this much shorter is a keyboard. */

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MIME_EXT_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
};

const ZOOM_IN_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
const ZOOM_OUT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>';

function formatPasteToast(files) {
  const hasImg = files.some((f) => f.type?.startsWith('image/'));
  const hasAud = files.some((f) => f.type?.startsWith('audio/'));
  const hasVid = files.some((f) => f.type?.startsWith('video/'));
  if (files.length === 1) {
    if (hasImg) return '已貼上圖片附件';
    if (hasAud) return '已貼上音訊附件';
    if (hasVid) return '已貼上影片附件';
    return `已貼上附件 (${files[0].name})`;
  }
  return `已貼上 ${files.length} 個附件檔案`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function highlightMatch(container, text, q) {
  const lower = String(text || '').toLowerCase();
  const needle = String(q || '').toLowerCase();
  if (!needle) {
    container.append(document.createTextNode(text || ''));
    return;
  }
  let i = 0;
  while (true) {
    const at = lower.indexOf(needle, i);
    if (at === -1) break;
    if (at > i) container.append(document.createTextNode(text.slice(i, at)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + needle.length);
    container.append(mark);
    i = at + needle.length;
  }
  container.append(document.createTextNode(text.slice(i)));
}

export function createSessionDashboard({
  app,
  drawer,
  sessionList,
  main,
  api,
  getSessions,
  getCommands = () => [],
  getModels = () => [],
  getSessionBadge,
  usageCommandForSession = () => 'gpt-usage',
  isAgyCommandSession = () => false,
  isPiBtwSession = () => true,
  isCommandEchoText = () => false,
  buildEventNode,
  streamRich,
  canReuseRich,
  trySendCommand,
  runQuickCommand = async () => false,
  onOpenModelSheet = () => {},
  onOpenThinkingSheet = () => {},
  onOpenMediaSheet = () => {},
  onOpenSubagents = () => {},
  onOpenCommandsRunning = () => {},
  onDeleteSession = () => {},
  onReloadSessions = async () => {},
  createHotKeywords = null,
  createPromptPin = null,
  prepareImageUpload = async (file) => ({ file, resized: false, warning: null }),
  readCompressionPreference = () => true,
  IMAGE_COMPRESSION_KEY = 'piweb.compressImages',
  sendJsonWithUploadProgress = null,
  showUploadProgress = () => {},
  hideUploadProgress = () => {},
  quotePreview = (t) => String(t || '').slice(0, 72),
  copyText = async () => false,
  openLightbox,
  onSelectSingleSession,
  onMarkSeen,
  onApplySessionTitle,
  showToast,
  isAutoScrollEnabled = () => false,
  // Returns '' when the attachments fit the server's upload limits, else why not.
  attachmentLimitProblem = () => '',
  // Komorebi voice input (voice-ime.js): a mic button in every pane composer.
  voiceIme = null,
}) {
  const wideQuery = window.matchMedia('(min-width: 768px) and (min-height: 500px), (min-width: 768px) and (pointer: fine)');
  let active = false;
  let panes = new Map(); // jid -> pane state
  let composerJid = null;
  try {
    composerJid = localStorage.getItem(COMPOSER_PANE_KEY);
  } catch {
    // Storage blocked: start on the first pane.
  }
  let dockGhost = null; // { el, jid }: the card copy mid-hop and the pane it lands on
  let zoomedJid = null; // the pane blown up to the whole stage, still in the Dashboard
  let pinchSteps = null; // { jid, base, step, key }: the pane a pinch resized, its step from `base`, and the layout it made
  let twoFingerQuietUntil = 0; // header taps this soon after a two-finger gesture are its fingers lifting

  /** A transcript that shrinks (the card arrives, the card grows, a splitter
   *  moves) keeps a reader who was following the newest message at the bottom. */
  const transcriptObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const pane = panes.get(entry.target.closest('.dashboard-pane')?.dataset.jid);
            if (pane && !pane.disposed && !pane.userScrolledUp && !pane.holdScroll) {
              entry.target.scrollTop = entry.target.scrollHeight;
            }
          }
        })
      : null;

  /** The size steps a pane's layout folds at, as classes on the pane: short
   *  (460px or less tall) trims its input card (`.pane-short`); the header's
   *  content width folds its icons (`.pane-w460` … `.pane-w170`) and the dock's
   *  the paste button (`.pane-w240`). Classes, not container queries: a
   *  container makes WebKit restyle its whole subtree on every size change,
   *  which on nine panes froze a splitter drag on the iPad (2026-10-25); a
   *  class changes only when a step is crossed. */
  const HEADER_WIDTH_STEPS = [460, 300, 220, 170];
  const DOCK_WIDTH_STEPS = [240];
  const paneSizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          for (const { target, contentRect } of entries) {
            const paneEl = target.closest('.dashboard-pane');
            if (!paneEl) continue;
            if (target === paneEl) {
              paneEl.classList.toggle('pane-short', contentRect.height <= 460);
              continue;
            }
            const steps = target.classList.contains('dashboard-pane-dock')
              ? DOCK_WIDTH_STEPS
              : HEADER_WIDTH_STEPS;
            for (const px of steps) paneEl.classList.toggle(`pane-w${px}`, contentRect.width <= px);
          }
        })
      : null;

  /** While a splitter changes widths, each transcript keeps the width it had,
   *  clipped or with room to spare: rewrapping every transcript on every step
   *  is what kept a side-to-side drag under 120fps in WebKit. They rewrap
   *  once, at the new width, when the splitter has settled. */
  function freezeTranscriptWidths() {
    // A drag that grabs the splitter mid-reflow freezes the widths it reached.
    cancelAnimationFrame(reflowRaf);
    reflowRaf = 0;
    const scrollers = [...panes.values()]
      .flatMap((p) => [p.messagesEl, p.btwMessagesEl])
      .filter((node) => node && !node.hidden);
    const widths = scrollers.map((node) => node.offsetWidth); // read all, then write
    scrollers.forEach((node, i) => {
      node.style.width = `${widths[i]}px`;
    });
  }

  function thawTranscriptWidths() {
    cancelAnimationFrame(reflowRaf);
    reflowRaf = 0;
    for (const p of panes.values()) {
      for (const node of [p.messagesEl, p.btwMessagesEl]) if (node) node.style.width = '';
    }
  }

  /** The block nearest the top edge of a transcript's view (a paragraph, a
   *  list item, a code block…), and how far into it the view starts. */
  function readingPoint(scroller) {
    const top = scroller.getBoundingClientRect().top;
    let node = scroller;
    for (let depth = 0; depth < 8; depth++) {
      let hit = null;
      for (const child of node.children) {
        const r = child.getBoundingClientRect();
        if (r.height > 0 && r.bottom > top) {
          hit = { child, r };
          break;
        }
      }
      if (!hit) break;
      node = hit.child;
      if (hit.r.top >= top) break; // starts below the edge: hold its top
    }
    if (node === scroller) return null;
    const r = node.getBoundingClientRect();
    return { el: node, frac: Math.min(1, Math.max(0, (top - r.top) / r.height)) };
  }

  let reflowRaf = 0;

  /** After a side-to-side drag, each frozen transcript eases from the width
   *  it kept to its pane's, rewrapping as it goes, so the text flows into its
   *  new lines instead of jumping to them. A reader following the bottom stays
   *  at the bottom; one scrolled up keeps the line they were reading at the
   *  same height, the transcript scrolling under it as the text rewraps. */
  function reflowTranscripts(duration) {
    cancelAnimationFrame(reflowRaf);
    reflowRaf = 0;
    if (prefersReducedMotion() || duration <= 0) {
      thawTranscriptWidths();
      return;
    }
    const moving = [];
    for (const p of panes.values()) {
      for (const node of [p.messagesEl, p.btwMessagesEl]) {
        if (!node?.style.width) continue;
        const from = parseFloat(node.style.width);
        // The transcript stretches across its column (no margins).
        const to = node.parentElement?.clientWidth ?? from;
        if (!node.isConnected || Math.abs(to - from) < 1) {
          node.style.width = '';
          continue;
        }
        const bottom = isNearBottom(node);
        moving.push({ node, from, to, bottom, point: bottom ? null : readingPoint(node) });
      }
    }
    if (!moving.length) return;
    for (const m of moving) m.lastTop = m.node.scrollTop;
    const start = performance.now();
    const step = (now) => {
      // A frame's timestamp can predate `start`.
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const ease = 1 - Math.pow(1 - t, 3);
      for (const m of moving) {
        // A finger on the transcript takes its scrolling back.
        if (Math.abs(m.node.scrollTop - m.lastTop) > 1) m.bottom = m.point = null;
        m.node.style.width = t < 1 ? `${(m.from + (m.to - m.from) * ease).toFixed(1)}px` : '';
      }
      // Write every width, then read every position (one layout), then scroll.
      const shifts = moving.map((m) => {
        if (!m.point?.el.isConnected) return 0;
        const r = m.point.el.getBoundingClientRect();
        return r.top + m.point.frac * r.height - m.node.getBoundingClientRect().top;
      });
      moving.forEach((m, i) => {
        if (m.bottom) m.node.scrollTop = m.node.scrollHeight;
        else if (m.point) m.node.scrollTop += shifts[i] - m.offset;
        m.lastTop = m.node.scrollTop;
      });
      reflowRaf = t < 1 ? requestAnimationFrame(step) : 0;
    };
    // The offset each reading point starts at, before any width moves.
    for (const m of moving) {
      if (!m.point) continue;
      const r = m.point.el.getBoundingClientRect();
      m.offset = r.top + m.point.frac * r.height - m.node.getBoundingClientRect().top;
    }
    reflowRaf = requestAnimationFrame(step);
  }

  const isNearBottom = (scroller) =>
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;

  /**
   * Split-tree layout:
   * - `direction`: 'row' (top level is columns) or 'column' (top level is rows)
   * - `groups`: the top-level cells, each `{ weight, items }`. An item is a
   *   pane `{ jid, weight }` or a nested split `{ weight, items }`; every level
   *   runs perpendicular to its parent (columns → rows → columns …), so a cell
   *   in a column can itself be split side by side. Saved layouts without
   *   nesting are the same two-level shape as before.
   */
  let direction = 'row';
  let groups = [];
  let dragSourceJid = null;
  let pointerDrag = null;
  let currentDropTarget = null; // { mode: 'stage' | 'edge' | 'pane', jid?: string, zone: 'left' | 'right' | 'top' | 'bottom' }
  const PANE_CONTROL_DRAG_PX = 10;

  /**
   * Swallow the click a drag's release may still deliver to the control under
   * it. Listens on the dragged element itself, not window: a swap re-parents
   * the pane, and a click on a detached subtree never reaches window.
   */
  function suppressNextClick(host) {
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
      host.removeEventListener('click', swallow, true);
    };
    host.addEventListener('click', swallow, true);
    setTimeout(() => host.removeEventListener('click', swallow, true), 400);
  }

  // ── 1. Sidebar Dashboard Entry ("首頁 Dashboard") ──────────────────────────
  const navEntry = document.createElement('button');
  navEntry.type = 'button';
  navEntry.id = 'btn-dashboard-home';
  navEntry.className = 'dashboard-nav-entry';
  navEntry.setAttribute('aria-pressed', 'false');
  navEntry.innerHTML = `
    <span class="dashboard-nav-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="8" height="8" rx="1.8" />
        <rect x="13" y="3" width="8" height="8" rx="1.8" />
        <rect x="3" y="13" width="8" height="8" rx="1.8" />
        <rect x="13" y="13" width="8" height="8" rx="1.8" />
      </svg>
    </span>
    <span class="dashboard-nav-text">
      <strong>Dashboard</strong>
      <small>水平／垂直多視窗並排</small>
    </span>
    <span class="dashboard-nav-count" id="dashboard-nav-count" hidden>0</span>
  `;
  sessionList.before(navEntry);

  // ── 2. Topbar quick button on tablet/desktop ("並排 Dashboard") ────────────
  const topbarBtn = document.createElement('button');
  topbarBtn.type = 'button';
  topbarBtn.id = 'btn-topbar-dashboard';
  topbarBtn.className = 'icon-btn dashboard-topbar-btn';
  topbarBtn.title = '開啟並排 Dashboard（將目前對話加入並排）';
  topbarBtn.setAttribute('aria-label', '開啟並排 Dashboard');
  topbarBtn.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="1.8" />
      <rect x="13" y="3" width="8" height="8" rx="1.8" />
      <rect x="3" y="13" width="8" height="8" rx="1.8" />
      <rect x="13" y="13" width="8" height="8" rx="1.8" />
    </svg>
  `;
  const btnMore = document.getElementById('btn-more');
  if (btnMore) btnMore.before(topbarBtn);

  // ── 3. Dashboard Host View inside .main ────────────────────────────────────
  const root = document.createElement('section');
  root.id = 'dashboard-view';
  root.className = 'dashboard-view';
  root.hidden = true;
  root.setAttribute('aria-label', 'Multi-session dashboard');
  root.innerHTML = `
    <header class="dashboard-toolbar">
      <div class="dashboard-toolbar-title">
        <button type="button" class="icon-btn dashboard-Menu-btn" id="btn-dashboard-drawer" aria-label="切換側邊欄" title="切換側邊欄">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        <div class="dashboard-heading-stack">
          <h2>Session Dashboard</h2>
          <span class="dashboard-toolbar-sub" id="dashboard-pane-counter">0 個並排視窗</span>
        </div>
      </div>
      <div class="dashboard-layout-presets" id="dashboard-layout-presets" role="group" aria-label="並排佈局切換" hidden>
        <button type="button" class="dashboard-preset-btn" data-preset="horizontal" aria-label="水平並排" title="水平並排（左右分欄）">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="4" width="8" height="16" rx="1.5"/><rect x="13" y="4" width="8" height="16" rx="1.5"/></svg>
          <span>水平</span>
        </button>
        <button type="button" class="dashboard-preset-btn" data-preset="vertical" aria-label="垂直並排" title="垂直並排（上下分列）">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="4" y="3" width="16" height="8" rx="1.5"/><rect x="4" y="13" width="16" height="8" rx="1.5"/></svg>
          <span>垂直</span>
        </button>
        <button type="button" class="dashboard-preset-btn" data-preset="grid" aria-label="網格並排" title="2D 網格並排（自動水平＋垂直對齊）">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>
          <span>網格</span>
        </button>
      </div>
      <div class="dashboard-toolbar-actions"></div>
    </header>
    <div class="dashboard-stage" id="dashboard-stage">
      <div class="dashboard-empty" id="dashboard-empty">
        <div class="dashboard-empty-card">
          <div class="dashboard-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <rect x="3" y="3" width="8" height="8" rx="1.8" />
              <rect x="13" y="3" width="8" height="8" rx="1.8" />
              <rect x="3" y="13" width="8" height="8" rx="1.8" />
              <rect x="13" y="13" width="8" height="8" rx="1.8" />
            </svg>
          </div>
          <h3>拖曳 Session 到這裡（支援水平＆垂直並排）</h3>
          <p>將左側 Session 拖曳到任一視窗的<strong>左、右、上、下邊緣</strong>即可自由組合水平或垂直分割，也可隨時切換上方「水平並排／垂直並排／網格並排」，或拖拉水平與垂直分隔線調整視窗大小。</p>
          <div class="dashboard-quick-picks" id="dashboard-quick-picks" role="group" aria-label="快速加入並排"></div>
        </div>
      </div>
      <div class="dashboard-grid" id="dashboard-grid" role="region" aria-label="Tiled session panes" hidden></div>
      <div class="dashboard-drop-preview" id="dashboard-drop-preview" hidden>
        <span class="dashboard-drop-label" id="dashboard-drop-label">放開以加入並排視窗</span>
      </div>
    </div>
  `;
  main.append(root);

  const stageEl = root.querySelector('#dashboard-stage');
  const emptyEl = root.querySelector('#dashboard-empty');
  const quickPicksEl = root.querySelector('#dashboard-quick-picks');
  const gridEl = root.querySelector('#dashboard-grid');
  const dropPreviewEl = root.querySelector('#dashboard-drop-preview');
  const dropLabelEl = root.querySelector('#dashboard-drop-label');
  const counterEl = root.querySelector('#dashboard-pane-counter');
  const presetsEl = root.querySelector('#dashboard-layout-presets');
  const navCountEl = navEntry.querySelector('#dashboard-nav-count');
  const btnDrawerToggle = root.querySelector('#btn-dashboard-drawer');

  // ── State Helpers ──────────────────────────────────────────────────────────
  function allJids() {
    const out = [];
    const walk = (node) => {
      if (node.jid) {
        if (!out.includes(node.jid)) out.push(node.jid);
      } else {
        node.items.forEach(walk);
      }
    };
    groups.forEach(walk);
    return out;
  }

  const cleanWeight = (w) => (Number.isFinite(w) && w > 0.05 ? Number(w) : 1);

  // Siblings must fill their container: a lone child takes all of it, and in
  // CSS flexbox a flex-grow sum below 1 leaves space unallocated.
  function balanceWeights(nodes) {
    if (nodes.length === 1) {
      nodes[0].weight = 1;
      return;
    }
    const total = nodes.reduce((sum, n) => sum + n.weight, 0);
    if (total > 0 && total < 1) {
      for (const n of nodes) n.weight = Number((n.weight / total).toFixed(4));
    }
  }

  // Replace a child split by its own children (same axis as `into`), keeping
  // their share of the space the split had.
  function spliceFlattened(into, split) {
    const total = split.items.reduce((sum, n) => sum + n.weight, 0) || 1;
    for (const n of split.items) {
      into.push({ ...n, weight: Number(((n.weight / total) * split.weight).toFixed(4)) });
    }
  }

  // Clean a nested split's children: drop empty/duplicate panes, collapse a
  // split left with one child into that child, and flatten a child split that
  // ended up on the same axis as its parent (its children join the parent).
  function normalizeItems(rawItems, seen) {
    const items = [];
    for (const it of Array.isArray(rawItems) ? rawItems : []) {
      if (!it || typeof it !== 'object') continue;
      if (typeof it.jid === 'string' && it.jid) {
        if (seen.has(it.jid)) continue;
        seen.add(it.jid);
        items.push({ jid: it.jid, weight: cleanWeight(it.weight) });
        continue;
      }
      if (!Array.isArray(it.items)) continue;
      const children = normalizeItems(it.items, seen);
      if (children.length === 0) continue;
      const weight = cleanWeight(it.weight);
      if (children.length === 1) {
        const only = children[0];
        // A lone grandchild split runs on this level's axis: lift its children.
        if (only.items) spliceFlattened(items, { weight, items: only.items });
        else items.push({ ...only, weight });
        continue;
      }
      items.push({ weight, items: children });
    }
    balanceWeights(items);
    return items;
  }

  function normalizeGroups() {
    const seen = new Set();
    const cleaned = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || typeof g !== 'object') continue;
      // A bare pane at the top level becomes its own cell.
      const items = normalizeItems(g.jid ? [g] : g.items, seen);
      if (items.length === 0) continue;
      const weight = cleanWeight(g.weight);
      if (items.length === 1 && items[0].items) {
        // A cell holding only a split on the top-level axis: its children
        // become top-level cells side by side.
        const lifted = [];
        spliceFlattened(lifted, { weight, items: items[0].items });
        for (const n of lifted) {
          cleaned.push(n.items ? n : { weight: n.weight, items: [{ jid: n.jid, weight: 1 }] });
        }
        continue;
      }
      cleaned.push({ weight, items });
    }
    balanceWeights(cleaned);
    groups = cleaned;
  }

  function serializeNode(node) {
    return node.jid
      ? { jid: node.jid, weight: Number(node.weight.toFixed(4)) }
      : { weight: Number(node.weight.toFixed(4)), items: node.items.map(serializeNode) };
  }

  function serializeLayout() {
    return { direction, groups: groups.map(serializeNode), updatedAt: localUpdatedAt };
  }

  /**
   * Where a pane sits: the chain of `{ node, index }` from the virtual root
   * (`{ items: groups }`, depth 0) down to the pane's parent. A split at depth
   * d lays its children out along `axisAt(d)`.
   */
  function pathToJid(jid) {
    const walk = (node, trail) => {
      for (let i = 0; i < node.items.length; i++) {
        const child = node.items[i];
        const step = [...trail, { node, index: i }];
        if (child.jid === jid) return step;
        if (child.items) {
          const found = walk(child, step);
          if (found) return found;
        }
      }
      return null;
    };
    return walk({ items: groups }, []);
  }

  const crossAxis = (axis) => (axis === 'row' ? 'column' : 'row');
  const axisAt = (depth) => (depth % 2 === 0 ? direction : crossAxis(direction));

  function firstLeafJid(node) {
    return node.jid ?? firstLeafJid(node.items[0]);
  }

  // The split whose children i and i+1 start with these panes (for splitters).
  function siblingsOf(firstJid, secondJid) {
    const a = pathToJid(firstJid);
    const b = pathToJid(secondJid);
    if (!a || !b) return null;
    for (let d = 0; d < Math.min(a.length, b.length); d++) {
      // Compare child arrays: each call wraps `groups` in a fresh virtual root.
      if (a[d].node.items !== b[d].node.items) return null;
      if (a[d].index !== b[d].index) return { node: a[d].node, index: a[d].index };
    }
    return null;
  }

  let cloudSyncTimer = null;
  function scheduleCloudSave() {
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(async () => {
      try {
        if (typeof api !== 'function') return;
        const payload = serializeLayout();
        await api('/api/dashboard-layout', {
          method: 'POST',
          body: JSON.stringify({ layout: payload }),
        });
      } catch {
        // Ignore background offline/network errors
      }
    }, 350);
  }

  let localUpdatedAt = 0;

  function loadSavedState() {
    try {
      const raw = JSON.parse(localStorage.getItem(DASHBOARD_STORAGE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return;
      if (Number.isFinite(raw.updatedAt)) {
        localUpdatedAt = Number(raw.updatedAt);
      }
      if (raw.direction === 'column' || raw.direction === 'row') {
        direction = raw.direction;
      }
      if (Array.isArray(raw.groups)) {
        groups = raw.groups;
        normalizeGroups();
        return;
      }
      // Migrate legacy 1D `{ jids, weights }` format
      if (Array.isArray(raw.jids)) {
        const wMap = raw.weights && typeof raw.weights === 'object' ? raw.weights : {};
        groups = raw.jids
          .filter((j) => typeof j === 'string' && j)
          .map((jid) => ({
            weight: Number(wMap[jid]) > 0.1 ? Number(wMap[jid]) : 1,
            items: [{ jid, weight: 1 }],
          }));
        normalizeGroups();
      }
    } catch {
      groups = [];
    }
  }

  async function syncCloudLayout() {
    try {
      if (typeof api !== 'function') return;
      const res = await api('/api/dashboard-layout');
      const raw = res?.layout;
      if (!raw || typeof raw !== 'object') return;
      if (!Array.isArray(raw.groups)) return;

      const serverUpdatedAt = Number(raw.updatedAt) || 0;
      const hadNoLocal = groups.length === 0;

      // Inherit settings from other devices: if local had no layout or cloud layout is newer or equal
      if (hadNoLocal || serverUpdatedAt >= localUpdatedAt) {
        if (raw.direction === 'column' || raw.direction === 'row') {
          direction = raw.direction;
        }
        groups = raw.groups;
        localUpdatedAt = serverUpdatedAt || Date.now();
        normalizeGroups();
        try {
          localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(serializeLayout()));
        } catch {
          // Ignore storage quota
        }

        if (active) {
          rebuildGrid(true);
          onRenderSessionListDecorations();
        } else {
          syncNavCounts();
        }
      }
    } catch {
      // Offline fallback
    }
  }

  function saveState() {
    try {
      normalizeGroups();
      localUpdatedAt = Date.now();
      localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(serializeLayout()));
    } catch {
      // Ignore storage quota errors
    }
    scheduleCloudSave();
  }

  loadSavedState();
  void syncCloudLayout();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function currentLayoutMode() {
    const jids = allJids();
    if (jids.length <= 1) return 'horizontal';
    if (groups.some((g) => g.items.some((it) => it.items))) return 'grid';
    const hasMultiPerGroup = groups.some((g) => g.items.length > 1);
    if (direction === 'row' && !hasMultiPerGroup) return 'horizontal';
    if (direction === 'column' && !hasMultiPerGroup) return 'vertical';
    if (groups.length === 1 && direction === 'row' && hasMultiPerGroup) return 'vertical';
    if (groups.length === 1 && direction === 'column' && hasMultiPerGroup) return 'horizontal';
    return 'grid';
  }

  function syncNavCounts() {
    const jids = allJids();
    const count = jids.length;
    navCountEl.textContent = String(count);
    navCountEl.hidden = count === 0;
    counterEl.textContent = `${count} 個並排視窗`;
    presetsEl.hidden = count < 2;
    navEntry.setAttribute('aria-pressed', String(active));
    navEntry.classList.toggle('active', active);
    app.classList.toggle('dashboard-active', active);
    root.hidden = !active;

    const mode = currentLayoutMode();
    for (const btn of presetsEl.querySelectorAll('.dashboard-preset-btn')) {
      const isCurrent = btn.dataset.preset === mode;
      btn.classList.toggle('active', isCurrent);
      btn.setAttribute('aria-pressed', String(isCurrent));
    }
  }

  function renderQuickPicks() {
    quickPicksEl.replaceChildren();
    const jids = allJids();
    const sessions = getSessions().filter((s) => !s.deleted && s.kind !== 'life');
    for (const s of sessions.slice(0, 12)) {
      const inDash = jids.includes(s.jid);
      const chip = el('button', `dashboard-quick-chip${inDash ? ' added' : ''}`);
      chip.type = 'button';
      chip.dataset.jid = s.jid;
      chip.append(el('span', 'hash', '#'), el('span', 'name', s.name));
      const badge = getSessionBadge(s);
      if (badge) {
        chip.append(el('span', `provider-badge ${badge.kind}`, badge.label));
      }
      chip.append(el('span', 'add-tag', inDash ? '已加入' : '+ 並排'));
      chip.addEventListener('click', () => {
        addPane(s.jid);
      });
      quickPicksEl.append(chip);
    }
  }

  const prefersReducedMotion = () =>
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  function smoothScrollTo(element, targetTop, duration = 240) {
    if (!element || prefersReducedMotion() || duration <= 0) {
      if (element) element.scrollTop = targetTop;
      return;
    }
    const startTop = element.scrollTop;
    const distance = targetTop - startTop;
    if (Math.abs(distance) < 2) return;
    const startTime = performance.now();

    const step = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Apple quartic ease-out: 1 - (1 - t)^4 -> snappy 120Hz fluid snap
      const ease = 1 - Math.pow(1 - progress, 4);
      element.scrollTop = startTop + distance * ease;
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        element.scrollTop = targetTop;
      }
    };
    requestAnimationFrame(step);
  }

  // ── Pane Lifecycle, Full Topbar, BTW Workspace, Search, & Full Composer ───
  function createPaneDOM(jid) {
    const session = getSessions().find((s) => s.jid === jid);
    const paneEl = el('article', 'dashboard-pane');
    paneEl.dataset.jid = jid;
    paneEl.setAttribute('aria-label', `Session pane ${session?.name || jid}`);

    // 1. Header (matches single-session .topbar in exact relative position & order)
    const header = el('header', 'dashboard-pane-header');
    header.draggable = true;
    header.title = '拖曳標題列至其他視窗的上下左右邊緣可水平或垂直分割，拖至中央可交換視窗位置';

    const titleWrap = el('div', 'dashboard-pane-title');
    const hash = el('span', 'hash', '#');
    const nameEl = el('span', 'pane-session-name', session?.name || jid);
    nameEl.role = 'button';
    nameEl.tabIndex = 0;
    nameEl.title = '點擊重新命名';
    const nameInput = el('input', 'name-edit pane-name-edit');
    nameInput.maxLength = 80;
    nameInput.hidden = true;
    nameInput.setAttribute('aria-label', `Rename ${session?.name || jid}`);
    const badgeEl = el('span', 'provider-badge');
    badgeEl.hidden = true;
    const spinnerEl = el('span', 'work-spinner');
    spinnerEl.hidden = true;
    titleWrap.append(hash, spinnerEl, nameEl, nameInput, badgeEl);

    // Topbar right actions (Stop, Status, Usage, Model, Thinking, More ⋯, Close ×)
    const actions = el('div', 'dashboard-pane-actions');

    const stopBtn = el('button', 'icon-btn danger pane-stop-btn');
    stopBtn.type = 'button';
    stopBtn.title = 'Stop';
    stopBtn.setAttribute('aria-label', `Stop ${session?.name || jid}`);
    stopBtn.hidden = true;
    stopBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

    const statusBtn = el('button', 'icon-btn pane-status-btn');
    statusBtn.type = 'button';
    statusBtn.title = '/pi status';
    statusBtn.setAttribute('aria-label', `Show pi status for ${session?.name || jid}`);
    statusBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.9"/></svg>';

    const usageBtn = el('button', 'icon-btn pane-usage-btn');
    usageBtn.type = 'button';
    usageBtn.title = '/gpt-usage';
    usageBtn.setAttribute('aria-label', `Show usage for ${session?.name || jid}`);
    usageBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18a8 8 0 1116 0"/><path d="M12 18l4-5.5"/><circle cx="12" cy="18" r="1.1"/></svg>';

    const modelBtn = el('button', 'icon-btn pane-model-btn');
    modelBtn.type = 'button';
    modelBtn.title = 'Model';
    modelBtn.setAttribute('aria-label', `Choose model for ${session?.name || jid}`);
    modelBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>';

    const thinkingBtn = el('button', 'icon-btn pane-thinking-btn');
    thinkingBtn.type = 'button';
    thinkingBtn.title = 'Thinking level';
    thinkingBtn.setAttribute('aria-label', `Choose thinking level for ${session?.name || jid}`);
    thinkingBtn.setAttribute('aria-haspopup', 'dialog');
    thinkingBtn.dataset.level = session?.thinking || 'default';
    thinkingBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 15.5a6 6 0 117 0c-1 .7-1.5 1.5-1.5 2.5h-4c0-1-.5-1.8-1.5-2.5z"/><path d="M10 21h4M12 1V0M4.2 4.2l-1.4-1.4M19.8 4.2l1.4-1.4M2 11H0M24 11h-2"/></svg>';

    const moreBtn = el('button', 'icon-btn pane-more-btn');
    moreBtn.type = 'button';
    moreBtn.title = 'More';
    moreBtn.setAttribute('aria-label', `More actions for ${session?.name || jid}`);
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';

    const splitDownBtn = el('button', 'icon-btn pane-split-dir-btn');
    splitDownBtn.type = 'button';
    splitDownBtn.title = '切換此視窗為垂直（上下）或水平（左右）並排';
    splitDownBtn.setAttribute('aria-label', `Toggle vertical/horizontal split for ${session?.name || jid}`);
    splitDownBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="8" rx="1.5"/><rect x="4" y="13" width="16" height="8" rx="1.5"/></svg>';

    const focusBtn = el('button', 'icon-btn pane-expand-btn');
    focusBtn.type = 'button';
    focusBtn.title = '放大此視窗';
    focusBtn.setAttribute('aria-label', `Expand ${session?.name || jid}`);
    focusBtn.setAttribute('aria-pressed', 'false');
    focusBtn.innerHTML = ZOOM_IN_ICON;

    const closeBtn = el('button', 'icon-btn pane-close-btn');
    closeBtn.type = 'button';
    closeBtn.title = '從並排移除（不會刪除對話）';
    closeBtn.setAttribute('aria-label', `Remove ${session?.name || jid} from dashboard`);
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    actions.append(
      stopBtn,
      statusBtn,
      usageBtn,
      modelBtn,
      thinkingBtn,
      moreBtn,
      splitDownBtn,
      focusBtn,
      closeBtn,
    );
    header.append(titleWrap, actions);

    // 2. Per-pane Overflow Menu (⋯) anchored right under the pane header
    const menuScrim = el('div', 'pane-menu-scrim');
    menuScrim.hidden = true;
    const moreMenu = el('div', 'menu-pop pane-more-menu');
    moreMenu.setAttribute('role', 'menu');
    moreMenu.hidden = true;
    moreMenu.innerHTML = `
      <button type="button" class="menu-item" data-action="search" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <span class="mi-label">Search</span>
      </button>
      <button type="button" class="menu-item" data-action="new-chat" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M4 20l1-4 9.5-9.5a2.1 2.1 0 013 3L8 19z" /></svg>
        <span class="mi-label">New pi session</span>
        <span class="mi-cmd">/pi new</span>
      </button>
      <button type="button" class="menu-item" data-action="commands-running" role="menuitem" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 19H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5M6 7l3 3-3 3m6-6h5" /><circle cx="17" cy="17" r="5" /><path d="M17 14v3l2 1" /></svg>
        <span class="mi-label">背景命令</span>
      </button>
      <button type="button" class="menu-item" data-action="status" role="menuitem" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.6v.9" /></svg>
        <span class="mi-label">Status</span>
        <span class="mi-cmd">/pi status</span>
      </button>
      <button type="button" class="menu-item" data-action="usage" role="menuitem" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18a8 8 0 1116 0" /><path d="M12 18l4-5.5" /><circle cx="12" cy="18" r="1.1" /></svg>
        <span class="mi-label">Usage</span>
        <span class="mi-cmd">/gpt-usage</span>
      </button>
      <button type="button" class="menu-item" data-action="model" role="menuitem" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>
        <span class="mi-label">Model</span>
      </button>
      <button type="button" class="menu-item" data-action="thinking" role="menuitem" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z" /></svg>
        <span class="mi-label">Thinking level</span>
      </button>
      <button type="button" class="menu-item" data-action="btw" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5z" /></svg>
        <span class="mi-label">BTW 側聊</span>
      </button>
      <button type="button" class="menu-item" data-action="subagents" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v7M5 14v-4h14v4" /><circle cx="12" cy="3" r="2" /><circle cx="5" cy="18" r="3" /><circle cx="19" cy="18" r="3" /></svg>
        <span class="mi-label">Subagents</span>
      </button>
      <button type="button" class="menu-item" data-action="media" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M3 14l4.5-4.5 3.5 3.5 3-3L21 15" /><circle cx="8.5" cy="8.5" r="1.4" /></svg>
        <span class="mi-label">Media</span>
      </button>
      <div class="menu-sep" role="separator"></div>
      <button type="button" class="menu-item" data-action="split-dir" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="8" rx="1.5"/><rect x="4" y="13" width="16" height="8" rx="1.5"/></svg>
        <span class="mi-label">切換水平／垂直分割</span>
      </button>
      <button type="button" class="menu-item" data-action="expand" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        <span class="mi-label">放大此視窗</span>
      </button>
      <button type="button" class="menu-item" data-action="close" role="menuitem" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        <span class="mi-label">關閉視窗</span>
      </button>
      <button type="button" class="menu-item danger" data-action="delete" role="menuitem">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
        <span class="mi-label">Delete session</span>
      </button>
    `;

    // 3. Per-pane Search Panel (directly under header, same position as #search-panel)
    const searchPanel = el('div', 'search-panel pane-search-panel');
    searchPanel.hidden = true;
    searchPanel.innerHTML = `
      <div class="search-bar">
        <input type="search" inputmode="search" class="pane-search-input" placeholder="Search this session…" aria-label="Search this session" />
        <button type="button" class="icon-btn pane-search-close" aria-label="Close search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <div class="search-results pane-search-results"></div>
    `;
    const searchInput = searchPanel.querySelector('.pane-search-input');
    const searchCloseBtn = searchPanel.querySelector('.pane-search-close');
    const searchResultsEl = searchPanel.querySelector('.pane-search-results');

    // 4. Per-pane BTW Ownership Card (directly under header when in BTW mode, matching #btw-card)
    const btwCard = el('div', 'btw-card pane-btw-card');
    btwCard.hidden = true;
    const btwBackBtn = el('button', 'icon-btn pane-btw-back');
    btwBackBtn.type = 'button';
    btwBackBtn.title = '回主對話';
    btwBackBtn.setAttribute('aria-label', '回主對話');
    btwBackBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>';
    const btwStatusWrap = el('div');
    const btwTitleStrong = el('strong', null, 'BTW 側聊');
    const btwStatusSpan = el('span', null, '不會加入主對話');
    btwStatusWrap.append(btwTitleStrong, btwStatusSpan);
    const btwClearBtn = el('button', 'icon-btn pane-btw-clear');
    btwClearBtn.type = 'button';
    btwClearBtn.title = '清除 BTW';
    btwClearBtn.setAttribute('aria-label', '清除 BTW 訊息');
    btwClearBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>';
    btwCard.append(btwBackBtn, btwStatusWrap, btwClearBtn);

    // 5. Messages scroller & BTW side messages scroller
    const messagesEl = el('div', 'messages dashboard-pane-messages');
    const btwMessagesEl = el('div', 'messages btw-messages dashboard-pane-btw-messages');
    btwMessagesEl.setAttribute('aria-label', 'BTW 側聊紀錄');
    btwMessagesEl.hidden = true;

    const jumpBtn = el('button', 'jump-live pane-jump-live', 'Jump to present ↓');
    jumpBtn.type = 'button';

    // 6. Typing row + BTW quick switch link right on the typing line above composer
    const typingEl = el('div', 'typing dashboard-pane-typing');
    typingEl.hidden = true;
    typingEl.innerHTML =
      '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="typing-label">pi is working…</span>';

    const btwPendingRow = el('div', 'btw-pending-row pane-btw-pending-row');
    btwPendingRow.hidden = !isPiBtwSession(jid);
    const btwPendingLink = el('button', 'pane-btw-switch-btn', 'BTW ›');
    btwPendingLink.type = 'button';
    btwPendingLink.setAttribute('aria-label', '開啟 BTW');
    btwPendingRow.append(btwPendingLink);

    // 7. Full Composer Wrap (matching #composer-wrap exact stack order)
    const composerWrap = el('div', 'composer-wrap dashboard-pane-composer-wrap');

    const acBox = el('div', 'autocomplete pane-autocomplete');
    acBox.hidden = true;

    const uploadProgressEl = el('div', 'upload-progress pane-upload-progress');
    uploadProgressEl.setAttribute('role', 'progressbar');
    uploadProgressEl.setAttribute('aria-label', 'Uploading attachments');
    uploadProgressEl.hidden = true;
    const uploadHead = el('div', 'upload-progress-head');
    uploadHead.append(el('span', null, 'Uploading attachments…'));
    const uploadPercentEl = el('span', null, '0%');
    uploadHead.append(uploadPercentEl);
    const uploadTrack = el('div', 'upload-progress-track');
    const uploadBarEl = el('div', 'upload-progress-bar');
    uploadTrack.append(uploadBarEl);
    uploadProgressEl.append(uploadHead, uploadTrack);
    const paneUploadProgress = {
      container: uploadProgressEl,
      bar: uploadBarEl,
      percent: uploadPercentEl,
    };

    const quotePreviewEl = el('div', 'quote-preview pane-quote-preview');
    quotePreviewEl.hidden = true;
    const quoteLabel = el('span', 'quote-preview-label', '引用');
    const quoteTextEl = el('span', 'quote-preview-text');
    const quoteRemoveBtn = el('button', 'pane-quote-remove', '×');
    quoteRemoveBtn.type = 'button';
    quoteRemoveBtn.setAttribute('aria-label', 'Remove quote');
    quotePreviewEl.append(quoteLabel, quoteTextEl, quoteRemoveBtn);

    const attachmentsEl = el('div', 'attachments pane-attachments');
    attachmentsEl.hidden = true;

    const compressionOptionsEl = el('div', 'image-compression-options pane-compression-options');
    compressionOptionsEl.hidden = true;
    const compressionLabel = document.createElement('label');
    const compressionCheckbox = document.createElement('input');
    compressionCheckbox.type = 'checkbox';
    compressionCheckbox.checked = readCompressionPreference();
    compressionCheckbox.setAttribute('aria-label', '壓縮圖片');
    compressionLabel.append(compressionCheckbox, el('span', null, '壓縮圖片'));
    const compressionHint = el(
      'span',
      'pane-compression-hint',
      'JPEG／PNG ≤541,200 像素（528×1025），保持比例；取消傳原檔',
    );
    compressionOptionsEl.append(compressionLabel, compressionHint);

    const hotKeywordsEl = el('div', 'life-tags hot-keywords pane-hot-keywords');
    hotKeywordsEl.setAttribute('role', 'group');
    hotKeywordsEl.setAttribute('aria-label', '熱門關鍵字');
    hotKeywordsEl.hidden = true;

    const form = el('form', 'composer dashboard-pane-composer');
    const attachBtn = el('button', 'icon-btn pane-attach-btn');
    attachBtn.type = 'button';
    attachBtn.title = 'Add attachment';
    attachBtn.setAttribute('aria-label', 'Add attachment');
    attachBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.hidden = true;

    const pasteBtn = el('button', 'icon-btn pane-paste-btn');
    pasteBtn.type = 'button';
    pasteBtn.title = '貼上';
    pasteBtn.setAttribute('aria-label', '貼上剪貼簿內容');
    pasteBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      </svg>
    `;

    const textarea = el('textarea', 'dashboard-pane-input');
    textarea.rows = 1;
    textarea.placeholder = `Message ${session?.name || 'pi'}…`;
    textarea.setAttribute('aria-label', `Message ${session?.name || jid}`);

    const sendBtn = el('button', 'icon-btn send dashboard-pane-send');
    sendBtn.type = 'submit';
    sendBtn.title = 'Send';
    sendBtn.setAttribute('aria-label', `Send to ${session?.name || jid}`);
    sendBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 8 6 8z" /></svg>';

    form.append(attachBtn, fileInput, pasteBtn, textarea, sendBtn);
    composerWrap.append(
      acBox,
      uploadProgressEl,
      quotePreviewEl,
      attachmentsEl,
      compressionOptionsEl,
      hotKeywordsEl,
      form,
    );

    const transcript = el('div', 'dashboard-pane-transcript');
    transcript.append(messagesEl, btwMessagesEl, jumpBtn);

    // One floating input for the whole Dashboard: every pane keeps its own
    // composer (draft, attachments, BTW), but only the pane last touched shows
    // it, as a card under its transcript (selectComposerPane).
    const dock = el('div', 'dashboard-pane-dock');
    dock.append(typingEl, btwPendingRow, composerWrap);

    paneEl.append(header, menuScrim, moreMenu, searchPanel, btwCard, transcript, dock);
    // On click, not pointerdown: the card's arrival shrinks this transcript,
    // and a pointerdown hop would lift Jump to present (or any button near the
    // bottom) out from under the finger before the tap lands.
    // A finger scroll never ends in a click, so browsing moves nothing.
    let pressPointer = '';
    // Read on press: by the click, the tap itself may have blurred the input.
    let pressTyping = false;
    let pressTypingHere = false;
    paneEl.addEventListener(
      'pointerdown',
      (e) => {
        pressPointer = e.pointerType;
        const typingIn = document.activeElement?.closest?.('.dashboard-pane-composer');
        pressTyping = Boolean(typingIn);
        pressTypingHere = Boolean(typingIn && dock.contains(typingIn));
      },
      true,
    );
    paneEl.addEventListener(
      'click',
      (e) => {
        // Closing a pane is no reason to send the input there first.
        if (e.target.closest('.pane-close-btn')) return;
        // Neither is ending a mouse drag-select: the arriving card would
        // shrink the transcript, which keeps to its bottom and scrolls the
        // selection out from under its 引用 / 複製 pill. 引用 brings the card.
        const selection = document.getSelection();
        if (selection && !selection.isCollapsed && messagesEl.contains(selection.anchorNode)) return;
        // The first tap only brings the card here; a second tap on the pane
        // that already holds it opens the keyboard, and a third closes it
        // again (2026-10-22: the keyboard popping up on every pane switch was
        // unwanted). A keyboard that is up in another pane moves along with
        // the card instead of closing.
        const holdsCard = composerJid === jid && dock.classList.contains('is-floating');
        const typing = pressTyping;
        const typingHere = pressTypingHere;
        selectComposerPane(jid);
        // iPhone / iPad: a finger tap on the transcript itself (not a control,
        // image or video, not ending a text selection) toggles the keyboard.
        // focus() must run inside the tap for iOS to raise the keyboard.
        if (
          (holdsCard || typing) &&
          pressPointer === 'touch' &&
          e.target.closest('.dashboard-pane-transcript') &&
          !e.target.closest(PANE_TAP_KEEPS_FOCUS) &&
          !document.getSelection()?.toString()
        ) {
          const input = dock.querySelector('.dashboard-pane-composer textarea');
          if (typingHere) document.activeElement?.blur();
          else input?.focus({ preventScroll: true });
        }
      },
      true,
    );
    // A button takes focus on press, before its click: only typing fields hop
    // on focus, or the card would move under the finger mid-tap.
    paneEl.addEventListener('focusin', (e) => {
      if (e.target.matches('textarea, input')) selectComposerPane(jid);
    });
    transcriptObserver?.observe(messagesEl);
    paneSizeObserver?.observe(paneEl);
    paneSizeObserver?.observe(header);
    paneSizeObserver?.observe(dock);

    // Mount pinned prompt bar inside the pane right above messagesEl
    if (typeof createPromptPin === 'function') {
      createPromptPin({
        scroller: messagesEl,
        isCommand: isCommandEchoText,
        // A pane holds only the newest page, often one prompt or none: a turn
        // that began before it (scrolled up past the latest prompt, or one long
        // tool loop) looks its prompt up on the server.
        getEarlier: () => {
          let oldest = Infinity;
          for (const node of messagesEl.querySelectorAll('[data-event-id]')) {
            const id = Number(node.dataset.eventId);
            if (id > 0 && id < oldest) oldest = id;
          }
          if (!Number.isFinite(oldest) || oldest <= 1) return null;
          return {
            key: `${jid}:${oldest}`,
            load: async () => {
              let before = oldest;
              for (let page = 0; page < 5 && before; page++) {
                const { events = [], hasMore } = await api(
                  `/api/sessions/${encodeURIComponent(jid)}/events?before=${before}&limit=200`,
                );
                const prompt = events.findLast(
                  (event) =>
                    event.kind === 'message' && event.role === 'user' && !isCommandEchoText(event.content),
                );
                if (prompt) return prompt.content || '';
                if (!hasMore || !events.length) break;
                before = Math.min(...events.map((event) => event.id));
              }
              return '';
            },
          };
        },
      });
    }

    // Mount hot keywords shortcut chips inside the pane's composer
    let hotKeywordsCtrl = null;
    if (typeof createHotKeywords === 'function') {
      hotKeywordsCtrl = createHotKeywords({
        container: hotKeywordsEl,
        input: textarea,
        select: document.getElementById('hot-keywords-days'),
      });
    }

    const pane = {
      jid,
      el: paneEl,
      header,
      nameEl,
      nameInput,
      badgeEl,
      spinnerEl,
      stopBtn,
      statusBtn,
      usageBtn,
      modelBtn,
      thinkingBtn,
      moreBtn,
      moreMenu,
      menuScrim,
      splitDownBtn,
      focusBtn,
      closeBtn,
      searchPanel,
      searchInput,
      searchResultsEl,
      btwCard,
      btwStatusSpan,
      btwClearBtn,
      transcript,
      messagesEl,
      btwMessagesEl,
      jumpBtn,
      typingEl,
      btwPendingRow,
      btwPendingLink,
      dock,
      composerWrap,
      acBox,
      uploadProgressEl,
      paneUploadProgress,
      quotePreviewEl,
      quoteTextEl,
      attachmentsEl,
      compressionOptionsEl,
      compressionCheckbox,
      hotKeywordsEl,
      hotKeywordsCtrl,
      attachBtn,
      fileInput,
      pasteBtn,
      textarea,
      sendBtn,
      form,
      cursor: 0,
      // Older history, paged in as the reader scrolls up (see loadPaneOlder).
      oldest: 0,
      hasMoreOlder: false,
      loadingOlder: false,
      historyGeneration: 0,
      busy: false,
      source: null,
      reconnectTimer: null,
      disposed: false,
      partialThinkingEl: null,
      partialMsgEl: null,
      userScrolledUp: false,
      pendingQuote: '',
      attachments: [],
      uploading: false,
      ac: { open: false, items: [], index: 0, mode: null, command: null },
      // Per-pane BTW state
      btwTarget: 'main', // 'main' | 'btw'
      btwGeneration: null,
      btwSending: false,
      btwRemotePending: false,
      btwPollTimer: null,
      btwMainDraft: '',
      btwSideDraft: '',
      btwLive: [],
      btwSettledKey: '',
    };

    // ── Inline Rename on Pane Title ──────────────────────────────────────────
    const startPaneRename = () => {
      nameInput.value = nameEl.textContent || '';
      nameEl.hidden = true;
      nameInput.hidden = false;
      nameInput.focus();
      nameInput.select();
    };
    const commitPaneRename = async (save) => {
      if (nameInput.hidden) return;
      const nextName = nameInput.value.trim();
      nameInput.hidden = true;
      nameEl.hidden = false;
      if (!save || !nextName || nextName === nameEl.textContent) return;
      const prevName = nameEl.textContent;
      nameEl.textContent = nextName;
      onApplySessionTitle(jid, nextName);
      try {
        await api(`/api/sessions/${encodeURIComponent(jid)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: nextName }),
        });
        await onReloadSessions();
      } catch (err) {
        nameEl.textContent = prevName;
        alert(err.message);
      }
    };
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      startPaneRename();
    });
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        startPaneRename();
      }
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void commitPaneRename(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void commitPaneRename(false);
      }
    });
    nameInput.addEventListener('blur', () => void commitPaneRename(true));

    // ── Scroll & Jump to Present (120Hz ProMotion optimized) ─────────────────
    const isNearBottom = () =>
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= 28;
    const scrollToBottom = (instant = false) => {
      pane.userScrolledUp = false;
      if (instant || prefersReducedMotion()) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        smoothScrollTo(messagesEl, messagesEl.scrollHeight, 240);
      }
      jumpBtn.classList.remove('visible');
    };
    let scrollRafId = 0;
    let lastJumpState = false;
    messagesEl.addEventListener(
      'scroll',
      () => {
        if (scrollRafId) return;
        scrollRafId = requestAnimationFrame(() => {
          scrollRafId = 0;
          if (shouldLoadOlderHistory(messagesEl)) void loadPaneOlder(pane);
          const near = isNearBottom();
          if (near) pane.userScrolledUp = false;
          const showJump = !near && pane.btwTarget === 'main';
          if (showJump !== lastJumpState) {
            lastJumpState = showJump;
            jumpBtn.classList.toggle('visible', showJump);
          }
        });
      },
      { passive: true },
    );
    for (const evtName of ['wheel', 'touchmove', 'pointerdown']) {
      messagesEl.addEventListener(
        evtName,
        () => {
          if (!isNearBottom()) pane.userScrolledUp = true;
        },
        { passive: true },
      );
    }
    jumpBtn.addEventListener('click', () => scrollToBottom(false));

    // Disclosure summary toggle inside pane messages
    messagesEl.addEventListener('click', (e) => {
      const img = e.target.closest?.('.msg-files img, .msg-text img, .msg-inline-media img');
      if (img && img.src && !img.closest('a')) {
        const urls = [...messagesEl.querySelectorAll('.msg-files img, .msg-text img, .msg-inline-media img')]
          .map((node) => node.getAttribute('src'))
          .filter(Boolean);
        openLightbox(
          img.getAttribute('src'),
          urls.length ? urls : [img.getAttribute('src')],
          annotationTarget,
        );
      }
    });

    // ── Header Dragging (Swap / Split) ───────────────────────────────────────
    header.addEventListener('dragstart', (e) => {
      if (e.target.closest('button, input') || !nameInput.hidden || pointerDrag) {
        e.preventDefault();
        return;
      }
      dragSourceJid = jid;
      paneEl.classList.add('dragging-pane');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/piweb-session-jid', jid);
      }
    });
    header.addEventListener('dragend', () => {
      dragSourceJid = null;
      paneEl.classList.remove('dragging-pane');
      hideDropPreview();
    });

    // A touch anywhere on the header, the session name and icon buttons
    // included, may become a drag: movement past the threshold drags the pane,
    // a still finger stays a tap (rename / button action). Only the open
    // rename field is excluded, since moving in it selects text.
    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('input, textarea')) return;
      if (e.pointerType === 'mouse') return;
      window.getSelection()?.removeAllRanges();
      pointerDrag = {
        source: 'pane',
        targetElement: header,
        fromControl: Boolean(e.target.closest('button, [role="button"]')),
        jid,
        name: nameEl.textContent || jid,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        ghost: null,
      };
    });

    // A double click / double tap on the header's bare space zooms the pane,
    // like a window's title bar. The name renames on its first tap, and a
    // press that moved was a drag.
    let lastHeaderTap = null;
    header.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, .pane-session-name')) return;
      if (pointerDrag?.started || performance.now() < twoFingerQuietUntil) {
        lastHeaderTap = null;
        return;
      }
      const now = performance.now();
      const prev = lastHeaderTap;
      lastHeaderTap = { at: now, x: e.clientX, y: e.clientY };
      if (prev && now - prev.at < 350 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 24) {
        lastHeaderTap = null;
        setZoom(zoomedJid === jid ? null : jid);
      }
    });

    // ── Topbar Buttons & Overflow Menu (⋯) ───────────────────────────────────
    const closePaneMenu = () => {
      moreMenu.hidden = true;
      menuScrim.hidden = true;
      moreBtn.setAttribute('aria-expanded', 'false');
    };
    const openPaneMenu = () => {
      const commandsItem = moreMenu.querySelector('[data-action="commands-running"]');
      const btwItem = moreMenu.querySelector('[data-action="btw"]');
      const splitItem = moreMenu.querySelector('[data-action="split-dir"]');
      if (commandsItem) commandsItem.hidden = !isAgyCommandSession(jid);
      if (btwItem) btwItem.hidden = !isPiBtwSession(jid);
      if (splitItem) splitItem.hidden = allJids().length < 2;
      // A narrow pane drops its Status / Usage icons (CSS container query);
      // the menu then carries them, naming the quota this session draws on.
      const statusItem = moreMenu.querySelector('[data-action="status"]');
      const usageItem = moreMenu.querySelector('[data-action="usage"]');
      statusItem.hidden = getComputedStyle(statusBtn).display !== 'none';
      usageItem.hidden = getComputedStyle(usageBtn).display !== 'none';
      // Narrower still, the header keeps only ⋯ (and Stop while running); the
      // menu takes over Model, Thinking, Expand and Close.
      for (const [action, btn] of [
        ['model', modelBtn],
        ['thinking', thinkingBtn],
        ['close', closeBtn],
      ]) {
        moreMenu.querySelector(`[data-action="${action}"]`).hidden =
          getComputedStyle(btn).display !== 'none';
      }
      usageItem.querySelector('.mi-cmd').textContent = `/${usageCommandForSession(jid)}`;
      // A narrow pane's menu drops the command hints (measured here rather
      // than by a container query, see paneSizeObserver).
      moreMenu.classList.toggle('is-narrow', paneEl.clientWidth <= 300);
      moreMenu.hidden = false;
      menuScrim.hidden = false;
      moreBtn.setAttribute('aria-expanded', 'true');
    };

    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!moreMenu.hidden) closePaneMenu();
      else openPaneMenu();
    });
    menuScrim.addEventListener('click', closePaneMenu);

    stopBtn.addEventListener('click', () => {
      void runQuickCommand('pi stop', {}, jid);
    });
    statusBtn.addEventListener('click', () => {
      void runQuickCommand('pi status', {}, jid);
    });
    usageBtn.addEventListener('click', () => {
      void runQuickCommand(usageCommandForSession(jid), {}, jid);
    });
    modelBtn.addEventListener('click', () => {
      onOpenModelSheet(jid);
    });
    thinkingBtn.addEventListener('click', () => {
      onOpenThinkingSheet(jid);
    });
    splitDownBtn.addEventListener('click', () => {
      togglePaneAxis(jid);
    });
    focusBtn.addEventListener('click', () => {
      setZoom(zoomedJid === jid ? null : jid);
    });
    closeBtn.addEventListener('click', () => {
      removePane(jid);
    });

    // Overflow menu actions
    moreMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      const action = item.dataset.action;
      closePaneMenu();
      if (action === 'search') {
        searchPanel.hidden = false;
        searchInput.focus();
      } else if (action === 'new-chat') {
        void runQuickCommand('pi new', {}, jid);
      } else if (action === 'status') {
        void runQuickCommand('pi status', {}, jid);
      } else if (action === 'usage') {
        void runQuickCommand(usageCommandForSession(jid), {}, jid);
      } else if (action === 'commands-running') {
        onOpenCommandsRunning(jid);
      } else if (action === 'btw') {
        void openPaneBtw();
      } else if (action === 'subagents') {
        onOpenSubagents(jid);
      } else if (action === 'media') {
        onOpenMediaSheet(jid);
      } else if (action === 'model') {
        onOpenModelSheet(jid);
      } else if (action === 'thinking') {
        onOpenThinkingSheet(jid);
      } else if (action === 'close') {
        removePane(jid);
      } else if (action === 'split-dir') {
        togglePaneAxis(jid);
      } else if (action === 'expand') {
        setZoom(zoomedJid === jid ? null : jid);
      } else if (action === 'delete') {
        const s = getSessions().find((cand) => cand.jid === jid) || {
          jid,
          name: nameEl.textContent || jid,
          kind: 'standard',
        };
        onDeleteSession(s);
      }
    });

    // ── Per-pane Search Bar ──────────────────────────────────────────────────
    let paneSearchTimer = null;
    const closePaneSearch = () => {
      clearTimeout(paneSearchTimer);
      searchPanel.hidden = true;
      searchInput.value = '';
      searchResultsEl.replaceChildren();
    };
    searchCloseBtn.addEventListener('click', closePaneSearch);
    searchInput.addEventListener('input', () => {
      clearTimeout(paneSearchTimer);
      paneSearchTimer = setTimeout(async () => {
        const q = searchInput.value.trim();
        if (q.length < 2) {
          searchResultsEl.replaceChildren();
          return;
        }
        try {
          const { hits } = await api(
            `/api/sessions/${encodeURIComponent(jid)}/search?q=${encodeURIComponent(q)}`,
          );
          if (pane.disposed || searchPanel.hidden) return;
          searchResultsEl.replaceChildren();
          if (!hits || hits.length === 0) {
            searchResultsEl.append(el('div', 'search-empty', `No matches for "${q}"`));
            return;
          }
          for (const hit of hits) {
            const row = el('div', 'search-hit');
            const meta = el('div', 'hit-meta');
            meta.append(
              el('span', 'hit-who', hit.kind === 'message' ? (hit.role === 'user' ? 'You' : 'pi') : hit.role || hit.kind),
            );
            row.append(meta);
            const text = el('div', 'hit-text');
            highlightMatch(text, hit.snippet, q);
            row.append(text);
            row.addEventListener('click', async () => {
              const existing = messagesEl.querySelector(`[data-event-id="${hit.id}"]`);
              if (existing) {
                existing.scrollIntoView({ block: 'center', behavior: 'smooth' });
                existing.classList.add('jump-target');
                setTimeout(() => existing.classList.remove('jump-target'), 2200);
                closePaneSearch();
                return;
              }
              try {
                const { events, hasMore } = await api(
                  `/api/sessions/${encodeURIComponent(jid)}/events?around=${hit.id}&limit=50`,
                );
                if (pane.disposed) return;
                messagesEl.replaceChildren();
                for (const ev of events || []) {
                  appendPaneEvent(pane, ev, false);
                }
                resetPaneHistory(pane, events, hasMore);
                const target = messagesEl.querySelector(`[data-event-id="${hit.id}"]`);
                if (target) {
                  target.scrollIntoView({ block: 'center' });
                  target.classList.add('jump-target');
                  setTimeout(() => target.classList.remove('jump-target'), 2200);
                }
                closePaneSearch();
              } catch {
                // Ignore jump errors
              }
            });
            searchResultsEl.append(row);
          }
        } catch {
          // Ignore search errors
        }
      }, 240);
    });

    // ── Per-pane Quote Preview ───────────────────────────────────────────────
    const renderPaneQuote = () => {
      quotePreviewEl.hidden = !pane.pendingQuote;
      quoteTextEl.textContent = pane.pendingQuote ? `「${quotePreview(pane.pendingQuote)}」` : '';
    };
    pane.renderQuote = renderPaneQuote;

    quoteRemoveBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    quoteRemoveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pane.pendingQuote = '';
      renderPaneQuote();
    });

    // ── Per-pane Multimedia / Image Attachment Previews & Compression ────────
    compressionCheckbox.addEventListener('change', () => {
      try {
        localStorage.setItem(IMAGE_COMPRESSION_KEY, String(compressionCheckbox.checked));
      } catch {
        // Ignore storage errors
      }
    });

    const renderPaneAttachments = () => {
      attachmentsEl.replaceChildren();
      attachmentsEl.hidden = pane.attachments.length === 0;
      compressionOptionsEl.hidden = !pane.attachments.some((a) => a.isImage);

      pane.attachments.forEach((attachment, idx) => {
        const isImg = attachment.isImage;
        const isAud = attachment.isAudio;
        const isVid = attachment.isVideo;
        const chip = el(
          'div',
          `chip${isImg ? ' chip-image' : isAud ? ' chip-audio' : isVid ? ' chip-video' : ''}`,
        );
        if (isImg) {
          const thumb = el('img', 'chip-thumb');
          thumb.src = attachment.url;
          thumb.alt = attachment.name;
          const previewBtn = el('button', 'chip-preview');
          previewBtn.type = 'button';
          previewBtn.disabled = pane.uploading;
          previewBtn.setAttribute('aria-label', `Preview ${attachment.name}`);
          previewBtn.addEventListener('click', () =>
            openLightbox(attachment.url, [attachment.url], annotationTarget),
          );
          previewBtn.append(thumb);
          chip.append(previewBtn);
        } else {
          const icon = isAud ? '🎵 ' : isVid ? '🎬 ' : '📎 ';
          chip.append(el('span', 'chip-name', `${icon}${attachment.name}`));
        }
        const remove = el('button', 'chip-remove', '×');
        remove.type = 'button';
        remove.disabled = pane.uploading;
        remove.setAttribute('aria-label', `Remove ${attachment.name}`);
        remove.addEventListener('click', () => {
          if (pane.uploading) return;
          const [gone] = pane.attachments.splice(idx, 1);
          if (gone?.url) URL.revokeObjectURL(gone.url);
          renderPaneAttachments();
        });
        chip.append(remove);
        attachmentsEl.append(chip);
      });
    };

    // The viewer's draw (annotate) button attaches its PNG to this pane's
    // composer: a pending image is replaced in place, a transcript image is
    // added as a new attachment, and the card comes to this pane.
    const annotationTarget = {
      canAttach: () => !pane.disposed && !pane.uploading && pane.btwTarget !== 'btw',
      attach: (file, sourceUrl) => {
        const index = pane.attachments.findIndex((a) => a.url && a.url === sourceUrl);
        if (index >= 0) {
          const old = pane.attachments[index];
          pane.attachments[index] = {
            ...old,
            name: file.name || old.name,
            file,
            url: URL.createObjectURL(file),
          };
          if (old.url) URL.revokeObjectURL(old.url);
          renderPaneAttachments();
        } else {
          addPaneFiles([file]);
        }
        selectComposerPane(jid);
      },
    };

    const addPaneFiles = (fileList) => {
      let added = 0;
      for (const file of fileList) {
        if (!file) continue;
        const type = file.type || '';
        const isImage = type.startsWith('image/');
        const isAudio = type.startsWith('audio/');
        const isVideo = type.startsWith('video/');
        const ext = MIME_EXT_MAP[type] || type.split('/')[1]?.split('+')[0] || 'bin';
        const name = file.name || `pasted-${Date.now()}-${added}.${ext}`;
        pane.attachments.push({
          name,
          file,
          isImage,
          isAudio,
          isVideo,
          url: isImage || isAudio || isVideo ? URL.createObjectURL(file) : null,
        });
        added += 1;
      }
      if (added > 0) renderPaneAttachments();
    };

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      addPaneFiles(e.target.files);
      e.target.value = '';
    });

    pasteBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard?.read) {
          try {
            const items = await navigator.clipboard.read();
            const mediaFiles = [];
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              const fileType = item.types.find(
                (t) =>
                  t.startsWith('image/') ||
                  t.startsWith('audio/') ||
                  t.startsWith('video/') ||
                  (t.startsWith('application/') && !t.includes('json') && !t.includes('xml')),
              );
              if (fileType) {
                const blob = await item.getType(fileType);
                const ext = MIME_EXT_MAP[fileType] || fileType.split('/')[1]?.split('+')[0] || 'bin';
                mediaFiles.push(
                  new File([blob], `pasted-${Date.now()}-${i}.${ext}`, { type: fileType }),
                );
              }
            }
            if (mediaFiles.length > 0) {
              addPaneFiles(mediaFiles);
              showToast?.(formatPasteToast(mediaFiles));
              return;
            }
          } catch {
            // Fall through to readText
          }
        }
        if (navigator.clipboard?.readText) {
          const text = await navigator.clipboard.readText();
          if (text) {
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? textarea.value.length;
            textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
            textarea.selectionStart = textarea.selectionEnd = start + text.length;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.focus({ preventScroll: true });
            showToast?.('已貼上文字');
          } else {
            showToast?.('剪貼簿中沒有文字或多媒體內容');
          }
        }
      } catch {
        showToast?.('無法存取剪貼簿（請確認瀏覽器授權）');
      }
    });

    textarea.addEventListener('paste', (e) => {
      const items = [...(e.clipboardData?.items ?? [])];
      const files = items
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (files.length === 0) return;
      e.preventDefault();
      addPaneFiles(files);
      showToast?.(formatPasteToast(files));
    });

    // ── Per-pane BTW Side Workspace ──────────────────────────────────────────
    const sideBusy = () => pane.btwSending || pane.btwRemotePending;
    const syncPaneBtwControls = () => {
      const available = isPiBtwSession(jid);
      const isBtw = pane.btwTarget === 'btw';
      btwPendingRow.hidden = isBtw ? false : !available;
      const linkText = isBtw ? '‹ 主對話' : sideBusy() ? 'BTW 回答中 ›' : 'BTW ›';
      const linkLabel = isBtw ? '返回主對話' : sideBusy() ? '查看 BTW（回答中）' : '開啟 BTW';
      if (btwPendingLink.textContent !== linkText) btwPendingLink.textContent = linkText;
      if (btwPendingLink.getAttribute('aria-label') !== linkLabel) {
        btwPendingLink.setAttribute('aria-label', linkLabel);
      }
      if (sideBusy()) btwStatusSpan.textContent = 'BTW 回答中…';
      else if (pane.busy) btwStatusSpan.textContent = '主對話執行中 · 不會加入主對話';
      else btwStatusSpan.textContent = '不會加入主對話';
      btwStatusSpan.classList.toggle('btw-live', sideBusy() || pane.busy);
      btwClearBtn.disabled = sideBusy();
      paneEl.classList.toggle('pane-btw-active', isBtw);
      attachBtn.disabled = isBtw || pane.uploading;
      pasteBtn.disabled = isBtw || pane.uploading;
    };
    pane.syncBtwControls = syncPaneBtwControls;

    const setPaneBtwTarget = (next) => {
      if (next === pane.btwTarget) return;
      if (pane.btwTarget === 'main') {
        pane.btwMainDraft = textarea.value;
      } else {
        pane.btwSideDraft = textarea.value;
      }
      pane.btwTarget = next;
      const isBtw = next === 'btw';
      textarea.value = isBtw ? pane.btwSideDraft : pane.btwMainDraft;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      messagesEl.hidden = isBtw;
      btwMessagesEl.hidden = !isBtw;
      btwCard.hidden = !isBtw;
      if (isBtw) jumpBtn.classList.remove('visible');
      const s = getSessions().find((cand) => cand.jid === jid);
      textarea.placeholder = isBtw ? '問 BTW…' : `Message ${s?.name || 'pi'}…`;
      textarea.setAttribute('aria-label', isBtw ? `傳送至 BTW (${s?.name || jid})` : `Message ${s?.name || jid}`);
      sendBtn.setAttribute('aria-label', isBtw ? '傳送至 BTW' : `Send to ${s?.name || jid}`);
      if (isBtw) btwMessagesEl.scrollTop = btwMessagesEl.scrollHeight;
      syncPaneBtwControls();
    };

    const renderPaneBtwThread = (thread) => {
      const messages = (thread?.messages || []).filter(
        (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
      );
      const pending = (thread?.pending || []).filter((t) => typeof t === 'string' && t);
      const streaming = Array.isArray(thread?.streaming) ? thread.streaming : [];

      btwMessagesEl.replaceChildren(
        ...messages.map((m) =>
          buildEventNode({
            kind: 'message',
            role: m.role,
            content: m.content,
            createdAt: m.createdAt || new Date().toISOString(),
            files: [],
          }),
        ),
      );

      for (const qText of pending) {
        const qNode = buildEventNode({
          kind: 'message',
          role: 'user',
          content: qText,
          createdAt: new Date().toISOString(),
          files: [],
        });
        qNode.classList.add('btw-pending');
        btwMessagesEl.append(qNode);
        const streamItem = streaming.find((it) => it?.question === qText);
        if (streamItem?.answer) {
          const ansNode = buildEventNode({
            kind: 'message',
            role: 'assistant',
            content: streamItem.answer,
            createdAt: new Date().toISOString(),
            files: [],
          });
          ansNode.classList.add('partial', 'btw-streaming');
          btwMessagesEl.append(ansNode);
        } else {
          const wait = el('div', 'btw-waiting');
          wait.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span>BTW 回答中…</span>';
          btwMessagesEl.append(wait);
        }
      }
      pane.btwRemotePending = pending.length > 0;
      btwMessagesEl.scrollTop = btwMessagesEl.scrollHeight;
      syncPaneBtwControls();
    };

    const pollPaneBtw = async () => {
      clearTimeout(pane.btwPollTimer);
      pane.btwPollTimer = null;
      if (pane.disposed || !sideBusy()) return;
      try {
        const data = await api(`/api/sessions/${encodeURIComponent(jid)}/btw`);
        if (pane.disposed || !data?.available) return;
        pane.btwGeneration = data.generation || pane.btwGeneration;
        renderPaneBtwThread(data.thread);
        if (sideBusy()) {
          pane.btwPollTimer = setTimeout(pollPaneBtw, 700);
        }
      } catch {
        if (!pane.disposed && sideBusy()) {
          pane.btwPollTimer = setTimeout(pollPaneBtw, 2500);
        }
      }
    };

    const openPaneBtw = async () => {
      if (!isPiBtwSession(jid)) {
        showToast?.('BTW 僅支援 Pi 模型');
        return;
      }
      if (pane.attachments.length > 0 || pane.pendingQuote) {
        showToast?.('請先移除主對話附件或引用，再切到 BTW');
        return;
      }
      try {
        const data = await api(`/api/sessions/${encodeURIComponent(jid)}/btw`);
        if (pane.disposed) return;
        if (!data?.available) {
          showToast?.(data?.reason || '此執行模式尚未支援 BTW');
          return;
        }
        pane.btwGeneration = data.generation;
        renderPaneBtwThread(data.thread);
        setPaneBtwTarget('btw');
        if (sideBusy()) pane.btwPollTimer = setTimeout(pollPaneBtw, 700);
      } catch (err) {
        showToast?.(err.message || '無法開啟 BTW');
      }
    };

    btwBackBtn.addEventListener('click', () => setPaneBtwTarget('main'));
    btwPendingLink.addEventListener('click', () => {
      if (pane.btwTarget === 'btw') setPaneBtwTarget('main');
      else void openPaneBtw();
    });
    btwClearBtn.addEventListener('click', async () => {
      if (sideBusy() || !pane.btwGeneration) return;
      if (!confirm('清除這個 BTW 側聊的訊息與脈絡？主對話不受影響。')) return;
      try {
        const res = await api(`/api/sessions/${encodeURIComponent(jid)}/btw`, {
          method: 'POST',
          body: JSON.stringify({ action: 'clear', generation: pane.btwGeneration }),
        });
        if (res?.available) {
          btwMessagesEl.replaceChildren();
          showToast?.('BTW 已清除，主對話保持不變');
        }
      } catch (err) {
        showToast?.(err.message || 'BTW 清除失敗');
      }
    });

    // ── Per-pane Slash Command Autocomplete ──────────────────────────────────
    const hidePaneAutocomplete = () => {
      pane.ac = { open: false, items: [], index: 0, mode: null, command: null };
      acBox.hidden = true;
    };

    const applyPaneAutocomplete = (item) => {
      if (!item) return;
      if (pane.ac.mode === 'arg') {
        textarea.value = `/${pane.ac.command.name} ${item.name}`;
        hidePaneAutocomplete();
      } else {
        textarea.value = `/${item.name}${item.arg ? ' ' : ''}`;
        if (item.arg) updatePaneAutocomplete();
        else hidePaneAutocomplete();
      }
      textarea.focus({ preventScroll: true });
      autoGrow();
    };

    const renderPaneAutocomplete = () => {
      acBox.replaceChildren();
      acBox.hidden = false;
      acBox.append(el('div', 'ac-head', pane.ac.mode === 'arg' ? 'Values' : 'Commands'));
      pane.ac.items.forEach((item, i) => {
        const row = el('div', `ac-item${i === pane.ac.index ? ' sel' : ''}`);
        row.dataset.index = String(i);
        const name = el('div', 'ac-name');
        name.append(
          document.createTextNode(pane.ac.mode === 'arg' ? item.name : `/${item.name}`),
        );
        if (pane.ac.mode === 'command' && item.arg) {
          name.append(el('span', 'arg', ` [${item.arg.name}]`));
        }
        row.append(name);
        if (item.description) row.append(el('div', 'ac-desc', item.description));
        row.addEventListener('pointerdown', (e) => e.preventDefault());
        row.addEventListener('click', () => applyPaneAutocomplete(item));
        acBox.append(row);
      });
      const selected = acBox.querySelector('.ac-item.sel');
      if (selected) selected.scrollIntoView({ block: 'nearest' });
    };

    const updatePaneAutocomplete = () => {
      if (pane.btwTarget === 'btw') return hidePaneAutocomplete();
      const value = textarea.value;
      if (!value.startsWith('/')) return hidePaneAutocomplete();
      const commands = getCommands() || [];
      const models = getModels() || [];
      const raw = value.slice(1);
      const command = commands
        .filter((c) => raw.startsWith(`${c.name} `))
        .sort((a, b) => b.name.length - a.name.length)[0];

      if (command && command.arg) {
        const partial = raw.slice(command.name.length).trim().toLowerCase();
        let options = [];
        if (command.arg.kind === 'model') {
          options = models
            .map((m) => m.ref)
            .filter((ref) => ref.toLowerCase().includes(partial))
            .slice(0, 40);
        } else if (command.arg.kind === 'thinking') {
          options = THINKING_LEVELS.filter((level) => level.startsWith(partial));
        }
        if (options.length > 0) {
          pane.ac = {
            open: true,
            mode: 'arg',
            command,
            items: options.map((val) => ({ name: val, description: '' })),
            index: 0,
          };
          return renderPaneAutocomplete();
        }
        return hidePaneAutocomplete();
      }

      const query = raw.toLowerCase();
      const items = commands.filter((c) => c.name.toLowerCase().includes(query));
      if (items.length === 0) return hidePaneAutocomplete();
      pane.ac = { open: true, mode: 'command', items, index: 0, command: null };
      renderPaneAutocomplete();
    };

    // ── Composer Input & Submit ──────────────────────────────────────────────
    let hadFocusBeforeSend = false;
    sendBtn.addEventListener('pointerdown', (e) => {
      hadFocusBeforeSend = document.activeElement === textarea;
      if (hadFocusBeforeSend) {
        e.preventDefault();
      }
    });

    const autoGrow = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(140, textarea.scrollHeight)}px`;
    };
    voiceIme?.register(textarea, { frame: form, before: sendBtn, onRender: autoGrow });
    textarea.addEventListener('input', () => {
      autoGrow();
      updatePaneAutocomplete();
    });
    textarea.addEventListener('focus', () => {
      paneEl.classList.add('pane-focused');
    });
    textarea.addEventListener('blur', () => {
      paneEl.classList.remove('pane-focused');
    });

    let compositionEndedAt = 0;
    textarea.addEventListener('compositionstart', () => {
      compositionEndedAt = 0;
    });
    textarea.addEventListener('compositionend', () => {
      compositionEndedAt = Date.now();
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && Date.now() - compositionEndedAt < 100) return;

      if (pane.ac.open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          pane.ac.index =
            (pane.ac.index + delta + pane.ac.items.length) % pane.ac.items.length;
          renderPaneAutocomplete();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          applyPaneAutocomplete(pane.ac.items[pane.ac.index]);
          return;
        }
        if (e.key === 'Escape') {
          hidePaneAutocomplete();
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (pane.uploading) return;
      const keepKeyboardOpen = hadFocusBeforeSend || document.activeElement === textarea;
      hadFocusBeforeSend = false;
      // Voice input: the last sentence and its clean-up land first.
      const voiced = await voiceIme?.take(textarea);
      if (voiced != null) textarea.value = voiced;

      // BTW Side Conversation Submit
      if (pane.btwTarget === 'btw') {
        const text = textarea.value.trim();
        if (!text || sideBusy() || !pane.btwGeneration) return;
        pane.btwSending = true;
        pane.btwSideDraft = '';
        textarea.value = '';
        autoGrow();
        syncPaneBtwControls();

        const qNode = buildEventNode({
          kind: 'message',
          role: 'user',
          content: text,
          createdAt: new Date().toISOString(),
          files: [],
        });
        qNode.classList.add('btw-pending');
        const wait = el('div', 'btw-waiting');
        wait.innerHTML =
          '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span>BTW 回答中…</span>';
        btwMessagesEl.append(qNode, wait);
        btwMessagesEl.scrollTop = btwMessagesEl.scrollHeight;
        pane.btwPollTimer = setTimeout(pollPaneBtw, 450);

        try {
          const response = await api(`/api/sessions/${encodeURIComponent(jid)}/btw`, {
            method: 'POST',
            body: JSON.stringify({ text, generation: pane.btwGeneration }),
          });
          if (!pane.disposed && response?.thread) {
            renderPaneBtwThread(response.thread);
          }
        } catch (err) {
          if (!pane.disposed) {
            if (!textarea.value.trim()) {
              textarea.value = text;
              autoGrow();
            }
            showToast?.(err.message || 'BTW 送出失敗，草稿已保留');
          }
        } finally {
          pane.btwSending = false;
          syncPaneBtwControls();
        }
        return;
      }

      // Main Conversation Submit (supports text, quote, attachments, slash commands)
      const rawDraft = textarea.value;
      const text = rawDraft.trim();
      const quote = pane.pendingQuote;
      const submittedAttachments = [...pane.attachments];

      if (!text && !quote && submittedAttachments.length === 0) {
        if (keepKeyboardOpen) textarea.focus({ preventScroll: true });
        return;
      }
      // Keep an oversized file in the pane rather than failing after upload.
      const limitProblem = attachmentLimitProblem(submittedAttachments, {
        compressImages: compressionCheckbox.checked,
      });
      if (limitProblem) {
        alert(limitProblem);
        return;
      }

      textarea.value = '';
      pane.pendingQuote = '';
      pane.attachments = [];
      renderPaneQuote();
      renderPaneAttachments();
      hidePaneAutocomplete();
      autoGrow();
      if (keepKeyboardOpen && document.activeElement !== textarea) {
        textarea.focus({ preventScroll: true });
      }

      if (!quote && text.startsWith('/') && submittedAttachments.length === 0) {
        const handled = await trySendCommand(text, jid);
        if (handled) return;
      }

      const hasAttachments = submittedAttachments.length > 0;
      const compressImages = compressionCheckbox.checked;
      if (hasAttachments) {
        pane.uploading = true;
        sendBtn.disabled = true;
        attachBtn.disabled = true;
        pasteBtn.disabled = true;
        showUploadProgress(paneUploadProgress, 0);
      }

      let result = null;
      try {
        const attachmentsPayload = [];
        for (const attachment of submittedAttachments) {
          const prepared = await prepareImageUpload(attachment.file, compressImages);
          if (prepared.warning) showToast?.(`${prepared.warning}：${attachment.name}`);
          attachmentsPayload.push({
            name: prepared.resized ? prepared.file.name : attachment.name,
            dataBase64: await fileToBase64(prepared.file),
          });
        }

        const path = `/api/sessions/${encodeURIComponent(jid)}/messages`;
        const payload = { text, quote, attachments: attachmentsPayload };
        result =
          hasAttachments && typeof sendJsonWithUploadProgress === 'function'
            ? await sendJsonWithUploadProgress(path, payload, {
                onProgress: (pct) => showUploadProgress(paneUploadProgress, pct),
              })
            : await api(path, {
                method: 'POST',
                body: JSON.stringify(payload),
              });

        const eventId = result?.eventId || pane.cursor + 1;
        const uploadedFiles =
          Array.isArray(result?.files) && result.files.length > 0
            ? result.files
            : submittedAttachments.map((a) => a.url).filter(Boolean);

        if (eventId > pane.cursor) {
          appendPaneEvent(
            pane,
            {
              id: eventId,
              kind: 'message',
              role: 'user',
              content: quote ? `> ${quote.replace(/\n/g, '\n> ')}\n\n${text}` : text,
              files: uploadedFiles,
              createdAt: new Date().toISOString(),
            },
            true,
          );
        }
        if (result?.sessionTitle) {
          onApplySessionTitle(jid, result.sessionTitle);
        }
        scrollToBottom(true);
      } catch (err) {
        if (!textarea.value) {
          textarea.value = rawDraft;
          autoGrow();
        }
        if (!pane.pendingQuote && quote) {
          pane.pendingQuote = quote;
          renderPaneQuote();
        }
        alert(err.message);
      } finally {
        for (const attachment of submittedAttachments) {
          if (attachment.url && (!result?.files || result.files.length === 0)) {
            setTimeout(() => URL.revokeObjectURL(attachment.url), 10000);
          } else if (attachment.url) {
            URL.revokeObjectURL(attachment.url);
          }
        }
        if (hasAttachments) {
          pane.uploading = false;
          sendBtn.disabled = false;
          attachBtn.disabled = pane.btwTarget === 'btw';
          pasteBtn.disabled = pane.btwTarget === 'btw';
          hideUploadProgress(paneUploadProgress);
        }
      }
    });

    return pane;
  }

  function syncPaneHeader(pane) {
    const session = getSessions().find((s) => s.jid === pane.jid);
    if (session) {
      if (pane.nameInput.hidden) {
        pane.nameEl.textContent = session.name || pane.jid;
      }
      if (pane.btwTarget !== 'btw') {
        pane.textarea.placeholder = `Message ${session.name || 'pi'}…`;
      }
      const badge = getSessionBadge(session);
      if (badge) {
        pane.badgeEl.hidden = false;
        pane.badgeEl.className = `provider-badge ${badge.kind}`;
        pane.badgeEl.textContent = badge.label;
      } else {
        pane.badgeEl.hidden = true;
      }
      const thinkingLevel = session.thinking || '';
      pane.thinkingBtn.dataset.level = thinkingLevel || 'default';
      const tLabel = thinkingLevel || 'runtime default';
      pane.thinkingBtn.title = `Thinking: ${tLabel}`;
      pane.thinkingBtn.setAttribute('aria-label', `Choose thinking level. Current: ${tLabel}`);
    }
    const usageCmd = usageCommandForSession(pane.jid);
    pane.usageBtn.title = `/${usageCmd}`;
    const uLabel =
      usageCmd === 'claude-usage' ? 'Claude' : usageCmd === 'agy-usage' ? 'agy' : 'GPT';
    pane.usageBtn.setAttribute('aria-label', `Show ${uLabel} usage`);

    const busy = Boolean(pane.busy || session?.busy);
    pane.el.classList.toggle('pane-busy', busy);
    pane.spinnerEl.hidden = !busy;
    pane.stopBtn.hidden = !busy;
    pane.typingEl.hidden = !busy || pane.btwTarget === 'btw';
    pane.splitDownBtn.hidden = allJids().length < 2;
    pane.syncBtwControls?.();
  }

  function shouldFollowPane(pane) {
    if (!isAutoScrollEnabled()) return false;
    if (pane.userScrolledUp) return false;
    return (
      pane.messagesEl.scrollHeight - pane.messagesEl.scrollTop - pane.messagesEl.clientHeight <= 28
    );
  }

  function appendPaneEvent(pane, event, live = false) {
    pane.cursor = Math.max(pane.cursor, event.id || 0);
    const follow = live ? shouldFollowPane(pane) : false;

    if (live && pane.partialMsgEl && event.kind === 'message' && event.role !== 'user') {
      pane.partialMsgEl.remove();
      pane.partialMsgEl = null;
    }
    if (live && pane.partialThinkingEl && event.kind === 'thinking') {
      pane.partialThinkingEl.remove();
      pane.partialThinkingEl = null;
    }

    const existing = event.id ? pane.messagesEl.querySelector(`[data-event-id="${event.id}"]`) : null;
    if (existing) {
      const node = buildEventNode(event, { liveRich: false });
      node.dataset.eventId = String(event.id);
      existing.replaceWith(node);
      if (follow) {
        pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
        pane.jumpBtn.classList.remove('visible');
      }
      return;
    }

    const node = buildEventNode(event, { liveRich: false });
    node.dataset.eventId = String(event.id);
    if (pane.partialMsgEl) {
      pane.messagesEl.insertBefore(node, pane.partialMsgEl);
    } else {
      pane.messagesEl.append(node);
    }

    if (follow) {
      if (!pane.scrollRafPending) {
        pane.scrollRafPending = true;
        requestAnimationFrame(() => {
          pane.scrollRafPending = false;
          if (pane.disposed || pane.userScrolledUp) return;
          pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
          pane.jumpBtn.classList.remove('visible');
        });
      }
    } else if (live) {
      const near =
        pane.messagesEl.scrollHeight - pane.messagesEl.scrollTop - pane.messagesEl.clientHeight <=
        28;
      pane.jumpBtn.classList.toggle('visible', !near && pane.btwTarget === 'main');
    }
  }

  function renderPanePartial(pane, text = '', thinking = '') {
    const follow = shouldFollowPane(pane);

    if (!thinking) {
      if (pane.partialThinkingEl) {
        pane.partialThinkingEl.remove();
        pane.partialThinkingEl = null;
      }
    } else {
      if (!pane.partialThinkingEl) {
        const node = el('details', 'event thinking partial');
        const summary = el('summary');
        summary.append(el('span', 'event-chevron', '›'), el('span', 'label', '💭 Thinking…'));
        const bodyWrap = el('div', 'event-body-wrap');
        bodyWrap.append(el('div', 'event-body'));
        node.append(summary, bodyWrap);
        pane.partialThinkingEl = node;
        pane.messagesEl.insertBefore(node, pane.partialMsgEl);
      }
      void streamRich(pane.partialThinkingEl.querySelector('.event-body'), thinking, {
        complete: false,
      });
    }

    if (!text) {
      if (pane.partialMsgEl) {
        pane.partialMsgEl.remove();
        pane.partialMsgEl = null;
      }
    } else {
      if (!pane.partialMsgEl) {
        const node = el('div', 'msg partial');
        const body = el('div', 'msg-body');
        body.append(el('div', 'msg-text'));
        node.append(body);
        pane.partialMsgEl = node;
        pane.messagesEl.append(node);
      }
      void streamRich(
        pane.partialMsgEl.querySelector('.msg-text'),
        text.replace(/\n{3,}/g, '\n\n'),
        { complete: false },
      );
    }

    if (follow) {
      if (!pane.scrollRafPending) {
        pane.scrollRafPending = true;
        requestAnimationFrame(() => {
          pane.scrollRafPending = false;
          if (pane.disposed || pane.userScrolledUp) return;
          pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
        });
      }
    } else {
      const near =
        pane.messagesEl.scrollHeight - pane.messagesEl.scrollTop - pane.messagesEl.clientHeight <=
        28;
      pane.jumpBtn.classList.toggle('visible', !near && pane.btwTarget === 'main');
    }
  }

  function connectPaneStream(pane) {
    if (pane.source) {
      pane.source.close();
      pane.source = null;
    }
    clearTimeout(pane.reconnectTimer);
    if (pane.disposed || !active) return;

    const source = new EventSource(
      `/api/sessions/${encodeURIComponent(pane.jid)}/stream?after=${pane.cursor}`,
    );
    pane.source = source;

    source.addEventListener('event', (e) => {
      if (pane.disposed || pane.source !== source) return;
      const event = JSON.parse(e.data);
      const existing = event.id ? pane.messagesEl.querySelector(`[data-event-id="${event.id}"]`) : null;
      if (event.id <= pane.cursor && !existing) return;
      appendPaneEvent(pane, event, true);
      if (
        event.kind !== 'thinking' &&
        event.kind !== 'narration' &&
        event.kind !== 'tool' &&
        event.kind !== 'tool_result' &&
        event.role !== 'user'
      ) {
        onMarkSeen(pane.jid, event.id);
      }
    });

    source.addEventListener('busy', (e) => {
      if (pane.disposed || pane.source !== source) return;
      pane.busy = Boolean(JSON.parse(e.data)?.busy);
      syncPaneHeader(pane);
    });

    source.addEventListener('partial', (e) => {
      if (pane.disposed || pane.source !== source) return;
      const data = JSON.parse(e.data);
      renderPanePartial(pane, data?.content ?? '', data?.thinking ?? '');
    });

    source.addEventListener('error', () => {
      if (pane.disposed || pane.source !== source) return;
      source.close();
      pane.source = null;
      pane.reconnectTimer = setTimeout(() => {
        if (!pane.disposed && active) connectPaneStream(pane);
      }, 2000);
    });
  }

  function scrollPaneToLatest(pane) {
    if (!pane || pane.disposed) return;
    pane.userScrolledUp = false;
    pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
    pane.jumpBtn.classList.remove('visible');
    requestAnimationFrame(() => {
      if (pane.disposed || pane.userScrolledUp) return;
      pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
      pane.jumpBtn.classList.remove('visible');
    });
  }

  /** The transcript was replaced by `events`: page older history from its
   *  first event, behind a top row that says whether there is more. */
  function resetPaneHistory(pane, events, hasMore) {
    pane.historyGeneration++;
    pane.loadingOlder = false;
    pane.oldest = events?.[0]?.id || 0;
    pane.hasMoreOlder = Boolean(hasMore && pane.oldest);
    let sentinel = pane.messagesEl.querySelector(':scope > .top-sentinel');
    if (!sentinel) {
      sentinel = el('div', 'top-sentinel');
      sentinel.addEventListener('click', () => void loadPaneOlder(pane));
      pane.messagesEl.prepend(sentinel);
    }
    setPaneSentinel(pane, pane.hasMoreOlder ? 'more' : 'start');
  }

  function setPaneSentinel(pane, mode) {
    const sentinel = pane.messagesEl.querySelector(':scope > .top-sentinel');
    if (!sentinel) return;
    sentinel.textContent =
      mode === 'loading'
        ? 'Loading older messages…'
        : mode === 'more'
          ? 'Load older messages'
          : 'Beginning of this session';
    sentinel.className = `top-sentinel${mode === 'start' ? ' start' : ''}`;
  }

  /** Prepend one page of older events, keeping the text under the reader's
   *  eyes where it was (as the single-session view does). */
  async function loadPaneOlder(pane) {
    if (pane.disposed || pane.loadingOlder || !pane.hasMoreOlder || !pane.oldest) return;
    const generation = pane.historyGeneration;
    const current = () => !pane.disposed && pane.historyGeneration === generation;
    pane.loadingOlder = true;
    setPaneSentinel(pane, 'loading');
    try {
      const { events = [], hasMore } = await api(
        `/api/sessions/${encodeURIComponent(pane.jid)}/events?before=${pane.oldest}&limit=${PANE_PAGE_SIZE}`,
      );
      if (!current()) return;
      const messages = pane.messagesEl;
      const sentinel = messages.querySelector(':scope > .top-sentinel');
      const viewportTop = messages.getBoundingClientRect().top;
      const anchor = Array.from(messages.children).find(
        (node) => node !== sentinel && node.getBoundingClientRect().bottom > viewportTop + 1,
      );
      const anchorTop = anchor?.getBoundingClientRect().top;
      const heightBefore = messages.scrollHeight;
      const topBefore = messages.scrollTop;
      // The prepend is compensated below; native scroll anchoring would add a
      // second correction mid-momentum.
      const overflowAnchor = messages.style.overflowAnchor;
      messages.style.overflowAnchor = 'none';
      requestAnimationFrame(() => {
        messages.style.overflowAnchor = overflowAnchor;
      });
      const frag = document.createDocumentFragment();
      for (const event of events) {
        if (event.id && messages.querySelector(`[data-event-id="${event.id}"]`)) continue;
        const node = buildEventNode(event, { liveRich: false });
        node.dataset.eventId = String(event.id);
        frag.append(node);
      }
      messages.insertBefore(frag, sentinel ? sentinel.nextSibling : messages.firstChild);
      if (events.length) pane.oldest = events[0].id;
      pane.hasMoreOlder = Boolean(hasMore) && events.length > 0;
      if (anchor?.isConnected && anchorTop != null) {
        messages.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      } else {
        messages.scrollTop = topBefore + (messages.scrollHeight - heightBefore);
      }
    } catch {
      // Leave the row tappable for another try.
    } finally {
      if (current()) {
        pane.loadingOlder = false;
        setPaneSentinel(pane, pane.hasMoreOlder ? 'more' : 'start');
      }
    }
  }

  async function hydratePane(pane) {
    try {
      const { events, busy, partial, session, hasMore } = await api(
        `/api/sessions/${encodeURIComponent(pane.jid)}/events?limit=${PANE_PAGE_SIZE}`,
      );
      if (pane.disposed) return;
      pane.messagesEl.replaceChildren();
      pane.partialThinkingEl = null;
      pane.partialMsgEl = null;
      pane.cursor = 0;
      for (const ev of events || []) {
        appendPaneEvent(pane, ev, false);
      }
      resetPaneHistory(pane, events, hasMore);
      pane.busy = Boolean(busy);
      if (session?.name && pane.nameInput.hidden) pane.nameEl.textContent = session.name;
      syncPaneHeader(pane);
      if (partial?.content || partial?.thinking) {
        renderPanePartial(pane, partial.content ?? '', partial.thinking ?? '');
      }
      if (events?.length) {
        onMarkSeen(pane.jid, events[events.length - 1].id);
      }
      scrollPaneToLatest(pane);
      connectPaneStream(pane);
    } catch {
      if (!pane.disposed) {
        pane.messagesEl.replaceChildren(
          el('div', 'empty-note', '無法載入此 Session（可能已被刪除）。'),
        );
      }
    }
  }

  // ── Floating composer ─────────────────────────────────────────────────────
  /**
   * Move the floating input to `jid`'s pane. The card takes its own row under
   * the transcript (the transcript shrinks; nothing scrolls behind it), and a
   * reader already at the bottom stays there. With `animate`, a copy of the card hops
   * from the old pane to the new one in an arc (it must fly above the grid:
   * panes clip their own overflow).
   */
  function selectComposerPane(jid, { animate = true } = {}) {
    const pane = panes.get(jid);
    if (!pane) return;
    if (composerJid === jid && pane.dock.classList.contains('is-floating')) return;
    const prev = composerJid && composerJid !== jid ? panes.get(composerJid) : null;
    const from =
      animate && prev?.dock.classList.contains('is-floating') && prev.el.isConnected
        ? prev.dock.getBoundingClientRect()
        : null;
    let ghost = null;
    if (from && from.width > 0 && !prefersReducedMotion()) {
      dockGhost?.el.remove();
      ghost = prev.dock.cloneNode(true);
      const typed = prev.dock.querySelector('textarea');
      const ghostInput = ghost.querySelector('textarea');
      if (typed && ghostInput) ghostInput.value = typed.value;
      ghost.classList.remove('is-floating', 'dock-arriving');
      ghost.classList.add('dashboard-dock-ghost');
      ghost.setAttribute('aria-hidden', 'true');
    }

    const keepBottom = isNearBottom(pane.messagesEl);
    const prevDockH = prev?.el.isConnected ? prev.dock.offsetHeight : 0;
    const restDockH = pane.dock.offsetHeight; // its typing line, before the card
    for (const p of panes.values()) {
      const on = p.jid === jid;
      p.el.classList.toggle('composer-active', on);
      p.dock.classList.toggle('is-floating', on);
    }
    composerJid = jid;
    voiceIme?.retarget();
    try {
      localStorage.setItem(COMPOSER_PANE_KEY, jid);
    } catch {
      // Not persisted; the in-memory choice still holds.
    }
    if (keepBottom) pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
    // With the keyboard up the card lands already clear of it.
    syncKeyboardLift({ instant: true });

    if (!ghost) return;
    const to = pane.dock.getBoundingClientRect();
    if (!to.width) return;
    // The ghost sits on the landing rect and flies in by transform alone, so
    // the compositor runs the hop at the display's refresh rate (120Hz on
    // ProMotion) instead of re-laying out every frame on the main thread.
    Object.assign(ghost.style, {
      left: `${to.left}px`,
      top: `${to.top}px`,
      width: `${to.width}px`,
      height: `${to.height}px`,
    });
    document.body.append(ghost);
    dockGhost = { el: ghost, jid };
    pane.dock.classList.add('dock-arriving');
    // Both transcripts change height with the hop instead of jumping: the card's
    // row opens under the new pane's messages (a reader at the bottom is pushed
    // up with it, see transcriptObserver) and closes in the pane it left.
    const ease = 'cubic-bezier(0.25, 0.8, 0.3, 1)';
    pane.dock.animate(
      [{ height: `${restDockH}px`, marginTop: '0px', marginBottom: '0px' }, { height: `${to.height}px` }],
      { duration: 380, easing: ease },
    );
    const prevRestH = prev.dock.offsetHeight;
    if (prevDockH > prevRestH) {
      prev.dock.animate([{ height: `${prevDockH + 10}px` }, { height: `${prevRestH}px` }], {
        duration: 380,
        easing: ease,
      });
    }
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = from.width / to.width;
    const sy = from.height / (to.height || from.height);
    const lift = Math.min(56, 18 + Math.hypot(dx, dy) * 0.1);
    const midY = Math.min(from.top, to.top) - lift - to.top;
    const flight = ghost.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        {
          transform: `translate(${dx / 2}px, ${midY}px) scale(${((sx + 1) / 2) * 1.03}, ${((sy + 1) / 2) * 1.03})`,
          offset: 0.45,
        },
        { transform: 'none' },
      ],
      { duration: 380, easing: 'cubic-bezier(0.3, 0.9, 0.35, 1.05)', fill: 'forwards' },
    );
    const land = () => {
      ghost.remove();
      if (dockGhost?.el === ghost) dockGhost = null;
      pane.dock.classList.remove('dock-arriving');
    };
    flight.onfinish = land;
    flight.oncancel = land;
  }

  /** Keyboard up: the panes keep their places and the keyboard covers what is
   *  under it. Only the input card moves, and only as far as it must to clear
   *  the keyboard (iPhone recording 2026-10-22: shrinking the whole Dashboard
   *  to the visible strip crushed both stacked panes to a line or two). */
  function syncKeyboardLift({ instant = false } = {}) {
    const vv = window.visualViewport;
    // viewport-shell.js decides whether the keyboard is up (a short visual
    // viewport AND typing focus: iOS 26 can leave the viewport short after
    // the keyboard closes).
    const keyboard = vv && document.documentElement.classList.contains('keyboard-shell');
    const target = active && keyboard && composerJid ? panes.get(composerJid) : null;
    for (const pane of panes.values()) {
      let lift = 0;
      if (pane === target && !pane.disposed && pane.dock.classList.contains('is-floating')) {
        // Measured against the shell, not visualViewport.offsetTop: the shell
        // is pinned to the top of the visible strip, so the strip is
        // [0, vv.height] in its coordinates. While iOS animates the keyboard,
        // offsetTop and the shell's position disagree for a moment, and the
        // card flew ~100px too high before settling (iPhone recording
        // 2026-10-22).
        const rect = pane.dock.getBoundingClientRect();
        const shellTop = app.getBoundingClientRect().top;
        const current = pane.kbLift || 0;
        // Just above the keyboard, but never past the top of the visible strip.
        const need = rect.bottom - shellTop + current - (vv.height - 6);
        const room = rect.top - shellTop + current - 8;
        lift = Math.round(Math.max(0, Math.min(need, room)));
      }
      if (lift === (pane.kbLift || 0)) continue;
      pane.kbLift = lift;
      if (instant) pane.dock.style.transition = 'none';
      pane.dock.style.setProperty('--kb-lift', `${lift}px`);
      clearTimeout(pane.kbLiftTimer);
      if (lift > 0) pane.el.classList.add('kb-lifted');
      // Stay unclipped while the card slides back down into its pane.
      else if (instant) pane.el.classList.remove('kb-lifted');
      else pane.kbLiftTimer = setTimeout(() => pane.el.classList.remove('kb-lifted'), 260);
      if (instant) {
        pane.dock.getBoundingClientRect();
        pane.dock.style.transition = '';
      }
    }
  }

  /** Keep the floating input on a pane that exists (after add/remove/reload). */
  function ensureComposerPane() {
    const jids = allJids();
    if (jids.length === 0) return;
    const target = jids.includes(composerJid) ? composerJid : jids[0];
    selectComposerPane(target, { animate: false });
    // A rebuilt or resized layout moves the card relative to the keyboard.
    requestAnimationFrame(() => syncKeyboardLift());
  }

  function disposePane(jid) {
    const pane = panes.get(jid);
    if (!pane) return;
    pane.disposed = true;
    voiceIme?.unregister(pane.textarea);
    transcriptObserver?.unobserve(pane.messagesEl);
    paneSizeObserver?.unobserve(pane.el);
    paneSizeObserver?.unobserve(pane.el.querySelector('.dashboard-pane-header'));
    paneSizeObserver?.unobserve(pane.el.querySelector('.dashboard-pane-dock'));
    if (dockGhost?.jid === jid) dockGhost.el.getAnimations().forEach((a) => a.cancel());
    if (pane.source) {
      pane.source.close();
      pane.source = null;
    }
    clearTimeout(pane.reconnectTimer);
    clearTimeout(pane.btwPollTimer);
    for (const att of pane.attachments || []) {
      if (att.url) URL.revokeObjectURL(att.url);
    }
    pane.el.remove();
    panes.delete(jid);
  }

  let activeResizerCount = 0;

  // ── 2D Layout & Both Horizontal and Vertical Splitters ─────────────────────
  // ── Inertial Spring Physics & Collision Bounce Engine ─────────────────────

  // ── Analytical Damped Harmonic Oscillator (120Hz ProMotion Spring Physics) ─
  function solveSpringProgress(t, zeta = 0.52, omega0 = 18.0) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const c = zeta / Math.sqrt(1 - zeta * zeta);
    const tau = t * 0.52;
    return 1 - Math.exp(-zeta * omega0 * tau) * (Math.cos(omegaD * tau) + c * Math.sin(omegaD * tau));
  }

  function triggerWallImpactBounce(targetEl, axis, sign, intensity = 1) {
    if (!targetEl || prefersReducedMotion()) return;
    try {
      const k = Math.max(0.6, Math.min(1.8, intensity));
      const peakShift = Math.round(14 * k) * sign;
      const keyframes = [];
      const steps = 30;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = solveSpringProgress(t, 0.58, 20.0);
        const shift = (peakShift * (1 - p)).toFixed(2);
        const tx = axis === 'x' ? `${shift}px` : '0px';
        const ty = axis === 'y' ? `${shift}px` : '0px';
        const scaleVal = (1 - 0.03 * k * (1 - p)).toFixed(3);
        const sx = axis === 'x' ? scaleVal : '1';
        const sy = axis === 'y' ? scaleVal : '1';
        keyframes.push({
          transform: `translate3d(${tx}, ${ty}, 0) scale(${sx}, ${sy})`,
          offset: t,
        });
      }
      targetEl.getAnimations?.().forEach((a) => a.cancel());
      targetEl.animate(keyframes, {
        duration: 440,
        easing: 'linear',
      });
    } catch {
      // Ignore Web Animations API errors on detached nodes
    }
  }

  /** `lift` names a pane that starts from `from` (where a pinch left it, larger
   *  than its tile) and is drawn over its neighbours, unclipped, until it lands. */
  function animatePaneLayoutTransition(mutateLayoutFn, { lift = null, from = null } = {}) {
    // Moving, adding or re-tiling panes is about the tiles: show them all.
    if (zoomedJid) setZoom(null, { instant: true });
    const lifted = lift ? panes.get(lift) : null;
    const land = () => {
      if (!lifted) return;
      gridEl.classList.remove('zoom-moving');
      markZoomPath(zoomedJid);
      lifted.el.style.transformOrigin = '';
    };
    if (!active || prefersReducedMotion() || gridEl.hidden) {
      mutateLayoutFn();
      land();
      return;
    }

    // 1. FIRST: record current bounding boxes of all visible panes
    const firstRects = new Map();
    for (const [jid, pane] of panes.entries()) {
      if (gridEl.contains(pane.el)) {
        const r = pane.el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          firstRects.set(jid, r);
        }
      }
    }

    if (lifted && from) firstRects.set(lift, from);

    // 2. Execute layout mutation & DOM update
    mutateLayoutFn();
    if (lifted) {
      markZoomPath(lift);
      gridEl.classList.add('zoom-moving');
    }

    // 3. LAST + INVERT + PLAY with pronounced analytical 120Hz inertial spring bounce
    for (const [jid, pane] of panes.entries()) {
      if (!gridEl.contains(pane.el)) continue;
      const lastRect = pane.el.getBoundingClientRect();
      if (lastRect.width <= 0 || lastRect.height <= 0) continue;
      const firstRect = firstRects.get(jid);

      try {
        pane.el.getAnimations?.().forEach((anim) => anim.cancel());
        if (firstRect) {
          const dx = firstRect.left - lastRect.left;
          const dy = firstRect.top - lastRect.top;
          const dw = firstRect.width - lastRect.width;
          const dh = firstRect.height - lastRect.height;
          if (Math.hypot(dx, dy) < 2 && Math.hypot(dw, dh) < 2) continue;

          const sx = Math.max(0.25, Math.min(3.5, firstRect.width / lastRect.width));
          const sy = Math.max(0.25, Math.min(3.5, firstRect.height / lastRect.height));
          const signX = dx === 0 ? (dw > 0 ? -1 : 1) : -Math.sign(dx);
          const signY = dy === 0 ? (dh > 0 ? -1 : 1) : -Math.sign(dy);
          const overX =
            Math.abs(dx) > 4
              ? Math.max(-28, Math.min(28, -dx * 0.14))
              : Math.abs(dw) > 8
                ? signX * Math.min(18, Math.abs(dw) * 0.12)
                : 0;
          const overY =
            Math.abs(dy) > 4
              ? Math.max(-28, Math.min(28, -dy * 0.14))
              : Math.abs(dh) > 8
                ? signY * Math.min(18, Math.abs(dh) * 0.12)
                : 0;

          const keyframes = [];
          const steps = 36;
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const p = solveSpringProgress(t, 0.52, 18.0);
            const curX = (dx * (1 - p) + overX * Math.sin(t * Math.PI)).toFixed(2);
            const curY = (dy * (1 - p) + overY * Math.sin(t * Math.PI)).toFixed(2);
            const curSx = (1 + (sx - 1) * (1 - p)).toFixed(3);
            const curSy = (1 + (sy - 1) * (1 - p)).toFixed(3);
            keyframes.push({
              transform: `translate3d(${curX}px, ${curY}px, 0) scale(${curSx}, ${curSy})`,
              offset: t,
            });
          }

          pane.el.style.transformOrigin = '0 0';
          const anim = pane.el.animate(keyframes, {
            duration: 480,
            easing: 'linear',
          });
          anim.onfinish = () => {
            pane.el.style.transformOrigin = '';
          };
          if (pane === lifted) anim.oncancel = anim.onfinish = land;
        } else {
          // Newly added pane: pop in with spring collision bounce
          const popKeyframes = [];
          const popSteps = 30;
          for (let i = 0; i <= popSteps; i++) {
            const t = i / popSteps;
            const p = solveSpringProgress(t, 0.52, 18.0);
            const curS = (0.84 + 0.16 * p).toFixed(3);
            const curOp = Math.min(1, 0.35 + 0.65 * (t * 2.5)).toFixed(2);
            popKeyframes.push({
              transform: `scale(${curS})`,
              opacity: curOp,
              offset: t,
            });
          }
          pane.el.animate(popKeyframes, {
            duration: 440,
            easing: 'linear',
          });
        }
      } catch {
        // Ignore animation errors in headless/unsupported environments
      }
    }
    if (lifted && !lifted.el.getAnimations?.().length) land();
  }

  function createAxisSplitter({
    axis, // 'x' (vertical bar resizing width) or 'y' (horizontal bar resizing height)
    label,
    firstEl,
    secondEl,
    getWeights,
    setWeights,
    // Optional: the whole row/column this splitter sits in, so a drag can push
    // past a pane at its minimum into the next one ({ index, els, weights, set }).
    getChain,
  }) {
    const isHorizontalDrag = axis === 'x';
    const splitter = el(
      'div',
      `dashboard-splitter ${isHorizontalDrag ? 'splitter-vertical' : 'splitter-horizontal'}`,
    );
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', isHorizontalDrag ? 'vertical' : 'horizontal');
    splitter.setAttribute('aria-label', label);
    splitter.tabIndex = 0;
    splitter.title = isHorizontalDrag
      ? '左右拖拉調整視窗寬度（雙擊平均對齊）'
      : '上下拖拉調整視窗高度（雙擊平均對齊）';
    splitter.innerHTML = '<span class="dashboard-splitter-grip" aria-hidden="true"></span>';

    let activeSpringCleanup = null;
    const cancelSpring = () => {
      splitter.getAnimations?.().forEach((a) => a.cancel());
      firstEl?.getAnimations?.().forEach((a) => a.cancel());
      secondEl?.getAnimations?.().forEach((a) => a.cancel());
      if (activeSpringCleanup) {
        activeSpringCleanup();
        activeSpringCleanup = null;
      }
      gridEl.classList.remove('spring-bouncing');
    };

    const equalizePair = () => {
      cancelSpring();
      animatePaneLayoutTransition(() => {
        const [w1, w2] = getWeights();
        const avg = (w1 + w2) / 2;
        setWeights(avg, avg);
        saveState();
      });
    };

    splitter.addEventListener('dblclick', equalizePair);

    // Prevent iOS/iPadOS Safari from claiming touch gestures as page/rubber-band scroll
    splitter.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 1) e.preventDefault();
      },
      { passive: false },
    );

    let lastTapTime = 0;
    splitter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (!firstEl || !secondEl) return;
      cancelSpring();

      // Support double-tap on touch screens to equalize adjacent panes
      if (e.pointerType !== 'mouse') {
        const now = performance.now();
        if (now - lastTapTime < 320) {
          lastTapTime = 0;
          equalizePair();
          return;
        }
        lastTapTime = now;
      }

      const startPos = isHorizontalDrag ? e.clientX : e.clientY;
      const chain = getChain?.();
      const useChain = Boolean(chain && chain.els.length > 1 && chain.els.every(Boolean));
      const chainEls = useChain ? chain.els : [firstEl, secondEl];
      const k = useChain ? chain.index : 0;
      // Layout sizes, not getBoundingClientRect: a neighbour may still be
      // mid-bounce from the last drag, and its transform is not its size.
      const startSizes = chainEls.map((node) =>
        isHorizontalDrag ? node.offsetWidth : node.offsetHeight,
      );
      const totalPx = startSizes.reduce((sum, px) => sum + px, 0);
      const minPx = isHorizontalDrag ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX;
      // How far the splitter may travel: every pane on that side down to its minimum.
      const slack = (from, to) => {
        let room = 0;
        for (let i = from; i <= to; i++) room += Math.max(0, startSizes[i] - minPx);
        return room;
      };
      const roomBefore = slack(0, k);
      const roomAfter = slack(k + 1, startSizes.length - 1);
      if (roomBefore + roomAfter <= 0) return;

      const startWeights = useChain ? chain.weights : getWeights();
      const totalWeight = startWeights.reduce((sum, w) => sum + w, 0);
      const writeWeights = useChain ? chain.set : ([w1, w2]) => setWeights(w1, w2);

      activeResizerCount++;
      splitter.classList.add('dragging');
      gridEl.classList.add('resizing-active');
      if (isHorizontalDrag) freezeTranscriptWidths();
      try {
        splitter.setPointerCapture(e.pointerId);
      } catch {
        // Ignore synthetic pointer events without active pointerId
      }

      let currentSizes = startSizes;
      let currentDelta = 0;
      let lastMovePos = startPos;
      let lastMoveTime = performance.now();
      let velocityPxPerSec = 0;
      let hitBoundDuringDrag = 0; // -1 (hit min), 1 (hit max), 0 (none)

      const applySizes = (sizes) => {
        currentSizes = sizes;
        writeWeights(sizes.map((px) => (totalWeight * px) / totalPx));
      };

      // The pane the splitter moves toward gives way first; once it is at its
      // minimum the next one in line is pushed, like a row of springs.
      const applyDelta = (delta) => {
        const d = Math.max(-roomBefore, Math.min(roomAfter, delta));
        const sizes = startSizes.slice();
        const grow = d > 0 ? k : k + 1;
        const step = d > 0 ? 1 : -1;
        let left = Math.abs(d);
        sizes[grow] += left;
        for (let i = d > 0 ? k + 1 : k; left > 0 && i >= 0 && i < sizes.length; i += step) {
          const take = Math.min(left, Math.max(0, sizes[i] - minPx));
          sizes[i] -= take;
          left -= take;
        }
        currentDelta = d;
        applySizes(sizes);
      };

      // 120Hz+ zero-lag direct style mutation on every pointermove / coalesced event
      const applyPosition = (clientPos, nowTime) => {
        const dt = Math.max(1, nowTime - lastMoveTime);
        const instVel = ((clientPos - lastMovePos) / dt) * 1000;
        velocityPxPerSec = velocityPxPerSec * 0.35 + instVel * 0.65;
        lastMovePos = clientPos;
        lastMoveTime = nowTime;

        const rawDelta = clientPos - startPos;
        if (rawDelta <= -roomBefore) {
          if (hitBoundDuringDrag !== -1) {
            hitBoundDuringDrag = -1;
            triggerWallImpactBounce(chainEls[0], axis, -1, 1.35);
          }
        } else if (rawDelta >= roomAfter) {
          if (hitBoundDuringDrag !== 1) {
            hitBoundDuringDrag = 1;
            triggerWallImpactBounce(chainEls[chainEls.length - 1], axis, 1, 1.35);
          }
        } else {
          hitBoundDuringDrag = 0;
        }
        applyDelta(rawDelta);
      };

      const onMove = (moveEvent) => {
        if (moveEvent.pointerId !== e.pointerId) return;
        const coalesced =
          typeof moveEvent.getCoalescedEvents === 'function'
            ? moveEvent.getCoalescedEvents()
            : null;
        const latest = coalesced && coalesced.length > 0 ? coalesced[coalesced.length - 1] : moveEvent;
        const currentPos = isHorizontalDrag ? latest.clientX : latest.clientY;
        applyPosition(currentPos, performance.now());
      };

      let ended = false;
      const onEnd = (endEvent) => {
        if (ended || (endEvent && endEvent.pointerId !== e.pointerId)) return;
        ended = true;
        activeResizerCount = Math.max(0, activeResizerCount - 1);
        splitter.classList.remove('dragging');
        if (activeResizerCount === 0) {
          gridEl.classList.remove('resizing-active');
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        saveState();

        // Pronounced Inertial Collision & Bounce upon release:
        // Whether the user flicks fast or drags and releases, give the divider and both
        // adjacent panes a clearly visible inertial overshoot & elastic rebound (24px..52px peak)
        // before locking cleanly onto `restPx`.
        const totalDelta = currentDelta;
        const timeSinceMove = performance.now() - lastMoveTime;
        const dragSign =
          Math.abs(totalDelta) > 2
            ? Math.sign(totalDelta)
            : Math.abs(velocityPxPerSec) > 20
              ? Math.sign(velocityPxPerSec)
              : 0;

        if (!prefersReducedMotion() && dragSign !== 0 && Math.abs(totalDelta) > 3) {
          const restSizes = currentSizes;
          const isX = axis === 'x';
          const origFirstSize = restSizes[k];
          const origSecondSize = restSizes[k + 1];

          const speedBoost = timeSinceMove < 120 ? Math.min(28, Math.abs(velocityPxPerSec) * 0.03) : 0;
          const distBoost = Math.min(54, Math.max(28, Math.abs(totalDelta) * 0.42));
          const peakShift = dragSign * (distBoost + speedBoost);

          // 120Hz Analytical Damped Harmonic Oscillator (GPU Compositor Keyframes)
          const splitterKeyframes = [];
          const firstKeyframes = [];
          const secondKeyframes = [];
          const steps = 60;

          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const decay = Math.exp(-3.8 * t);
            const osc = Math.sin(t * Math.PI * 2.8);
            const dispPx = peakShift * decay * osc;
            const dispStr = dispPx.toFixed(2);

            const tx = isX ? `${dispStr}px` : '0px';
            const ty = isX ? '0px' : `${dispStr}px`;
            splitterKeyframes.push({
              transform: `translate3d(${tx}, ${ty}, 0)`,
              offset: t,
            });

            const sx1 = isX ? ((origFirstSize + dispPx) / origFirstSize).toFixed(4) : '1';
            const sy1 = isX ? '1' : ((origFirstSize + dispPx) / origFirstSize).toFixed(4);
            firstKeyframes.push({
              transform: `scale3d(${sx1}, ${sy1}, 1)`,
              offset: t,
            });

            const sx2 = isX ? ((origSecondSize - dispPx) / origSecondSize).toFixed(4) : '1';
            const sy2 = isX ? '1' : ((origSecondSize - dispPx) / origSecondSize).toFixed(4);
            secondKeyframes.push({
              transform: `scale3d(${sx2}, ${sy2}, 1)`,
              offset: t,
            });
          }

          if (isX) {
            firstEl.style.transformOrigin = 'left center';
            secondEl.style.transformOrigin = 'right center';
          } else {
            firstEl.style.transformOrigin = 'center top';
            secondEl.style.transformOrigin = 'center bottom';
          }

          gridEl.classList.add('spring-bouncing');
          splitter.classList.add('impact-bounce');

          firstEl.getAnimations?.().forEach((a) => a.cancel());
          secondEl.getAnimations?.().forEach((a) => a.cancel());
          splitter.getAnimations?.().forEach((a) => a.cancel());

          const duration = 440;
          // The text flows into its new width while the splitter settles.
          if (isHorizontalDrag) reflowTranscripts(duration);
          const animSplitter = splitter.animate(splitterKeyframes, { duration, easing: 'linear' });
          const animFirst = firstEl.animate(firstKeyframes, { duration, easing: 'linear' });
          const animSecond = secondEl.animate(secondKeyframes, { duration, easing: 'linear' });

          const cleanup = () => {
            gridEl.classList.remove('spring-bouncing');
            splitter.classList.remove('impact-bounce');
            firstEl.style.transform = '';
            secondEl.style.transform = '';
            splitter.style.transform = '';
            firstEl.style.transformOrigin = '';
            secondEl.style.transformOrigin = '';
            applySizes(restSizes);
            saveState();
            activeSpringCleanup = null;
          };
          activeSpringCleanup = cleanup;
          animSplitter.onfinish = cleanup;
          // A rebuild that drops these elements cancels the bounce silently.
          setTimeout(() => {
            if (activeSpringCleanup === cleanup) cleanup();
          }, duration + 200);
          return;
        }
        if (isHorizontalDrag) reflowTranscripts(320);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    });

    return splitter;
  }

  let lastLayoutSignature = '';

  function computeLayoutSignature() {
    const sig = (node) => (node.jid ? node.jid : `(${node.items.map(sig).join(',')})`);
    return `${direction}|${groups.map(sig).join(';')}`;
  }

  function rebuildGrid(forceRebuildDOM = false) {
    // Never interrupt an active splitter drag with a background poll rebuild
    if (activeResizerCount > 0 && !forceRebuildDOM) {
      return;
    }

    normalizeGroups();
    syncNavCounts();
    renderQuickPicks();

    const jids = allJids();
    if (jids.length === 0) {
      gridEl.hidden = true;
      emptyEl.hidden = false;
      gridEl.replaceChildren();
      lastLayoutSignature = '';
      return;
    }

    emptyEl.hidden = true;
    gridEl.hidden = false;
    gridEl.style.flexDirection = direction;
    gridEl.dataset.paneCount = String(jids.length);
    gridEl.classList.toggle('density-compact', jids.length >= 6);
    gridEl.classList.toggle('density-ultra', jids.length >= 9);

    // Ensure pane instances exist for all active jids
    for (const jid of jids) {
      if (!panes.has(jid)) {
        const pane = createPaneDOM(jid);
        panes.set(jid, pane);
        if (active) void hydratePane(pane);
      } else {
        syncPaneHeader(panes.get(jid));
      }
    }

    // Remove stale panes
    for (const jid of [...panes.keys()]) {
      if (!jids.includes(jid)) disposePane(jid);
    }
    ensureComposerPane();

    // iPadOS Safari critical fix: NEVER call replaceChildren() when the group/pane
    // topology hasn't changed! Re-parenting a focused <textarea> on iOS/iPadOS WebKit
    // immediately blurs it and collapses the software keyboard (especially on the 5s poll).
    const nextSignature = computeLayoutSignature();
    if (!forceRebuildDOM && nextSignature === lastLayoutSignature && gridEl.children.length > 0) {
      // Same topology: walk the DOM alongside the model and update weights only.
      const applyWeights = (nodes, container) => {
        const childEls = [...container.children].filter(
          (c) => c.classList.contains('dashboard-group') || c.classList.contains('dashboard-pane'),
        );
        nodes.forEach((node, i) => {
          const nodeEl = childEls[i];
          if (!nodeEl) return;
          nodeEl.style.flex = `${nodes.length === 1 ? 1 : node.weight} 1 0px`;
          if (node.items) applyWeights(node.items, nodeEl);
        });
      };
      applyWeights(groups, gridEl);
      applyZoom();
      return;
    }

    // Capture focused textarea state before structural DOM changes so iPad keyboard stays open
    const prevFocusedEl =
      gridEl.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA'
        ? document.activeElement
        : null;
    const selStart = prevFocusedEl ? prevFocusedEl.selectionStart : null;
    const selEnd = prevFocusedEl ? prevFocusedEl.selectionEnd : null;

    lastLayoutSignature = nextSignature;

    // Render one split's children along axisAt(depth), with a splitter between
    // each pair. Splitters find their split again by the panes that start each
    // side, because normalizeGroups() rebuilds the model objects on every save.
    const renderSplit = (nodes, depth, container) => {
      const splitterAxis = axisAt(depth) === 'row' ? 'x' : 'y';
      const childEls = nodes.map((node) => {
        let nodeEl;
        if (node.jid) {
          nodeEl = panes.get(node.jid)?.el;
        } else {
          const innerDirection = axisAt(depth + 1);
          nodeEl = el('div', `dashboard-group dashboard-group-${innerDirection}`);
          nodeEl.style.flexDirection = innerDirection;
          renderSplit(node.items, depth + 1, nodeEl);
        }
        if (nodeEl) nodeEl.style.flex = `${nodes.length === 1 ? 1 : node.weight} 1 0px`;
        return nodeEl;
      });

      const children = [];
      childEls.forEach((childEl, i) => {
        if (!childEl) return;
        children.push(childEl);
        const nextEl = childEls[i + 1];
        if (!nextEl) return;
        const firstJid = firstLeafJid(nodes[i]);
        const secondJid = firstLeafJid(nodes[i + 1]);
        const label =
          depth === 0
            ? splitterAxis === 'x'
              ? `Resize columns ${i + 1} and ${i + 2}`
              : `Resize rows ${i + 1} and ${i + 2}`
            : splitterAxis === 'y'
              ? `Resize vertical panes ${i + 1} and ${i + 2}`
              : `Resize horizontal panes ${i + 1} and ${i + 2}`;
        children.push(
          createAxisSplitter({
            axis: splitterAxis,
            label,
            firstEl: childEl,
            secondEl: nextEl,
            getWeights: () => {
              const at = siblingsOf(firstJid, secondJid);
              return at
                ? [at.node.items[at.index].weight, at.node.items[at.index + 1].weight]
                : [1, 1];
            },
            setWeights: (w1, w2) => {
              const at = siblingsOf(firstJid, secondJid);
              if (at) {
                at.node.items[at.index].weight = w1;
                at.node.items[at.index + 1].weight = w2;
              }
              childEl.style.flex = `${w1} 1 0px`;
              nextEl.style.flex = `${w2} 1 0px`;
            },
            getChain: () => {
              const at = siblingsOf(firstJid, secondJid);
              if (!at) return null;
              const siblings = at.node.items;
              return {
                index: at.index,
                els: childEls,
                weights: siblings.map((n) => n.weight),
                set: (weights) => {
                  siblings.forEach((n, j) => {
                    n.weight = weights[j];
                    if (childEls[j]) childEls[j].style.flex = `${weights[j]} 1 0px`;
                  });
                },
              };
            },
          }),
        );
      });
      container.replaceChildren(...children);
    };
    renderSplit(groups, 0, gridEl);
    applyZoom();

    if (prevFocusedEl && gridEl.contains(prevFocusedEl)) {
      prevFocusedEl.focus({ preventScroll: true });
      try {
        if (selStart != null && selEnd != null) {
          prevFocusedEl.setSelectionRange(selStart, selEnd);
        }
      } catch {
        // Ignore selection errors
      }
    }
  }

  // ── Layout Mutations (Swap, Horizontal, Vertical, 2D Grid, Directional Drop) ──
  function detachJidFromGroups(jid) {
    const path = pathToJid(jid);
    if (path) {
      const { node, index } = path[path.length - 1];
      node.items.splice(index, 1);
    }
    normalizeGroups();
  }

  function swapPanesInPlace(jidA, jidB) {
    if (!jidA || !jidB || jidA === jidB) return false;
    const pathA = pathToJid(jidA);
    const pathB = pathToJid(jidB);
    if (!pathA || !pathB) return false;
    const a = pathA[pathA.length - 1];
    const b = pathB[pathB.length - 1];
    a.node.items[a.index].jid = jidB;
    b.node.items[b.index].jid = jidA;
    return true;
  }

  /**
   * Put `jid` at the far edge of the whole dashboard: a full-height column
   * (left/right) or full-width row (top/bottom). Along the top-level axis it
   * becomes one more cell with an average share; across it, the existing
   * layout and the new pane split the stage in two.
   */
  function placeAtStageEdge(jid, zone) {
    const axis = zone === 'left' || zone === 'right' ? 'row' : 'column';
    const atStart = zone === 'left' || zone === 'top';
    const cell = { weight: 1, items: [{ jid, weight: 1 }] };
    if (groups.length === 0) {
      direction = axis;
      groups = [cell];
    } else if (axis === direction) {
      cell.weight = groups.reduce((sum, g) => sum + g.weight, 0) / groups.length;
      groups.splice(atStart ? 0 : groups.length, 0, cell);
    } else {
      const rest = { weight: 1, items: groups };
      direction = axis;
      groups = atStart ? [cell, rest] : [rest, cell];
    }
    normalizeGroups();
  }

  /**
   * Put `jid` where the drop preview showed it. An edge drop splits the pane
   * under the finger: left/right make two panes side by side, top/bottom two
   * stacked, each taking half of that pane's space — never the whole column
   * or row it sits in. The stage's outer band (`mode: 'edge'`) instead puts
   * it beside everything (placeAtStageEdge).
   */
  function placeSessionAt(jid, target = null) {
    if (!jid || jid === 'web:life') return;
    if (target?.mode === 'pane' && target.jid === jid) return;

    // Direct swap when dragging an existing pane onto another pane's center, or adding alongside target pane
    if (target?.mode === 'pane' && target.zone === 'swap' && target.jid) {
      if (swapPanesInPlace(jid, target.jid)) return;
      // If `jid` was dragged from the sidebar (not yet in dashboard), insert as a new pane adjacent to target.jid
      const path = pathToJid(target.jid);
      if (path) {
        detachJidFromGroups(jid);
        groups.splice(path[0].index + 1, 0, { weight: 1, items: [{ jid, weight: 1 }] });
        return;
      }
    }

    detachJidFromGroups(jid);

    const zone = target?.zone || 'right';
    const path = target?.mode === 'pane' && target.jid ? pathToJid(target.jid) : null;
    if (!path) {
      // No pane to split: add a whole column/row at that edge of the stage.
      placeAtStageEdge(jid, zone);
      return;
    }

    const wanted = zone === 'left' || zone === 'right' ? 'row' : 'column';
    const before = zone === 'left' || zone === 'top';
    const depth = path.length - 1;
    const { node: parent, index } = path[depth];
    const targetNode = parent.items[index];
    if (axisAt(depth) === wanted) {
      // The pane's own split already runs this way: insert beside it and let
      // the two share the pane's old space.
      const half = targetNode.weight / 2;
      targetNode.weight = half;
      parent.items.splice(before ? index : index + 1, 0, { jid, weight: half });
    } else {
      // Split the pane itself across the other axis.
      const pair = before
        ? [{ jid, weight: 1 }, { jid: targetNode.jid, weight: 1 }]
        : [{ jid: targetNode.jid, weight: 1 }, { jid, weight: 1 }];
      parent.items[index] = { weight: targetNode.weight, items: pair };
    }
    // A pane alone in its top-level cell split along the top-level axis is
    // just two cells; normalizeGroups() lifts it to that shape.
    normalizeGroups();
  }

  function applyPreset(preset) {
    const jids = allJids();
    if (jids.length === 0) return;

    animatePaneLayoutTransition(() => {
      if (preset === 'horizontal') {
        direction = 'row';
        groups = jids.map((jid) => ({
          weight: 1,
          items: [{ jid, weight: 1 }],
        }));
      } else if (preset === 'vertical') {
        direction = 'column';
        groups = jids.map((jid) => ({
          weight: 1,
          items: [{ jid, weight: 1 }],
        }));
      } else if (preset === 'grid') {
        direction = 'row';
        groups = buildBalancedGridGroups(jids);
      }

      saveState();
      rebuildGrid();
    });
  }

  function togglePaneAxis(jid) {
    const jids = allJids();
    if (jids.length < 2) return;
    const path = pathToJid(jid);
    if (!path) return;
    const gIdx = path[0].index;

    animatePaneLayoutTransition(() => {
      const grp = groups[gIdx];
      if (path.length > 2) {
        // Inside a split within a cell -> lift it out to its own cell next to that cell
        const { node, index } = path[path.length - 1];
        const [removed] = node.items.splice(index, 1);
        groups.splice(gIdx + 1, 0, { weight: 1, items: [{ jid: removed.jid, weight: 1 }] });
      } else if (grp.items.length > 1) {
        // Currently stacked with another pane -> extract to its own outer group next to this one
        const [removed] = grp.items.splice(path[1].index, 1);
        groups.splice(gIdx + 1, 0, { weight: 1, items: [removed] });
      } else if (groups.length > 1) {
        // Currently in its own outer group -> merge into neighbor group to stack perpendicularly
        const targetGroupIdx = gIdx > 0 ? gIdx - 1 : 1;
        const [removedGroup] = groups.splice(gIdx, 1);
        const neighbor = groups[gIdx > 0 ? targetGroupIdx : 0];
        neighbor.items.push(...removedGroup.items);
      }
      saveState();
      rebuildGrid();
    });
  }

  // ── Public Operations ──────────────────────────────────────────────────────
  function setActive(nextActive) {
    if (active === nextActive) return;
    active = nextActive;
    syncNavCounts();

    if (active) {
      rebuildGrid();
      for (const pane of panes.values()) {
        scrollPaneToLatest(pane);
        void hydratePane(pane);
      }
    } else {
      if (zoomedJid) setZoom(null, { instant: true });
      for (const pane of panes.values()) {
        if (pane.source) {
          pane.source.close();
          pane.source = null;
        }
        clearTimeout(pane.reconnectTimer);
      }
    }
    if (active && !wideQuery.matches) document.getElementById('btn-hide-drawer')?.click();
    syncKeyboardLift();
    onRenderSessionListDecorations();
    voiceIme?.retarget();
  }

  function buildBalancedGridGroups(jids) {
    const cols = Math.min(4, Math.ceil(Math.sqrt(jids.length)));
    const newGroups = Array.from({ length: cols }, () => ({ weight: 1, items: [] }));
    jids.forEach((jid, idx) => {
      newGroups[idx % cols].items.push({ jid, weight: 1 });
    });
    return newGroups.filter((g) => g.items.length > 0);
  }

  function addPane(jid, dropTarget = null) {
    if (!jid || jid === 'web:life') return;
    if (!wideQuery.matches) document.getElementById('btn-hide-drawer')?.click();
    const wasAlreadyIn = allJids().includes(jid);
    animatePaneLayoutTransition(() => {
      if (dropTarget && (dropTarget.mode === 'pane' || dropTarget.mode === 'edge')) {
        placeSessionAt(jid, dropTarget);
      } else if (!wasAlreadyIn) {
        const nextJids = [...allJids(), jid];
        if (nextJids.length >= 4) {
          direction = 'row';
          groups = buildBalancedGridGroups(nextJids);
        } else {
          groups.push({ weight: 1, items: [{ jid, weight: 1 }] });
        }
      }
      saveState();
      if (!active) {
        setActive(true);
      } else {
        rebuildGrid();
        onRenderSessionListDecorations();
      }
    });
  }

  /** A session-list tap while the Dashboard is open: the session joins the
   *  tiles (or keeps its place if it is already there), takes the input card,
   *  and its pane flashes so the eye finds it. No keyboard on touch; a mouse
   *  can type straight away. */
  function revealSession(jid) {
    if (!jid || jid === 'web:life') return;
    if (!allJids().includes(jid)) addPane(jid);
    else if (zoomedJid && zoomedJid !== jid) setZoom(null);
    const pane = panes.get(jid);
    if (!pane) return;
    selectComposerPane(jid);
    if (window.matchMedia?.('(pointer: fine)')?.matches) {
      pane.textarea?.focus({ preventScroll: true });
    }
    pane.el.classList.remove('pane-locating');
    void pane.el.offsetWidth; // a second tap replays the flash
    pane.el.classList.add('pane-locating');
    clearTimeout(pane.locateTimer);
    pane.locateTimer = setTimeout(() => pane.el.classList.remove('pane-locating'), 1200);
  }

  function markZoomPath(jid) {
    for (const node of gridEl.querySelectorAll('.zoom-path')) node.classList.remove('zoom-path');
    const pane = jid ? panes.get(jid) : null;
    if (!pane || !gridEl.contains(pane.el)) return;
    for (let node = pane.el; node && node !== gridEl; node = node.parentElement) {
      node.classList.add('zoom-path');
    }
  }

  /** Re-applies the zoom after the grid is rebuilt (new group elements). */
  function applyZoom() {
    const pane = zoomedJid ? panes.get(zoomedJid) : null;
    if (zoomedJid && !(pane && gridEl.contains(pane.el))) zoomedJid = null;
    gridEl.classList.toggle('has-zoom', Boolean(zoomedJid));
    // A zoomed pane has the stage to itself: full-size header and text.
    const count = allJids().length;
    gridEl.classList.toggle('density-compact', !zoomedJid && count >= 6);
    gridEl.classList.toggle('density-ultra', !zoomedJid && count >= 9);
    if (!gridEl.classList.contains('zoom-moving')) markZoomPath(zoomedJid);
    for (const p of panes.values()) {
      const on = p.jid === zoomedJid;
      p.el.classList.toggle('pane-zoomed', on);
      p.focusBtn.innerHTML = on ? ZOOM_OUT_ICON : ZOOM_IN_ICON;
      p.focusBtn.title = on ? '縮回並排' : '放大此視窗';
      p.focusBtn.setAttribute('aria-pressed', String(on));
      const label = p.moreMenu.querySelector('[data-action="expand"] .mi-label');
      if (label) label.textContent = on ? '縮回並排' : '放大此視窗';
    }
  }

  /** Zoom one pane to the whole stage without leaving the Dashboard (jid), or
   *  back to its tile (null). The other panes step aside, not away: their
   *  streams keep running and their places are kept. The pane grows from its
   *  tile, or shrinks back into it, on a spring that overshoots a little and
   *  settles, by transform alone so the compositor runs it. */
  function setZoom(jid, { instant = false, from = null } = {}) {
    if (jid && !panes.has(jid)) return;
    if (jid === zoomedJid) return;
    if (jid && allJids().length < 2) return; // a lone pane already fills the stage
    const moving = panes.get(jid || zoomedJid);
    const animate = !instant && active && !gridEl.hidden && !prefersReducedMotion() && moving;
    const first = animate ? from || moving.el.getBoundingClientRect() : null;

    if (jid) {
      for (const p of panes.values()) {
        p.zoomRestore = { top: p.messagesEl.scrollTop, bottom: isNearBottom(p.messagesEl) };
      }
    }
    for (const p of panes.values()) p.el.getAnimations?.().forEach((a) => a.cancel());
    // The tap that zoomed also sent the card here; land it now, not on the
    // tile rect it was flying to.
    dockGhost?.el.getAnimations().forEach((a) => a.cancel());
    moving?.dock.getAnimations().forEach((a) => a.cancel());
    gridEl.classList.remove('zoom-moving');
    zoomedJid = jid;
    applyZoom();
    if (!jid) {
      // Hidden panes lost their scroll; give each back its place (or the end).
      for (const p of panes.values()) {
        const at = p.zoomRestore;
        if (!at || p === moving) continue;
        p.messagesEl.scrollTop = at.bottom ? p.messagesEl.scrollHeight : at.top;
        p.zoomRestore = null;
      }
    } else {
      selectComposerPane(jid, { animate: false });
    }
    if (moving && isNearBottom(moving.messagesEl)) {
      moving.messagesEl.scrollTop = moving.messagesEl.scrollHeight;
    }
    syncKeyboardLift({ instant: true });
    if (!animate) return;

    const last = moving.el.getBoundingClientRect();
    if (!first.width || !last.width || !last.height) return;
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;
    const keyframes = [];
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = solveSpringProgress(t, 0.6, 16);
      const rest = 1 - p;
      keyframes.push({
        transform: `translate3d(${(dx * rest).toFixed(2)}px, ${(dy * rest).toFixed(2)}px, 0) scale(${(1 + (sx - 1) * rest).toFixed(4)}, ${(1 + (sy - 1) * rest).toFixed(4)})`,
        offset: t,
      });
    }
    // While it moves, the pane is drawn over its neighbours and its groups
    // stop clipping it: shrinking back it starts larger than its tile.
    markZoomPath(moving.jid);
    gridEl.classList.add('zoom-moving');
    moving.el.style.transformOrigin = '0 0';
    const anim = moving.el.animate(keyframes, { duration: 620, easing: 'linear' });
    const settle = () => {
      if (moving.el.style.transformOrigin === '0 0') moving.el.style.transformOrigin = '';
      gridEl.classList.remove('zoom-moving');
      markZoomPath(zoomedJid);
    };
    anim.onfinish = settle;
    anim.oncancel = settle;
  }

  // ── Pinch: spread two fingers to make a pane a step bigger, and on until
  // the next step would nearly fill the stage, which is then the zoom; pinch
  // to step back down, one step below its own tile at most ───────────────────
  // A step multiplies the pane's area, shared out over every level of the
  // split tree where it has neighbours, so it grows on both axes in a grid.
  const PINCH_STEP_AREA = 1.7;
  // A step up that would cover this much of the stage is the zoom instead.
  const PINCH_FULL_AREA = 0.6;
  const PINCH_MIN_STEP = -1;
  const STEP_MAX_SHARE = 0.8;
  const cloneLayout = (layout) => layout.map(serializeNode);
  const layoutKey = (layout) => JSON.stringify(cloneLayout(layout));
  const holdsJid = (node, jid) => node.jid === jid || Boolean(node.items?.some((n) => holdsJid(n, jid)));

  /** Where a pane would sit (client px) under `layout`; splitters are left
   *  out, which is close enough for a preview outline. */
  function predictPaneRect(jid, layout = groups) {
    const g = gridEl.getBoundingClientRect();
    const walk = (nodes, depth, box) => {
      const row = axisAt(depth) === 'row';
      const weightOf = (n) => (nodes.length === 1 ? 1 : n.weight);
      const total = nodes.reduce((sum, n) => sum + weightOf(n), 0) || 1;
      let at = row ? box.left : box.top;
      for (const n of nodes) {
        const size = ((row ? box.width : box.height) * weightOf(n)) / total;
        const r = row
          ? { left: at, top: box.top, width: size, height: box.height }
          : { left: box.left, top: at, width: box.width, height: size };
        at += size;
        if (n.jid === jid) return r;
        const inner = n.items && walk(n.items, depth + 1, r);
        if (inner) return inner;
      }
      return null;
    };
    return walk(layout, 0, g);
  }

  /** `base` with `jid` `step` steps bigger (or smaller, below 0), each
   *  share kept between the pane's minimum size and what leaves every
   *  neighbour its own; null when the pane has no neighbours to trade with. */
  function stepLayout(base, jid, step) {
    const layout = cloneLayout(base);
    let levels = 0;
    const count = (nodes) => {
      const node = nodes.find((n) => holdsJid(n, jid));
      if (!node) return;
      if (nodes.length > 1) levels++;
      if (node.items) count(node.items);
    };
    count(layout);
    if (!levels) return null;
    const gain = PINCH_STEP_AREA ** (step / levels);
    const g = gridEl.getBoundingClientRect();
    const walk = (nodes, depth, width, height) => {
      const i = nodes.findIndex((n) => holdsJid(n, jid));
      if (i < 0) return;
      const row = axisAt(depth) === 'row';
      const total = nodes.reduce((sum, n) => sum + n.weight, 0) || 1;
      let share = nodes.length === 1 ? 1 : nodes[i].weight / total;
      if (nodes.length > 1) {
        const size = Math.max(1, row ? width : height);
        const minPx = row ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX;
        const most = Math.min(STEP_MAX_SHARE, 1 - ((nodes.length - 1) * minPx) / size);
        const next = Math.max(minPx / size, Math.min(most, share * gain));
        if (Math.abs(next - share) > 0.005) {
          const rest = (1 - next) / (1 - share);
          nodes.forEach((n, j) => {
            n.weight = Number((j === i ? next * total : n.weight * rest).toFixed(4));
          });
          share = next;
        }
      }
      if (nodes[i].items) {
        walk(nodes[i].items, depth + 1, row ? width * share : width, row ? height : height * share);
      }
    };
    walk(layout, 0, g.width, g.height);
    return layout;
  }

  /** What a pinch on `jid` can reach from here: its step (and the layout it
   *  steps from), the tile one step up (null: the step up is the zoom) and one
   *  step down (null: nowhere to go). A step holds only while the layout is the
   *  one it made; any splitter move, preset, swap or pane change makes the
   *  current layout step 0 again. The zoom keeps the weights, so the step
   *  survives a zoom in and out. */
  function pinchLadder(jid) {
    const held = pinchSteps?.jid === jid && pinchSteps.key === layoutKey(groups);
    const base = held ? pinchSteps.base : cloneLayout(groups);
    const step = held ? pinchSteps.step : 0;
    const g = gridEl.getBoundingClientRect();
    const area = (layout) => {
      const r = layout && predictPaneRect(jid, layout);
      return r && g.width && g.height ? (r.width * r.height) / (g.width * g.height) : 0;
    };
    const at = (k) => (k === step ? groups : k === 0 ? base : stepLayout(base, jid, k));
    const now = area(groups);
    const upLayout = at(step + 1);
    const up = area(upLayout) < PINCH_FULL_AREA && area(upLayout) > now * 1.1 ? upLayout : null;
    const downLayout = step - 1 >= PINCH_MIN_STEP ? at(step - 1) : null;
    const down = downLayout && area(downLayout) < now / 1.1 ? downLayout : null;
    return {
      base,
      step,
      zoomed: zoomedJid === jid,
      up,
      down,
      layouts: { [step + 1]: up, [step - 1]: down, 0: base, [step]: groups },
    };
  }

  // Pinch ratios (finger distance now / at the start) that pick the next level.
  // Stage one gets a wide band: at 1.6 an ordinary spread went past it to the
  // zoom in one go (iPad, 2026-10-26).
  const PINCH_GROW = 1.18;
  const PINCH_FULL = 2.1;
  const PINCH_SHRINK = 0.85;
  const PINCH_TILE = 0.6;
  // Fingers set down close together count from this span: from 50px apart, a
  // 40px spread is a ratio of 1.8 but only a small gesture.
  const PINCH_MIN_SPAN = 100;

  /** Where a pinch at ratio `r` lands: `{ zoom: true }`, `{ step }`, or null
   *  for where it started. One step either way, or further for a wide spread
   *  (the zoom) or a hard pinch (the pane's own tile, from above it). */
  function pinchTarget(pinch, r) {
    const { step } = pinch;
    if (pinch.zoomed) {
      if (r > PINCH_SHRINK) return null;
      return { step: r <= PINCH_TILE && step > 0 ? 0 : step };
    }
    if (r >= PINCH_GROW) return r < PINCH_FULL && pinch.up ? { step: step + 1 } : { zoom: true };
    if (r <= PINCH_SHRINK) {
      if (r <= PINCH_TILE && step > 0) return { step: 0 };
      if (pinch.down) return { step: step - 1 };
    }
    return null;
  }

  function pinchPreview(pinch, to) {
    if (!to) return null;
    if (to.zoom) return { rect: gridEl.getBoundingClientRect(), label: '放到最大' };
    const label = pinch.zoomed
      ? '縮回並排'
      : to.step === 0
        ? pinch.step > 0
          ? '縮回原本大小'
          : '放回原本大小'
        : to.step > pinch.step
          ? '放大一點'
          : '縮小一點';
    return { rect: predictPaneRect(pinch.jid, pinch.layouts[to.step]), label };
  }

  function showPinchPreview(preview) {
    if (!preview?.rect) {
      dropPreviewEl.hidden = true;
      dropPreviewEl.classList.remove('pinch-target');
      return;
    }
    const stage = stageEl.getBoundingClientRect();
    dropPreviewEl.classList.add('pinch-target');
    dropPreviewEl.hidden = false;
    dropPreviewEl.style.left = `${Math.round(preview.rect.left - stage.left + 4)}px`;
    dropPreviewEl.style.top = `${Math.round(preview.rect.top - stage.top + 4)}px`;
    dropPreviewEl.style.width = `${Math.round(preview.rect.width - 8)}px`;
    dropPreviewEl.style.height = `${Math.round(preview.rect.height - 8)}px`;
    dropLabelEl.textContent = preview.label;
  }

  /** The pane under the fingers: lifted over its neighbours, unclipped. */
  function beginPinch(pinch) {
    const pane = panes.get(pinch.jid);
    pane.el.getAnimations?.().forEach((a) => a.cancel());
    const rect = pane.el.getBoundingClientRect();
    const grid = gridEl.getBoundingClientRect();
    pinch.pane = pane;
    pinch.fill = Math.max(grid.width / rect.width, grid.height / rect.height);
    pane.el.style.transformOrigin = `${pinch.startX - rect.left}px ${pinch.startY - rect.top}px`;
    markZoomPath(pinch.jid);
    gridEl.classList.add('zoom-moving');
    pane.el.classList.add('pane-pinching');
    window.getSelection()?.removeAllRanges();
  }

  /** Follow the fingers: the pane scales with their spread and moves with
   *  their midpoint, and gives way like rubber past what the stage can hold. */
  function trackPinch(pinch, at, distance) {
    const r = distance / pinch.startDistance;
    const max = pinch.fill * 1.05;
    const min = pinch.zoomed || pinch.down ? 0.5 : 0.92;
    let scale = r;
    if (scale > max) scale = max + (scale - max) * 0.2;
    if (scale < min) scale = min - (min - scale) * 0.2;
    pinch.dx = at.x - pinch.startX;
    pinch.dy = at.y - pinch.startY;
    pinch.scale = scale;
    const reach = 1 + (distance - pinch.startDistance) / Math.max(pinch.startDistance, PINCH_MIN_SPAN);
    pinch.to = pinchTarget(pinch, reach);
    pinch.pane.el.style.transform = `translate3d(${pinch.dx.toFixed(1)}px, ${pinch.dy.toFixed(1)}px, 0) scale(${scale.toFixed(4)})`;
    showPinchPreview(pinchPreview(pinch, pinch.to));
  }

  function endPinchLift(pinch) {
    pinch.pane.el.classList.remove('pane-pinching');
    pinch.pane.el.style.transformOrigin = '';
    gridEl.classList.remove('zoom-moving');
    markZoomPath(zoomedJid);
  }

  /** Back to where the pinch started, on the zoom spring. */
  function springPinchBack(pinch) {
    const { el: paneEl } = pinch.pane;
    const { dx = 0, dy = 0, scale = 1 } = pinch;
    paneEl.style.transform = '';
    if (prefersReducedMotion() || (Math.hypot(dx, dy) < 1 && Math.abs(scale - 1) < 0.005)) {
      endPinchLift(pinch);
      return;
    }
    const keyframes = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const rest = 1 - solveSpringProgress(t, 0.6, 16);
      keyframes.push({
        transform: `translate3d(${(dx * rest).toFixed(2)}px, ${(dy * rest).toFixed(2)}px, 0) scale(${(1 + (scale - 1) * rest).toFixed(4)})`,
        offset: t,
      });
    }
    const anim = paneEl.animate(keyframes, { duration: 460, easing: 'linear' });
    anim.onfinish = anim.oncancel = () => endPinchLift(pinch);
  }

  /** Land a released pinch on its level, springing from where the fingers
   *  left the pane rather than from its tile. */
  function settlePinch(pinch) {
    const to = pinch.to;
    if (!to || !panes.has(pinch.jid)) {
      springPinchBack(pinch);
      return;
    }
    const paneEl = pinch.pane.el;
    const from = paneEl.getBoundingClientRect();
    paneEl.style.transform = '';
    endPinchLift(pinch);
    if (to.zoom) {
      setZoom(pinch.jid, { from });
      return;
    }
    const land = () => {
      groups = cloneLayout(pinch.layouts[to.step]);
      saveState();
      rebuildGrid();
      pinchSteps =
        to.step === 0 ? null : { jid: pinch.jid, base: pinch.base, step: to.step, key: layoutKey(groups) };
    };
    if (pinch.zoomed) {
      // Hidden behind the zoom, the tiles take their new sizes first.
      if (to.step !== pinch.step) land();
      setZoom(null, { from });
      return;
    }
    animatePaneLayoutTransition(land, { lift: pinch.jid, from });
  }

  function removePane(jid) {
    if (!allJids().includes(jid)) return;
    animatePaneLayoutTransition(() => {
      detachJidFromGroups(jid);
      disposePane(jid);
      saveState();
      rebuildGrid(true);
      onRenderSessionListDecorations();
    });
  }

  function equalizeWeights() {
    animatePaneLayoutTransition(() => {
      const reset = (node) => {
        node.weight = 1;
        node.items?.forEach(reset);
      };
      groups.forEach(reset);
      saveState();
      rebuildGrid();
    });
  }

  // ── 2D Directional Drop & Swap Detection & Visual Preview ──────────────────
  // A thin band along the grid's outer edge drops beside everything (a full
  // column or row) rather than splitting the pane there. Top and bottom are
  // thinner so picking a pane up by its header does not land in the top band.
  const STAGE_EDGE_SIDE_PX = 28;
  const STAGE_EDGE_END_PX = 16;
  // A pane's drop zones are its thirds (computeDropTarget).
  const DROP_THIRD = 1 / 3;

  function stageEdgeTarget(clientX, clientY, stageRect) {
    if (!wideQuery.matches) return null;
    const g = gridEl.getBoundingClientRect();
    if (clientX < g.left || clientX > g.right || clientY < g.top || clientY > g.bottom) return null;
    const dist = {
      left: clientX - g.left,
      right: g.right - clientX,
      top: clientY - g.top,
      bottom: g.bottom - clientY,
    };
    const zone = ['left', 'right', 'top', 'bottom'].find(
      (z) => dist[z] < (z === 'left' || z === 'right' ? STAGE_EDGE_SIDE_PX : STAGE_EDGE_END_PX),
    );
    if (!zone) return null;
    const axis = zone === 'left' || zone === 'right' ? 'row' : 'column';
    // Show the share the new cell will get (placeAtStageEdge).
    const others = allJids().filter((j) => j !== dragSourceJid).length;
    const cells = groups.filter((cell) => {
      const ids = [];
      const walk = (n) => (n.jid ? ids.push(n.jid) : n.items.forEach(walk));
      walk(cell);
      return ids.some((j) => j !== dragSourceJid);
    }).length;
    const share = others === 0 ? 1 : axis === direction ? 1 / (cells + 1) : 1 / 2;
    const left = g.left - stageRect.left;
    const top = g.top - stageRect.top;
    const w = axis === 'row' ? g.width * share : g.width;
    const h = axis === 'column' ? g.height * share : g.height;
    const rect = {
      left: left + (zone === 'right' ? g.width - w : 0) + 6,
      top: top + (zone === 'bottom' ? g.height - h : 0) + 6,
      width: w - 12,
      height: h - 12,
    };
    const label = {
      left: '⇤ 最左側（整欄）',
      right: '最右側（整欄）⇥',
      top: '⤒ 最上方（整列）',
      bottom: '⤓ 最下方（整列）',
    }[zone];
    return { mode: 'edge', zone, rect, label };
  }

  function computeDropTarget(clientX, clientY) {
    const stageRect = stageEl.getBoundingClientRect();
    const paneEls = [...gridEl.querySelectorAll('.dashboard-pane')];
    if (paneEls.length === 0) {
      return {
        mode: 'stage',
        zone: 'right',
        rect: {
          left: 12,
          top: 12,
          width: Math.max(100, stageRect.width - 24),
          height: Math.max(100, stageRect.height - 24),
        },
        label: '放開以加入並排視窗',
      };
    }

    const edge = stageEdgeTarget(clientX, clientY, stageRect);
    if (edge) return edge;

    // Find hovered pane (or closest pane)
    let hoveredPane = paneEls.find((el) => {
      const r = el.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    });
    if (!hoveredPane) {
      hoveredPane = paneEls.reduce((best, el) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const d = Math.hypot(clientX - cx, clientY - cy);
        return !best || d < best.d ? { el, d } : best;
      }, null)?.el;
    }

    const r = hoveredPane.getBoundingClientRect();
    const relX = (clientX - r.left) / Math.max(1, r.width);
    const relY = (clientY - r.top) / Math.max(1, r.height);

    // 5-way zone detection by the finger/pointer, in thirds of the pane: the
    // top third drops above, the bottom third below, and the middle row is
    // left / swap (or add beside it from the sidebar) / right. Top and bottom
    // win the corners, so a pane picked up by the name at the left of its
    // header and dragged straight down flips above/below a third of the way
    // in, wherever it was grabbed (it used to take the outer 20%).
    const isExistingPaneDrag = Boolean(dragSourceJid && allJids().includes(dragSourceJid));
    // Over its own pane a drop changes nothing (placeSessionAt): no preview.
    if (hoveredPane.dataset.jid === dragSourceJid) return null;
    let zone;
    if (relY < DROP_THIRD) zone = 'top';
    else if (relY > 1 - DROP_THIRD) zone = 'bottom';
    else if (relX < DROP_THIRD) zone = 'left';
    else if (relX > 1 - DROP_THIRD) zone = 'right';
    else zone = 'swap';

    const localLeft = r.left - stageRect.left;
    const localTop = r.top - stageRect.top;
    let previewRect;
    let label;

    if (zone === 'swap') {
      previewRect = {
        left: localLeft + 6,
        top: localTop + 6,
        width: r.width - 12,
        height: r.height - 12,
      };
      label = isExistingPaneDrag ? '⇄ 交換視窗順序' : '➕ 加入此視窗旁';
    } else if (zone === 'top') {
      previewRect = { left: localLeft + 6, top: localTop + 6, width: r.width - 12, height: r.height / 2 - 8 };
      label = '↑ 垂直並排（上方）';
    } else if (zone === 'bottom') {
      previewRect = {
        left: localLeft + 6,
        top: localTop + r.height / 2 + 2,
        width: r.width - 12,
        height: r.height / 2 - 8,
      };
      label = '↓ 垂直並排（下方）';
    } else if (zone === 'left') {
      previewRect = { left: localLeft + 6, top: localTop + 6, width: r.width / 2 - 8, height: r.height - 12 };
      label = '← 水平並排（左側）';
    } else {
      previewRect = {
        left: localLeft + r.width / 2 + 2,
        top: localTop + 6,
        width: r.width / 2 - 8,
        height: r.height - 12,
      };
      label = '→ 水平並排（右側）';
    }

    return {
      mode: 'pane',
      jid: hoveredPane.dataset.jid,
      zone,
      rect: previewRect,
      label,
    };
  }

  function showDropPreview(target) {
    currentDropTarget = target;
    if (!target) {
      hideDropPreview();
      return;
    }
    dropPreviewEl.hidden = false;
    dropPreviewEl.style.left = `${Math.round(target.rect.left)}px`;
    dropPreviewEl.style.top = `${Math.round(target.rect.top)}px`;
    dropPreviewEl.style.width = `${Math.round(target.rect.width)}px`;
    dropPreviewEl.style.height = `${Math.round(target.rect.height)}px`;
    dropLabelEl.textContent = target.label;
    stageEl.classList.add('drag-over');
  }

  function hideDropPreview() {
    currentDropTarget = null;
    dropPreviewEl.hidden = true;
    stageEl.classList.remove('drag-over');
  }

  // HTML5 Drag & Drop on main / stage
  main.addEventListener('dragover', (e) => {
    const hasSession =
      dragSourceJid || e.dataTransfer?.types?.includes('text/piweb-session-jid');
    if (!hasSession) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copyMove';
    if (!active) setActive(true);
    const target = computeDropTarget(e.clientX, e.clientY);
    showDropPreview(target);
  });

  main.addEventListener('dragleave', (e) => {
    if (!main.contains(e.relatedTarget)) {
      hideDropPreview();
    }
  });

  main.addEventListener('drop', (e) => {
    const jid =
      e.dataTransfer?.getData('text/piweb-session-jid') || dragSourceJid;
    const target = currentDropTarget || computeDropTarget(e.clientX, e.clientY);
    hideDropPreview();
    dragSourceJid = null;
    if (!jid) return;
    e.preventDefault();
    if (!active) setActive(true);
    addPane(jid, target);
  });

  // Decorate each `.session-item` in the left sidebar with drag support + pin button
  function onRenderSessionListDecorations() {
    const sessions = getSessions();
    const jids = allJids();
    const items = sessionList.querySelectorAll('.session-item');
    items.forEach((item, index) => {
      const nameNode = item.querySelector('.name');
      const session =
        sessions.find((s) => s.jid === item.dataset.jid) ||
        sessions.find((s) => s.name === nameNode?.textContent) ||
        sessions[index];
      if (!session || session.kind === 'life') return;
      const jid = session.jid;
      item.dataset.jid = jid;
      item.draggable = true;
      const inDash = jids.includes(jid);
      item.classList.toggle('in-dashboard', inDash);

      if (!item.dataset.dashDragBound) {
        item.dataset.dashDragBound = '1';
        item.addEventListener('dragstart', (e) => {
          if (e.target.closest('input, .del') || pointerDrag) {
            e.preventDefault();
            return;
          }
          dragSourceJid = jid;
          item.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'copyMove';
            e.dataTransfer.setData('text/piweb-session-jid', jid);
            e.dataTransfer.setData('text/plain', session.name || jid);
          }
        });
        item.addEventListener('dragend', () => {
          dragSourceJid = null;
          item.classList.remove('dragging');
          hideDropPreview();
        });

        // Touch / Pen Pointer Drag fallback for iPad & Tablet
        item.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || e.target.closest('button, input')) return;
          if (e.pointerType === 'mouse') return;
          window.getSelection()?.removeAllRanges();
          pointerDrag = {
            source: 'sidebar',
            targetElement: item,
            jid,
            name: session.name || jid,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startScrollTop: sessionList.scrollTop,
            lastY: e.clientY,
            lastTime: performance.now(),
            velocity: 0,
            mode: null,
            started: false,
            ghost: null,
          };
        });
      }

      let tileBtn = item.querySelector('.session-tile-btn');
      if (!tileBtn) {
        tileBtn = el('button', 'icon-btn session-tile-btn');
        tileBtn.type = 'button';
        tileBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>';
        tileBtn.addEventListener('pointerdown', (e) => {
          if (
            gridEl.contains(document.activeElement) &&
            document.activeElement?.tagName === 'TEXTAREA'
          ) {
            e.preventDefault();
          }
        });
        tileBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (allJids().includes(jid) && active) {
            removePane(jid);
          } else {
            addPane(jid);
          }
        });
        const delBtn = item.querySelector('.del');
        if (delBtn) delBtn.before(tileBtn);
        else item.append(tileBtn);
      }
      tileBtn.classList.toggle('active', inDash);
      tileBtn.setAttribute('aria-pressed', String(inDash));
      tileBtn.title = inDash && active ? '從並排視窗移除' : '加入並排 Dashboard';
      tileBtn.setAttribute(
        'aria-label',
        inDash && active ? `Remove ${session.name} from dashboard` : `Tile ${session.name} in dashboard`,
      );
    });
  }

  // Tablet touch/pen pointer-drag handler
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;
      const dx = e.clientX - pointerDrag.startX;
      const dy = e.clientY - pointerDrag.startY;
      const isFromSidebar =
        pointerDrag.source === 'sidebar' ||
        Boolean(pointerDrag.targetElement?.closest('#session-list, .drawer'));

      if (!pointerDrag.mode) {
        if (Math.hypot(dx, dy) < 6) return;
        if (isFromSidebar) {
          // If vertical movement dominates, prioritize scrolling the session list
          if (Math.abs(dy) >= 6 && Math.abs(dy) >= Math.abs(dx)) {
            pointerDrag.mode = 'scroll';
          } else if (dx >= 16 && dx > Math.abs(dy) * 1.2) {
            // Dragging horizontally towards the dashboard stage
            pointerDrag.mode = 'drag';
          } else if (Math.abs(dy) >= 6) {
            pointerDrag.mode = 'scroll';
          } else {
            return;
          }
        } else {
          // Existing pane drag. A finger on a control jitters a little during
          // a plain tap, so it must travel further before the tap is given up.
          if (pointerDrag.fromControl && Math.hypot(dx, dy) < PANE_CONTROL_DRAG_PX) return;
          pointerDrag.mode = 'drag';
        }
      }

      if (pointerDrag.mode === 'scroll') {
        if (e.cancelable) e.preventDefault();
        sessionList.scrollTop = pointerDrag.startScrollTop - dy;
        const now = performance.now();
        const dt = now - pointerDrag.lastTime;
        if (dt > 10) {
          pointerDrag.velocity = (e.clientY - pointerDrag.lastY) / dt;
          pointerDrag.lastY = e.clientY;
          pointerDrag.lastTime = now;
        }
        return;
      }

      if (pointerDrag.mode === 'drag') {
        // Absolute scroll freeze: keep sessionList locked at startScrollTop so it NEVER scrolls while dragging!
        if (pointerDrag.startScrollTop !== undefined) {
          sessionList.scrollTop = pointerDrag.startScrollTop;
        }

        if (!pointerDrag.started) {
          pointerDrag.started = true;
          dragSourceJid = pointerDrag.jid;
          try {
            pointerDrag.targetElement?.setPointerCapture?.(e.pointerId);
          } catch {}
          document.body.classList.add('dashboard-pointer-dragging');
          window.getSelection()?.removeAllRanges();
          if (!active) setActive(true);
          if (!wideQuery.matches) document.getElementById('btn-hide-drawer')?.click();
          const ghost = el('div', 'dashboard-drag-ghost', `# ${pointerDrag.name}`);
          document.body.append(ghost);
          pointerDrag.ghost = ghost;
        }

        if (e.cancelable) e.preventDefault();
        if (pointerDrag.ghost) {
          pointerDrag.ghost.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY - 18}px, 0)`;
        }
        showDropPreview(computeDropTarget(e.clientX, e.clientY));
      }
    },
    { passive: false },
  );

  const finishPointerDrag = (e, commit) => {
    if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;
    const drag = pointerDrag;
    const target = currentDropTarget;
    try {
      drag.targetElement?.releasePointerCapture?.(e.pointerId);
    } catch {}
    pointerDrag = null;
    document.body.classList.remove('dashboard-pointer-dragging');
    drag.ghost?.remove();
    hideDropPreview();
    dragSourceJid = null;

    if (drag.mode === 'scroll' && Math.abs(drag.velocity) > 0.12) {
      let v = drag.velocity * 16;
      const momentumStep = () => {
        v *= 0.92;
        sessionList.scrollTop -= v;
        if (Math.abs(v) > 0.5) requestAnimationFrame(momentumStep);
      };
      requestAnimationFrame(momentumStep);
      return;
    }

    if (!drag.started) return;

    // The drag began on the name or a button: its trailing click is not a tap.
    if (drag.fromControl) suppressNextClick(drag.targetElement);

    // Ensure session list remains at original scroll position after drag
    if (drag.startScrollTop !== undefined) {
      sessionList.scrollTop = drag.startScrollTop;
    }

    const mainRect = main.getBoundingClientRect();
    const isOverMain =
      (typeof e.clientX === 'number' && e.clientX >= mainRect.left) ||
      (target && (target.mode === 'pane' || target.mode === 'edge'));

    if ((commit || target?.mode === 'pane' || target?.mode === 'edge') && isOverMain) {
      addPane(drag.jid, target || computeDropTarget(e.clientX, e.clientY));
    }
  };
  window.addEventListener('pointerup', (e) => finishPointerDrag(e, true));
  window.addEventListener('pointercancel', (e) => finishPointerDrag(e, false));

  // Two fingers anywhere on a pane either drag it, as its header does (the
  // pair's midpoint carries the ghost and picks the drop zone), or pinch it
  // (spread: a little bigger, then the whole stage; pinch: back down). The
  // first clear movement decides which. Touch events, not pointer events,
  // because only a cancelled touchmove keeps iOS from turning two fingers into
  // a scroll or a page pinch (which cancels the pointers).
  let twoFinger = null;
  const midpoint = (touches) => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  });
  const spread = (touches) =>
    Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  const endTwoFinger = (commit) => {
    const gesture = twoFinger;
    twoFinger = null;
    if (!gesture?.mode) return;
    twoFingerQuietUntil = performance.now() + 400;
    if (gesture.mode === 'pinch') {
      showPinchPreview(null);
      if (commit) settlePinch(gesture);
      else springPinchBack(gesture);
      return;
    }
    const target = currentDropTarget;
    document.body.classList.remove('dashboard-pointer-dragging');
    gesture.paneEl.classList.remove('dragging-pane');
    gesture.ghost?.remove();
    hideDropPreview();
    dragSourceJid = null;
    if (commit && (target?.mode === 'pane' || target?.mode === 'edge')) addPane(gesture.jid, target);
  };
  gridEl.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 2) {
        if (e.touches.length > 2) endTwoFinger(false);
        return;
      }
      if (twoFinger || pointerDrag?.started || allJids().length < 2) return;
      const paneEl = e.touches[0].target.closest?.('.dashboard-pane');
      if (!paneEl || paneEl !== e.touches[1].target.closest?.('.dashboard-pane')) return;
      const jid = paneEl.dataset.jid;
      // Zoomed, only the zoomed pane is on screen, and it can only be pinched.
      if (zoomedJid && jid !== zoomedJid) return;
      // The first finger may have armed a header drag; two fingers own it now.
      pointerDrag = null;
      const at = midpoint(e.touches);
      twoFinger = {
        jid,
        name: panes.get(jid)?.nameEl.textContent || jid,
        paneEl,
        startX: at.x,
        startY: at.y,
        startDistance: Math.max(1, spread(e.touches)),
        mode: null,
        ...pinchLadder(jid),
        ghost: null,
      };
    },
    { passive: true },
  );
  gridEl.addEventListener(
    'touchmove',
    (e) => {
      if (!twoFinger || e.touches.length !== 2) return;
      // A one-finger scroll already under way cannot be taken over.
      if (!e.cancelable) {
        endTwoFinger(false);
        return;
      }
      e.preventDefault();
      const at = midpoint(e.touches);
      const distance = spread(e.touches);
      if (!twoFinger.mode) {
        const moved = Math.hypot(at.x - twoFinger.startX, at.y - twoFinger.startY);
        const stretched = Math.abs(distance - twoFinger.startDistance);
        if (stretched >= 14 && stretched > moved) {
          twoFinger.mode = 'pinch';
          beginPinch(twoFinger);
        } else if (moved >= 10 && moved >= stretched && !zoomedJid) {
          twoFinger.mode = 'drag';
          dragSourceJid = twoFinger.jid;
          document.body.classList.add('dashboard-pointer-dragging');
          twoFinger.paneEl.classList.add('dragging-pane');
          window.getSelection()?.removeAllRanges();
          twoFinger.ghost = el('div', 'dashboard-drag-ghost', `# ${twoFinger.name}`);
          document.body.append(twoFinger.ghost);
        } else {
          return;
        }
      }
      if (twoFinger.mode === 'pinch') {
        trackPinch(twoFinger, at, distance);
        return;
      }
      twoFinger.ghost.style.transform = `translate3d(${at.x + 12}px, ${at.y - 18}px, 0)`;
      showDropPreview(computeDropTarget(at.x, at.y));
    },
    { passive: false },
  );
  gridEl.addEventListener('touchend', (e) => {
    if (twoFinger && e.touches.length < 2) endTwoFinger(true);
  });
  gridEl.addEventListener('touchcancel', () => endTwoFinger(false));
  // iOS Safari's own pinch gesture events: the pane's pinch owns two fingers.
  gridEl.addEventListener('gesturestart', (e) => {
    if (twoFinger) e.preventDefault();
  });

  // ── Controls & Listeners ───────────────────────────────────────────────────
  navEntry.addEventListener('click', () => {
    setActive(!active);
  });

  topbarBtn.addEventListener('click', () => {
    const activeSessionItem = sessionList.querySelector('.session-item.active');
    const currentJid = activeSessionItem?.dataset?.jid;
    if (currentJid && !allJids().includes(currentJid)) {
      addPane(currentJid);
    } else {
      setActive(true);
    }
  });

  // iPadOS optimization: prevent toolbar and sidebar tile buttons from stealing
  // focus and dismissing the virtual keyboard when a pane input is already focused.
  const preventTouchFocusSteal = (btn) => {
    btn.addEventListener('pointerdown', (e) => {
      if (
        gridEl.contains(document.activeElement) &&
        document.activeElement?.tagName === 'TEXTAREA'
      ) {
        e.preventDefault();
      }
    });
  };

  for (const btn of presetsEl.querySelectorAll('.dashboard-preset-btn')) {
    preventTouchFocusSteal(btn);
    btn.addEventListener('click', () => {
      applyPreset(btn.dataset.preset);
    });
  }

  preventTouchFocusSteal(btnDrawerToggle);
  btnDrawerToggle.addEventListener('click', () => {
    // The shell's own buttons, so the docked drawer slides (setDrawerCollapsed).
    // aria-expanded is the state being headed for, even mid-slide.
    const menu = document.getElementById('btn-menu');
    const hide = wideQuery.matches && menu?.getAttribute('aria-expanded') === 'true';
    (hide ? document.getElementById('btn-hide-drawer') : menu)?.click();
  });

  // While the docked drawer slides, the panes widen or narrow with transcripts
  // held at their width (as in a splitter drag), then the text flows into the
  // new width.
  app.addEventListener('drawermotionstart', () => {
    if (active) freezeTranscriptWidths();
  });
  app.addEventListener('drawermotionend', () => reflowTranscripts(360));

  // Height follows the shared .app/.main viewport shell on every device.
  // Do not maintain a second cached visualViewport height for the dashboard.
  // The keyboard only moves the input card (syncKeyboardLift). iOS may finish
  // its keyboard layout after the last viewport event, so sample again briefly.
  // The first sample waits a frame: viewport-shell.js, bound after this, must
  // first update `keyboard-shell` for the same event.
  let liftTimers = [];
  const scheduleKeyboardLift = () => {
    for (const timer of liftTimers) clearTimeout(timer);
    liftTimers = [0, 120, 350, 700].map((delay) => setTimeout(() => syncKeyboardLift(), delay));
  };
  window.visualViewport?.addEventListener('resize', scheduleKeyboardLift);
  window.visualViewport?.addEventListener('scroll', scheduleKeyboardLift);
  window.addEventListener('resize', scheduleKeyboardLift);
  document.addEventListener('focusout', scheduleKeyboardLift);

  syncNavCounts();

  return {
    get active() {
      return active;
    },
    /** The textarea of the pane that shows the composer card. */
    composerTextarea() {
      return panes.get(composerJid)?.textarea ?? null;
    },
    setActive,
    addPane,
    revealSession,
    removePane,
    applyPreset,
    equalizeWeights,
    /** A selection in `jid`'s pane quotes itself, as in the chat: the card
     *  comes to that pane (no hop, no focus, so no keyboard) carrying the quote.
     *  The text stays where it is unless the card now covers it; then the
     *  transcript scrolls just enough to lift it above the card, never past the
     *  pane's top. Returns that scroll (px) for the pill to follow. */
    quoteSelection(jid, text, rect) {
      const pane = panes.get(jid);
      if (!pane) return 0;
      const scroller = pane.messagesEl;
      const from = scroller.scrollTop;
      // Not the keep-at-bottom jump either (selectComposerPane, the observer):
      // it scrolled a selection near the top out of the pane.
      pane.holdScroll = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          pane.holdScroll = false;
        }),
      );
      selectComposerPane(jid, { animate: false });
      pane.pendingQuote = (text || '').trim();
      pane.renderQuote?.();
      scroller.scrollTop = from;
      if (rect) {
        const view = scroller.getBoundingClientRect();
        const over = rect.bottom - (view.bottom - 8);
        const room = rect.top - (view.top + 8);
        if (over > 0 && room > 0) scroller.scrollTop = from + Math.min(over, room);
      }
      return scroller.scrollTop - from;
    },
    setPaneQuote(jid, text, focusInput = false) {
      const pane = panes.get(jid);
      if (!pane) return;
      pane.pendingQuote = (text || '').trim();
      pane.renderQuote?.();
      if (focusInput && pane.textarea) {
        // Quote goes to this pane's card: bring the card here before focusing it.
        selectComposerPane(jid);
        pane.textarea.focus({ preventScroll: true });
      }
    },
    syncSessions() {
      const validJids = new Set(getSessions().map((s) => s.jid));
      if (validJids.size > 0) {
        const beforeCount = allJids().length;
        const prune = (node) => {
          node.items = node.items.filter((it) => {
            if (it.items) {
              prune(it);
              return true;
            }
            const keep = validJids.has(it.jid);
            if (!keep) disposePane(it.jid);
            return keep;
          });
        };
        groups.forEach(prune);
        normalizeGroups();
        if (allJids().length !== beforeCount) saveState();
      }
      for (const pane of panes.values()) syncPaneHeader(pane);
      if (active) rebuildGrid();
      else syncNavCounts();
      onRenderSessionListDecorations();
    },
  };
}
