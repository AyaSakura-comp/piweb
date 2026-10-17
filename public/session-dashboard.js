/**
 * Desktop & Tablet Multi-Session Tiling Dashboard (>= 768px)
 *
 * Allows dragging sessions from the left sidebar (or clicking the Dashboard entry /
 * pin buttons) into an auto-aligned side-by-side workspace where each pane is a
 * live, interactive session with its own SSE stream, composer, stop action, and
 * draggable resize splitters.
 */

const DASHBOARD_STORAGE_KEY = 'piweb.dashboard';
const MIN_PANE_WIDTH_PX = 220;

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
}) {
  const wideQuery = window.matchMedia('(min-width: 768px)');
  let active = false;
  let panes = new Map(); // jid -> pane state
  let orderedJids = [];
  let weights = new Map(); // jid -> relative flex weight (default 1)
  let dragSourceJid = null;
  let pointerDrag = null;

  // ── 1. Sidebar Dashboard Entry ("首頁 Dashboard") ──────────────────────────
  const navEntry = document.createElement('button');
  navEntry.type = 'button';
  navEntry.id = 'btn-dashboard-home';
  navEntry.className = 'dashboard-nav-entry';
  navEntry.setAttribute('aria-pressed', 'false');
  navEntry.innerHTML = `
    <span class="dashboard-nav-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="8" height="16" rx="2" />
        <rect x="13" y="4" width="8" height="16" rx="2" />
      </svg>
    </span>
    <span class="dashboard-nav-text">
      <strong>Dashboard</strong>
      <small>多視窗並排工作區</small>
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
      <rect x="3" y="4" width="8" height="16" rx="2" />
      <rect x="13" y="4" width="8" height="16" rx="2" />
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
        <button type="button" class="icon-btn dashboard-Menu-btn" id="btn-dashboard-drawer" aria-label="Toggle sessions sidebar" title="切換側邊欄">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        <svg class="dashboard-toolbar-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="8" height="16" rx="2" />
          <rect x="13" y="4" width="8" height="16" rx="2" />
        </svg>
        <h2>Session Dashboard</h2>
        <span class="dashboard-toolbar-badge" id="dashboard-pane-counter">0 個並排視窗</span>
      </div>
      <span class="dashboard-toolbar-hint">從左側將 Session 拖曳至此即可自動對齊並排，拖拉中間分隔線可調整視窗寬度</span>
      <div class="dashboard-toolbar-actions">
        <button type="button" class="dashboard-action-btn" id="btn-dashboard-equalize" title="平均對齊所有視窗寬度" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          <span>平均對齊</span>
        </button>
        <button type="button" class="dashboard-action-btn" id="btn-dashboard-clear" title="清空所有並排視窗" hidden>
          <span>清空</span>
        </button>
        <button type="button" class="dashboard-action-btn primary" id="btn-dashboard-exit" title="返回單一對話模式">
          <span>單一檢視</span>
        </button>
      </div>
    </header>
    <div class="dashboard-stage" id="dashboard-stage">
      <div class="dashboard-empty" id="dashboard-empty">
        <div class="dashboard-empty-card">
          <div class="dashboard-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <rect x="3" y="4" width="8" height="16" rx="2" />
              <rect x="13" y="4" width="8" height="16" rx="2" />
              <path d="M8 12h8m-3-3 3 3-3 3" />
            </svg>
          </div>
          <h3>拖曳 Session 到這裡並排處理</h3>
          <p>從左側列表將任意 Session 拖過來（或點選下方快速加入），系統會自動對齊並排，並可隨時拖拉中間分隔線調整視窗大小。</p>
          <div class="dashboard-quick-picks" id="dashboard-quick-picks" role="group" aria-label="快速加入並排"></div>
        </div>
      </div>
      <div class="dashboard-grid" id="dashboard-grid" role="region" aria-label="Tiled session panes" hidden></div>
      <div class="dashboard-drop-indicator" id="dashboard-drop-indicator" hidden>
        <span>放開以加入並排視窗</span>
      </div>
    </div>
  `;
  main.append(root);

  const stageEl = root.querySelector('#dashboard-stage');
  const emptyEl = root.querySelector('#dashboard-empty');
  const quickPicksEl = root.querySelector('#dashboard-quick-picks');
  const gridEl = root.querySelector('#dashboard-grid');
  const dropIndicatorEl = root.querySelector('#dashboard-drop-indicator');
  const counterEl = root.querySelector('#dashboard-pane-counter');
  const navCountEl = navEntry.querySelector('#dashboard-nav-count');
  const btnEqualize = root.querySelector('#btn-dashboard-equalize');
  const btnClear = root.querySelector('#btn-dashboard-clear');
  const btnExit = root.querySelector('#btn-dashboard-exit');
  const btnDrawerToggle = root.querySelector('#btn-dashboard-drawer');

  // ── Persistence ────────────────────────────────────────────────────────────
  function loadSavedState() {
    try {
      const raw = JSON.parse(localStorage.getItem(DASHBOARD_STORAGE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return { jids: [], weights: {} };
      return {
        jids: Array.isArray(raw.jids) ? raw.jids.filter((j) => typeof j === 'string') : [],
        weights: raw.weights && typeof raw.weights === 'object' ? raw.weights : {},
      };
    } catch {
      return { jids: [], weights: {} };
    }
  }

  function saveState() {
    try {
      const weightObj = {};
      for (const jid of orderedJids) {
        weightObj[jid] = Number((weights.get(jid) ?? 1).toFixed(4));
      }
      localStorage.setItem(
        DASHBOARD_STORAGE_KEY,
        JSON.stringify({
          jids: orderedJids,
          weights: weightObj,
        }),
      );
    } catch {
      // Ignore quota errors
    }
  }

  const initialSaved = loadSavedState();
  for (const [jid, w] of Object.entries(initialSaved.weights)) {
    const num = Number(w);
    if (Number.isFinite(num) && num > 0.1) weights.set(jid, num);
  }
  orderedJids = [...new Set(initialSaved.jids)];

  // ── Helpers ────────────────────────────────────────────────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function syncNavCounts() {
    const count = orderedJids.length;
    navCountEl.textContent = String(count);
    navCountEl.hidden = count === 0;
    counterEl.textContent = `${count} 個並排視窗`;
    btnEqualize.hidden = count < 2;
    btnClear.hidden = count === 0;
    navEntry.setAttribute('aria-pressed', String(active));
    navEntry.classList.toggle('active', active);
    app.classList.toggle('dashboard-active', active);
    root.hidden = !active;
  }

  function renderQuickPicks() {
    quickPicksEl.replaceChildren();
    const sessions = getSessions().filter((s) => !s.deleted && s.kind !== 'life');
    for (const s of sessions.slice(0, 6)) {
      const inDash = orderedJids.includes(s.jid);
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
    header.title = '拖曳標題列可交換並排順序';

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
    stopBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

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

    actions.append(stopBtn, focusBtn, closeBtn);
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
    };

    // Scroll & Jump to present
    const isNearBottom = () =>
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= 80;
    const scrollToBottom = (instant = false) => {
      messagesEl.scrollTo({
        top: messagesEl.scrollHeight,
        behavior: instant ? 'auto' : 'smooth',
      });
      jumpBtn.classList.remove('visible');
    };
    messagesEl.addEventListener(
      'scroll',
      () => {
        jumpBtn.classList.toggle('visible', !isNearBottom());
      },
      { passive: true },
    );
    jumpBtn.addEventListener('click', () => scrollToBottom(false));

    // Image click inside pane -> open lightbox
    messagesEl.addEventListener('click', (e) => {
      const img = e.target.closest?.('.msg-files img, .msg-text img');
      if (img && img.src) {
        const urls = [...messagesEl.querySelectorAll('.msg-files img, .msg-text img')]
          .map((node) => node.getAttribute('src'))
          .filter(Boolean);
        openLightbox(img.getAttribute('src'), urls.length ? urls : [img.getAttribute('src')]);
      }
    });

    // Header reorder via HTML5 drag & drop
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
    });

    // Actions
    stopBtn.addEventListener('click', async () => {
      await api(`/api/sessions/${encodeURIComponent(jid)}/commands`, {
        method: 'POST',
        body: JSON.stringify({ command: 'pi stop', args: {} }),
      }).catch((err) => alert(err.message));
    });

    focusBtn.addEventListener('click', () => {
      setActive(false);
      onSelectSingleSession(jid);
    });

    closeBtn.addEventListener('click', () => {
      removePane(jid);
    });

    // Auto-grow textarea & Enter to send
    const autoGrow = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(140, textarea.scrollHeight)}px`;
    };
    textarea.addEventListener('input', autoGrow);
    textarea.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = textarea.value.trim();
      if (!text) return;
      textarea.value = '';
      autoGrow();

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
  }

  function appendPaneEvent(pane, event, live = false) {
    pane.cursor = Math.max(pane.cursor, event.id || 0);
    const follow =
      pane.messagesEl.scrollHeight - pane.messagesEl.scrollTop - pane.messagesEl.clientHeight <= 90;

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

    if (follow || !live) {
      pane.messagesEl.scrollTop = pane.messagesEl.scrollHeight;
      pane.jumpBtn.classList.remove('visible');
    } else {
      pane.jumpBtn.classList.add('visible');
    }
  }

  function renderPanePartial(pane, text = '', thinking = '') {
    const follow =
      pane.messagesEl.scrollHeight - pane.messagesEl.scrollTop - pane.messagesEl.clientHeight <= 90;

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

  // ── Layout & Resizable Splitters ───────────────────────────────────────────
  function applyPaneWeights() {
    for (const jid of orderedJids) {
      const pane = panes.get(jid);
      if (!pane) continue;
      const w = Math.max(0.15, weights.get(jid) ?? 1);
      weights.set(jid, w);
      pane.el.style.flex = `${w} 1 0px`;
      pane.el.style.minWidth = `${MIN_PANE_WIDTH_PX}px`;
    }
  }

  function createSplitter(leftJid, rightJid, index) {
    const splitter = el('div', 'dashboard-splitter');
    splitter.setAttribute('role', 'separator');
    splitter.setAttribute('aria-orientation', 'vertical');
    splitter.setAttribute('aria-label', `Resize panes ${index + 1} and ${index + 2}`);
    splitter.tabIndex = 0;
    splitter.title = '拖拉調整左右視窗大小（雙擊平均對齊）';
    splitter.innerHTML = '<span class="dashboard-splitter-grip" aria-hidden="true"></span>';

    splitter.addEventListener('dblclick', () => {
      const avg = ((weights.get(leftJid) ?? 1) + (weights.get(rightJid) ?? 1)) / 2;
      weights.set(leftJid, avg);
      weights.set(rightJid, avg);
      applyPaneWeights();
      saveState();
    });

    splitter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const leftPane = panes.get(leftJid)?.el;
      const rightPane = panes.get(rightJid)?.el;
      if (!leftPane || !rightPane) return;

      const startX = e.clientX;
      const leftRect = leftPane.getBoundingClientRect();
      const rightRect = rightPane.getBoundingClientRect();
      const totalPx = leftRect.width + rightRect.width;
      if (totalPx <= MIN_PANE_WIDTH_PX * 2) return;

      const startLeftW = weights.get(leftJid) ?? 1;
      const startRightW = weights.get(rightJid) ?? 1;
      const totalWeight = startLeftW + startRightW;

      splitter.classList.add('dragging');
      splitter.setPointerCapture(e.pointerId);

      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const clampedLeftPx = Math.max(
          MIN_PANE_WIDTH_PX,
          Math.min(totalPx - MIN_PANE_WIDTH_PX, leftRect.width + dx),
        );
        const leftRatio = clampedLeftPx / totalPx;
        weights.set(leftJid, totalWeight * leftRatio);
        weights.set(rightJid, totalWeight * (1 - leftRatio));
        applyPaneWeights();
      };

      const onEnd = () => {
        splitter.classList.remove('dragging');
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

  function rebuildGrid() {
    syncNavCounts();
    renderQuickPicks();

    if (orderedJids.length === 0) {
      gridEl.hidden = true;
      emptyEl.hidden = false;
      gridEl.replaceChildren();
      return;
    }

    emptyEl.hidden = true;
    gridEl.hidden = false;

    // Ensure pane instances exist for all orderedJids
    for (const jid of orderedJids) {
      if (!panes.has(jid)) {
        const pane = createPaneDOM(jid);
        panes.set(jid, pane);
        if (!weights.has(jid)) weights.set(jid, 1);
        if (active) void hydratePane(pane);
      } else {
        syncPaneHeader(panes.get(jid));
      }
    }

    // Remove stale panes
    for (const jid of [...panes.keys()]) {
      if (!orderedJids.includes(jid)) disposePane(jid);
    }

    // Assemble panes + splitters in order without destroying existing pane DOM
    const children = [];
    orderedJids.forEach((jid, idx) => {
      const pane = panes.get(jid);
      if (pane) children.push(pane.el);
      if (idx < orderedJids.length - 1) {
        children.push(createSplitter(jid, orderedJids[idx + 1], idx));
      }
    });
    gridEl.replaceChildren(...children);
    applyPaneWeights();
  }

  // ── Public Operations ──────────────────────────────────────────────────────
  function setActive(nextActive) {
    if (nextActive && !wideQuery.matches) return;
    if (active === nextActive) return;
    active = nextActive;
    syncNavCounts();

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

  function addPane(jid, insertIndex = -1) {
    if (!jid || jid === 'web:life') return;
    if (!orderedJids.includes(jid)) {
      if (insertIndex >= 0 && insertIndex <= orderedJids.length) {
        orderedJids.splice(insertIndex, 0, jid);
      } else {
        orderedJids.push(jid);
      }
      if (!weights.has(jid)) weights.set(jid, 1);
    } else if (insertIndex >= 0) {
      const currentIdx = orderedJids.indexOf(jid);
      if (currentIdx !== insertIndex) {
        orderedJids.splice(currentIdx, 1);
        orderedJids.splice(insertIndex > currentIdx ? insertIndex - 1 : insertIndex, 0, jid);
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
    const idx = orderedJids.indexOf(jid);
    if (idx === -1) return;
    orderedJids.splice(idx, 1);
    weights.delete(jid);
    disposePane(jid);
    saveState();
    rebuildGrid();
    onRenderSessionListDecorations();
  }

  function equalizeWeights() {
    for (const jid of orderedJids) weights.set(jid, 1);
    applyPaneWeights();
    saveState();
  }

  // ── Drag-and-drop from Sidebar & Between Panes ─────────────────────────────
  function computeDropIndex(clientX) {
    const paneEls = [...gridEl.querySelectorAll('.dashboard-pane')];
    for (let i = 0; i < paneEls.length; i++) {
      const rect = paneEls[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return paneEls.length;
  }

  function showDropFeedback(show) {
    dropIndicatorEl.hidden = !show;
    stageEl.classList.toggle('drag-over', show);
  }

  // HTML5 Drag & Drop on main / stage
  main.addEventListener('dragover', (e) => {
    if (!wideQuery.matches) return;
    const hasSession =
      dragSourceJid || e.dataTransfer?.types?.includes('text/piweb-session-jid');
    if (!hasSession) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'CopyMove';
    if (!active) setActive(true);
    showDropFeedback(true);
  });

  main.addEventListener('dragleave', (e) => {
    if (!main.contains(e.relatedTarget)) {
      showDropFeedback(false);
    }
  });

  main.addEventListener('drop', (e) => {
    if (!wideQuery.matches) return;
    const jid =
      e.dataTransfer?.getData('text/piweb-session-jid') || dragSourceJid;
    showDropFeedback(false);
    dragSourceJid = null;
    if (!jid) return;
    e.preventDefault();
    if (!active) setActive(true);
    const insertIdx = computeDropIndex(e.clientX);
    addPane(jid, insertIdx);
  });

  // Decorate each `.session-item` in the left sidebar with drag support + pin button
  function onRenderSessionListDecorations() {
    const sessions = getSessions();
    const items = sessionList.querySelectorAll('.session-item');
    items.forEach((item, index) => {
      const nameNode = item.querySelector('.name');
      const session = sessions.find((s) => s.name === nameNode?.textContent) || sessions[index];
      if (!session || session.kind === 'life') return;
      const jid = session.jid;
      item.dataset.jid = jid;
      item.draggable = true;
      const inDash = orderedJids.includes(jid);
      item.classList.toggle('in-dashboard', inDash);

      // HTML5 drag from sidebar
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
          showDropFeedback(false);
        });

        // Touch / Pen / Mouse Pointer Drag fallback for iPad & Tablet
        item.addEventListener('pointerdown', (e) => {
          if (!wideQuery.matches || e.button !== 0 || e.target.closest('button, input')) return;
          if (e.pointerType === 'mouse') return; // mouse uses native HTML5 dragstart
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

      // Pin/Tile button on each session row (visible on tablet/desktop)
      let tileBtn = item.querySelector('.session-tile-btn');
      if (!tileBtn) {
        tileBtn = el('button', 'icon-btn session-tile-btn');
        tileBtn.type = 'button';
        tileBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="8" height="16" rx="2"/><rect x="13" y="4" width="8" height="16" rx="2"/></svg>';
        tileBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (orderedJids.includes(jid) && active) {
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
        if (Math.hypot(dx, dy) < 18 || Math.abs(dx) < Math.abs(dy)) return;
        pointerDrag.started = true;
        dragSourceJid = pointerDrag.jid;
        if (!active) setActive(true);
        showDropFeedback(true);
        const ghost = el('div', 'dashboard-drag-ghost', `# ${pointerDrag.name}`);
        document.body.append(ghost);
        pointerDrag.ghost = ghost;
      }
      if (pointerDrag.ghost) {
        pointerDrag.ghost.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY - 18}px, 0)`;
      }
    },
    { passive: true },
  );

  const finishPointerDrag = (e, commit) => {
    if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;
    const drag = pointerDrag;
    pointerDrag = null;
    drag.ghost?.remove();
    showDropFeedback(false);
    dragSourceJid = null;
    if (!drag.started || !commit) return;
    const mainRect = main.getBoundingClientRect();
    if (e.clientX >= mainRect.left) {
      addPane(drag.jid, computeDropIndex(e.clientX));
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
    if (currentJid && !orderedJids.includes(currentJid)) {
      addPane(currentJid);
    } else {
      setActive(true);
    }
  });

  btnEqualize.addEventListener('click', () => {
    equalizeWeights();
    showToast?.('已平均對齊所有並排視窗');
  });

  btnClear.addEventListener('click', () => {
    for (const jid of [...orderedJids]) disposePane(jid);
    orderedJids = [];
    weights.clear();
    saveState();
    rebuildGrid();
    onRenderSessionListDecorations();
  });

  btnExit.addEventListener('click', () => {
    setActive(false);
  });

  btnDrawerToggle.addEventListener('click', () => {
    app.classList.toggle('drawer-collapsed');
  });

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
    equalizeWeights,
    syncSessions() {
      // Remove deleted sessions from dashboard
      const validJids = new Set(getSessions().map((s) => s.jid));
      if (validJids.size > 0) {
        const beforeLen = orderedJids.length;
        orderedJids = orderedJids.filter((jid) => {
          const keep = validJids.has(jid);
          if (!keep) disposePane(jid);
          return keep;
        });
        if (orderedJids.length !== beforeLen) saveState();
      }
      for (const pane of panes.values()) syncPaneHeader(pane);
      if (active) rebuildGrid();
      else syncNavCounts();
      onRenderSessionListDecorations();
    },
  };
}
