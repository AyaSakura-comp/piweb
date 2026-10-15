// Hot keywords above the composer (standard sessions only; Life has its own
// quick tags in the same spot). The host worker recounts the words the user
// typed most this week whenever a message lands and publishes them as a JSON
// file in the media dir; the page fetches it on every (re)connect.
//
// Multi-select: tapping a chip toggles it and adds or removes that word in the
// message box; nothing is ever sent. A tap leaves the iPhone keyboard exactly
// as it was: the chip never takes focus (which would close the keyboard) and
// never focuses the box (which would open it). Editing the word out of the box, or
// sending, releases the chip. More chips than fit scroll sideways.
export const HOT_KEYWORDS_URL = '/media/piweb-shared/hot-keywords.json';
export const HOT_KEYWORDS_STORAGE_KEY = 'piweb.hot_keywords_days';
export const DEFAULT_WINDOW_DAYS = '1';
const MAX_CHIPS = 10;

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Latin words match on word boundaries ("push" not inside "pushed"); CJK has none.
const wordPattern = (word) =>
  /^[\w-]+$/.test(word) ? new RegExp(`(^|[^\\w-])${escapeRe(word)}(?![\\w-])`, 'i') : new RegExp(escapeRe(word));

export function createHotKeywords({ container, input, select, fetchImpl = fetch, storage = null }) {
  let storageImpl = storage;
  if (!storageImpl) {
    try { storageImpl = localStorage; } catch {}
  }
  let selectedDays = DEFAULT_WINDOW_DAYS;
  try {
    const stored = storageImpl?.getItem(HOT_KEYWORDS_STORAGE_KEY);
    if (stored) selectedDays = String(stored);
  } catch {}

  let cachedData = null;
  let items = [];
  const selected = new Set();

  if (select) {
    select.value = selectedDays;
    select.addEventListener('change', () => {
      setWindowDays(select.value);
    });
  }

  function applyWindow() {
    let windowItems = cachedData?.windows?.[selectedDays];
    if (!Array.isArray(windowItems) && String(cachedData?.windowDays) === selectedDays) {
      windowItems = cachedData?.items;
    }
    items = Array.isArray(windowItems)
      ? windowItems
          .filter((item) => typeof item?.word === 'string' && item.word)
          .slice(0, MAX_CHIPS)
      : Array.isArray(cachedData?.items)
        ? cachedData.items
            .filter((item) => typeof item?.word === 'string' && item.word)
            .slice(0, MAX_CHIPS)
        : [];
    render();
    sync();
  }

  function setWindowDays(days) {
    selectedDays = String(days);
    if (select && select.value !== selectedDays) select.value = selectedDays;
    try {
      storageImpl?.setItem(HOT_KEYWORDS_STORAGE_KEY, selectedDays);
    } catch {}
    applyWindow();
  }

  function render() {
    container.replaceChildren();
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'life-tag hot-keyword';
      button.textContent = item.word;
      button.dataset.word = item.word;
      button.setAttribute('aria-pressed', String(selected.has(item.word)));
      button.title = `${selectedDays} 天內用了 ${item.count} 次`;
      bindTap(button, () => toggle(item.word));
      container.append(button);
    }
    container.hidden = items.length === 0;
  }

  // iOS moves focus on the compatibility mousedown that follows touchend, so a
  // tap is handled on touchend itself and its default (focus change + click)
  // cancelled; a finger that moved is a sideways scroll of the row, not a tap.
  // Mouse: keep focus where it is on mousedown and act on click.
  function bindTap(button, onTap) {
    let start = null;
    button.addEventListener('touchstart', (event) => {
      const touch = event.touches[0];
      start = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
    }, { passive: true });
    button.addEventListener('touchmove', (event) => {
      const touch = event.touches[0];
      if (start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) start = null;
    }, { passive: true });
    button.addEventListener('touchcancel', () => { start = null; });
    button.addEventListener('touchend', (event) => {
      if (!start) return;
      start = null;
      event.preventDefault();
      onTap();
    });
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', onTap);
  }

  function setInput(value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function toggle(word) {
    const draft = input.value;
    if (selected.has(word)) {
      selected.delete(word);
      const match = draft.match(wordPattern(word));
      if (match) {
        const start = match.index + (match[1] ?? '').length;
        const before = draft.slice(0, start).replace(/[ \t]+$/, '');
        const after = draft.slice(start + word.length).replace(/^[ \t]+/, '');
        setInput(before && after ? `${before} ${after}` : before + after);
      }
    } else {
      selected.add(word);
      setInput(draft.trim() ? `${draft.replace(/\s+$/, '')} ${word}` : word);
    }
    // Keep the caret at the end when typing is under way; never focus the box.
    if (document.activeElement === input) input.setSelectionRange(input.value.length, input.value.length);
    render();
  }

  // A chip stays pressed only while its word is still in the box: typing it
  // away, clearing the box, or sending (the composer empties it) releases it.
  function sync() {
    let changed = false;
    for (const word of selected) {
      if (!wordPattern(word).test(input.value)) {
        selected.delete(word);
        changed = true;
      }
    }
    if (changed) render();
  }

  async function refresh() {
    try {
      const res = await fetchImpl(HOT_KEYWORDS_URL, { credentials: 'same-origin', cache: 'no-cache' });
      if (!res.ok) return;
      cachedData = await res.json();
      applyWindow();
    } catch {
      // No file yet, offline, or signed out: keep whatever is shown.
    }
  }

  input.addEventListener('input', sync);
  // Sending clears the box programmatically (no input event), from the form,
  // the Send button or the camera's Send; a light poll while anything is
  // selected catches every path.
  setInterval(() => {
    if (selected.size) sync();
  }, 400);
  // "Connect": the page loading and every return to it (iOS suspends
  // backgrounded tabs, so coming back is effectively a reconnect).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  window.addEventListener('online', () => void refresh());
  render();
  void refresh();
  return {
    refresh,
    sync,
    setWindowDays,
    get windowDays() { return selectedDays; },
    get items() { return items; },
    get selected() { return [...selected]; }
  };
}
