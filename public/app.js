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

const $ = (id) => document.getElementById(id);

const state = {
  sessions: [],
  activeJid: null,
  cursor: 0,
  source: null,
  attachments: [],
  commands: [],
  models: [],
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

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ token: $('login-token').value }) });
    $('login-token').value = '';
    showApp();
    await boot();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ── sessions ─────────────────────────────────────────────────────────────

async function loadSessions() {
  const { sessions } = await api('/api/sessions');
  state.sessions = sessions;
  renderSessions();
}

function renderSessions() {
  const list = $('session-list');
  list.textContent = '';

  if (state.sessions.length === 0) {
    const note = el('div', 'empty-note', 'No sessions yet.\nTap + to start one.');
    list.append(note);
    return;
  }

  for (const session of state.sessions) {
    const item = el('div', `session-item${session.jid === state.activeJid ? ' active' : ''}`);
    item.append(el('span', 'hash', '#'));
    item.append(el('span', 'name', session.name));
    if (session.busy) item.append(el('span', 'busy-dot'));

    const del = el('button', 'icon-btn del');
    del.setAttribute('aria-label', `Delete ${session.name}`);
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${session.name}"? This removes its transcript.`)) return;
      await api(`/api/sessions/${encodeURIComponent(session.jid)}`, { method: 'DELETE' });
      if (state.activeJid === session.jid) {
        state.activeJid = null;
        $('messages').textContent = '';
        $('session-name').textContent = 'no session';
        closeStream();
      }
      await loadSessions();
      if (!state.activeJid && state.sessions.length > 0) selectSession(state.sessions[0].jid);
    });
    item.append(del);

    item.addEventListener('click', () => {
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

async function selectSession(jid) {
  state.activeJid = jid;
  state.cursor = 0;
  state.oldest = 0;
  state.hasMore = false;
  state.loadingOlder = false;
  state.newest = 0;
  state.hasMoreNewer = false;
  state.atLive = true;
  closeSearch();
  const session = state.sessions.find((s) => s.jid === jid);
  $('session-name').textContent = session ? session.name : jid;
  $('messages').textContent = '';
  renderSessions();

  // Only the newest page; older history is pulled in as the user scrolls up.
  const { events, busy, hasMore } = await api(
    `/api/sessions/${encodeURIComponent(jid)}/events?limit=${PAGE_SIZE}`,
  );
  for (const event of events) appendEvent(event, false);
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
  },
  { passive: true },
);

function setJumpLive(show) {
  $('jump-live').hidden = !show;
}

$('jump-live').addEventListener('click', () => {
  if (state.activeJid) selectSession(state.activeJid);
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

$('btn-search').addEventListener('click', () => {
  if ($('search-panel').hidden) openSearch();
  else closeSearch();
});
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
  const needle = q.toLowerCase();
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

$('btn-new-session').addEventListener('click', createSession);

$('btn-clean').addEventListener('click', async () => {
  if (!state.activeJid) return;
  if (!confirm('Clean this session? Clears the transcript and starts a fresh pi session.')) return;
  await api(`/api/sessions/${encodeURIComponent(state.activeJid)}/clear`, { method: 'POST' });
  $('messages').textContent = '';
  state.cursor = 0;
  openStream();
});

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
  });

  source.addEventListener('busy', (e) => setBusy(JSON.parse(e.data).busy));

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

/**
 * Minimal markdown: fenced code, inline code, bold. Everything is inserted as
 * text nodes — no innerHTML on model output, which can contain anything.
 */
function renderText(container, raw) {
  const parts = String(raw).split(/```(\w*)\n?([\s\S]*?)```/g);

  for (let i = 0; i < parts.length; i += 1) {
    // split() with two capture groups yields [text, lang, code, text, ...]
    if (i % 3 === 0) {
      if (parts[i]) renderInline(container, parts[i]);
    } else if (i % 3 === 2) {
      const pre = el('pre');
      pre.append(el('code', null, parts[i]));
      container.append(pre);
    }
  }
}

function renderInline(container, text) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      container.append(el('code', null, token.slice(1, -1)));
    } else if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      container.append(el('strong', null, token.slice(2, -2)));
    } else {
      container.append(document.createTextNode(token));
    }
  }
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
      const link = el('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.append(img);
      wrap.append(link);
    } else if (/\.(mp4|webm|mov)$/.test(lower)) {
      const video = el('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      wrap.append(video);
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
  const stick = isNearBottom();
  messages.append(buildEventNode(event));
  if (live && stick) scrollToBottom();
}

/** Build the DOM for one event. Shared by live append and paged prepend. */
function buildEventNode(event) {
  if (event.kind === 'message') {
    const isUser = event.role === 'user';
    const row = el('div', 'msg');
    const avatar = el('div', `avatar${isUser ? '' : ' pi'}`, isUser ? 'U' : 'π');
    row.append(avatar);

    const body = el('div', 'msg-body');
    const head = el('div', 'msg-head');
    head.append(el('span', 'msg-author', isUser ? 'You' : 'pi'));
    head.append(el('span', 'msg-time', timeLabel(event.createdAt)));
    body.append(head);

    const textNode = el('div', 'msg-text');
    renderText(textNode, event.content);
    body.append(textNode);
    renderFiles(body, event.files);

    row.append(body);
    return row;
  }
  {
    const [label, icon] = EVENT_LABELS[event.kind] ?? ['Event', '•'];
    const details = el('details', `event ${event.kind}`);
    // Command output and errors are short and matter; agent chatter stays folded.
    const openByDefault = event.kind === 'system' || event.kind === 'error';
    details.open = openByDefault;

    const summary = el('summary');
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

    const bodyNode = el('div', 'event-body');
    renderText(bodyNode, event.content);
    details.append(bodyNode);
    return details;
  }
}

function isNearBottom() {
  const messages = $('messages');
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
}

function scrollToBottom(instant) {
  const messages = $('messages');
  messages.scrollTo({ top: messages.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

// ── composer ─────────────────────────────────────────────────────────────

const input = $('input');

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
}

input.addEventListener('input', () => {
  autoGrow();
  updateAutocomplete();
});

input.addEventListener('keydown', (e) => {
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

$('file-input').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    state.attachments.push({ name: file.name, file });
  }
  e.target.value = '';
  renderAttachments();
});

function renderAttachments() {
  const wrap = $('attachments');
  wrap.textContent = '';
  wrap.hidden = state.attachments.length === 0;

  state.attachments.forEach((attachment, i) => {
    const chip = el('div', 'chip');
    chip.append(el('span', 'chip-name', attachment.name));
    const remove = el('button', null, '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.addEventListener('click', () => {
      state.attachments.splice(i, 1);
      renderAttachments();
    });
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
  if (!state.activeJid) {
    alert('Create or pick a session first.');
    return;
  }

  const text = input.value.trim();
  if (!text && state.attachments.length === 0) return;

  // A slash line is a command, not a prompt.
  if (text.startsWith('/') && state.attachments.length === 0) {
    const sent = await trySendCommand(text);
    if (sent) {
      input.value = '';
      autoGrow();
      hideAutocomplete();
      return;
    }
  }

  const attachments = [];
  for (const attachment of state.attachments) {
    attachments.push({ name: attachment.name, dataBase64: await fileToBase64(attachment.file) });
  }

  input.value = '';
  state.attachments = [];
  renderAttachments();
  autoGrow();
  hideAutocomplete();

  await api(`/api/sessions/${encodeURIComponent(state.activeJid)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, attachments }),
  }).catch((err) => alert(err.message));
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

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

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

// ── keyboard-aware sizing ────────────────────────────────────────────────

/**
 * Cap the autocomplete to the space actually visible.
 *
 * Opening the on-screen keyboard changes only the VISUAL viewport; the layout
 * viewport (and therefore vh/dvh) stays at full screen height on iOS. Without
 * this the list is sized against a viewport taller than what you can see and
 * runs off the top of the screen instead of scrolling.
 */
function syncAutocompleteHeight() {
  const vv = window.visualViewport;
  const available = vv ? vv.height : window.innerHeight;
  const composer = $('composer').getBoundingClientRect().height;
  // Leave room for the composer, the attachment chips and a little breathing space.
  const max = Math.max(140, Math.round(available - composer - 90));
  document.documentElement.style.setProperty('--ac-max', `${max}px`);
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncAutocompleteHeight);
  window.visualViewport.addEventListener('scroll', syncAutocompleteHeight);
}
window.addEventListener('resize', syncAutocompleteHeight);
syncAutocompleteHeight();

// ── drawer ───────────────────────────────────────────────────────────────

function openDrawer() {
  $('drawer').classList.add('open');
  $('scrim').hidden = false;
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').hidden = true;
}

$('btn-menu').addEventListener('click', openDrawer);
$('scrim').addEventListener('click', closeDrawer);

// ── boot ─────────────────────────────────────────────────────────────────

async function boot() {
  const [{ commands }, { models }] = await Promise.all([
    api('/api/commands'),
    api('/api/models').catch(() => ({ models: [] })),
  ]);
  state.commands = commands;
  state.models = models;

  await loadSessions();
  if (state.sessions.length > 0) selectSession(state.sessions[0].jid);
}

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
