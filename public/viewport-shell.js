/**
 * Keyboard-aware shell placement plus viewport change notifications for the
 * transcript/composer/sheet policies.
 *
 * At rest `.app` is `100dvh` (the layout viewport). The iOS keyboard shrinks
 * only the VISUAL viewport, and iOS then pans it as far down the page as the
 * page goes, so everything under the input (the composer's safe-area padding
 * and any page height past the shell) shows as a blank band above the keyboard
 * (iPhone screenshot, 2026-10-20). While the keyboard is up the shell is
 * therefore pinned to the visual viewport itself: `position: fixed` at
 * `visualViewport.offsetTop` with `visualViewport.height`. Fixed boxes live in
 * layout-viewport coordinates, the same ones `offsetTop` is measured in, so the
 * shell covers exactly what is visible however far iOS panned. Shrinking the
 * height WITHOUT following the pan (715f9cc) left the composer floating at the
 * top of the screen instead.
 *
 * The iOS 26 standalone "page is short by the status bar height" bug is fixed
 * in CSS (`app.css`, display-mode: standalone), not here.
 *
 * iOS may finish keyboard/rotation layout after its last viewport event, so
 * sample again over a bounded settling window.
 *
 * A short visual viewport alone is not proof of a keyboard: iOS 26 can leave
 * `visualViewport.height` short after the keyboard closes (WebKit 301857), and
 * the pinned shell then stayed squeezed into the top of an empty screen
 * (iPhone screenshot, 2026-10-22). The keyboard is only up while something
 * that takes typing has focus, so the pin also requires that, and focus
 * changes re-check it.
 *
 * Tapping a button (Send, Jump to present) blurs the box BEFORE iOS starts
 * lowering the keyboard, and iOS then reports the visual viewport frame by
 * frame on the way down. Unpinning at the blur put the full-height shell
 * under a viewport still panned a keyboard down: the topbar shot off the top
 * and the page slid back over 300ms (iPhone recording 2026-10-23), and Send
 * jumped out from under the finger between mousedown and mouseup, so the tap
 * sometimes sent nothing. The shell therefore keeps following the viewport
 * for a moment after typing focus leaves, like it does for Done.
 *
 * When iOS reports a whole keyboard move at once (it does on open), the
 * values are final while iOS is still animating its pan, and a shell jumped
 * straight there showed a keyboard-tall blank band that closed as the pan
 * caught up. Such jumps ease along the pan instead; the curves are fitted to
 * that recording.
 */

/** A visual viewport this much shorter than the layout one is a keyboard. */
const KEYBOARD_MIN_PX = 150;

/** How long the shell follows the viewport after typing focus leaves. */
const BLUR_FOLLOW_MS = 650;

/**
 * A pin change this large in one step is a keyboard move iOS is still
 * animating. Frame-by-frame steps while the keyboard goes down reach ~185px.
 */
const JUMP_PX = 240;
const ENTER_EASE = { ms: 190, curve: 'cubic-bezier(0.3, 0.2, 0.6, 0.95)' };
const LEAVE_EASE = { ms: 320, curve: 'cubic-bezier(0.25, 0.4, 0, 1)' };

const TEXT_INPUT_TYPES = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/;

/** Whether the focused element is one the on-screen keyboard types into. */
export function typingFocused(doc) {
  const el = doc.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.test(el.type || 'text') && !el.readOnly && !el.disabled;
  return false;
}

export function bindViewportShell(win, doc, onViewportChange = () => {}) {
  const viewport = win.visualViewport;
  const root = doc.documentElement;
  let frame = 0;
  let timers = [];
  let disposed = false;
  let pinned = null;
  let typing = false;
  let typingLeftAt = -Infinity;
  let easeFrame = 0;
  let easeUntil = 0;
  let leaveTimer = 0;

  function cancelPending() {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    for (const timer of timers) win.clearTimeout(timer);
    timers = [];
  }

  function reducedMotion() {
    return Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }

  function setGeometry({ top, height }) {
    root.style.setProperty('--keyboard-shell-top', `${top}px`);
    root.style.setProperty('--keyboard-shell-height', `${height}px`);
  }

  function release() {
    if (leaveTimer) win.clearTimeout(leaveTimer);
    leaveTimer = 0;
    root.classList.remove('keyboard-shell', 'keyboard-shell-leaving');
    root.style.removeProperty('--keyboard-shell-top');
    root.style.removeProperty('--keyboard-shell-height');
    // The app never scrolls the document itself; drop any pan iOS left behind.
    if (win.scrollY) win.scrollTo(0, 0);
  }

  // The composer and transcript re-anchor on every frame the shell moves.
  function easeFrames() {
    easeFrame = 0;
    if (disposed) return;
    onViewportChange();
    if (performance.now() < easeUntil) easeFrame = win.requestAnimationFrame(easeFrames);
    else root.classList.remove('keyboard-shell-easing');
  }

  function ease({ ms, curve }) {
    root.style.setProperty('--keyboard-shell-ease', `${ms}ms ${curve}`);
    root.classList.add('keyboard-shell-easing');
    easeUntil = performance.now() + ms;
    if (!easeFrame) easeFrame = win.requestAnimationFrame(easeFrames);
  }

  function place() {
    if (!viewport) return;
    // Pinch zoom also shrinks visualViewport.height; it must not relayout the UI.
    if (Math.abs((viewport.scale ?? 1) - 1) > 0.01) return;
    const layoutHeight = Math.max(win.innerHeight || 0, root.clientHeight || 0);
    const nowTyping = typingFocused(doc);
    if (typing && !nowTyping) typingLeftAt = performance.now();
    typing = nowTyping;
    const following = typing || performance.now() - typingLeftAt < BLUR_FOLLOW_MS;
    // Once pinned, follow the keyboard all the way down: letting go while it
    // still covers a little would leave the rest of iOS's pan to a jump.
    const covered = layoutHeight - viewport.height >= (pinned ? 1 : KEYBOARD_MIN_PX);
    const keyboard = covered && following;
    const next = keyboard
      ? { top: Math.round(viewport.offsetTop || 0), height: Math.round(viewport.height) }
      : null;
    if (next?.top === pinned?.top && next?.height === pinned?.height) return;
    const rest = { top: 0, height: layoutHeight };
    const from = pinned || rest;
    const to = next || rest;
    const jump =
      Math.max(Math.abs(to.top - from.top), Math.abs(to.height - from.height)) >= JUMP_PX &&
      !reducedMotion();
    pinned = next;
    if (next) {
      if (leaveTimer) {
        win.clearTimeout(leaveTimer);
        leaveTimer = 0;
        root.classList.remove('keyboard-shell-leaving');
      } else if (!root.classList.contains?.('keyboard-shell') && jump) {
        // Start the eased move from the shell's resting place.
        setGeometry(rest);
        root.classList.add('keyboard-shell');
        root.getBoundingClientRect?.();
      }
      if (jump) ease(ENTER_EASE);
      setGeometry(next);
      root.classList.add('keyboard-shell');
    } else if (jump) {
      // Ease back to the resting place while iOS lowers the keyboard, then let go.
      ease(LEAVE_EASE);
      root.classList.add('keyboard-shell-leaving');
      setGeometry(rest);
      leaveTimer = win.setTimeout(release, LEAVE_EASE.ms);
    } else {
      release();
    }
  }

  function sample() {
    if (disposed || doc.visibilityState === 'hidden') return;
    place();
    onViewportChange();
  }

  function refresh() {
    cancelPending();
    sample();
    if (disposed || doc.visibilityState === 'hidden') return;
    frame = win.requestAnimationFrame(() => { frame = 0; sample(); });
    timers = [120, 350, 700].map(delay => win.setTimeout(sample, delay));
  }

  const bindings = [
    [win, 'resize'],
    [win, 'orientationchange'],
    [win, 'pageshow'],
    [doc, 'visibilitychange'],
    [doc, 'focusin'],
    [doc, 'focusout'],
    ...(viewport ? [[viewport, 'resize'], [viewport, 'scroll']] : []),
  ];
  for (const [target, type] of bindings) target.addEventListener(type, refresh);

  return () => {
    disposed = true;
    cancelPending();
    if (easeFrame) win.cancelAnimationFrame(easeFrame);
    if (leaveTimer) win.clearTimeout(leaveTimer);
    for (const [target, type] of bindings) target.removeEventListener(type, refresh);
  };
}
