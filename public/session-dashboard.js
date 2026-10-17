/**
 * Desktop & Tablet Multi-Session 2D Tiling Dashboard (>= 768px)
 *
 * Supports both horizontal (left/right columns) and vertical (top/bottom rows)
 * automatic alignment and directional drop zones (left, right, top, bottom),
 * with independent draggable vertical AND horizontal resize splitters.
 */

const DASHBOARD_STORAGE_KEY = 'piweb.dashboard';
const MIN_PANE_WIDTH_PX = 140;
const MIN_PANE_HEIGHT_PX = 95;

export function createSessionDashboard({
  app,
  drawer,
  sessionList,
  main,
  api,
  getSessions,
  getSessionBadge,
  buildEventNode,
  streamRich,
  canReuseRich,
  trySendCommand,
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
        <button type="button" class="icon-btn dashboard-back-btn" id="btn-dashboard-exit" aria-label="回單一對話" title="回單一對話">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
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
      <div class="dashboard-toolbar-actions">
        <button type="button" class="icon-btn dashboard-icon-action" id="btn-dashboard-equalize" aria-label="平均對齊所有並排視窗" title="平均對齊所有視窗大小" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>
        <button type="button" class="icon-btn dashboard-icon-action" id="btn-dashboard-clear" aria-label="清空並排視窗" title="清空所有並排視窗" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>
        </button>
      </div>
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
  const btnEqualize = root.querySelector('#btn-dashboard-equalize');
  const btnClear = root.querySelector('#btn-dashboard-clear');
  const btnExit = root.querySelector('#btn-dashboard-exit');
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
          weight: Number.isFinite(it.weight) && it.weight > 0.1 ? Number(it.weight) : 1,
        });
      }
      if (items.length > 0) {
        cleaned.push({
          weight: Number.isFinite(g.weight) && g.weight > 0.1 ? Number(g.weight) : 1,
          items,
        });
      }
    }
    groups = cleaned;
  }

  function loadSavedState() {
    try {
      const raw = JSON.parse(localStorage.getItem(DASHBOARD_STORAGE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return;
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

  function saveState() {
    try {
      normalizeGroups();
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
        }),
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  loadSavedState();

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
    btnEqualize.hidden = count < 2;
    btnClear.hidden = count === 0;
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

  // ── Pane Lifecycle & Live Stream ───────────────────────────────────────────
  function createPaneDOM(jid) {
    const session = getSessions().find((s) => s.jid === jid);
    const paneEl = el('article', 'dashboard-pane');
    paneEl.dataset.jid = jid;
    paneEl.setAttribute('aria-label', `Session pane ${session?.name || jid}`);

    // Header
    const header = el('header', 'dashboard-pane-header');
    header.draggable = true;
    header.title = '拖曳標題列至其他視窗的上下左右邊緣可水平或垂直分割';

    const titleWrap = el('div', 'dashboard-pane-title');
    const hash = el('span', 'hash', '#');
    const nameEl = el('span', 'pane-session-name', session?.name || jid);
    const badgeEl = el('span', 'provider-badge');
    badgeEl.hidden = true;
    const spinnerEl = el('span', 'work-spinner');
    spinnerEl.hidden = true;
    titleWrap.append(hash, nameEl, badgeEl, spinnerEl);

    const actions = el('div', 'dashboard-pane-actions');
    const stopBtn = el('button', 'icon-btn danger pane-stop-btn');
    stopBtn.type = 'button';
    stopBtn.title = 'Stop task';
    stopBtn.setAttribute('aria-label', `Stop ${session?.name || jid}`);
    stopBtn.hidden = true;
    stopBtn.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

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

    actions.append(stopBtn, splitDownBtn, focusBtn, closeBtn);
    header.append(titleWrap, actions);

    // Messages scroller
    const messagesEl = el('div', 'messages dashboard-pane-messages');
    const jumpBtn = el('button', 'jump-live pane-jump-live', 'Jump to present ↓');
    jumpBtn.type = 'button';

    // Typing row
    const typingEl = el('div', 'typing dashboard-pane-typing');
    typingEl.hidden = true;
    typingEl.innerHTML =
      '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="typing-label">pi is working…</span>';

    // Composer
    const composerWrap = el('div', 'composer-wrap dashboard-pane-composer-wrap');
    const form = el('form', 'composer dashboard-pane-composer');
    const textarea = el('textarea', 'dashboard-pane-input');
    textarea.rows = 1;
    textarea.placeholder = `Message ${session?.name || 'pi'}…`;
    textarea.setAttribute('aria-label', `Message ${session?.name || jid}`);
    const sendBtn = el('button', 'icon-btn send dashboard-pane-send');
    sendBtn.type = 'submit';
    sendBtn.title = 'Send';
    sendBtn.setAttribute('aria-label', `Send to ${session?.name || jid}`);
    sendBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" /></svg>';
    form.append(textarea, sendBtn);
    composerWrap.append(form);

    paneEl.append(header, messagesEl, jumpBtn, typingEl, composerWrap);

    const pane = {
      jid,
      el: paneEl,
      header,
      nameEl,
      badgeEl,
      spinnerEl,
      stopBtn,
      splitDownBtn,
      focusBtn,
      closeBtn,
      messagesEl,
      jumpBtn,
      typingEl,
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
    };

    const isNearBottom = () =>
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= 28;
    const scrollToBottom = (instant = false) => {
      pane.userScrolledUp = false;
      messagesEl.scrollTo({
        top: messagesEl.scrollHeight,
        behavior: instant ? 'auto' : 'smooth',
      });
      jumpBtn.classList.remove('visible');
    };
    messagesEl.addEventListener(
      'scroll',
      () => {
        const near = isNearBottom();
        if (near) pane.userScrolledUp = false;
        jumpBtn.classList.toggle('visible', !near);
      },
      { passive: true },
    );
    // Any explicit user touch/wheel/pointer interaction on the message list locks out auto-scroll
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

    messagesEl.addEventListener('click', (e) => {
      const img = e.target.closest?.('.msg-files img, .msg-text img');
      if (img && img.src) {
        const urls = [...messagesEl.querySelectorAll('.msg-files img, .msg-text img')]
          .map((node) => node.getAttribute('src'))
          .filter(Boolean);
        openLightbox(img.getAttribute('src'), urls.length ? urls : [img.getAttribute('src')]);
      }
    });

    header.addEventListener('dragstart', (e) => {
      if (e.target.closest('button')) {
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

    // Touch / Pen Pointer Drag on pane header so iPad/tablet users can drag panes to swap order
    header.addEventListener('pointerdown', (e) => {
      if (!wideQuery.matches || e.button !== 0 || e.target.closest('button, input, textarea')) return;
      if (e.pointerType === 'mouse') return;
      pointerDrag = {
        jid,
        name: nameEl.textContent || jid,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        ghost: null,
      };
    });

    stopBtn.addEventListener('click', async () => {
      await api(`/api/sessions/${encodeURIComponent(jid)}/commands`, {
        method: 'POST',
        body: JSON.stringify({ command: 'pi stop', args: {} }),
      }).catch((err) => alert(err.message));
    });

    // Quick toggle: move this pane under its neighbor (vertical stack) or out to its own column
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

    // iPadOS / iOS optimization: prevent tapping the Send button from blurring
    // the textarea and dismissing the virtual keyboard during multi-session work.
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
    textarea.addEventListener('input', autoGrow);
    textarea.addEventListener('focus', () => {
      paneEl.classList.add('pane-focused');
    });
    textarea.addEventListener('blur', () => {
      paneEl.classList.remove('pane-focused');
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const keepKeyboardOpen = hadFocusBeforeSend || document.activeElement === textarea;
      hadFocusBeforeSend = false;
      const text = textarea.value.trim();
      if (!text) {
        if (keepKeyboardOpen) textarea.focus({ preventScroll: true });
        return;
      }
      textarea.value = '';
      autoGrow();
      if (keepKeyboardOpen && document.activeElement !== textarea) {
        textarea.focus({ preventScroll: true });
      }

      if (text.startsWith('/')) {
        const handled = await trySendCommand(text, jid);
        if (handled) return;
      }

      try {
        const result = await api(`/api/sessions/${encodeURIComponent(jid)}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text, quote: '', attachments: [] }),
        });
        const eventId = result?.eventId || pane.cursor + 1;
        if (eventId > pane.cursor) {
          appendPaneEvent(
            pane,
            {
              id: eventId,
              kind: 'message',
              role: 'user',
              content: text,
              files: [],
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
        textarea.value = text;
        autoGrow();
        alert(err.message);
      }
    });

    return pane;
  }

  function syncPaneHeader(pane) {
    const session = getSessions().find((s) => s.jid === pane.jid);
    if (session) {
      pane.nameEl.textContent = session.name || pane.jid;
      pane.textarea.placeholder = `Message ${session.name || 'pi'}…`;
      const badge = getSessionBadge(session);
      if (badge) {
        pane.badgeEl.hidden = false;
        pane.badgeEl.className = `provider-badge ${badge.kind}`;
        pane.badgeEl.textContent = badge.label;
      } else {
        pane.badgeEl.hidden = true;
      }
    }
    const busy = Boolean(pane.busy || session?.busy);
    pane.spinnerEl.hidden = !busy;
    pane.stopBtn.hidden = !busy;
    pane.typingEl.hidden = !busy;
    pane.splitDownBtn.hidden = allJids().length < 2;
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

    const node = buildEventNode(event, { liveRich: false });
    node.dataset.eventId = String(event.id);
    if (pane.partialMsgEl) {
      pane.messagesEl.insertBefore(node, pane.partialMsgEl);
    } else {
      pane.messagesEl.append(node);
    }

    if (follow) {
      pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
      pane.jumpBtn.classList.remove('visible');
    } else if (live) {
      const near =
        pane.messagesEl.scrollHeight - pane.messagesEl.scrollTop - pane.messagesEl.clientHeight <=
        28;
      pane.jumpBtn.classList.toggle('visible', !near);
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
      pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
    } else {
      const near =
        pane.messagesEl.scrollHeight - pane.messagesEl.scrollTop - pane.messagesEl.clientHeight <=
        28;
      pane.jumpBtn.classList.toggle('visible', !near);
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
      if (event.id <= pane.cursor) return;
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
      if (session?.name) pane.nameEl.textContent = session.name;
      syncPaneHeader(pane);
      if (partial?.content || partial?.thinking) {
        renderPanePartial(pane, partial.content ?? '', partial.thinking ?? '');
      }
      if (events?.length) {
        onMarkSeen(pane.jid, events[events.length - 1].id);
      }
      pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
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
    pane.el.remove();
    panes.delete(jid);
  }

  // ── 2D Layout & Both Horizontal and Vertical Splitters ─────────────────────
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

    splitter.addEventListener('dblclick', () => {
      const [w1, w2] = getWeights();
      const avg = (w1 + w2) / 2;
      setWeights(avg, avg);
      saveState();
    });

    splitter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (!firstEl || !secondEl) return;

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

      splitter.classList.add('dragging');
      gridEl.classList.add('resizing-active');
      splitter.setPointerCapture(e.pointerId);

      // 120Hz+ zero-lag direct style mutation on every pointermove / coalesced event
      const applyPosition = (clientPos) => {
        const delta = clientPos - startPos;
        const clampedFirstPx = Math.max(minPx, Math.min(totalPx - minPx, firstSize + delta));
        const firstRatio = clampedFirstPx / totalPx;
        setWeights(totalWeight * firstRatio, totalWeight * (1 - firstRatio));
      };

      const onMove = (moveEvent) => {
        const coalesced =
          typeof moveEvent.getCoalescedEvents === 'function'
            ? moveEvent.getCoalescedEvents()
            : null;
        const latest = coalesced && coalesced.length > 0 ? coalesced[coalesced.length - 1] : moveEvent;
        const currentPos = isHorizontalDrag ? latest.clientX : latest.clientY;
        applyPosition(currentPos);
      };

      const onEnd = () => {
        splitter.classList.remove('dragging');
        gridEl.classList.remove('resizing-active');
        splitter.removeEventListener('pointermove', onMove);
        splitter.removeEventListener('pointerup', onEnd);
        splitter.removeEventListener('pointercancel', onEnd);
        saveState();
      };

      splitter.addEventListener('pointermove', onMove);
      splitter.addEventListener('pointerup', onEnd);
      splitter.addEventListener('pointercancel', onEnd);
    });

    return splitter;
  }

  let lastLayoutSignature = '';

  function computeLayoutSignature() {
    return `${direction}|${groups.map((g) => g.items.map((it) => it.jid).join(',')).join(';')}`;
  }

  function rebuildGrid(forceRebuildDOM = false) {
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
        if (groupEl) groupEl.style.flex = `${group.weight} 1 0px`;
        group.items.forEach((item) => {
          const pane = panes.get(item.jid);
          if (pane) pane.el.style.flex = `${item.weight} 1 0px`;
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
      groupEl.style.flex = `${group.weight} 1 0px`;

      const itemChildren = [];
      group.items.forEach((item, itemIdx) => {
        const pane = panes.get(item.jid);
        if (!pane) return;
        pane.el.style.flex = `${item.weight} 1 0px`;
        itemChildren.push(pane.el);

        if (itemIdx < group.items.length - 1) {
          const nextItem = group.items[itemIdx + 1];
          const nextPane = panes.get(nextItem.jid);
          if (nextPane) {
            itemChildren.push(
              createAxisSplitter({
                axis: innerAxis,
                label:
                  innerAxis === 'y'
                    ? `Resize vertical panes ${itemIdx + 1} and ${itemIdx + 2}`
                    : `Resize horizontal panes ${itemIdx + 1} and ${itemIdx + 2}`,
                firstEl: pane.el,
                secondEl: nextPane.el,
                getWeights: () => [item.weight, nextItem.weight],
                setWeights: (w1, w2) => {
                  item.weight = w1;
                  nextItem.weight = w2;
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
        const g1 = groups[gIdx];
        const g2 = groups[gIdx + 1];
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
            getWeights: () => [g1.weight, g2.weight],
            setWeights: (w1, w2) => {
              g1.weight = w1;
              g2.weight = w2;
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

    // Direct swap when dragging an existing pane onto another pane's center, or replacing with a sidebar session
    if (target?.mode === 'pane' && target.zone === 'swap' && target.jid) {
      if (swapPanesInPlace(jid, target.jid)) return;
      // If `jid` was dragged from the sidebar (not yet in dashboard), insert right after target.jid
      const loc = findJidLocation(target.jid);
      if (loc) {
        detachJidFromGroups(jid);
        groups[loc.gIdx].items.splice(loc.iIdx + 1, 0, { jid, weight: 1 });
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
  }

  function togglePaneAxis(jid) {
    const jids = allJids();
    if (jids.length < 2) return;
    const loc = findJidLocation(jid);
    if (!loc) return;

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
  }

  // ── Public Operations ──────────────────────────────────────────────────────
  function setActive(nextActive) {
    if (nextActive && !wideQuery.matches) return;
    if (active === nextActive) return;
    active = nextActive;
    syncNavCounts();
    syncDashboardVisualViewport();

    if (active) {
      rebuildGrid();
      for (const pane of panes.values()) {
        if (pane.cursor === 0) void hydratePane(pane);
        else connectPaneStream(pane);
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
    const wasAlreadyIn = allJids().includes(jid);
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
    if (!active && wideQuery.matches) {
      setActive(true);
    } else {
      rebuildGrid();
      onRenderSessionListDecorations();
    }
  }

  function removePane(jid) {
    if (!allJids().includes(jid)) return;
    detachJidFromGroups(jid);
    disposePane(jid);
    saveState();
    rebuildGrid();
    onRenderSessionListDecorations();
  }

  function equalizeWeights() {
    for (const g of groups) {
      g.weight = 1;
      for (const it of g.items) it.weight = 1;
    }
    saveState();
    rebuildGrid();
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
    // - Center region (22%..78% on both axes) when dragging an existing dashboard pane => 'swap' (交換視窗位置)
    // - Top / Bottom / Left / Right edges => directional split
    const isExistingPaneDrag = Boolean(dragSourceJid && allJids().includes(dragSourceJid));
    const inCenter = relX > 0.22 && relX < 0.78 && relY > 0.22 && relY < 0.78;

    const distTop = relY;
    const distBottom = 1 - relY;
    const distLeft = relX;
    const distRight = 1 - relX;
    const minDist = Math.min(distTop, distBottom, distLeft, distRight);

    let zone = 'right';
    if (isExistingPaneDrag && inCenter && hoveredPane.dataset.jid !== dragSourceJid) {
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
      label = '⇄ 交換視窗順序';
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
          if (!wideQuery.matches || e.target.closest('input, .del')) {
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
          pointerDrag = {
            jid,
            name: session.name || jid,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
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
      if (!pointerDrag.started) {
        const isFromSidebar = !allJids().includes(pointerDrag.jid);
        if (Math.hypot(dx, dy) < 14 || (isFromSidebar && Math.abs(dx) < Math.abs(dy))) return;
        pointerDrag.started = true;
        dragSourceJid = pointerDrag.jid;
        if (!active) setActive(true);
        const ghost = el('div', 'dashboard-drag-ghost', `# ${pointerDrag.name}`);
        document.body.append(ghost);
        pointerDrag.ghost = ghost;
      }
      if (pointerDrag.ghost) {
        pointerDrag.ghost.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY - 18}px, 0)`;
        showDropPreview(computeDropTarget(e.clientX, e.clientY));
      }
    },
    { passive: true },
  );

  const finishPointerDrag = (e, commit) => {
    if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;
    const drag = pointerDrag;
    const target = currentDropTarget;
    pointerDrag = null;
    drag.ghost?.remove();
    hideDropPreview();
    dragSourceJid = null;
    if (!drag.started || !commit) return;
    const mainRect = main.getBoundingClientRect();
    if (e.clientX >= mainRect.left) {
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

  preventTouchFocusSteal(btnEqualize);
  btnEqualize.addEventListener('click', () => {
    equalizeWeights();
    showToast?.('已平均對齊所有並排視窗');
  });

  btnClear.addEventListener('click', () => {
    for (const jid of allJids()) disposePane(jid);
    groups = [];
    saveState();
    rebuildGrid();
    onRenderSessionListDecorations();
  });

  btnExit.addEventListener('click', () => {
    setActive(false);
  });

  preventTouchFocusSteal(btnDrawerToggle);
  btnDrawerToggle.addEventListener('click', () => {
    app.classList.toggle('drawer-collapsed');
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

  wideQuery.addEventListener('change', (e) => {
    if (!e.matches && active) {
      setActive(false);
    }
  });

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
