/**
 * piweb client.
 *
 * Single-file, no framework — the whole app is a session list, a transcript,
 * and a composer. State lives in `state`; the server is the source of truth and
 * every mutation round-trips through the API.
 *
 * Live updates come over SSE. The stream is resumed by event id (`cursor`), so
 * a phone that slept through a long pi run reconnects and replays exactly the
 * events it missed instead of losing them or double-rendering.
 */

import { renderRich } from './markdown.js';
import { createVideoAttachment } from './media-files.js';
import { bindCodeCopy } from './message-copy.js';
import {
  bindCustomSelection,
  quotePreview,
  selectedTranscriptText,
} from './text-selection.js';
import {
  bindLongPress,
  isTranscriptNearBottom,
  jumpToLatest,
  needsViewportRecovery,
  recoverViewportShell,
  setDrawerCollapsed,
  settleTranscriptUpdate,
} from './session-ui.js';
import {
  hideUploadProgress,
  sendJsonWithUploadProgress,
  showUploadProgress,
} from './upload-progress.js';

const $ = (id) => document.getElementById(id);

const state = {
  sessions: [],
  activeJid: null,
  cursor: 0,
  source: null,
  attachments: [],
  pendingQuote: '',
  uploading: false,
  commands: [],
  models: [],
  previewingDeleted: false,
  renamingJid: null,
  renameDraft: '',
  ac: { open: false, items: [], index: 0, mode: null },
  // Infinite scroll upward: `oldest` is the lowest event id currently rendered,
  // `hasMore` says whether anything precedes it, `loadingOlder` prevents the
  // scroll handler from firing overlapping fetches.
  oldest: 0,
  hasMore: false,
  loadingOlder: false,
  // Jumping to a search hit detaches the view from the live tail: newer events
  // must then be paged in downward, and incoming SSE events must NOT be
  // appended (they belong after history the user cannot see yet).
  newest: 0,
  hasMoreNewer: false,
  loadingNewer: false,
  atLive: true,
};

// ── api ──────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });

  if (res.status === 401) {
    showLogin();
    throw new Error('Not authenticated');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ── auth ─────────────────────────────────────────────────────────────────

function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
  closeStream();
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
}

// Remembering the entered token so it never has to be retyped. The durable
// session cookie already keeps you logged in across restarts; this additionally
// re-logs-in automatically if that cookie ever expires. Tradeoff: the token
// sits in localStorage, readable by any script on this origin — acceptable for
// a personal PIN, but it is why logout wipes it.
const TOKEN_KEY = 'piweb.token';

function rememberToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // private mode / quota — auto-login just won't persist
  }
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function submitToken(token, { remember }) {
  await api('/api/login', { method: 'POST', body: JSON.stringify({ token }) });
  if (remember) rememberToken(token);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.hidden = true;
  try {
    await submitToken($('login-token').value, { remember: $('login-remember').checked });
    $('login-token').value = '';
    showApp();
    await boot();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
});

$('btn-logout').addEventListener('click', async () => {
  forgetToken();
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/** Try a stored token when there is no valid session cookie. Returns true on success. */
async function tryStoredToken() {
  let token;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    return false;
  }
  if (!token) return false;
  try {
    await submitToken(token, { remember: true });
    return true;
  } catch {
    // Token no longer valid (changed on the server) — drop it and fall back to
    // the login screen rather than silently retrying a dead credential.
    forgetToken();
    return false;
  }
}

// ── toast ────────────────────────────────────────────────────────────────

let toastTimer;

function showToast(text, action) {
  const toast = $('toast');
  const btn = $('toast-action');
  $('toast-text').textContent = text;

  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => {
      hideToast();
      action.run();
    };
  }

  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 4500 : 2200);
}

function hideToast() {
  $('toast').hidden = true;
  clearTimeout(toastTimer);
}

// ── copy links on tap ────────────────────────────────────────────────────
//
// Tapping a URL copies it instead of navigating: on a phone the usual way to
// grab a link is a long-press and a fiddly menu. Opening is still one tap away
// via the toast, so nothing is actually lost.

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }

  // Older iOS Safari has no async clipboard outside a few contexts.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

bindCodeCopy(document, {
  copyText,
  onResult: (copied) => showToast(copied ? 'Copied code' : 'Could not copy code'),
});

document.addEventListener('click', async (e) => {
  const link = e.target.closest('#messages .msg-text a, #messages .event-body a');
  if (!link) return;

  const url = link.href;
  e.preventDefault();

  const copied = await copyText(url);
  const shown = url.length > 48 ? `${url.slice(0, 47)}…` : url;
  showToast(copied ? `Copied ${shown}` : `Could not copy — ${shown}`, {
    label: 'Open',
    run: () => window.open(url, '_blank', 'noopener'),
  });
});

// ── transcript selection actions ─────────────────────────────────────────

let selectedText = '';
let selectionFrame = 0;
let clearCustomSelection = () => {};

function hideSelectionActions(clearSelection = false) {
  selectedText = '';
  $('selection-actions').hidden = true;
  if (clearSelection) {
    window.getSelection()?.removeAllRanges();
    clearCustomSelection();
  }
}

function showSelectionActions(text, rect) {
  selectedText = text;
  if (!state.previewingDeleted && text) {
    state.pendingQuote = text;
    renderQuotePreview();
  }
  $('selection-quote').disabled = state.previewingDeleted;
  const actions = $('selection-actions');
  actions.hidden = false;

  const toolbarWidth = actions.offsetWidth || 150;
  const toolbarHeight = actions.offsetHeight || 42;
  const composer = $('composer-wrap');
  const composerTop = composer ? composer.getBoundingClientRect().top : window.innerHeight - 70;

  // Center horizontally over selection, clamped within margins
  const left = Math.min(
    window.innerWidth - toolbarWidth / 2 - 12,
    Math.max(toolbarWidth / 2 + 12, rect.left + rect.width / 2)
  );

  // Position directly BELOW the selection box
  let top = rect.bottom + 12;

  // If placing below overflows past the composer/screen bottom, flip directly above
  if (top + toolbarHeight > composerTop - 8) {
    top = Math.max(8, rect.top - toolbarHeight - 12);
  }

  actions.style.left = `${left}px`;
  actions.style.top = `${top}px`;
  actions.style.bottom = 'auto';
}

function syncSelectionActions() {
  selectionFrame = 0;
  const selection = window.getSelection();
  const text = selectedTranscriptText(selection, $('messages'));
  if (!text) {
    hideSelectionActions();
    return;
  }
  showSelectionActions(text, selection.getRangeAt(0).getBoundingClientRect());
}

document.addEventListener('selectionchange', () => {
  cancelAnimationFrame(selectionFrame);
  selectionFrame = requestAnimationFrame(syncSelectionActions);
});

$('messages')?.addEventListener('scroll', () => {
  if (!$('selection-actions').hidden) {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(syncSelectionActions);
  }
}, { passive: true });

$('messages')?.addEventListener('contextmenu', (event) => {
  if (event.target.closest('.msg-text, .event-body')) {
    event.preventDefault();
  }
});

clearCustomSelection = bindCustomSelection($('messages'), $('custom-selection-overlay'), {
  onSelection: showSelectionActions,
  onClear: () => hideSelectionActions(),
});

// Keep the native drag handles and selection alive until the chosen action's
// click fires. Without this, iOS collapses the range on pointer-down.
$('selection-actions').addEventListener('pointerdown', (event) => event.preventDefault());

$('selection-copy').addEventListener('click', async () => {
  const copied = selectedText ? await copyText(selectedText) : false;
  hideSelectionActions(true);
  showToast(copied ? '已複製選取文字' : '無法複製文字');
});

$('selection-quote').addEventListener('click', () => {
  if (!selectedText) return;
  state.pendingQuote = selectedText;
  renderQuotePreview();
  hideSelectionActions(true);
  $('input').focus();
});

function renderQuotePreview() {
  const preview = $('quote-preview');
  preview.hidden = !state.pendingQuote;
  $('quote-preview-text').textContent = state.pendingQuote
    ? `「${quotePreview(state.pendingQuote)}」`
    : '';
}

$('quote-preview-remove').addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});

$('quote-preview-remove').addEventListener('click', (e) => {
  e.stopPropagation();
  state.pendingQuote = '';
  renderQuotePreview();
  hideSelectionActions(true);
});

// ── push notifications ───────────────────────────────────────────────────
//
// iOS only delivers Web Push to a site launched from the Home Screen, and only
// lets permission be requested from a user gesture — hence a button rather
// than asking on load.

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function refreshNotifyState() {
  const label = $('notify-label');
  const badge = $('notify-state');

  if (!pushSupported()) {
    // Safari in a normal tab has no PushManager at all; say why rather than
    // showing a button that cannot work.
    badge.textContent = isStandalone() ? 'unsupported' : 'add to Home Screen';
    badge.className = 'notif-state';
    return;
  }

  if (Notification.permission === 'denied') {
    badge.textContent = 'blocked';
    badge.className = 'notif-state blocked';
    return;
  }

  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  badge.textContent = sub ? 'on' : 'off';
  badge.className = `notif-state${sub ? ' on' : ''}`;
  label.textContent = 'Notifications';
}

async function toggleNotifications() {
  if (!pushSupported()) {
    alert(
      isStandalone()
        ? 'This browser does not support web push notifications.'
        : 'iOS only allows notifications for apps added to the Home Screen.\n\nShare → Add to Home Screen, then open piweb from there.',
    );
    return;
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();

  if (existing) {
    await api('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: existing.endpoint }),
    }).catch(() => {});
    await existing.unsubscribe();
    await refreshNotifyState();
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    await refreshNotifyState();
    return;
  }

  const { key } = await api('/api/push/key');
  if (!key) {
    alert('Server has no push key configured.');
    return;
  }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
  await refreshNotifyState();
}

$('btn-notify').addEventListener('click', () => {
  toggleNotifications().catch((err) => alert(err.message));
});

// Tapping a notification asks the open window to switch sessions.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-session' && e.data.jid) {
      selectSession(e.data.jid);
      closeDrawer();
    }
  });
}

// ── unread tracking ──────────────────────────────────────────────────────
//
// "Replied but not yet read" is a per-device notion, so the high-water mark
// lives in localStorage rather than the database: reading a session on the
// phone should not clear the marker on a laptop.

const SEEN_KEY = 'piweb.seen';

function loadSeen() {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Private mode / quota — unread marks simply do not persist.
  }
}

function markSeen(jid, replyId) {
  if (!jid || !replyId) return;
  const seen = loadSeen();
  if ((seen[jid] ?? 0) >= replyId) return;
  seen[jid] = replyId;
  saveSeen(seen);
}

function isUnread(session) {
  const seen = loadSeen();
  return session.lastReplyId > (seen[session.jid] ?? 0);
}

// ── sessions ─────────────────────────────────────────────────────────────

async function loadSessions() {
  const { sessions } = await api('/api/sessions');
  state.sessions = sessions;
  renderSessions();
  renderHeaderBadge();
  renderThinkingButton();
}

/** Mirror the provider badge next to the title, so it is visible without opening the drawer. */
function renderHeaderBadge() {
  const host = $('header-badge');
  host.textContent = '';
  const session = state.sessions.find((s) => s.jid === state.activeJid);
  if (!session || !session.badge || state.previewingDeleted) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.className = `provider-badge ${session.badge.kind}`;
  host.textContent = session.badge.label;
  host.title = session.runningModel || session.provider;
}

// Drawer order: most recently active session first, by the timestamp of its
// newest event (`lastActivity` = max(web_events.created_at) for the channel).
// Anything that touches a session — your message, pi's reply, a command's
// output — moves it up, so a session with a new message is at the top for free.
//
// Recomputed on every render, and `lastActivity` comes fresh from the 5s
// loadSessions poll (SSE only carries the open session), so a reply landing in
// a background session moves it up while the drawer is open.
//
// Timestamps are SQLite's 'YYYY-MM-DD HH:MM:SS' in UTC: fixed-width and
// zero-padded, so a plain string compare is a correct chronological compare and
// needs no Date parsing (which would also need the 'Z' fix — see CLAUDE.md).
// A session with no events yet was only just created, so it sorts newest.
function activityKey(session) {
  return session.lastActivity || '9999-12-31 23:59:59';
}

function sessionsForDisplay() {
  return state.sessions
    .map((session, index) => ({ session, index }))
    .sort(
      (a, b) =>
        activityKey(b.session).localeCompare(activityKey(a.session)) || a.index - b.index,
    )
    .map((e) => e.session);
}

function renderSessions(force = false) {
  const list = $('session-list');
  // The 5s session poll and busy-state updates must not replace an input while
  // someone is typing into it. The next render happens when the edit finishes.
  if (!force && state.renamingJid && list.querySelector('.session-name-edit')) return;
  list.textContent = '';

  if (state.sessions.length === 0) {
    const note = el('div', 'empty-note', 'No sessions yet.\nTap + to start one.');
    list.append(note);
    return;
  }

  for (const session of sessionsForDisplay()) {
    const item = el('div', `session-item${session.jid === state.activeJid ? ' active' : ''}`);
    item.append(el('span', 'hash', '#'));

    if (state.renamingJid === session.jid) {
      const input = el('input', 'session-name-edit');
      input.value = state.renameDraft;
      input.maxLength = 80;
      input.setAttribute('aria-label', `Rename ${session.name}`);
      input.addEventListener('input', () => {
        if (state.renamingJid === session.jid) state.renameDraft = input.value;
      });
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          commitListRename(session.jid, true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          commitListRename(session.jid, false);
        }
      });
      input.addEventListener('blur', () => commitListRename(session.jid, true));
      item.append(input);
    } else {
      const name = el('span', 'name', session.name);
      name.title = 'Press and hold to rename';
      bindLongPress(name, () => startListRename(session));
      item.append(name);
    }

    if (session.badge) {
      const badge = el('span', `provider-badge ${session.badge.kind}`, session.badge.label);
      // The full model id is long; keep it to the tooltip/long-press.
      badge.title = session.runningModel || session.provider;
      item.append(badge);
    }
    // Busy and unread are different states: a spinner means pi is working
    // right now, the dot means it finished and you have not looked yet.
    if (session.busy) {
      const spinner = el('span', 'work-spinner');
      spinner.title = 'pi is working';
      item.append(spinner);
    } else if (isUnread(session)) {
      const dot = el('span', 'unread-dot');
      dot.title = 'New reply';
      item.append(dot);
    }

    const del = el('button', 'icon-btn del');
    del.setAttribute('aria-label', `Delete ${session.name}`);
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Soft delete: it goes to "Recently deleted" and can be restored.
      if (!confirm(`Move "${session.name}" to Recently deleted?`)) return;
      await api(`/api/sessions/${encodeURIComponent(session.jid)}`, { method: 'DELETE' });
      refreshTrashCount();
      if (state.activeJid === session.jid) {
        state.activeJid = null;
        $('messages').textContent = '';
        $('session-name').textContent = 'no session';
        closeStream();
      }
      await loadSessions();
      if (!state.activeJid) {
        const nextTarget = sessionsForDisplay()[0]?.jid;
        if (nextTarget) selectSession(nextTarget);
      }
    });
    item.append(del);

    item.addEventListener('click', (e) => {
      if (e.defaultPrevented || state.renamingJid === session.jid) return;
      selectSession(session.jid);
      closeDrawer();
    });
    list.append(item);
  }
}

async function createSession() {
  const name = prompt('Session name', 'New session');
  if (name === null) return;
  const session = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim() || 'New session' }),
  });
  await loadSessions();
  selectSession(session.jid);
  closeDrawer();
}

async function selectSession(jid, opts = {}) {
  state.activeJid = jid;
  state.previewingDeleted = Boolean(opts.deleted);
  state.cursor = 0;
  state.oldest = 0;
  state.hasMore = false;
  state.loadingOlder = false;
  state.newest = 0;
  state.hasMoreNewer = false;
  state.atLive = true;
  closeSearch();
  // A trashed session is not in state.sessions, so its name has to be passed in
  // by the trash sheet — otherwise the header falls back to the raw jid.
  const session = state.sessions.find((s) => s.jid === jid);
  commitRename(false);
  $('session-name').textContent = opts.name || (session ? session.name : jid);
  $('messages').textContent = '';
  state.pendingQuote = '';
  renderQuotePreview();
  renderSessions();

  // A trashed session is previewable but frozen: hide the composer so there is
  // no way to type into something that would be rejected by the server anyway.
  renderHeaderBadge();
  $('deleted-banner').hidden = !state.previewingDeleted;
  $('composer-wrap').hidden = state.previewingDeleted;
  // btn-more stays: Search still works on a trashed session (the other rows are
  // disabled in openMoreMenu). The rest act on a live session, so they go.
  for (const id of ['btn-model', 'btn-thinking', 'btn-status', 'btn-gpt-usage']) {
    $(id).hidden = state.previewingDeleted;
  }
  syncUsageButton();
  closeModelSheet();
  closeThinkingSheet();
  closeMoreMenu();
  // The gallery belongs to the session that was open; switching must not leave
  // the previous session's media on screen.
  closeMediaSheet();
  // Same for a half-written reply from the session being left.
  renderPartial('');

  // Only the newest page; older history is pulled in as the user scrolls up.
  const { events, busy, hasMore, partial } = await api(
    `/api/sessions/${encodeURIComponent(jid)}/events?limit=${PAGE_SIZE}`,
  );
  for (const event of events) appendEvent(event, false);
  // Opening a session while pi is mid-reply should show the text so far.
  renderPartial(partial?.content ?? '');
  const openedSession = state.sessions.find((s) => s.jid === jid);
  if (openedSession) {
    markSeen(jid, openedSession.lastReplyId);
    // renderSessions() already ran above, before the events were fetched, so
    // re-render or the dot lingers until the next poll.
    renderSessions();
  }
  state.oldest = events.length > 0 ? events[0].id : 0;
  state.newest = events.length > 0 ? events[events.length - 1].id : 0;
  state.hasMore = Boolean(hasMore);
  state.hasMoreNewer = false;
  state.atLive = true;
  setJumpLive(false);
  renderTopSentinel();
  setBusy(busy);
  scrollToBottom(true);
  openStream();
}

const PAGE_SIZE = 50;

/**
 * Prepend one page of older events, keeping the viewport visually still.
 *
 * Inserting above the scroll position would otherwise jump the content down by
 * the height of whatever was added, so the scroll offset is re-anchored by the
 * change in scrollHeight — the standard trick, and the reason this measures
 * before and after the DOM insert.
 */
async function loadOlder() {
  if (state.loadingOlder || !state.hasMore || !state.activeJid || !state.oldest) return;
  state.loadingOlder = true;
  setTopSentinel('loading');

  try {
    const { events, hasMore } = await api(
      `/api/sessions/${encodeURIComponent(state.activeJid)}/events?before=${state.oldest}&limit=${PAGE_SIZE}`,
    );

    const messages = $('messages');
    const heightBefore = messages.scrollHeight;
    const topBefore = messages.scrollTop;

    // Build detached, then insert in one go so layout is touched once.
    const frag = document.createDocumentFragment();
    for (const event of events) frag.append(buildEventNode(event));
    const anchor = $('top-sentinel');
    messages.insertBefore(frag, anchor ? anchor.nextSibling : messages.firstChild);

    if (events.length > 0) state.oldest = events[0].id;
    state.hasMore = Boolean(hasMore);

    messages.scrollTop = topBefore + (messages.scrollHeight - heightBefore);
  } finally {
    state.loadingOlder = false;
    renderTopSentinel();
  }
}

/** A marker row at the top: "load more" affordance, spinner, or start-of-history. */
function renderTopSentinel() {
  const messages = $('messages');
  let sentinel = $('top-sentinel');
  if (!sentinel) {
    sentinel = el('div', 'top-sentinel');
    sentinel.id = 'top-sentinel';
    sentinel.addEventListener('click', loadOlder);
    messages.prepend(sentinel);
  }
  setTopSentinel(state.hasMore ? 'more' : 'start');
}

function setTopSentinel(mode) {
  const sentinel = $('top-sentinel');
  if (!sentinel) return;
  sentinel.textContent =
    mode === 'loading'
      ? 'Loading older messages…'
      : mode === 'more'
        ? 'Load older messages'
        : 'Beginning of this session';
  sentinel.className = `top-sentinel${mode === 'start' ? ' start' : ''}`;
}

/** Page forward — only needed after a jump has detached the view from the tail. */
async function loadNewer() {
  // Only relevant while detached: at the live tail, SSE already appends.
  if (state.atLive || state.loadingNewer || !state.hasMoreNewer) return;
  if (!state.activeJid || !state.newest) return;
  state.loadingNewer = true;
  try {
    const { events, hasMoreNewer } = await api(
      `/api/sessions/${encodeURIComponent(state.activeJid)}/events?after=${state.newest}&limit=${PAGE_SIZE}`,
    );
    const messages = $('messages');
    const frag = document.createDocumentFragment();
    for (const event of events) frag.append(buildEventNode(event));
    messages.append(frag);
    if (events.length > 0) state.newest = events[events.length - 1].id;
    state.hasMoreNewer = Boolean(hasMoreNewer);
    if (!state.hasMoreNewer) {
      // Caught up with the tail: resume live appends.
      state.atLive = true;
      state.cursor = Math.max(state.cursor, state.newest);
      setJumpLive(false);
    }
  } finally {
    state.loadingNewer = false;
  }
}

// Scrolling near either end pages history in, Discord-style.
$('messages').addEventListener(
  'scroll',
  () => {
    const m = $('messages');
    if (m.scrollTop < 300) loadOlder();
    if (!state.atLive && m.scrollHeight - m.scrollTop - m.clientHeight < 300) loadNewer();
    // Layout shifts are guarded while the mobile keyboard opens; later unguarded
    // scrolls still release the lock for keyboard/scrollbar navigation.
    if (shouldReleaseComposerBottomLock()) releaseComposerBottomLock();
    if (state.atLive) setJumpLive(!isNearBottom());
  },
  { passive: true },
);

function setJumpLive(show) {
  $('jump-live').classList.toggle('visible', !!show);
}

$('jump-live').addEventListener('click', () => {
  if (!state.atLive && state.activeJid) {
    selectSession(state.activeJid);
    return;
  }
  jumpToLatest($('messages'), $('jump-live'));
});

// ── search ───────────────────────────────────────────────────────────────

let searchTimer;

function openSearch() {
  $('search-panel').hidden = false;
  $('search-input').focus();
}

function closeSearch() {
  $('search-panel').hidden = true;
  $('search-input').value = '';
  $('search-results').textContent = '';
  clearTimeout(searchTimer);
}

$('btn-search-close').addEventListener('click', closeSearch);

$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  // Debounced: every keystroke would otherwise scan the session's rows.
  searchTimer = setTimeout(runSearch, 250);
});

async function runSearch() {
  const q = $('search-input').value.trim();
  const results = $('search-results');
  if (!state.activeJid || q.length < 2) {
    results.textContent = '';
    return;
  }

  const { hits } = await api(
    `/api/sessions/${encodeURIComponent(state.activeJid)}/search?q=${encodeURIComponent(q)}`,
  );

  results.textContent = '';
  if (hits.length === 0) {
    results.append(el('div', 'search-empty', `No matches for "${q}"`));
    return;
  }

  for (const hit of hits) {
    const row = el('div', 'search-hit');
    const meta = el('div', 'hit-meta');
    meta.append(el('span', 'hit-who', hitLabel(hit)));
    meta.append(el('span', null, timeLabel(hit.createdAt)));
    row.append(meta);

    const text = el('div', 'hit-text');
    highlight(text, hit.snippet, q);
    row.append(text);

    row.addEventListener('click', () => jumpTo(hit.id));
    results.append(row);
  }
}

function hitLabel(hit) {
  if (hit.kind === 'message') return hit.role === 'user' ? 'You' : 'pi';
  return hit.role || hit.kind;
}

/** Mark occurrences of `q` without ever assigning HTML from stored content. */
function highlight(container, text, q) {
  const lower = text.toLowerCase();
  const needle = (q ?? '').toLowerCase();
  // An empty needle makes indexOf return the search position forever, so the
  // loop below would never advance — an infinite loop that freezes the tab.
  if (!needle) {
    container.append(document.createTextNode(text));
    return;
  }
  let i = 0;
  while (true) {
    const at = lower.indexOf(needle, i);
    if (at === -1) break;
    if (at > i) container.append(document.createTextNode(text.slice(i, at)));
    container.append(el('mark', null, text.slice(at, at + needle.length)));
    i = at + needle.length;
  }
  container.append(document.createTextNode(text.slice(i)));
}

/** Load a window centred on an event, scroll to it and flash it. */
async function jumpTo(id) {
  if (!state.activeJid) return;

  const { events, hasMore, hasMoreNewer, busy } = await api(
    `/api/sessions/${encodeURIComponent(state.activeJid)}/events?around=${id}&limit=${PAGE_SIZE}`,
  );

  const messages = $('messages');
  messages.textContent = '';
  const nodes = new Map();
  for (const event of events) {
    const node = buildEventNode(event);
    nodes.set(event.id, node);
    messages.append(node);
  }

  state.oldest = events.length > 0 ? events[0].id : 0;
  state.newest = events.length > 0 ? events[events.length - 1].id : 0;
  state.hasMore = Boolean(hasMore);
  state.hasMoreNewer = Boolean(hasMoreNewer);
  // Detached from the tail unless the window happens to reach it.
  state.atLive = !state.hasMoreNewer;
  setJumpLive(!state.atLive);
  setBusy(busy);
  renderTopSentinel();

  const target = nodes.get(id);
  if (target) {
    target.scrollIntoView({ block: 'center' });
    target.classList.add('jump-target');
    setTimeout(() => target.classList.remove('jump-target'), 2200);
  }
  closeSearch();
}

// ── header shortcuts: model / new / stop ─────────────────────────────────

/** Enqueue one of the piscord commands and let its result land in the transcript. */
async function runQuickCommand(command, args = {}) {
  if (!state.activeJid || state.previewingDeleted) return;
  await api(`/api/sessions/${encodeURIComponent(state.activeJid)}/commands`, {
    method: 'POST',
    body: JSON.stringify({ command, args }),
  }).catch((err) => alert(err.message));
}

function newPiSession() {
  // No confirm: /pi new archives the old session rather than destroying it, and
  // the worker posts "Started a fresh pi session." straight into the transcript,
  // which is the feedback a dialog would have been asking for.
  runQuickCommand('pi new');
}

$('btn-stop').addEventListener('click', () => runQuickCommand('pi stop'));

$('btn-status').addEventListener('click', () => runQuickCommand('pi status'));
// The usage button reports the agent the session actually runs on: an agy model
// draws on Antigravity's Gemini quota, not the ChatGPT/Codex rate limit, so
// showing GPT usage there would answer a question the user did not ask.
function usageCommandForSession() {
  return currentModelRef().startsWith('agy/') ? 'agy-usage' : 'gpt-usage';
}

function syncUsageButton() {
  const command = usageCommandForSession();
  const button = $('btn-gpt-usage');
  button.title = `/${command}`;
  button.setAttribute('aria-label', command === 'agy-usage' ? 'Show agy usage' : 'Show GPT usage');
}

$('btn-gpt-usage').addEventListener('click', () => runQuickCommand(usageCommandForSession()));

// ── overflow menu ────────────────────────────────────────────────────────
//
// Search / new session / clean live behind a ⋯ button instead of sitting in the
// topbar, which was crowding the session title. Each row names the slash
// command it runs, so the menu also teaches the typed form.

function isMenuOpen() {
  return !$('more-menu').hidden;
}

function openMoreMenu() {
  $('more-menu').hidden = false;
  $('menu-scrim').hidden = false;
  $('btn-more').setAttribute('aria-expanded', 'true');
  // A trashed session is frozen: only Search still makes sense there.
  for (const id of ['mi-new-chat', 'mi-clean']) {
    $(id).disabled = state.previewingDeleted;
  }
}

function closeMoreMenu() {
  $('more-menu').hidden = true;
  $('menu-scrim').hidden = true;
  $('btn-more').setAttribute('aria-expanded', 'false');
}

$('btn-more').addEventListener('click', () => {
  if (isMenuOpen()) closeMoreMenu();
  else openMoreMenu();
});
$('menu-scrim').addEventListener('click', closeMoreMenu);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (isMenuOpen()) closeMoreMenu();
  if (!$('media-sheet').hidden) closeMediaSheet();
});

/** Wire a menu row: always dismiss first, so the action never runs under an open menu. */
function onMenuItem(id, action) {
  $(id).addEventListener('click', () => {
    closeMoreMenu();
    action();
  });
}

// ── media gallery ──
//
// Everything visual the session produced, on one screen. It lives behind ⋯
// rather than the topbar because it is a browse action, not something reached
// mid-conversation, and the transcript only ever holds the pages scrolled in.

function closeMediaSheet() {
  $('media-sheet').hidden = true;
}

async function openMediaSheet() {
  if (!state.activeJid) return;

  const grid = $('media-grid');
  const note = $('media-note');
  grid.textContent = '';
  note.textContent = 'Loading…';
  $('media-sheet').hidden = false;

  let items = [];
  try {
    ({ items } = await api(`/api/sessions/${encodeURIComponent(state.activeJid)}/media`));
  } catch {
    note.textContent = 'Could not load media for this session.';
    return;
  }

  if (items.length === 0) {
    note.textContent = 'No images or videos in this session yet.';
    return;
  }

  const images = items.filter((i) => i.type === 'image').map((i) => i.url);
  note.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

  const frag = document.createDocumentFragment();
  for (const item of items) {
    frag.append(buildMediaTile(item, images));
  }
  grid.append(frag);
}

function buildMediaTile(item, images) {
  const tile = el('button', 'media-tile');
  tile.type = 'button';
  tile.title = item.name;
  tile.setAttribute('aria-label', `${item.type}: ${item.name}`);

  if (item.type === 'image') {
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = item.name;
    img.loading = 'lazy';
    // A file purged from disk should leave a readable tile, not a broken icon.
    img.addEventListener('error', () => {
      img.remove();
      tile.prepend(el('span', 'media-fallback', item.name));
    });
    tile.append(img);
  } else if (item.type === 'video') {
    const video = document.createElement('video');
    video.src = item.url;
    // metadata only: a grid of fully buffered videos would be a lot of traffic
    // for something the user has not opened yet.
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    tile.append(video);
    tile.append(el('span', 'media-badge', 'VIDEO'));
  } else {
    tile.append(el('span', 'media-fallback', item.name));
    tile.append(el('span', 'media-badge', 'AUDIO'));
  }

  tile.addEventListener('click', () => {
    // Images get the in-app viewer and swipe between each other; video and
    // audio are handed to the browser, which already plays them properly.
    if (item.type === 'image') {
      closeMediaSheet();
      openLightbox(item.url, images);
    } else {
      window.open(item.url, '_blank', 'noopener');
    }
  });

  return tile;
}

$('btn-media-close').addEventListener('click', closeMediaSheet);
$('media-sheet').addEventListener('click', (e) => {
  if (e.target === $('media-sheet')) closeMediaSheet();
});

onMenuItem('mi-sessions', openDrawer);
onMenuItem('mi-media', () => openMediaSheet());
onMenuItem('mi-search', () => openSearch());
onMenuItem('mi-new-chat', newPiSession);
onMenuItem('mi-clean', cleanSession);

// ── model sheet ──

function currentModelRef() {
  const session = state.sessions.find((s) => s.jid === state.activeJid);
  return session ? session.model : '';
}

async function openModelSheet() {
  if (!state.activeJid || state.previewingDeleted) return;
  closeThinkingSheet();
  $('model-sheet').hidden = false;
  syncSheetHeight();
  $('model-search').value = '';
  const list = $('model-list');
  list.textContent = '';
  $('model-note').textContent = 'Loading…';

  const { models } = await api('/api/models').catch(() => ({ models: [] }));
  state.models = models;

  if (models.length === 0) {
    $('model-note').textContent =
      'No models published yet — the worker refreshes this list every 10 minutes.';
    return;
  }

  renderModelList('');

  // Only auto-focus with a real keyboard: on touch this would throw up the
  // on-screen keyboard and cover the list the user came here to read.
  if (!isTouch()) $('model-search').focus();
}

/** Filter across ref, display name and provider so any of them can be typed. */
function modelMatches(model, query) {
  if (!query) return true;
  const haystack = `${model.ref} ${model.name ?? ''} ${model.provider ?? ''}`.toLowerCase();
  return query.split(/\s+/).every((term) => haystack.includes(term));
}

function renderModelList(query) {
  const list = $('model-list');
  list.textContent = '';

  const current = currentModelRef();
  const q = query.trim().toLowerCase();
  const matches = state.models.filter((m) => modelMatches(m, q));

  $('model-note').textContent = q
    ? `${matches.length} of ${state.models.length} models`
    : current
      ? `This session uses ${current}.`
      : 'This session follows the gateway default.';

  // "Gateway default" is an action, not a model, so it is hidden once the user
  // is filtering for something specific.
  if (!q) {
    const reset = el('button', `model-item${current ? '' : ' current'}`);
    reset.type = 'button';
    reset.append(el('span', 'm-ref', 'Gateway default'));
    reset.append(el('span', 'm-tag', 'reset'));
    reset.addEventListener('click', async () => {
      closeModelSheet();
      await runQuickCommand('pi reset-model');
      setTimeout(loadSessions, 900);
    });
    list.append(reset);
  }

  if (matches.length === 0) {
    list.append(el('div', 'search-empty', `No model matches "${query.trim()}"`));
    return;
  }

  // A long unfiltered list would build 345 rows every keystroke; cap it and say
  // so, rather than silently truncating.
  const shown = matches.slice(0, 120);
  for (const model of shown) {
    const item = el('button', `model-item${model.ref === current ? ' current' : ''}`);
    item.type = 'button';

    const ref = el('span', 'm-ref');
    highlight(ref, model.ref, q);
    item.append(ref);

    if (model.provider) {
      const badge = providerBadgeFor(model.provider, model.ref);
      item.append(badge);
    }
    if (model.reasoning) item.append(el('span', 'm-tag', 'reasoning'));

    item.addEventListener('click', async () => {
      closeModelSheet();
      await runQuickCommand('pi model', { model: model.ref });
      // `pi model` round-trips through the worker's control queue, so the new
      // override lands some unpredictable moment later. Poll briefly until the
      // badge actually reflects the pick rather than guessing a single delay.
      awaitOverride(state.activeJid, model.ref);
    });
    list.append(item);
  }

  if (matches.length > shown.length) {
    list.append(
      el('div', 'search-empty', `+${matches.length - shown.length} more — keep typing to narrow`),
    );
  }
}

/**
 * Reload sessions until the chosen model shows up as the session's override,
 * so the badge tracks the pick. Bounded, and stops early once it matches; if
 * the command failed the badge simply stays as it was.
 */
async function awaitOverride(jid, ref, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 400));
    await loadSessions();
    const session = state.sessions.find((s) => s.jid === jid);
    if (session && session.model === ref) {
      // Switching to or away from an agy model changes which quota the usage
      // button should report, so re-sync it the moment the override lands.
      syncUsageButton();
      return;
    }
  }
}

/** Same labels the session badges use, so the two views agree. */
function providerBadgeFor(provider, modelRef = '') {
  // The Codex GPT-5.6 line has three variants (Terra/Sol/Luna); show which one
  // rather than a flat "GPT", mirroring providerBadge() on the server.
  if (provider === 'openai-codex') {
    const id = modelRef.toLowerCase();
    if (id.includes('terra')) return el('span', 'provider-badge terra', 'TERRA');
    if (id.includes('sol')) return el('span', 'provider-badge sol', 'SOL');
    if (id.includes('luna')) return el('span', 'provider-badge luna', 'LUNA');
  }
  const map = {
    nvim: ['NV', 'nv'],
    'openai-codex': ['GPT', 'gpt'],
    'local-llama': ['LOCAL', 'local'],
    'ollama-gemma': ['LOCAL', 'local'],
    'ollama-lfm2': ['LOCAL', 'local'],
    ds4: ['LOCAL', 'local'],
    gemini: ['GEM', 'gem'],
    xai: ['XAI', 'xai'],
    openrouter: ['OR', 'or'],
    sakana: ['SAK', 'sak'],
  };
  const [label, kind] = map[provider] ?? [provider.slice(0, 5).toUpperCase(), 'other'];
  return el('span', `provider-badge ${kind}`, label);
}

function closeModelSheet() {
  $('model-sheet').hidden = true;
}

let modelFilterTimer;
$('model-search').addEventListener('input', () => {
  clearTimeout(modelFilterTimer);
  // Debounced: rebuilding the list on every keystroke over 345 models is
  // needless work on a phone.
  modelFilterTimer = setTimeout(() => renderModelList($('model-search').value), 120);
});

$('model-search').addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if ($('model-search').value) {
      $('model-search').value = '';
      renderModelList('');
    } else {
      closeModelSheet();
    }
  }
});

$('btn-model').addEventListener('click', openModelSheet);
$('btn-model-close').addEventListener('click', closeModelSheet);
$('model-sheet').addEventListener('click', (e) => {
  if (e.target === $('model-sheet')) closeModelSheet();
});

// ── thinking level sheet ─────────────────────────────────────────────────

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const THINKING_DESCRIPTIONS = {
  off: 'No extended thinking',
  minimal: 'Fastest, for simple requests',
  low: 'Light reasoning',
  medium: 'Balanced speed and depth',
  high: 'Deep reasoning for harder work',
  xhigh: 'Maximum model-supported effort',
};

function currentThinkingLevel() {
  const session = state.sessions.find((s) => s.jid === state.activeJid);
  return session?.thinking || '';
}

function renderThinkingButton() {
  const button = $('btn-thinking');
  const current = currentThinkingLevel();
  button.dataset.level = current || 'default';
  const label = current || 'runtime default';
  button.title = `Thinking: ${label}`;
  button.setAttribute('aria-label', `Choose thinking level. Current: ${label}`);
}

function openThinkingSheet() {
  if (!state.activeJid || state.previewingDeleted) return;
  closeModelSheet();
  $('thinking-sheet').hidden = false;
  syncSheetHeight();
  renderThinkingList();
}

function renderThinkingList() {
  const list = $('thinking-list');
  const current = currentThinkingLevel();
  list.textContent = '';
  $('thinking-note').textContent = current
    ? `This session uses ${current}.`
    : 'This session follows the pi runtime default.';

  for (const level of THINKING_LEVELS) {
    const item = el('button', `thinking-item${level === current ? ' current' : ''}`);
    item.type = 'button';
    item.dataset.level = level;

    const copy = el('span', 'thinking-copy');
    copy.append(el('span', 'thinking-name', level));
    copy.append(el('span', 'thinking-description', THINKING_DESCRIPTIONS[level]));
    item.append(copy);

    item.addEventListener('click', async () => {
      const jid = state.activeJid;
      closeThinkingSheet();
      await runQuickCommand('pi thinking', { level });
      await awaitThinkingOverride(jid, level);
    });
    list.append(item);
  }
}

async function awaitThinkingOverride(jid, level, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    await loadSessions();
    const session = state.sessions.find((s) => s.jid === jid);
    if (session?.thinking === level) return;
  }
}

function closeThinkingSheet() {
  $('thinking-sheet').hidden = true;
}

$('btn-thinking').addEventListener('click', openThinkingSheet);
$('btn-thinking-close').addEventListener('click', closeThinkingSheet);
$('thinking-sheet').addEventListener('click', (e) => {
  if (e.target === $('thinking-sheet')) closeThinkingSheet();
});

// ── rename ───────────────────────────────────────────────────────────────

function startListRename(session) {
  state.renamingJid = session.jid;
  state.renameDraft = session.name;
  renderSessions(true);
  const input = $('session-list').querySelector('.session-name-edit');
  if (input) {
    input.focus();
    input.select();
  }
}

async function commitListRename(jid, save) {
  if (state.renamingJid !== jid) return;

  const session = state.sessions.find((s) => s.jid === jid);
  const name = state.renameDraft.trim();
  state.renamingJid = null;
  state.renameDraft = '';

  if (!save || !name || name === session?.name) {
    renderSessions();
    return;
  }

  // Optimistic so Enter feels instant; loadSessions below replaces it with the
  // server's canonical (length-limited) value or rolls it back after an error.
  if (session) session.name = name;
  if (state.activeJid === jid && !state.previewingDeleted) $('session-name').textContent = name;
  renderSessions();

  try {
    await api(`/api/sessions/${encodeURIComponent(jid)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    await loadSessions();
  } catch (err) {
    alert(err.message);
    await loadSessions().catch(() => {});
  }

  const saved = state.sessions.find((s) => s.jid === jid);
  if (saved && state.activeJid === jid && !state.previewingDeleted) {
    $('session-name').textContent = saved.name;
  }
}

function startRename() {
  if (!state.activeJid || state.previewingDeleted) return;
  const label = $('session-name');
  const input = $('session-name-input');
  input.value = label.textContent;
  label.hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

async function commitRename(save) {
  const label = $('session-name');
  const input = $('session-name-input');
  if (input.hidden) return;

  const jid = state.activeJid;
  const name = input.value.trim();
  input.hidden = true;
  label.hidden = false;

  // Empty or unchanged: silently keep what was there rather than erroring.
  if (!save || !name || name === label.textContent) return;

  label.textContent = name;
  try {
    await api(`/api/sessions/${encodeURIComponent(jid)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    await loadSessions();
  } catch (err) {
    alert(err.message);
    await loadSessions();
    const session = state.sessions.find((s) => s.jid === jid);
    if (session && state.activeJid === jid) label.textContent = session.name;
  }
}

$('session-name').addEventListener('click', startRename);
$('session-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    startRename();
  }
});
$('session-name-input').addEventListener('keydown', (e) => {
  // Same IME rule as the composer: Enter/Escape belong to the input method
  // while a composition is in flight, not to the rename.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    commitRename(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    commitRename(false);
  }
});
$('session-name-input').addEventListener('blur', () => commitRename(true));

$('btn-new-session').addEventListener('click', createSession);

async function cleanSession() {
  if (!state.activeJid || state.previewingDeleted) return;
  if (!confirm('Clean this session? Clears the transcript and starts a fresh pi session.')) return;
  await api(`/api/sessions/${encodeURIComponent(state.activeJid)}/clear`, { method: 'POST' });
  $('messages').textContent = '';
  state.cursor = 0;
  openStream();
}

// ── streaming ────────────────────────────────────────────────────────────

function closeStream() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
}

function openStream() {
  closeStream();
  if (!state.activeJid) return;

  const url = `/api/sessions/${encodeURIComponent(state.activeJid)}/stream?after=${state.cursor}`;
  const source = new EventSource(url);
  state.source = source;

  source.addEventListener('event', (e) => {
    const event = JSON.parse(e.data);
    // Guard against a late frame from a previous session's stream.
    if (event.id <= state.cursor) return;
    if (!state.atLive) {
      // Viewing older history after a jump — appending here would splice new
      // messages directly after unrelated ones. Offer to return instead.
      state.cursor = Math.max(state.cursor, event.id);
      state.hasMoreNewer = true;
      setJumpLive(true);
      return;
    }
    appendEvent(event, true);
    if (event.kind !== 'thinking' && event.kind !== 'tool' && event.kind !== 'tool_result' && event.role !== 'user') {
      markSeen(state.activeJid, event.id);
      // Keep the cached row in step so the next render does not resurrect the
      // dot for the session currently on screen.
      const open = state.sessions.find((s) => s.jid === state.activeJid);
      if (open) open.lastReplyId = Math.max(open.lastReplyId ?? 0, event.id);
    }
  });

  source.addEventListener('busy', (e) => setBusy(JSON.parse(e.data).busy));

  // The reply as it is being written. Null means the turn ended and the real
  // message row is arriving, so the preview must go.
  source.addEventListener('partial', (e) => {
    const data = JSON.parse(e.data);
    const live = data && state.atLive ? data : null;
    renderPartial(live?.content ?? '', live?.thinking ?? '');
  });

  // EventSource reconnects on its own, but it would replay from the ORIGINAL
  // `after` value in the URL and duplicate everything, so reopen with the
  // current cursor instead.
  source.addEventListener('error', () => {
    closeStream();
    setTimeout(() => {
      if (state.activeJid) openStream();
    }, 2000);
  });
}

function setBusy(busy) {
  $('typing').hidden = !busy;
  // Stop only exists while there is something to stop — it would be dead
  // weight in an already crowded header otherwise.
  $('btn-stop').hidden = !busy;
  const session = state.sessions.find((s) => s.jid === state.activeJid);
  if (session && session.busy !== busy) {
    session.busy = busy;
    renderSessions();
  }
}

// ── rendering ────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function timeLabel(iso) {
  // SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker; without
  // the Z, Safari parses it as local time and every stamp is hours off.
  const date = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Message bodies get full markdown + LaTeX; see markdown.js. */
function renderText(container, raw) {
  renderRich(container, raw);
}

function renderFiles(container, files) {
  if (!files || files.length === 0) return;
  const wrap = el('div', 'msg-files');

  for (const url of files) {
    const lower = url.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower)) {
      const img = el('img');
      img.src = url;
      img.loading = 'lazy';
      img.alt = 'attachment';
      // Opens the in-app viewer rather than a new tab, so paging between the
      // images in a transcript is a swipe instead of a back-and-forth.
      img.addEventListener('click', () => openLightbox(url));
      wrap.append(img);
    } else if (/\.(mp4|webm|mov)$/.test(lower)) {
      wrap.append(createVideoAttachment(url));
    } else if (/\.(wav|mp3|ogg|m4a)$/.test(lower)) {
      const audio = el('audio');
      audio.src = url;
      audio.controls = true;
      wrap.append(audio);
    } else {
      const link = el('a', 'file-link', decodeURIComponent(url.split('/').pop()));
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      wrap.append(link);
    }
  }

  container.append(wrap);
}

const EVENT_LABELS = {
  thinking: ['Thinking', '💭'],
  tool: ['Tool', '🔧'],
  tool_result: ['Result', '📤'],
  system: ['pi', 'ⓘ'],
  error: ['Error', '⚠️'],
};

function appendEvent(event, live) {
  state.cursor = Math.max(state.cursor, event.id);
  const messages = $('messages');
  const followLatest = shouldFollowTranscriptTail();
  const node = buildEventNode(event);
  if (live) node.classList.add('pop-in');
  messages.append(node);
  // Keep the tail lock synchronous. A smooth scroll can still be in flight when
  // the next stream chunk arrives, making the viewport look "away" from the
  // bottom and incorrectly disabling follow mode.
  if (live) settleTranscriptUpdate(messages, $('jump-live'), followLatest, 'auto');
}

/** Build the DOM for one event. Shared by live append and paged prepend. */
/**
 * The in-flight reply, shown as a normal assistant bubble that grows.
 *
 * Only the newly arrived tail is animated: re-rendering the whole string each
 * poll would restart the fade on text the user has already read, which reads as
 * flickering rather than typing.
 */
let partialSeenText = '';
let partialSeenThinking = '';

/**
 * Where it is safe to render markdown for a half-written message.
 *
 * Markdown is block-structured — a table, list or heading only means anything
 * once its block is complete — so the text is split at the last blank line and
 * only the part before it is rendered. The unfinished tail stays plain until
 * its block closes. Splitting inside an open code fence would render a partial
 * fence as garbage, so an odd number of ``` pushes the boundary back.
 */
function stableMarkdownSplit(text) {
  let cut = text.lastIndexOf('\n\n');
  while (cut > 0) {
    const head = text.slice(0, cut);
    if ((head.match(/```/g) || []).length % 2 === 0) return cut + 2;
    cut = text.lastIndexOf('\n\n', cut - 1);
  }
  return 0;
}

/**
 * Grow a block as text arrives.
 *
 * Completed blocks are handed to the markdown renderer; the still-growing tail
 * is appended as plain spans that fade in. Re-rendering everything on each poll
 * would restart the fade on text already read and reflow the whole bubble, so
 * the markdown half is only rebuilt when the block boundary actually advances.
 */
function growInto(target, text, seen) {
  const state = target.__grow || (target.__grow = { boundary: -1, tail: '' });

  if (!text.startsWith(seen)) {
    target.textContent = '';
    state.boundary = -1;
    state.tail = '';
    seen = '';
  }

  const boundary = stableMarkdownSplit(text);

  if (boundary !== state.boundary) {
    state.boundary = boundary;
    state.tail = '';
    target.textContent = '';
    if (boundary > 0) {
      const done = el('div', 'grow-done');
      renderRich(done, text.slice(0, boundary));
      target.append(done);
    }
    target.append(el('span', 'grow-tail'));
  }

  const tailHost = target.querySelector('.grow-tail');
  const tail = text.slice(boundary);
  const added = tail.slice(state.tail.length);
  if (added && tailHost) {
    const ink = el('span', 'ink', added);
    tailHost.append(ink);
    // Let the browser settle the fresh node before flipping the class on, or
    // the transition is skipped and the text simply pops in.
    requestAnimationFrame(() => ink.classList.add('lit'));
  }
  state.tail = tail;
  return text;
}

function removeFinishedPartial(node) {
  if (!node) return false;
  node.remove();
  return true;
}

function renderPartialThinking(thinking) {
  const host = $('messages');
  let node = document.getElementById('partial-thinking');

  if (!thinking) {
    const removed = removeFinishedPartial(node);
    partialSeenThinking = '';
    return removed;
  }

  if (!node) {
    // Matches the shape of a finished thinking row, so the swap at
    // thinking_end is not a visible jump.
    node = el('details', 'event thinking partial');
    node.id = 'partial-thinking';
    node.classList.add('pop-in');
    const summary = el('summary');
    summary.append(el('span', 'event-chevron', '›'));
    summary.append(el('span', 'label', '💭 Thinking…'));
    node.append(summary);
    const bodyWrap = el('div', 'event-body-wrap');
    bodyWrap.append(el('div', 'event-body'));
    node.append(bodyWrap);
    host.append(node);
    partialSeenThinking = '';
  }

  partialSeenThinking = growInto(node.querySelector('.event-body'), thinking, partialSeenThinking);
  return false;
}

function renderPartial(text, thinking = '') {
  const host = $('messages');
  const followLatest = shouldFollowTranscriptTail();
  const removedThinking = renderPartialThinking(thinking);
  let node = document.getElementById('partial-msg');
  let removedAnswer = false;

  if (!text) {
    removedAnswer = removeFinishedPartial(node);
    partialSeenText = '';
  } else {
    if (!node) {
      node = el('div', 'msg partial pop-in');
      node.id = 'partial-msg';
      const body = el('div', 'msg-body');
      body.append(el('div', 'msg-text'));
      node.append(body);
      host.append(node);
      partialSeenText = '';
    }

    partialSeenText = growInto(node.querySelector('.msg-text'), text, partialSeenText);
  }

  if (state.atLive) {
    const settle = () => settleTranscriptUpdate(host, $('jump-live'), followLatest);
    // Safari can report pre-layout geometry immediately after removing a tall
    // partial, so re-clamp only after that removal has been laid out.
    if (removedThinking || removedAnswer) requestAnimationFrame(settle);
    else settle();
  }
}

function buildEventNode(event) {
  if (event.kind === 'message') {
    const isUser = event.role === 'user';
    const row = el('div', `msg${isUser ? ' msg-user' : ''}`);

    if (isUser) {
      const avatar = el('div', 'avatar', 'U');
      row.append(avatar);

      const body = el('div', 'msg-body');
      const head = el('div', 'msg-head');
      head.append(el('span', 'msg-author', 'You'));
      head.append(el('span', 'msg-time', timeLabel(event.createdAt)));
      body.append(head);

      const textNode = el('div', 'msg-text');
      renderText(textNode, event.content);
      body.append(textNode);
      renderFiles(body, event.files);

      row.append(body);
      return row;
    } else {
      const body = el('div', 'msg-body');
      const textNode = el('div', 'msg-text');
      renderText(textNode, event.content);
      body.append(textNode);
      renderFiles(body, event.files);

      row.append(body);
      return row;
    }
  }
  {
    const [label, icon] = EVENT_LABELS[event.kind] ?? ['Event', '•'];
    const details = el('details', `event ${event.kind}`);
    // Command output and errors are short and matter; agent chatter stays folded.
    const openByDefault = event.kind === 'system' || event.kind === 'error';
    details.open = openByDefault;

    const summary = el('summary');
    summary.append(el('span', 'event-chevron', '›'));
    summary.append(el('span', 'label', `${icon} ${event.role || label}`));
    // A peek would just repeat the body verbatim when it is already expanded.
    if (!openByDefault) {
      const peek = event.content
        .replace(/```\w*\n?/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      summary.append(el('span', 'peek', peek));
    }
    details.append(summary);

    const bodyWrap = el('div', 'event-body-wrap');
    const bodyNode = el('div', 'event-body');
    renderText(bodyNode, event.content);
    bodyWrap.append(bodyNode);
    details.append(bodyWrap);
    return details;
  }
}

function isNearBottom() {
  return isTranscriptNearBottom($('messages'));
}

function shouldFollowTranscriptTail() {
  return composerBottomLocked || isNearBottom();
}

function scrollToBottom(instant) {
  const messages = $('messages');
  messages.scrollTo({ top: messages.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

// ── composer ─────────────────────────────────────────────────────────────

const input = $('input');
const COMPOSER_LAYOUT_GUARD_MS = 600;
const COMPOSER_VIEWPORT_SETTLE_MS = 180;
let composerBottomLocked = false;
let composerBottomFrame = 0;
let composerBottomGuardUntil = 0;
let composerSendIntent = false;
let composerSendIntentCleanupTimer = 0;
let composerSendLockActive = false;
let composerSendSettleTimer = 0;

function keepComposerBottomVisible() {
  if (!composerBottomLocked) return;
  composerBottomGuardUntil = performance.now() + COMPOSER_LAYOUT_GUARD_MS;
  if (composerBottomFrame) cancelAnimationFrame(composerBottomFrame);
  composerBottomFrame = requestAnimationFrame(() => {
    composerBottomFrame = 0;
    if (composerBottomLocked) scrollToBottom(true);
  });
}

function captureComposerBottomLock() {
  composerBottomLocked = isNearBottom();
  keepComposerBottomVisible();
}

function shouldReleaseComposerBottomLock() {
  return (
    composerBottomLocked &&
    !composerBottomFrame &&
    performance.now() >= composerBottomGuardUntil &&
    !isNearBottom()
  );
}

function releaseComposerBottomLock() {
  composerBottomLocked = false;
  composerBottomGuardUntil = 0;
  composerSendIntent = false;
  composerSendLockActive = false;
  if (composerBottomFrame) cancelAnimationFrame(composerBottomFrame);
  composerBottomFrame = 0;
  if (composerSendIntentCleanupTimer) clearTimeout(composerSendIntentCleanupTimer);
  composerSendIntentCleanupTimer = 0;
  if (composerSendSettleTimer) clearTimeout(composerSendSettleTimer);
  composerSendSettleTimer = 0;
}

function captureComposerSendIntent() {
  if (composerSendIntentCleanupTimer) clearTimeout(composerSendIntentCleanupTimer);
  composerSendIntentCleanupTimer = 0;
  composerSendIntent = shouldFollowTranscriptTail();
}

function scheduleComposerSendIntentCleanup() {
  if (composerSendIntentCleanupTimer) clearTimeout(composerSendIntentCleanupTimer);
  composerSendIntentCleanupTimer = setTimeout(() => {
    composerSendIntentCleanupTimer = 0;
    if (!composerSendIntent) return;
    composerSendIntent = false;
    if (document.activeElement !== input) releaseComposerBottomLock();
  }, 0);
}

function cancelMouseSendIntentOnLeave(event) {
  if (event.pointerType === 'mouse' && event.buttons !== 0) cancelComposerSendIntent();
}

function cancelComposerSendIntent() {
  composerSendIntent = false;
  if (composerSendIntentCleanupTimer) clearTimeout(composerSendIntentCleanupTimer);
  composerSendIntentCleanupTimer = 0;
  if (document.activeElement !== input) releaseComposerBottomLock();
}

function consumeComposerSendIntent() {
  const followLatest = composerSendIntent || shouldFollowTranscriptTail();
  composerSendIntent = false;
  if (composerSendIntentCleanupTimer) clearTimeout(composerSendIntentCleanupTimer);
  composerSendIntentCleanupTimer = 0;
  return followLatest;
}

function abandonComposerSend() {
  if (document.activeElement !== input) releaseComposerBottomLock();
}

function scheduleComposerSendSettlement() {
  if (!composerSendLockActive || document.activeElement === input) return;
  if (composerSendSettleTimer) clearTimeout(composerSendSettleTimer);
  composerSendSettleTimer = setTimeout(() => {
    composerSendSettleTimer = 0;
    recoverStandaloneViewport();
    requestAnimationFrame(() => {
      if (!composerSendLockActive || document.activeElement === input) return;
      // The reflow above is best-effort. Clamp once in the current viewport and
      // release; a later viewport expansion only moves the tail closer, while
      // retrying until innerHeight changes can loop forever on broken WebKit.
      scrollToBottom(true);
      releaseComposerBottomLock();
    });
  }, COMPOSER_VIEWPORT_SETTLE_MS);
}

function holdComposerBottomForSend(followLatest) {
  if (!followLatest) return;
  composerBottomLocked = true;
  composerSendLockActive = true;
  keepComposerBottomVisible();
  scheduleComposerSendSettlement();
}

function handleComposerBlur() {
  // Tapping Send blurs the textarea before the submit event. Keep the original
  // tail intent alive until submit consumes it and the keyboard settles.
  if (!composerSendIntent) releaseComposerBottomLock();
}

// Release immediately for explicit reader gestures. The guarded scroll handler
// above covers keyboard/scrollbar movement without mistaking keyboard layout
// animation for user intent.
$('messages').addEventListener('pointerdown', releaseComposerBottomLock, { passive: true });
$('messages').addEventListener('touchmove', releaseComposerBottomLock, { passive: true });
$('messages').addEventListener('wheel', releaseComposerBottomLock, { passive: true });

$('btn-send').addEventListener('pointerdown', captureComposerSendIntent);
$('btn-send').addEventListener('pointerup', scheduleComposerSendIntentCleanup);
$('btn-send').addEventListener('pointerleave', cancelMouseSendIntentOnLeave);
$('btn-send').addEventListener('pointercancel', cancelComposerSendIntent);
input.addEventListener('pointerdown', cancelStandaloneViewportRecovery);
input.addEventListener('focus', captureComposerBottomLock);
input.addEventListener('focus', cancelStandaloneViewportRecovery);
input.addEventListener('blur', handleComposerBlur);
input.addEventListener('blur', scheduleStandaloneViewportRecovery);

const uploadProgress = {
  container: $('upload-progress'),
  bar: $('upload-progress-bar'),
  percent: $('upload-progress-percent'),
};

function setUploading(uploading) {
  state.uploading = uploading;
  $('btn-send').disabled = uploading;
  $('btn-attach').disabled = uploading;
  if (!uploading) hideUploadProgress(uploadProgress);
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
}

input.addEventListener('input', () => {
  autoGrow();
  updateAutocomplete();
  // Growing the composer reduces transcript space just like opening the mobile
  // keyboard; preserve the tail only when focus began at the bottom.
  keepComposerBottomVisible();
});

// Safari fires the composition-committing Enter's keydown *after*
// compositionend, with isComposing already false, so that check alone still
// sends the half-typed line. Remember when composing ended and ignore an Enter
// that lands in the same tick-ish window; a human follow-up keypress is far
// slower than this.
let compositionEndedAt = 0;
input.addEventListener('compositionstart', () => { compositionEndedAt = 0; });
input.addEventListener('compositionend', () => { compositionEndedAt = Date.now(); });

input.addEventListener('keydown', (e) => {
  // An IME (Chinese, Japanese, …) uses Enter to commit the composition; that
  // keydown must not send the message or pick an autocomplete row. `isComposing`
  // is the standard signal, keyCode 229 the fallback browsers that omit it use.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && Date.now() - compositionEndedAt < 100) return;

  if (state.ac.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      state.ac.index = (state.ac.index + delta + state.ac.items.length) % state.ac.items.length;
      renderAutocomplete();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applyAutocomplete(state.ac.items[state.ac.index]);
      return;
    }
    if (e.key === 'Escape') {
      hideAutocomplete();
      return;
    }
  }

  // Enter sends on a physical keyboard; on touch the on-screen Return should
  // insert a newline, so only intercept when a modifier-free Enter arrives from
  // a device that has one.
  if (e.key === 'Enter' && !e.shiftKey && !isTouch()) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

function isTouch() {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

$('btn-attach').addEventListener('click', () => $('file-input').click());

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
  const hasImg = files.some((f) => f.type.startsWith('image/'));
  const hasAud = files.some((f) => f.type.startsWith('audio/'));
  const hasVid = files.some((f) => f.type.startsWith('video/'));

  if (files.length === 1) {
    if (hasImg) return '已貼上圖片附件';
    if (hasAud) return '已貼上音訊附件';
    if (hasVid) return '已貼上影片附件';
    return `已貼上附件 (${files[0].name})`;
  }
  return `已貼上 ${files.length} 個附件檔案`;
}

$('btn-paste')?.addEventListener('click', async () => {
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
            const file = new File([blob], `pasted-${Date.now()}-${i}.${ext}`, { type: fileType });
            mediaFiles.push(file);
          }
        }

        if (mediaFiles.length > 0) {
          addFiles(mediaFiles);
          showToast(formatPasteToast(mediaFiles));
          return;
        }
      } catch {
        // Fallback to readText if read() is not permitted for binary items
      }
    }

    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const before = input.value.slice(0, start);
        const after = input.value.slice(end);
        input.value = before + text + after;
        input.selectionStart = input.selectionEnd = start + text.length;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        autoGrow();
        showToast('已貼上文字');
      } else {
        showToast('剪貼簿中沒有文字或多媒體內容');
      }
    } else {
      showToast('此瀏覽器不支援讀取剪貼簿');
    }
  } catch (err) {
    showToast('無法存取剪貼簿（請確認瀏覽器授權）');
  }
});

// Pasting files (screenshot, audio, video, documents) drops them in with previews.
$('input').addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items ?? [])];
  const files = items
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (files.length === 0) return;
  // Don't paste the binary file as garbage text into the textarea as well.
  e.preventDefault();
  addFiles(files);
  showToast(formatPasteToast(files));
});

$('file-input').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

/**
 * Add files (from the picker or a paste) to the pending list.
 *
 * A pasted item arrives as a Blob with no filename, so one is synthesised;
 * without it the server has nothing to name the upload and pi cannot @-attach
 * it. Object URLs back the thumbnails and are revoked when the chip is removed
 * or the message sends, so previewing images does not leak memory.
 */
function addFiles(fileList) {
  let added = 0;
  for (const file of fileList) {
    if (!file) continue;
    const type = file.type || '';
    const isImage = type.startsWith('image/');
    const isAudio = type.startsWith('audio/');
    const isVideo = type.startsWith('video/');
    const ext = MIME_EXT_MAP[type] || type.split('/')[1]?.split('+')[0] || 'bin';
    const name = file.name || `pasted-${Date.now()}-${added}.${ext}`;
    state.attachments.push({
      name,
      file,
      isImage,
      isAudio,
      isVideo,
      url: isImage ? URL.createObjectURL(file) : null,
    });
    added += 1;
  }
  if (added > 0) renderAttachments();
}

function removeAttachment(i) {
  const [gone] = state.attachments.splice(i, 1);
  if (gone?.url) URL.revokeObjectURL(gone.url);
  renderAttachments();
}

function renderAttachments() {
  const wrap = $('attachments');
  wrap.textContent = '';
  wrap.hidden = state.attachments.length === 0;

  state.attachments.forEach((attachment, i) => {
    const isImg = attachment.isImage;
    const isAud = attachment.isAudio;
    const isVid = attachment.isVideo;
    const chip = el(
      'div',
      `chip${isImg ? ' chip-image' : isAud ? ' chip-audio' : isVid ? ' chip-video' : ''}`,
    );

    if (isImg) {
      // Small square preview, matching what was asked for.
      const thumb = el('img', 'chip-thumb');
      thumb.src = attachment.url;
      thumb.alt = attachment.name;
      chip.append(thumb);
    } else {
      const icon = isAud ? '🎵 ' : isVid ? '🎬 ' : '📎 ';
      chip.append(el('span', 'chip-name', `${icon}${attachment.name}`));
    }

    const remove = el('button', 'chip-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.addEventListener('click', () => removeAttachment(i));
    chip.append(remove);
    wrap.append(chip);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const followAfterSend = consumeComposerSendIntent();
  if (state.uploading) {
    abandonComposerSend();
    return;
  }
  if (!state.activeJid) {
    abandonComposerSend();
    alert('Create or pick a session first.');
    return;
  }

  const text = input.value.trim();
  const quote = state.pendingQuote;
  if (!text && !quote && state.attachments.length === 0) {
    abandonComposerSend();
    return;
  }
  holdComposerBottomForSend(followAfterSend);

  // A slash line is a command, not a prompt. A quoted selection always makes
  // the turn a normal prompt, even when the reply itself begins with a slash.
  if (!quote && text.startsWith('/') && state.attachments.length === 0) {
    const sent = await trySendCommand(text);
    if (sent) {
      input.value = '';
      autoGrow();
      hideAutocomplete();
      return;
    }
  }

  const hasAttachments = state.attachments.length > 0;
  if (hasAttachments) {
    setUploading(true);
    showUploadProgress(uploadProgress, 0);
  }

  try {
    const attachments = [];
    for (const attachment of state.attachments) {
      attachments.push({ name: attachment.name, dataBase64: await fileToBase64(attachment.file) });
    }

    input.value = '';
    state.pendingQuote = '';
    renderQuotePreview();
    hideSelectionActions(true);
    for (const a of state.attachments) if (a.url) URL.revokeObjectURL(a.url);
    state.attachments = [];
    renderAttachments();
    autoGrow();
    hideAutocomplete();

    const path = `/api/sessions/${encodeURIComponent(state.activeJid)}/messages`;
    const payload = { text, quote, attachments };
    if (hasAttachments) {
      await sendJsonWithUploadProgress(path, payload, {
        onProgress: (percent) => showUploadProgress(uploadProgress, percent),
      });
    } else {
      await api(path, { method: 'POST', body: JSON.stringify(payload) });
    }
  } catch (err) {
    if (err.status === 401) showLogin();
    alert(err.message);
  } finally {
    if (hasAttachments) setUploading(false);
  }
});

/** Parse "/pi model gpt-5" into a command + its single argument. */
async function trySendCommand(line) {
  const raw = line.slice(1).trim();
  const match = state.commands
    .filter((c) => raw === c.name || raw.startsWith(`${c.name} `))
    // Longest name first so "pi reset-model" wins over a hypothetical "pi reset".
    .sort((a, b) => b.name.length - a.name.length)[0];

  if (!match) {
    alert(`Unknown command: /${raw.split(' ')[0]}`);
    return false;
  }

  const rest = raw.slice(match.name.length).trim();
  const args = {};
  if (match.arg) {
    if (!rest && match.arg.required) {
      alert(`/${match.name} needs a ${match.arg.name}.`);
      return false;
    }
    if (rest) args[match.arg.name] = rest;
  }

  await api(`/api/sessions/${encodeURIComponent(state.activeJid)}/commands`, {
    method: 'POST',
    body: JSON.stringify({ command: match.name, args }),
  }).catch((err) => alert(err.message));

  return true;
}

// ── slash autocomplete ───────────────────────────────────────────────────

function updateAutocomplete() {
  const value = input.value;
  if (!value.startsWith('/')) return hideAutocomplete();

  const raw = value.slice(1);
  const command = state.commands
    .filter((c) => raw.startsWith(`${c.name} `))
    .sort((a, b) => b.name.length - a.name.length)[0];

  // Once a complete command with an argument is typed, switch to suggesting
  // values for that argument instead of more command names.
  if (command && command.arg) {
    const partial = raw.slice(command.name.length).trim().toLowerCase();
    let options = [];
    if (command.arg.kind === 'model') {
      options = state.models
        .map((m) => m.ref)
        .filter((ref) => ref.toLowerCase().includes(partial))
        .slice(0, 40);
    } else if (command.arg.kind === 'thinking') {
      options = THINKING_LEVELS.filter((level) => level.startsWith(partial));
    }

    if (options.length > 0) {
      state.ac = {
        open: true,
        mode: 'arg',
        command,
        items: options.map((value2) => ({ name: value2, description: '' })),
        index: 0,
      };
      return renderAutocomplete();
    }
    return hideAutocomplete();
  }

  const query = raw.toLowerCase();
  const items = state.commands.filter((c) => c.name.toLowerCase().includes(query));
  if (items.length === 0) return hideAutocomplete();

  state.ac = { open: true, mode: 'command', items, index: 0 };
  renderAutocomplete();
}

/**
 * Tap vs scroll.
 *
 * Selection used to fire on `pointerdown`, which meant dragging the list to
 * scroll it immediately picked whatever item the finger landed on. Selection
 * now happens on pointerUP, and only if the pointer barely moved — so a drag
 * scrolls and a tap selects.
 */
const TAP_SLOP_PX = 10;
// Movement is the real scroll-vs-tap discriminator; this only rejects a finger
// left resting on the list. Kept generous so a slow, deliberate tap still works.
const TAP_MAX_MS = 1500;
let acPointer = null;

function bindAutocompleteTaps(box) {
  box.addEventListener(
    'pointerdown',
    (e) => {
      const row = e.target.closest('.ac-item');
      acPointer = row ? { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId } : null;
    },
    { passive: true },
  );

  const cancel = () => {
    acPointer = null;
  };
  box.addEventListener('pointercancel', cancel, { passive: true });
  box.addEventListener('pointerleave', cancel, { passive: true });

  box.addEventListener('pointerup', (e) => {
    const start = acPointer;
    acPointer = null;
    if (!start || e.pointerId !== start.id) return;

    const row = e.target.closest('.ac-item');
    if (!row) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP_PX) return; // a scroll
    if (Date.now() - start.t > TAP_MAX_MS) return; // a long press

    e.preventDefault();
    const index = Number(row.dataset.index);
    applyAutocomplete(state.ac.items[index]);
  });
}

function renderAutocomplete() {
  const box = $('autocomplete');
  box.textContent = '';
  box.hidden = false;
  syncAutocompleteHeight();

  // Listeners are delegated and bound once; rows are rebuilt on every keystroke.
  if (!box.dataset.bound) {
    bindAutocompleteTaps(box);
    box.dataset.bound = '1';
  }

  box.append(el('div', 'ac-head', state.ac.mode === 'arg' ? 'Values' : 'Commands'));

  state.ac.items.forEach((item, i) => {
    const row = el('div', `ac-item${i === state.ac.index ? ' sel' : ''}`);
    row.dataset.index = String(i);
    const name = el('div', 'ac-name');
    name.append(document.createTextNode(state.ac.mode === 'arg' ? item.name : `/${item.name}`));
    if (state.ac.mode === 'command' && item.arg) {
      name.append(el('span', 'arg', ` [${item.arg.name}]`));
    }
    row.append(name);
    if (item.description) row.append(el('div', 'ac-desc', item.description));
    box.append(row);
  });

  // Arrow-key navigation must not walk the selection out of view.
  const selected = box.querySelector('.ac-item.sel');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function applyAutocomplete(item) {
  if (!item) return;

  if (state.ac.mode === 'arg') {
    input.value = `/${state.ac.command.name} ${item.name}`;
    hideAutocomplete();
  } else {
    // Leave the cursor after a trailing space when the command takes an
    // argument, so the value list opens immediately.
    input.value = `/${item.name}${item.arg ? ' ' : ''}`;
    if (item.arg) updateAutocomplete();
    else hideAutocomplete();
  }

  input.focus();
  autoGrow();
}

function hideAutocomplete() {
  state.ac = { open: false, items: [], index: 0, mode: null };
  $('autocomplete').hidden = true;
}

// ── image lightbox ───────────────────────────────────────────────────────

const lb = {
  urls: [],
  index: 0,
  drag: null,
  scale: 1,
  x: 0,
  y: 0,
  startScale: 1,
  startX: 0,
  startY: 0,
  pinchDist: 0,
  pinchCenter: { x: 0, y: 0 },
  isPinching: false,
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  lastTap: 0,
  lastTapX: 0,
  lastTapY: 0,
};

function resetLightboxTransform(animate = false) {
  lb.scale = 1;
  lb.x = 0;
  lb.y = 0;
  lb.drag = null;
  lb.isPinching = false;
  lb.isPanning = false;
  const img = $('lb-img');
  if (img) {
    if (animate) {
      img.style.transition = 'transform 0.22s cubic-bezier(0.2, 0, 0.2, 1)';
    } else {
      img.style.transition = 'none';
    }
    img.style.transform = 'translate(0px, 0px) scale(1)';
  }
}

function applyLightboxTransform(animate = false) {
  const img = $('lb-img');
  if (!img) return;
  img.style.transition = animate ? 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)' : 'none';
  img.style.transform = `translate(${lb.x}px, ${lb.y}px) scale(${lb.scale})`;
}

/** Every image currently in the transcript, in reading order. */
function collectTranscriptImages() {
  return [...document.querySelectorAll('#messages .msg-files img')].map((n) => n.getAttribute('src'));
}

function openLightbox(url, urls) {
  lb.urls = urls && urls.length ? urls : collectTranscriptImages();
  lb.index = Math.max(0, lb.urls.indexOf(url));
  $('lightbox').hidden = false;
  $('lightbox').classList.toggle('single', lb.urls.length < 2);
  document.body.style.overflow = 'hidden';
  resetLightboxTransform(false);
  buildFilmstrip();
  showLightboxImage();
}

/** Thumbnail strip: jumping to image 12 of 16 should not need 11 swipes. */
function buildFilmstrip() {
  const strip = $('lb-strip');
  strip.textContent = '';
  if (lb.urls.length < 2) return;

  lb.urls.forEach((url, i) => {
    const btn = el('button', 'lb-thumb');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Image ${i + 1}`);
    btn.dataset.index = String(i);

    // Numbered placeholder card (0 bandwidth upfront)
    const num = el('span', 'lb-thumb-num', String(i + 1));
    btn.append(num);

    const img = el('img');
    img.alt = '';
    img.onload = () => img.classList.add('loaded');
    btn.append(img);

    btn.addEventListener('click', () => {
      const dir = i > lb.index ? 1 : -1;
      lb.index = i;
      showLightboxImage(dir);
    });
    strip.append(btn);
  });
}

function syncFilmstrip() {
  const strip = $('lb-strip');
  const total = lb.urls.length;
  const curr = lb.index;

  // Background window: current index and +/- 2 neighbors
  const start = Math.max(0, curr - 2);
  const end = Math.min(total - 1, curr + 2);

  [...strip.children].forEach((btn, i) => {
    const active = i === curr;
    btn.classList.toggle('active', active);
    if (active) btn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });

    // Only load thumbnail image if within the active +/- 2 window
    if (i >= start && i <= end) {
      const img = btn.querySelector('img');
      const url = lb.urls[i];
      if (img && !img.src && url) {
        img.src = url;
      }
    }
  });
}

function closeLightbox() {
  $('lightbox').hidden = true;
  document.body.style.overflow = '';
  resetLightboxTransform(false);
}

/**
 * Show the current image. `direction` (+1/-1) slides the new one in from that
 * side, so paging reads as movement through a sequence instead of a hard cut.
 */
function showLightboxImage(direction = 0) {
  const img = $('lb-img');
  const url = lb.urls[lb.index];

  resetLightboxTransform(false);

  img.style.transition = 'none';
  img.style.transform = direction ? `translateX(${direction * 36}px)` : 'translateX(0)';
  img.style.opacity = direction ? '0' : '1';
  img.classList.remove('fit-up');
  img.src = url;

  img.onload = () => {
    const stage = $('lb-stage').getBoundingClientRect();
    const small = img.naturalWidth < stage.width * 0.6 && img.naturalHeight < stage.height * 0.6;
    img.classList.toggle('fit-up', small);
  };

  requestAnimationFrame(() => {
    img.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0.2, 1), opacity 0.2s ease';
    img.style.transform = 'translateX(0)';
    img.style.opacity = '1';
  });

  $('lb-count').textContent = `${lb.index + 1} / ${lb.urls.length}`;
  $('lb-open').href = url;
  $('lb-prev').disabled = lb.index === 0;
  $('lb-next').disabled = lb.index === lb.urls.length - 1;
  syncFilmstrip();

  // Background prefetch window: preload +/- 2 images (lb.index - 2, -1, +1, +2)
  for (const offset of [-2, -1, 1, 2]) {
    const targetIdx = lb.index + offset;
    if (targetIdx >= 0 && targetIdx < lb.urls.length) {
      new Image().src = lb.urls[targetIdx];
    }
  }
}

function stepLightbox(delta) {
  const next = lb.index + delta;
  if (next < 0 || next >= lb.urls.length) return false;
  lb.index = next;
  showLightboxImage(delta);
  return true;
}

$('lb-close').addEventListener('click', closeLightbox);
$('lb-prev').addEventListener('click', () => stepLightbox(-1));
$('lb-next').addEventListener('click', () => stepLightbox(1));

$('lb-download')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  const url = lb.urls[lb.index];
  if (!url) return;

  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const cleanUrl = url.split('#')[0].split('?')[0];
    const rawName = cleanUrl.split('/').pop() || 'image';
    const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const filename = rawName.includes('.') ? rawName : `${rawName}.${ext}`;
    const file = new File([blob], filename, { type: blob.type || 'image/png' });

    // On iOS Safari / Android: Web Share API opens the native share sheet
    // ("儲存影像", "儲存到檔案", AirDrop, etc.) directly in place without navigating away!
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: filename,
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return; // User simply closed the share sheet
      }
    }

    // Desktop browser fallback: trigger standard download to Downloads folder
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
    showToast('圖片下載完成');
  } catch {
    const a = document.createElement('a');
    a.href = url;
    a.download = url.split('/').pop() || 'image.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
});

// Tapping the backdrop closes; tapping the image itself must not.
$('lightbox').addEventListener('click', (e) => {
  if (e.target === $('lightbox') || e.target === $('lb-stage')) closeLightbox();
});

document.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') stepLightbox(-1);
  else if (e.key === 'ArrowRight') stepLightbox(1);
});

// ── Touch & Gesture Controller (Pinch-to-zoom, Pan, Double-tap, Swipe) ──

const lightboxEl = $('lightbox');
const SWIPE_PAGE_PX = 60;
const SWIPE_DISMISS_PX = 110;

lightboxEl.addEventListener('touchstart', (e) => {
  if (e.target.closest('.lb-bar') || e.target.closest('.lb-nav') || e.target.closest('.lb-strip')) return;

  // 1. Two-finger pinch gesture
  if (e.touches.length === 2) {
    if (e.cancelable) e.preventDefault();
    lb.isPinching = true;
    lb.isPanning = false;
    lb.drag = null;
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    lb.pinchDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    lb.startScale = lb.scale;
    lb.startX = lb.x;
    lb.startY = lb.y;
    lb.pinchCenter = {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    };
    return;
  }

  // 2. Single finger touch
  if (e.touches.length === 1) {
    const touch = e.touches[0];
    const now = Date.now();

    // Double-tap zoom toggle
    if (now - lb.lastTap < 300 && Math.hypot(touch.clientX - (lb.lastTapX || 0), touch.clientY - (lb.lastTapY || 0)) < 40) {
      if (e.cancelable) e.preventDefault();
      lb.lastTap = 0;
      if (lb.scale > 1.1) {
        lb.scale = 1;
        lb.x = 0;
        lb.y = 0;
      } else {
        lb.scale = 2.5;
        const stage = $('lb-stage').getBoundingClientRect();
        const centerX = stage.left + stage.width / 2;
        const centerY = stage.top + stage.height / 2;
        lb.x = (centerX - touch.clientX) * 1.5;
        lb.y = (centerY - touch.clientY) * 1.5;
      }
      applyLightboxTransform(true);
      return;
    }
    lb.lastTap = now;
    lb.lastTapX = touch.clientX;
    lb.lastTapY = touch.clientY;

    if (lb.scale > 1.05) {
      lb.isPanning = true;
      lb.panStartX = touch.clientX - lb.x;
      lb.panStartY = touch.clientY - lb.y;
    } else {
      lb.drag = { x: touch.clientX, y: touch.clientY, axis: null };
    }
    $('lb-img').style.transition = 'none';
  }
}, { passive: false });

lightboxEl.addEventListener('touchmove', (e) => {
  if (e.target.closest('.lb-bar') || e.target.closest('.lb-nav') || e.target.closest('.lb-strip')) return;

  // 1. Two-finger pinch scaling
  if (lb.isPinching && e.touches.length === 2) {
    if (e.cancelable) e.preventDefault();
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    const ratio = dist / (lb.pinchDist || 1);
    lb.scale = Math.min(6, Math.max(0.6, lb.startScale * ratio));

    const cx = (t1.clientX + t2.clientX) / 2;
    const cy = (t1.clientY + t2.clientY) / 2;
    lb.x = lb.startX + (cx - lb.pinchCenter.x);
    lb.y = lb.startY + (cy - lb.pinchCenter.y);

    applyLightboxTransform(false);
    return;
  }

  // 2. Single finger panning when zoomed in
  if (lb.isPanning && e.touches.length === 1) {
    if (e.cancelable) e.preventDefault();
    const touch = e.touches[0];
    lb.x = touch.clientX - lb.panStartX;
    lb.y = touch.clientY - lb.panStartY;
    applyLightboxTransform(false);
    return;
  }

  // 3. Single finger swipe when 1x
  if (lb.drag && e.touches.length === 1) {
    const touch = e.touches[0];
    const dx = touch.clientX - lb.drag.x;
    const dy = touch.clientY - lb.drag.y;

    if (!lb.drag.axis && Math.hypot(dx, dy) > 8) {
      lb.drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }

    const img = $('lb-img');
    if (lb.drag.axis === 'x') {
      const atEnd = (dx > 0 && lb.index === 0) || (dx < 0 && lb.index === lb.urls.length - 1);
      img.style.transform = `translateX(${atEnd ? dx / 4 : dx}px)`;
    } else if (lb.drag.axis === 'y') {
      img.style.transform = `translateY(${dy}px)`;
      img.style.opacity = String(Math.max(0.3, 1 - Math.abs(dy) / 400));
    }
  }
}, { passive: false });

function endLightboxTouch(e) {
  if (lb.isPinching) {
    lb.isPinching = false;
    if (lb.scale < 1.05) {
      resetLightboxTransform(true);
    } else if (lb.scale > 5) {
      lb.scale = 5;
      applyLightboxTransform(true);
    }
    return;
  }

  if (lb.isPanning) {
    lb.isPanning = false;
    if (lb.scale < 1.05) {
      resetLightboxTransform(true);
    }
    return;
  }

  if (lb.drag) {
    const img = $('lb-img');
    const drag = lb.drag;
    lb.drag = null;

    img.style.transition = 'transform 0.18s ease, opacity 0.18s ease';

    const touch = e.changedTouches?.[0];
    const dx = touch ? touch.clientX - drag.x : 0;
    const dy = touch ? touch.clientY - drag.y : 0;

    if (drag.axis === 'y' && Math.abs(dy) > SWIPE_DISMISS_PX) {
      img.style.transform = `translateY(${dy > 0 ? 120 : -120}%)`;
      img.style.opacity = '0';
      lightboxEl.style.transition = 'opacity 0.18s ease';
      lightboxEl.style.opacity = '0';
      setTimeout(() => {
        lightboxEl.style.transition = '';
        lightboxEl.style.opacity = '';
        closeLightbox();
      }, 170);
      return;
    }

    if (drag.axis === 'x' && Math.abs(dx) > SWIPE_PAGE_PX) {
      if (stepLightbox(dx < 0 ? 1 : -1)) return;
    }

    img.style.transform = 'translateX(0)';
    img.style.opacity = '1';
  }
}

lightboxEl.addEventListener('touchend', endLightboxTouch);
lightboxEl.addEventListener('touchcancel', () => resetLightboxTransform(true));

// ── recently deleted ─────────────────────────────────────────────────────

async function refreshTrashCount() {
  try {
    const { sessions } = await api('/api/sessions/deleted');
    const badge = $('trash-count');
    badge.textContent = String(sessions.length);
    badge.hidden = sessions.length === 0;
    return sessions;
  } catch {
    return [];
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  // SQLite timestamps are UTC without a marker; see timeLabel().
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function openTrash() {
  $('trash-sheet').hidden = false;
  const list = $('trash-list');
  list.textContent = '';
  $('trash-note').textContent = 'Loading…';

  const sessions = await refreshTrashCount();
  if (sessions.length === 0) {
    $('trash-note').textContent = 'Nothing here. Deleted sessions appear for 30 days.';
    return;
  }
  $('trash-note').textContent = 'Deleted sessions are kept for 30 days, then purged automatically.';

  for (const s of sessions) {
    const item = el('div', 'trash-item');
    item.append(el('div', 't-name', s.name));
    item.append(
      el('div', 't-meta', `deleted ${fmtDate(s.deletedAt)} · ${s.events} messages`),
    );

    const actions = el('div', 'trash-actions');

    const preview = el('button', null, 'Preview');
    preview.addEventListener('click', () => {
      closeTrash();
      closeDrawer();
      selectSession(s.jid, { deleted: true, name: s.name });
    });

    const restore = el('button', 'primary', 'Restore');
    restore.addEventListener('click', async () => {
      await api(`/api/sessions/${encodeURIComponent(s.jid)}/restore`, { method: 'POST' });
      await loadSessions();
      await refreshTrashCount();
      closeTrash();
      selectSession(s.jid);
      closeDrawer();
    });

    const forever = el('button', 'danger', 'Delete forever');
    forever.addEventListener('click', async () => {
      if (!confirm(`Permanently delete "${s.name}"? This also removes pi's session files and cannot be undone.`)) return;
      await api(`/api/sessions/${encodeURIComponent(s.jid)}?permanent=1`, { method: 'DELETE' });
      openTrash();
    });

    actions.append(preview, restore, forever);
    item.append(actions);
    list.append(item);
  }
}

function closeTrash() {
  $('trash-sheet').hidden = true;
}

$('btn-trash').addEventListener('click', openTrash);
$('btn-trash-close').addEventListener('click', closeTrash);
$('trash-sheet').addEventListener('click', (e) => {
  if (e.target === $('trash-sheet')) closeTrash();
});

$('btn-restore-inline').addEventListener('click', async () => {
  if (!state.activeJid) return;
  await api(`/api/sessions/${encodeURIComponent(state.activeJid)}/restore`, { method: 'POST' });
  await loadSessions();
  await refreshTrashCount();
  selectSession(state.activeJid);
});

// ── keyboard-aware sizing ────────────────────────────────────────────────

/**
 * Cap the autocomplete to the space actually visible.
 *
 * Opening the on-screen keyboard changes only the VISUAL viewport; the layout
 * viewport (and therefore vh/dvh) stays at full screen height on iOS. Without
 * this the list is sized against a viewport taller than what you can see and
 * runs off the top of the screen instead of scrolling.
 */
/** Sheets are capped to the visible viewport, which the keyboard shrinks. */
let maximumViewportHeight = window.innerHeight;
let viewportRecoveryTimer = 0;
let orientationRecoveryTimer = 0;
let orientationChanging = false;

function isStandaloneApp() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function recoverStandaloneViewport() {
  if (
    orientationChanging ||
    !isStandaloneApp() ||
    !needsViewportRecovery(maximumViewportHeight, window.innerHeight)
  ) return;

  const messages = $('messages');
  const followLatest = shouldFollowTranscriptTail();
  recoverViewportShell($('app'), messages, followLatest);
}

function cancelStandaloneViewportRecovery() {
  if (viewportRecoveryTimer) clearTimeout(viewportRecoveryTimer);
  viewportRecoveryTimer = 0;
}

function scheduleStandaloneViewportRecovery() {
  cancelStandaloneViewportRecovery();
  viewportRecoveryTimer = setTimeout(() => {
    viewportRecoveryTimer = 0;
    if (document.activeElement === input) return;
    recoverStandaloneViewport();
  }, 140);
}

function handleOrientationChange() {
  orientationChanging = true;
  cancelStandaloneViewportRecovery();
  if (orientationRecoveryTimer) clearTimeout(orientationRecoveryTimer);
  orientationRecoveryTimer = setTimeout(() => {
    orientationRecoveryTimer = 0;
    maximumViewportHeight = window.innerHeight;
    orientationChanging = false;
    syncViewportSizes();
  }, 250);
}

function syncSheetHeight() {
  const vv = window.visualViewport;
  const available = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--sheet-max', `${Math.round(available * 0.86)}px`);
}

function syncAutocompleteHeight() {
  const vv = window.visualViewport;
  const available = vv ? vv.height : window.innerHeight;
  const composer = $('composer').getBoundingClientRect().height;
  // Leave room for the composer, the attachment chips and a little breathing space.
  const max = Math.max(140, Math.round(available - composer - 90));
  document.documentElement.style.setProperty('--ac-max', `${max}px`);
}

function syncViewportSizes() {
  maximumViewportHeight = Math.max(maximumViewportHeight, window.innerHeight);
  syncAutocompleteHeight();
  syncSheetHeight();
  // iOS reports the keyboard through visualViewport after focus. Re-anchor on
  // each resize/scroll event while the composer owns a bottom lock. A send
  // lock is released only after these events have stopped, not on a fixed
  // keyboard-animation deadline.
  keepComposerBottomVisible();
  scheduleComposerSendSettlement();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportSizes);
  window.visualViewport.addEventListener('scroll', syncViewportSizes);
}
window.addEventListener('resize', syncViewportSizes);
window.addEventListener('orientationchange', handleOrientationChange);
syncViewportSizes();

// ── drawer ───────────────────────────────────────────────────────────────

const wideDrawer = window.matchMedia('(min-width: 768px)');

function openDrawer() {
  renderSessions();
  if (wideDrawer.matches) {
    setDrawerCollapsed($('app'), $('btn-menu'), false);
    return;
  }
  $('drawer').classList.add('open');
  $('scrim').hidden = false;
  $('btn-menu').setAttribute('aria-expanded', 'true');
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').hidden = true;
  if (!wideDrawer.matches) $('btn-menu').setAttribute('aria-expanded', 'false');
}

function hideDrawer() {
  if (wideDrawer.matches) {
    setDrawerCollapsed($('app'), $('btn-menu'), true);
    return;
  }
  closeDrawer();
}

$('btn-menu').setAttribute('aria-expanded', String(wideDrawer.matches));
$('btn-menu').addEventListener('click', openDrawer);
document.querySelector('.hash')?.addEventListener('click', openDrawer);
$('btn-hide-drawer').addEventListener('click', hideDrawer);
$('scrim').addEventListener('click', closeDrawer);

// ── edge swipe ───────────────────────────────────────────────────────────
//
// Dragging in from the left edge pulls the session drawer out, and dragging
// left puts it back. The drawer tracks the finger rather than just toggling on
// release, so the gesture is reversible mid-way.
//
// Deliberately narrow and touch-only: anywhere else on screen a
// horizontal drag belongs to a table, a code block or the image viewer.

const EDGE_ZONE_PX = 36;
const DRAWER_AXIS_LOCK_PX = 8;
let drawerDrag = null;

function drawerWidth() {
  return $('drawer').offsetWidth || 280;
}

function isDrawerGestureAllowed() {
  // Above 768px the drawer is a permanent sidebar; overlays own their gestures.
  if (window.matchMedia('(min-width: 768px)').matches) return false;
  if (!$('login').hidden) return false;
  return (
    $('lightbox').hidden &&
    $('trash-sheet').hidden &&
    $('model-sheet').hidden &&
    $('thinking-sheet').hidden
  );
}

document.addEventListener(
  'touchstart',
  (e) => {
    if (!isDrawerGestureAllowed() || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const open = $('drawer').classList.contains('open');
    // Closed: only the left edge starts it. Open: anywhere, so it can be
    // pushed back from wherever the thumb happens to be.
    if (!open && touch.clientX > EDGE_ZONE_PX) return;
    drawerDrag = { x: touch.clientX, y: touch.clientY, open, axis: null };
  },
  { passive: true },
);

document.addEventListener(
  'touchmove',
  (e) => {
    if (!drawerDrag || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - drawerDrag.x;
    const dy = touch.clientY - drawerDrag.y;

    if (!drawerDrag.axis && Math.hypot(dx, dy) > DRAWER_AXIS_LOCK_PX) {
      drawerDrag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      // Vertical wins: it is a scroll, so bow out entirely.
      if (drawerDrag.axis === 'y') drawerDrag = null;
    }
    if (!drawerDrag || drawerDrag.axis !== 'x') return;

    // Only now claim the gesture, so a vertical scroll was never blocked.
    if (e.cancelable) e.preventDefault();

    const width = drawerWidth();
    const base = drawerDrag.open ? 0 : -width;
    const offset = Math.max(-width, Math.min(0, base + dx));
    // Remembered rather than re-read from getComputedStyle on release: the
    // computed value depends on a style flush having happened, so a fast burst
    // of events can report the stale CSS position and drop the gesture.
    drawerDrag.offset = offset;
    const drawer = $('drawer');
    drawer.style.transition = 'none';
    drawer.style.transform = `translateX(${offset}px)`;

    const scrim = $('scrim');
    scrim.hidden = false;
    scrim.style.transition = 'none';
    scrim.style.opacity = String((offset + width) / width);
  },
  { passive: false },
);

function endDrawerDrag() {
  if (!drawerDrag) return;
  const wasOpen = drawerDrag.open;
  const axis = drawerDrag.axis;
  const offset = drawerDrag.offset;
  drawerDrag = null;

  const drawer = $('drawer');
  const scrim = $('scrim');
  drawer.style.transition = '';
  scrim.style.transition = '';

  if (axis !== 'x') {
    drawer.style.transform = '';
    scrim.style.opacity = '';
    return;
  }

  const width = drawerWidth();
  // Past a third of the way decides it; otherwise it returns where it came from.
  const shouldOpen = wasOpen ? offset > -width / 3 : offset > -width * (2 / 3);

  drawer.style.transform = '';
  scrim.style.opacity = '';
  if (shouldOpen) openDrawer();
  else closeDrawer();
}

document.addEventListener('touchend', endDrawerDrag, { passive: true });
document.addEventListener('touchcancel', endDrawerDrag, { passive: true });

// ── boot ─────────────────────────────────────────────────────────────────

async function boot() {
  const [{ commands }, { models }] = await Promise.all([
    api('/api/commands'),
    api('/api/models').catch(() => ({ models: [] })),
  ]);
  state.commands = commands;
  state.models = models;

  await loadSessions();
  await refreshTrashCount();
  refreshNotifyState().catch(() => {});

  // A notification tap can hand us a session to open.
  const wanted = new URLSearchParams(location.search).get('session');
  const sorted = sessionsForDisplay();
  const target = wanted && state.sessions.some((s) => s.jid === wanted) ? wanted : sorted[0]?.jid;
  if (target) selectSession(target);
}

// The SSE stream only carries the OPEN session, so every other session's busy
// and unread state would otherwise be frozen at page load.
setInterval(() => {
  if (document.visibilityState === 'visible' && !$('app').hidden) {
    loadSessions().catch(() => {});
  }
}, 5000);

// Safari suspends timers and drops the SSE socket in a backgrounded tab;
// re-open on return so a run that finished meanwhile is picked up.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.activeJid && !state.source) openStream();
});

(async () => {
  const me = await api('/api/me').catch(() => ({ authed: false }));
  if (!me.authed) return showLogin();
  // Authenticated by Tailscale identity: there is no cookie to drop, so a
  // "Sign out" button would do nothing visible. Hide it and show who serve
  // says you are instead.
  if (me.via === 'tailscale') {
    $('btn-logout').hidden = true;
    const who = document.createElement('span');
    who.className = 'text-btn';
    who.textContent = `signed in as ${me.login}`;
    $('btn-logout').parentElement.append(who);
  }
  showApp();
  await boot();
})();
