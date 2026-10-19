/**
 * Responsive Multi-Session 2D Tiling Dashboard
 *
 * Supports both horizontal (left/right columns) and vertical (top/bottom rows)
 * automatic alignment and directional drop zones (left, right, top, bottom),
 * with independent draggable vertical AND horizontal resize splitters.
 */

const DASHBOARD_STORAGE_KEY = 'piweb.dashboard';
const MIN_PANE_WIDTH_PX = 140;
const MIN_PANE_HEIGHT_PX = 95;

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
}) {
  const wideQuery = window.matchMedia('(min-width: 768px)');
  let active = false;
  let panes = new Map(); // jid -> pane state
  /**
   * 2D Grid State:
   * - `direction`: 'row' (columns of rows) or 'column' (rows of columns)
   * - `groups`: Array<{ weight: number, items: Array<{ jid: string, weight: number }> }>
   */
  let direction = 'row';
  let groups = [];
  let dragSourceJid = null;
  let pointerDrag = null;
  let currentDropTarget = null; // { mode: 'stage' | 'pane', jid?: string, zone: 'left' | 'right' | 'top' | 'bottom' }

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
    for (const g of groups) {
      for (const item of g.items) {
        if (item.jid && !out.includes(item.jid)) out.push(item.jid);
      }
    }
    return out;
  }

  function normalizeGroups() {
    const seen = new Set();
    const cleaned = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.items)) continue;
      const items = [];
      for (const it of g.items) {
        if (!it || typeof it.jid !== 'string' || !it.jid || seen.has(it.jid)) continue;
        seen.add(it.jid);
        items.push({
          jid: it.jid,
          weight: Number.isFinite(it.weight) && it.weight > 0.05 ? Number(it.weight) : 1,
        });
      }
      if (items.length > 0) {
        if (items.length === 1) {
          // If only one pane remains in this column/row group, it MUST take 100% of the group!
          items[0].weight = 1;
        } else {
          // In CSS flexbox, if sum of flex-grow < 1, empty space is left unallocated.
          // Scale item weights up so sum is >= 1.
          const totalItemWeight = items.reduce((sum, it) => sum + it.weight, 0);
          if (totalItemWeight > 0 && totalItemWeight < 1) {
            for (const it of items) {
              it.weight = Number((it.weight / totalItemWeight).toFixed(4));
            }
          }
        }
        cleaned.push({
          weight: Number.isFinite(g.weight) && g.weight > 0.05 ? Number(g.weight) : 1,
          items,
        });
      }
    }
    if (cleaned.length === 1) {
      cleaned[0].weight = 1;
    } else if (cleaned.length > 1) {
      const totalGroupWeight = cleaned.reduce((sum, g) => sum + g.weight, 0);
      if (totalGroupWeight > 0 && totalGroupWeight < 1) {
        for (const g of cleaned) {
          g.weight = Number((g.weight / totalGroupWeight).toFixed(4));
        }
      }
    }
    groups = cleaned;
  }

  let cloudSyncTimer = null;
  function scheduleCloudSave() {
    if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(async () => {
      try {
        if (typeof api !== 'function') return;
        const payload = {
          direction,
          groups: groups.map((g) => ({
            weight: Number(g.weight.toFixed(4)),
            items: g.items.map((it) => ({
              jid: it.jid,
              weight: Number(it.weight.toFixed(4)),
            })),
          })),
          updatedAt: localUpdatedAt,
        };
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
          localStorage.setItem(
            DASHBOARD_STORAGE_KEY,
            JSON.stringify({
              direction,
              groups: groups.map((g) => ({
                weight: Number(g.weight.toFixed(4)),
                items: g.items.map((it) => ({
                  jid: it.jid,
                  weight: Number(it.weight.toFixed(4)),
                })),
              })),
              updatedAt: localUpdatedAt,
            }),
          );
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
      localStorage.setItem(
        DASHBOARD_STORAGE_KEY,
        JSON.stringify({
          direction,
          groups: groups.map((g) => ({
            weight: Number(g.weight.toFixed(4)),
            items: g.items.map((it) => ({
              jid: it.jid,
              weight: Number(it.weight.toFixed(4)),
            })),
          })),
          updatedAt: localUpdatedAt,
        }),
      );
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
    titleWrap.append(hash, nameEl, nameInput, badgeEl, spinnerEl);

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
    focusBtn.title = '單獨放大檢視此 Session';
    focusBtn.setAttribute('aria-label', `Expand ${session?.name || jid}`);
    focusBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';

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
        <span class="mi-label">單獨放大檢視</span>
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

    paneEl.append(
      header,
      menuScrim,
      moreMenu,
      searchPanel,
      btwCard,
      messagesEl,
      btwMessagesEl,
      jumpBtn,
      typingEl,
      btwPendingRow,
      composerWrap,
    );

    // Mount pinned prompt bar inside the pane right above messagesEl
    if (typeof createPromptPin === 'function') {
      createPromptPin({
        scroller: messagesEl,
        isCommand: isCommandEchoText,
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
      messagesEl,
      btwMessagesEl,
      jumpBtn,
      typingEl,
      btwPendingRow,
      btwPendingLink,
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
        openLightbox(img.getAttribute('src'), urls.length ? urls : [img.getAttribute('src')]);
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

    header.addEventListener('pointerdown', (e) => {
      if (
        !wideQuery.matches ||
        e.button !== 0 ||
        e.target.closest('button, input, textarea, [role="button"]')
      )
        return;
      if (e.pointerType === 'mouse') return;
      window.getSelection()?.removeAllRanges();
      pointerDrag = {
        source: 'pane',
        targetElement: header,
        jid,
        name: nameEl.textContent || jid,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        ghost: null,
      };
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
      setActive(false);
      onSelectSingleSession(jid);
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
      } else if (action === 'commands-running') {
        onOpenCommandsRunning(jid);
      } else if (action === 'btw') {
        void openPaneBtw();
      } else if (action === 'subagents') {
        onOpenSubagents(jid);
      } else if (action === 'media') {
        onOpenMediaSheet(jid);
      } else if (action === 'split-dir') {
        togglePaneAxis(jid);
      } else if (action === 'expand') {
        setActive(false);
        onSelectSingleSession(jid);
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
                const { events } = await api(
                  `/api/sessions/${encodeURIComponent(jid)}/events?around=${hit.id}&limit=50`,
                );
                if (pane.disposed) return;
                messagesEl.replaceChildren();
                for (const ev of events || []) {
                  appendPaneEvent(pane, ev, false);
                }
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
            openLightbox(attachment.url, [attachment.url]),
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

  async function hydratePane(pane) {
    try {
      const { events, busy, partial, session } = await api(
        `/api/sessions/${encodeURIComponent(pane.jid)}/events?limit=50`,
      );
      if (pane.disposed) return;
      pane.messagesEl.replaceChildren();
      pane.partialThinkingEl = null;
      pane.partialMsgEl = null;
      pane.cursor = 0;
      for (const ev of events || []) {
        appendPaneEvent(pane, ev, false);
      }
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

  function disposePane(jid) {
    const pane = panes.get(jid);
    if (!pane) return;
    pane.disposed = true;
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

  function animatePaneLayoutTransition(mutateLayoutFn) {
    if (!active || prefersReducedMotion() || gridEl.hidden) {
      mutateLayoutFn();
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

    // 2. Execute layout mutation & DOM update
    mutateLayoutFn();

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
  }

  function createAxisSplitter({
    axis, // 'x' (vertical bar resizing width) or 'y' (horizontal bar resizing height)
    label,
    firstEl,
    secondEl,
    getWeights,
    setWeights,
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
      const firstRect = firstEl.getBoundingClientRect();
      const secondRect = secondEl.getBoundingClientRect();
      const firstSize = isHorizontalDrag ? firstRect.width : firstRect.height;
      const secondSize = isHorizontalDrag ? secondRect.width : secondRect.height;
      const totalPx = firstSize + secondSize;
      const minPx = isHorizontalDrag ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX;
      if (totalPx <= minPx * 2) return;

      const [startW1, startW2] = getWeights();
      const totalWeight = startW1 + startW2;

      activeResizerCount++;
      splitter.classList.add('dragging');
      gridEl.classList.add('resizing-active');
      try {
        splitter.setPointerCapture(e.pointerId);
      } catch {
        // Ignore synthetic pointer events without active pointerId
      }

      let currentFirstPx = firstSize;
      let lastMovePos = startPos;
      let lastMoveTime = performance.now();
      let velocityPxPerSec = 0;
      let hitBoundDuringDrag = 0; // -1 (hit min), 1 (hit max), 0 (none)

      const applyFirstPx = (px) => {
        const clamped = Math.max(minPx, Math.min(totalPx - minPx, px));
        currentFirstPx = clamped;
        const firstRatio = clamped / totalPx;
        setWeights(totalWeight * firstRatio, totalWeight * (1 - firstRatio));
        return clamped;
      };

      // 120Hz+ zero-lag direct style mutation on every pointermove / coalesced event
      const applyPosition = (clientPos, nowTime) => {
        const dt = Math.max(1, nowTime - lastMoveTime);
        const instVel = ((clientPos - lastMovePos) / dt) * 1000;
        velocityPxPerSec = velocityPxPerSec * 0.35 + instVel * 0.65;
        lastMovePos = clientPos;
        lastMoveTime = nowTime;

        const rawFirstPx = firstSize + (clientPos - startPos);
        if (rawFirstPx <= minPx) {
          if (hitBoundDuringDrag !== -1) {
            hitBoundDuringDrag = -1;
            triggerWallImpactBounce(firstEl, axis, -1, 1.35);
          }
        } else if (rawFirstPx >= totalPx - minPx) {
          if (hitBoundDuringDrag !== 1) {
            hitBoundDuringDrag = 1;
            triggerWallImpactBounce(secondEl, axis, 1, 1.35);
          }
        } else {
          hitBoundDuringDrag = 0;
        }
        applyFirstPx(rawFirstPx);
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
        const totalDelta = currentFirstPx - firstSize;
        const timeSinceMove = performance.now() - lastMoveTime;
        const dragSign =
          Math.abs(totalDelta) > 2
            ? Math.sign(totalDelta)
            : Math.abs(velocityPxPerSec) > 20
              ? Math.sign(velocityPxPerSec)
              : 0;

        if (!prefersReducedMotion() && dragSign !== 0 && Math.abs(totalDelta) > 3) {
          const restPx = currentFirstPx;
          const isX = axis === 'x';
          const origFirstSize = currentFirstPx;
          const origSecondSize = totalPx - origFirstSize;

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
            applyFirstPx(restPx);
            saveState();
            activeSpringCleanup = null;
          };
          activeSpringCleanup = cleanup;
          animSplitter.onfinish = cleanup;
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    });

    return splitter;
  }

  let lastLayoutSignature = '';

  function computeLayoutSignature() {
    return `${direction}|${groups.map((g) => g.items.map((it) => it.jid).join(',')).join(';')}`;
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

    // iPadOS Safari critical fix: NEVER call replaceChildren() when the group/pane
    // topology hasn't changed! Re-parenting a focused <textarea> on iOS/iPadOS WebKit
    // immediately blurs it and collapses the software keyboard (especially on the 5s poll).
    const nextSignature = computeLayoutSignature();
    if (!forceRebuildDOM && nextSignature === lastLayoutSignature && gridEl.children.length > 0) {
      const groupEls = [...gridEl.querySelectorAll(':scope > .dashboard-group')];
      groups.forEach((group, gIdx) => {
        const groupEl = groupEls[gIdx];
        const groupWeight = groups.length === 1 ? 1 : group.weight;
        if (groupEl) groupEl.style.flex = `${groupWeight} 1 0px`;
        group.items.forEach((item) => {
          const pane = panes.get(item.jid);
          const itemWeight = group.items.length === 1 ? 1 : item.weight;
          if (pane) pane.el.style.flex = `${itemWeight} 1 0px`;
        });
      });
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

    const outerAxis = direction === 'row' ? 'x' : 'y';
    const innerAxis = direction === 'row' ? 'y' : 'x';
    const innerDirection = direction === 'row' ? 'column' : 'row';

    const groupEls = groups.map((group) => {
      const groupEl = el('div', `dashboard-group dashboard-group-${innerDirection}`);
      groupEl.style.flexDirection = innerDirection;
      const groupWeight = groups.length === 1 ? 1 : group.weight;
      groupEl.style.flex = `${groupWeight} 1 0px`;

      const itemChildren = [];
      group.items.forEach((item, itemIdx) => {
        const pane = panes.get(item.jid);
        if (!pane) return;
        const itemWeight = group.items.length === 1 ? 1 : item.weight;
        pane.el.style.flex = `${itemWeight} 1 0px`;
        itemChildren.push(pane.el);

        if (itemIdx < group.items.length - 1) {
          const nextItem = group.items[itemIdx + 1];
          const nextPane = panes.get(nextItem.jid);
          if (nextPane) {
            const firstJid = item.jid;
            const secondJid = nextItem.jid;
            itemChildren.push(
              createAxisSplitter({
                axis: innerAxis,
                label:
                  innerAxis === 'y'
                    ? `Resize vertical panes ${itemIdx + 1} and ${itemIdx + 2}`
                    : `Resize horizontal panes ${itemIdx + 1} and ${itemIdx + 2}`,
                firstEl: pane.el,
                secondEl: nextPane.el,
                getWeights: () => {
                  const loc1 = findJidLocation(firstJid);
                  const loc2 = findJidLocation(secondJid);
                  const w1 = loc1 ? groups[loc1.gIdx].items[loc1.iIdx].weight : 1;
                  const w2 = loc2 ? groups[loc2.gIdx].items[loc2.iIdx].weight : 1;
                  return [w1, w2];
                },
                setWeights: (w1, w2) => {
                  const loc1 = findJidLocation(firstJid);
                  const loc2 = findJidLocation(secondJid);
                  if (loc1) groups[loc1.gIdx].items[loc1.iIdx].weight = w1;
                  if (loc2) groups[loc2.gIdx].items[loc2.iIdx].weight = w2;
                  pane.el.style.flex = `${w1} 1 0px`;
                  nextPane.el.style.flex = `${w2} 1 0px`;
                },
              }),
            );
          }
        }
      });

      groupEl.replaceChildren(...itemChildren);
      return groupEl;
    });

    const gridChildren = [];
    groupEls.forEach((groupEl, gIdx) => {
      gridChildren.push(groupEl);
      if (gIdx < groupEls.length - 1) {
        const nextGroupEl = groupEls[gIdx + 1];
        gridChildren.push(
          createAxisSplitter({
            axis: outerAxis,
            label:
              outerAxis === 'x'
                ? `Resize columns ${gIdx + 1} and ${gIdx + 2}`
                : `Resize rows ${gIdx + 1} and ${gIdx + 2}`,
            firstEl: groupEl,
            secondEl: nextGroupEl,
            getWeights: () => [
              groups[gIdx]?.weight ?? 1,
              groups[gIdx + 1]?.weight ?? 1,
            ],
            setWeights: (w1, w2) => {
              if (groups[gIdx]) groups[gIdx].weight = w1;
              if (groups[gIdx + 1]) groups[gIdx + 1].weight = w2;
              groupEl.style.flex = `${w1} 1 0px`;
              nextGroupEl.style.flex = `${w2} 1 0px`;
            },
          }),
        );
      }
    });

    gridEl.replaceChildren(...gridChildren);

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
    for (const g of groups) {
      const idx = g.items.findIndex((it) => it.jid === jid);
      if (idx !== -1) g.items.splice(idx, 1);
    }
    normalizeGroups();
  }

  function findJidLocation(jid) {
    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const iIdx = groups[gIdx].items.findIndex((it) => it.jid === jid);
      if (iIdx !== -1) return { gIdx, iIdx };
    }
    return null;
  }

  function swapPanesInPlace(jidA, jidB) {
    if (!jidA || !jidB || jidA === jidB) return false;
    const locA = findJidLocation(jidA);
    const locB = findJidLocation(jidB);
    if (!locA || !locB) return false;
    groups[locA.gIdx].items[locA.iIdx].jid = jidB;
    groups[locB.gIdx].items[locB.iIdx].jid = jidA;
    return true;
  }

  function placeSessionAt(jid, target = null) {
    if (!jid || jid === 'web:life') return;
    if (target?.mode === 'pane' && target.jid === jid) return;

    // Direct swap when dragging an existing pane onto another pane's center, or adding alongside target pane
    if (target?.mode === 'pane' && target.zone === 'swap' && target.jid) {
      if (swapPanesInPlace(jid, target.jid)) return;
      // If `jid` was dragged from the sidebar (not yet in dashboard), insert as a new pane adjacent to target.jid
      const loc = findJidLocation(target.jid);
      if (loc) {
        detachJidFromGroups(jid);
        groups.splice(loc.gIdx + 1, 0, { weight: 1, items: [{ jid, weight: 1 }] });
        return;
      }
    }

    detachJidFromGroups(jid);

    if (!target || groups.length === 0) {
      groups.push({ weight: 1, items: [{ jid, weight: 1 }] });
      return;
    }

    const zone = target.zone || 'right';
    const loc = target.jid ? findJidLocation(target.jid) : null;

    if (direction === 'row') {
      // Outer groups are columns (left/right); inner items are rows (top/bottom)
      if (zone === 'left' || zone === 'right') {
        const insertAt = loc
          ? zone === 'left'
            ? loc.gIdx
            : loc.gIdx + 1
          : zone === 'left'
            ? 0
            : groups.length;
        groups.splice(insertAt, 0, { weight: 1, items: [{ jid, weight: 1 }] });
      } else {
        // 'top' or 'bottom'
        if (loc) {
          const grp = groups[loc.gIdx];
          const insertItemAt = zone === 'top' ? loc.iIdx : loc.iIdx + 1;
          grp.items.splice(insertItemAt, 0, { jid, weight: 1 });
        } else {
          const firstGrp = groups[0];
          if (zone === 'top') firstGrp.items.unshift({ jid, weight: 1 });
          else firstGrp.items.push({ jid, weight: 1 });
        }
      }
    } else {
      // direction === 'column': Outer groups are rows (top/bottom); inner items are columns (left/right)
      if (zone === 'top' || zone === 'bottom') {
        const insertAt = loc
          ? zone === 'top'
            ? loc.gIdx
            : loc.gIdx + 1
          : zone === 'top'
            ? 0
            : groups.length;
        groups.splice(insertAt, 0, { weight: 1, items: [{ jid, weight: 1 }] });
      } else {
        // 'left' or 'right'
        if (loc) {
          const grp = groups[loc.gIdx];
          const insertItemAt = zone === 'left' ? loc.iIdx : loc.iIdx + 1;
          grp.items.splice(insertItemAt, 0, { jid, weight: 1 });
        } else {
          const firstGrp = groups[0];
          if (zone === 'left') firstGrp.items.unshift({ jid, weight: 1 });
          else firstGrp.items.push({ jid, weight: 1 });
        }
      }
    }
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
    const loc = findJidLocation(jid);
    if (!loc) return;

    animatePaneLayoutTransition(() => {
      const grp = groups[loc.gIdx];
      if (grp.items.length > 1) {
        // Currently stacked with another pane -> extract to its own outer group next to this one
        const [removed] = grp.items.splice(loc.iIdx, 1);
        groups.splice(loc.gIdx + 1, 0, { weight: 1, items: [removed] });
      } else if (groups.length > 1) {
        // Currently in its own outer group -> merge into neighbor group to stack perpendicularly
        const targetGroupIdx = loc.gIdx > 0 ? loc.gIdx - 1 : 1;
        const [removedGroup] = groups.splice(loc.gIdx, 1);
        const neighbor = groups[loc.gIdx > 0 ? targetGroupIdx : 0];
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
    syncDashboardVisualViewport();

    if (active) {
      rebuildGrid();
      for (const pane of panes.values()) {
        scrollPaneToLatest(pane);
        void hydratePane(pane);
      }
    } else {
      for (const pane of panes.values()) {
        if (pane.source) {
          pane.source.close();
          pane.source = null;
        }
        clearTimeout(pane.reconnectTimer);
      }
    }
    if (active && !wideQuery.matches) document.getElementById('btn-hide-drawer')?.click();
    onRenderSessionListDecorations();
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
      if (dropTarget && dropTarget.mode === 'pane') {
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
      for (const g of groups) {
        g.weight = 1;
        for (const it of g.items) it.weight = 1;
      }
      saveState();
      rebuildGrid();
    });
  }

  // ── 2D Directional Drop & Swap Detection & Visual Preview ──────────────────
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

    // 5-Way zone detection:
    // - Center region (20%..80% on both axes) => 'swap' (替換或交換此視窗)
    // - Top / Bottom / Left / Right edges => directional split
    const isExistingPaneDrag = Boolean(dragSourceJid && allJids().includes(dragSourceJid));
    const isSamePane = hoveredPane.dataset.jid === dragSourceJid;
    const inCenter = relX > 0.20 && relX < 0.80 && relY > 0.20 && relY < 0.80;

    const distTop = relY;
    const distBottom = 1 - relY;
    const distLeft = relX;
    const distRight = 1 - relX;
    const minDist = Math.min(distTop, distBottom, distLeft, distRight);

    let zone = 'right';
    if (inCenter && !isSamePane) {
      zone = 'swap';
    } else if (minDist === distTop && distTop < 0.25) {
      zone = 'top';
    } else if (minDist === distBottom && distBottom < 0.25) {
      zone = 'bottom';
    } else if (minDist === distLeft) {
      zone = 'left';
    } else {
      zone = 'right';
    }

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
    if (!wideQuery.matches) return;
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
    if (!wideQuery.matches) return;
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
      const session = sessions.find((s) => s.name === nameNode?.textContent) || sessions[index];
      if (!session || session.kind === 'life') return;
      const jid = session.jid;
      item.dataset.jid = jid;
      item.draggable = true;
      const inDash = jids.includes(jid);
      item.classList.toggle('in-dashboard', inDash);

      if (!item.dataset.dashDragBound) {
        item.dataset.dashDragBound = '1';
        item.addEventListener('dragstart', (e) => {
          if (!wideQuery.matches || e.target.closest('input, .del') || pointerDrag) {
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
          if (!wideQuery.matches || e.button !== 0 || e.target.closest('button, input')) return;
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
          // Existing pane drag
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

    // Ensure session list remains at original scroll position after drag
    if (drag.startScrollTop !== undefined) {
      sessionList.scrollTop = drag.startScrollTop;
    }

    const mainRect = main.getBoundingClientRect();
    const isOverMain =
      (typeof e.clientX === 'number' && e.clientX >= mainRect.left) ||
      (target && target.mode === 'pane');

    if ((commit || target?.mode === 'pane') && isOverMain) {
      addPane(drag.jid, target || computeDropTarget(e.clientX, e.clientY));
    }
  };
  window.addEventListener('pointerup', (e) => finishPointerDrag(e, true));
  window.addEventListener('pointercancel', (e) => finishPointerDrag(e, false));

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
    if (wideQuery.matches) app.classList.toggle('drawer-collapsed');
    else document.getElementById('btn-menu')?.click();
  });

  // iPadOS visualViewport keyboard inset sync: shrink #dashboard-view height
  // dynamically when the iPad software keyboard opens so bottom panes are never
  // covered by the keyboard and never trigger document-level scroll/blur jumps.
  function syncDashboardVisualViewport() {
    if (!active) {
      root.style.removeProperty('--dashboard-vv-h');
      return;
    }
    const vv = window.visualViewport;
    if (vv && vv.height > 200) {
      root.style.setProperty('--dashboard-vv-h', `${Math.round(vv.height)}px`);
    } else {
      root.style.removeProperty('--dashboard-vv-h');
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncDashboardVisualViewport);
    window.visualViewport.addEventListener('scroll', syncDashboardVisualViewport);
  }
  window.addEventListener('resize', syncDashboardVisualViewport);

  wideQuery.addEventListener('change', syncDashboardVisualViewport);

  syncNavCounts();

  return {
    get active() {
      return active;
    },
    setActive,
    addPane,
    removePane,
    applyPreset,
    equalizeWeights,
    setPaneQuote(jid, text, focusInput = false) {
      const pane = panes.get(jid);
      if (!pane) return;
      pane.pendingQuote = (text || '').trim();
      pane.renderQuote?.();
      if (focusInput && pane.textarea) {
        pane.textarea.focus({ preventScroll: true });
      }
    },
    syncSessions() {
      const validJids = new Set(getSessions().map((s) => s.jid));
      if (validJids.size > 0) {
        const beforeCount = allJids().length;
        for (const g of groups) {
          g.items = g.items.filter((it) => {
            const keep = validJids.has(it.jid);
            if (!keep) disposePane(it.jid);
            return keep;
          });
        }
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
