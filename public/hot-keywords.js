// Hot keywords above the composer (standard sessions only; Life has its own
// quick tags in the same spot). The host worker recounts the words the user
// typed most this week whenever a message lands and publishes them as a JSON
// file in the media dir; the page fetches it on every (re)connect.
//
// Multi-select: tapping a chip toggles it and adds or removes that word in the
// message box; nothing is ever sent. Editing the word out of the box, or
// sending, releases the chip. More chips than fit scroll sideways.
export const HOT_KEYWORDS_URL = '/media/piweb-shared/hot-keywords.json';
const MAX_CHIPS = 10;

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Latin words match on word boundaries ("push" not inside "pushed"); CJK has none.
const wordPattern = (word) =>
  /^[\w-]+$/.test(word) ? new RegExp(`(^|[^\\w-])${escapeRe(word)}(?![\\w-])`, 'i') : new RegExp(escapeRe(word));

export function createHotKeywords({ container, input, fetchImpl = fetch }) {
  let items = [];
  const selected = new Set();

  function render() {
    container.replaceChildren();
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'life-tag hot-keyword';
      button.textContent = item.word;
      button.dataset.word = item.word;
      button.setAttribute('aria-pressed', String(selected.has(item.word)));
      button.title = `這週用了 ${item.count} 次`;
      button.addEventListener('click', () => toggle(item.word));
      container.append(button);
    }
    container.hidden = items.length === 0;
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
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
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
      const data = await res.json();
      items = Array.isArray(data?.items)
        ? data.items
            .filter((item) => typeof item?.word === 'string' && item.word)
            .slice(0, MAX_CHIPS)
        : [];
      render();
      sync();
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
  return { refresh, sync, get items() { return items; }, get selected() { return [...selected]; } };
}
