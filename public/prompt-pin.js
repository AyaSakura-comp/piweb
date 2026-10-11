// Pins the prompt of the turn being read to the top of the transcript once its
// first line has scrolled away. Collapsed it shows only that first line; a tap
// expands the whole prompt in place, and another tap folds it again.
export function createPromptPin({ scroller }) {
  // A div, not a <button>: the expanded prompt scrolls inside it, and iOS does
  // not scroll content inside a native button.
  const bar = document.createElement('div');
  bar.setAttribute('role', 'button');
  bar.tabIndex = 0;
  bar.id = 'prompt-pin';
  bar.className = 'prompt-pin';
  bar.hidden = true;
  bar.setAttribute('aria-expanded', 'false');
  const text = document.createElement('span');
  text.className = 'prompt-pin-text';
  const chevron = document.createElement('span');
  chevron.className = 'prompt-pin-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>';
  bar.append(text, chevron);
  scroller.before(bar);

  let current = null;
  let prompt = '';
  let expanded = false;
  let frame = 0;

  function setExpanded(next) {
    expanded = next;
    bar.classList.toggle('expanded', next);
    bar.setAttribute('aria-expanded', String(next));
    bar.setAttribute('aria-label', next ? '收合目前的提問' : '展開目前的提問');
    // Folded shows the first non-empty line only; expanded, the whole prompt.
    text.textContent = next ? prompt : prompt.split('\n').find((line) => line.trim()) || '';
  }

  /** The last user prompt whose first line is above the transcript's top edge. */
  function promptAbove() {
    const top = scroller.getBoundingClientRect().top + 4;
    const rows = scroller.querySelectorAll('.msg.msg-user');
    for (let index = rows.length - 1; index >= 0; index--) {
      const line = rows[index].querySelector('.msg-text') || rows[index];
      if (line.getBoundingClientRect().top < top) return rows[index];
    }
    return null;
  }

  function update() {
    frame = 0;
    const row = scroller.hidden || !scroller.isConnected ? null : promptAbove();
    const next = row?.dataset.prompt?.trim() || '';
    if (!row || !next) {
      current = null;
      bar.hidden = true;
      return;
    }
    if (row !== current || next !== prompt) {
      current = row;
      prompt = next;
      setExpanded(false);
    }
    bar.style.top = `${scroller.offsetTop}px`;
    bar.hidden = false;
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(scroller, {
    childList: true,
    attributes: true,
    attributeFilter: ['hidden'],
  });
  bar.addEventListener('click', () => setExpanded(!expanded));
  bar.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setExpanded(!expanded);
  });
  setExpanded(false);
  return { update: schedule };
}
