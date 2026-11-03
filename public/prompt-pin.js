// Pins the prompt of the turn being read to the top of the transcript once it
// has scrolled away. Collapsed it shows only its first line; a tap expands the
// whole prompt in place, and another tap folds it again. A long press on the
// folded bar jumps back to that prompt's own row, at the top of the transcript.
//
// It behaves like a sticky section header: the next prompt's own row pushes the
// pinned bar up and out as it reaches the top, and its own bar slides down in
// as the row's text scrolls past; scrolling back up runs the same in reverse.
//
// A long tool loop can push its prompt onto an older page that is not loaded.
// `getEarlier()` then names that boundary ({ key, load }) and `load()` fetches
// the latest prompt before it, once per boundary, as { prompt, id }; a long
// press then asks `jumpToEvent(id)` to load the page around it.
// A slash command (`/claude-usage`, typed or from a header button) is stored as
// a user message too, but it is not the prompt of the turn around it;
// `isCommand(text)` says which user messages are such command echoes.
import { bindLongPress } from './session-ui.js';

const JUMP_FLASH_MS = 2200;

export function createPromptPin({
  scroller,
  getEarlier = () => null,
  isCommand = () => false,
  jumpToEvent = () => {},
}) {
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
  let currentEventId = 0;
  let prompt = '';
  let expanded = false;
  let frame = 0;
  let lastPush = -1;
  const earlier = new Map();

  function setExpanded(next) {
    expanded = next;
    bar.classList.toggle('expanded', next);
    bar.setAttribute('aria-expanded', String(next));
    bar.setAttribute('aria-label', next ? '收合目前的提問' : '展開目前的提問');
    bar.setAttribute('aria-description', next ? '' : '長按跳到這則提問');
    // Folded shows the first non-empty line only; expanded, the whole prompt.
    text.textContent = next ? prompt : prompt.split('\n').find((line) => line.trim()) || '';
  }

  /**
   * Prompt rows (command echoes excluded), split at the transcript's top edge.
   * A row counts as scrolled past only once its first line of text is above
   * the edge: a just-sent prompt is placed flush with the edge, and its own
   * "You" line and text must stay visible, not be covered by its own pin.
   * The next row's push still follows the row's top edge.
   */
  function promptRows() {
    const top = scroller.getBoundingClientRect().top;
    let above = null;
    let below = null;
    for (const row of scroller.querySelectorAll('.msg.msg-user')) {
      if (isCommand(row.dataset.prompt || '')) continue;
      const line = row.querySelector('.msg-text') || row;
      const offset = line.getBoundingClientRect().top - top;
      if (offset < 0.5) above = { row, past: -offset };
      else {
        below = { row, offset: row.getBoundingClientRect().top - top };
        break;
      }
    }
    return { above, below };
  }

  /** Prompt (and identity) of the turn being read, or null when unknown yet. */
  function resolve(row) {
    if (row) return { id: row, eventId: 0, prompt: row.dataset.prompt?.trim() || '' };
    const boundary = getEarlier();
    if (!boundary) return null;
    let entry = earlier.get(boundary.key);
    if (!entry) {
      entry = { prompt: null, eventId: 0 };
      earlier.set(boundary.key, entry);
      Promise.resolve()
        .then(boundary.load)
        .then(
          (found) => {
            // A plain string is a prompt with nowhere to jump (a dashboard pane).
            const text = typeof found === 'string' ? found : found?.prompt;
            entry.prompt = typeof text === 'string' ? text.trim() : '';
            entry.eventId = Number(found?.id) || 0;
          },
          () => earlier.delete(boundary.key),
        )
        .finally(schedule);
    }
    return entry.prompt == null
      ? null
      : { id: boundary.key, eventId: entry.eventId, prompt: entry.prompt };
  }

  function update() {
    frame = 0;
    const rows = scroller.hidden || !scroller.isConnected ? null : promptRows();
    const found = rows && resolve(rows.above?.row);
    const row = found?.id;
    const next = found?.prompt || '';
    if (!row || !next) {
      current = null;
      currentEventId = 0;
      clip.hidden = true;
      return;
    }
    currentEventId = found.eventId;
    if (row !== current || next !== prompt) {
      current = row;
      prompt = next;
      setExpanded(false);
    }
    const targetClipTop = `${scroller.offsetTop}px`;
    if (clip.style.top !== targetClipTop) clip.style.top = targetClipTop;
    if (clip.hidden) clip.hidden = false;
    // The next prompt's row pushes the bar up as it comes within its height,
    // and the pinned prompt's own bar slides down into place as that prompt's
    // text scrolls past the edge, rather than popping in over it.
    const height = bar.offsetHeight;
    const out = rows.below && rows.below.offset < height ? height - rows.below.offset : 0;
    const enter = rows.above && rows.above.past < height ? height - rows.above.past : 0;
    const push = Math.min(height, Math.max(out, enter));
    if (push !== lastPush) {
      lastPush = push;
      bar.style.transform = push ? `translate3d(0, ${-push}px, 0)` : '';
      const nextInert = height > 0 && push >= height;
      if (bar.inert !== nextInert) bar.inert = nextInert;
      // Its shadow would linger at the top edge once the bar is pushed out.
      bar.classList.toggle('pushed', push > 0);
    }
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
  /**
   * Back to where the turn began: the prompt's own row at the top edge,
   * flashed like a search hit. One on an unloaded page is loaded around first.
   */
  function jump() {
    if (current instanceof Element) {
      if (!current.isConnected) return;
      // Rounded up, as a just-sent prompt is placed: a row edge a fraction
      // below the top edge would leave a sliver of the pin over it.
      scroller.scrollTop += Math.ceil(
        current.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      );
      current.classList.remove('jump-target');
      void current.offsetWidth; // restart the flash on a second press
      current.classList.add('jump-target');
      const row = current;
      setTimeout(() => row.classList.remove('jump-target'), JUMP_FLASH_MS);
    } else if (currentEventId) {
      jumpToEvent(currentEventId);
    }
  }
  // Expanded, a hold on the prompt's text selects it (to copy) instead.
  bindLongPress(bar, jump, { shouldStart: () => !expanded });
  bar.addEventListener('click', () => setExpanded(!expanded));
  bar.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setExpanded(!expanded);
  });
  setExpanded(false);
  return { update: schedule };
}
