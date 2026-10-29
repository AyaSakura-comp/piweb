// Full-screen reading for the chat (DESIGN.md "Full-screen reading"): a tap on
// the transcript slides the header up and the composer down so the
// conversation has the whole screen; another tap brings them back.
//
// The words under the reader's eyes never jump. Going full screen, the
// transcript grows under the header and composer first (they become overlays,
// `.session-fullscreen` in app.css) and its scroll offset is corrected in the
// same frame; the chrome then slides away and uncovers more of it. Coming
// back, the chrome slides in over the transcript first and the layout changes
// only once it covers the edges. A transcript at its newest message stays
// there instead: its last line rides with the composer.

const HIDE_MS = 140;
const HIDE_EASING = 'ease-in';
const SHOW_MS = 220;
const SHOW_EASING = 'cubic-bezier(.2,.8,.2,1)';

export function createSessionFullscreen({ app, scroller, followsTail = () => false }) {
  let active = false;
  let motion = null;
  let leaving = 0;
  let movingUntil = 0;

  const reducedMotion = () =>
    Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  // Where the transcript's content starts on screen.
  const origin = () => scroller.getBoundingClientRect().top - scroller.scrollTop;

  function stopMotion() {
    motion?.cancel();
    motion = null;
  }

  /** Change the layout, keep the content in place (or at the tail); how far did it move? */
  function relayout(change, tail) {
    const before = origin();
    change();
    const top = scroller.getBoundingClientRect().top;
    scroller.scrollTop = tail ? scroller.scrollHeight : top - before;
    return origin() - before;
  }

  function slide(from, to, duration, easing) {
    stopMotion();
    if (from === to || reducedMotion() || typeof scroller.animate !== 'function') return;
    motion = scroller.animate(
      [{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }],
      { duration, easing, fill: 'forwards' },
    );
  }

  function finishExit(tail) {
    clearTimeout(leaving);
    leaving = 0;
    stopMotion();
    relayout(() => app.classList.remove('session-fullscreen', 'session-fullscreen-leaving'), tail);
  }

  function enter() {
    if (active) return;
    active = true;
    stopMotion();
    const moved = relayout(() => app.classList.add('session-fullscreen'), followsTail());
    // Start from where the content was and settle with the chrome.
    slide(-moved, 0, HIDE_MS, HIDE_EASING);
    movingUntil = performance.now() + HIDE_MS;
  }

  function exit({ animate = true } = {}) {
    if (!active) {
      // Switching sessions mid-way does not wait for the chrome to land.
      if (leaving && !animate) finishExit(false);
      return;
    }
    active = false;
    const tail = followsTail();
    if (!animate || reducedMotion()) {
      finishExit(tail);
      return;
    }
    stopMotion();
    let shift = 0;
    if (tail) {
      // Measure where the tail will rest, then undo it before anything paints,
      // with transitions off: otherwise putting the chrome back off screen
      // starts its slide out again, and it would snap in instead of sliding.
      const top = scroller.scrollTop;
      app.classList.add('session-fullscreen-measuring');
      shift = relayout(() => app.classList.remove('session-fullscreen'), true);
      app.classList.add('session-fullscreen');
      scroller.scrollTop = top;
      scroller.getBoundingClientRect();
      app.classList.remove('session-fullscreen-measuring');
    }
    app.classList.add('session-fullscreen-leaving');
    slide(0, shift, SHOW_MS, SHOW_EASING);
    movingUntil = performance.now() + SHOW_MS;
    leaving = setTimeout(() => finishExit(tail), SHOW_MS);
  }

  return {
    get active() {
      return active;
    },
    /** A tap: ignored while the chrome is still moving (a double tap is not two). */
    toggle() {
      if (performance.now() < movingUntil) return;
      if (active) exit();
      else enter();
    },
    enter,
    exit,
  };
}
