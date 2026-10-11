// Pins the prompt of the turn being read to the top of the transcript once it
// has scrolled away. Collapsed it shows only its first line; a tap expands the
// whole prompt in place, and another tap folds it again.
//
// It behaves like a sticky section header: the next prompt's own row pushes the
// pinned bar up and out as it reaches the top, and scrolling back up, the row
// settles into its place while the previous prompt is pushed back down.
//
// A long tool loop can push its prompt onto an older page that is not loaded.
// `getEarlier()` then names that boundary ({ key, load }) and `load()` fetches
// the latest prompt before it, once per boundary.
// A slash command (`/claude-usage`, typed or from a header button) is stored as
// a user message too, but it is not the prompt of the turn around it;
// `isCommand(text)` says which user messages are such command echoes.
export function createPromptPin({ scroller, getEarlier = () => null, isCommand = () => false }) {
  // A div, not a <button>: the expanded prompt scrolls inside it, and iOS does
  // not scroll content inside a native button.
  const bar = document.createElement('div');
  bar.setAttribute('role', 'button');
  bar.tabIndex = 0;
  bar.id = 'prompt-pin';
  bar.className = 'prompt-pin';
  bar.setAttribute('aria-expanded', 'false');
  const text = document.createElement('span');
  text.className = 'prompt-pin-text';
  const chevron = document.createElement('span');
  chevron.className = 'prompt-pin-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>';
  bar.append(text, chevron);
  // The clip is the strip under the header; pushing the bar up slides it out
  // of the strip rather than over the header.
  const clip = document.createElement('div');
  clip.className = 'prompt-pin-clip';
  clip.hidden = true;
  clip.append(bar);
  scroller.before(clip);

  let current = null;
  let prompt = '';
  let expanded = false;
  let frame = 0;
  const earlier = new Map();

  function setExpanded(next) {
    expanded = next;
    bar.classList.toggle('expanded', next);
    bar.setAttribute('aria-expanded', String(next));
    bar.setAttribute('aria-label', next ? '收合目前的提問' : '展開目前的提問');
    // Folded shows the first non-empty line only; expanded, the whole prompt.
    text.textContent = next ? prompt : prompt.split('\n').find((line) => line.trim()) || '';
  }

  /** Prompt rows (command echoes excluded), split at the transcript's top edge. */
  function promptRows() {
    const top = scroller.getBoundingClientRect().top;
    let above = null;
    let below = null;
    for (const row of scroller.querySelectorAll('.msg.msg-user')) {
      if (isCommand(row.dataset.prompt || '')) continue;
      const offset = row.getBoundingClientRect().top - top;
      if (offset < 0.5) above = row;
      else {
        below = { row, offset };
        break;
      }
    }
    return { above, below };
  }

  /** Prompt (and identity) of the turn being read, or null when unknown yet. */
  function resolve(row) {
    if (row) return { id: row, prompt: row.dataset.prompt?.trim() || '' };
    const boundary = getEarlier();
    if (!boundary) return null;
    let entry = earlier.get(boundary.key);
    if (!entry) {
      entry = { prompt: null };
      earlier.set(boundary.key, entry);
      Promise.resolve()
        .then(boundary.load)
        .then(
          (prompt) => (entry.prompt = typeof prompt === 'string' ? prompt.trim() : ''),
          () => earlier.delete(boundary.key),
        )
        .finally(schedule);
    }
    return entry.prompt == null ? null : { id: boundary.key, prompt: entry.prompt };
  }

  function update() {
    frame = 0;
    const rows = scroller.hidden || !scroller.isConnected ? null : promptRows();
    const found = rows && resolve(rows.above);
    const row = found?.id;
    const next = found?.prompt || '';
    if (!row || !next) {
      current = null;
      clip.hidden = true;
      return;
    }
    if (row !== current || next !== prompt) {
      current = row;
      prompt = next;
      setExpanded(false);
    }
    clip.style.top = `${scroller.offsetTop}px`;
    clip.hidden = false;
    // The next prompt's row pushes the bar up as it comes within its height.
    const height = bar.offsetHeight;
    const push = rows.below && rows.below.offset < height ? height - rows.below.offset : 0;
    bar.style.transform = push ? `translateY(${-push}px)` : '';
    bar.inert = height > 0 && push >= height;
    // Its shadow would linger at the top edge once the bar is pushed out.
    bar.classList.toggle('pushed', push > 0);
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  // Rows move without a scroll too: replies finish rendering, images and
  // fonts load, details open. Any change inside re-checks (one per frame).
  new MutationObserver(schedule).observe(scroller, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  scroller.addEventListener('load', schedule, true);
  scroller.addEventListener('toggle', schedule, true);
  new ResizeObserver(schedule).observe(scroller);
  document.fonts?.addEventListener?.('loadingdone', schedule);
  bar.addEventListener('click', () => setExpanded(!expanded));
  bar.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setExpanded(!expanded);
  });
  setExpanded(false);
  return { update: schedule };
}
