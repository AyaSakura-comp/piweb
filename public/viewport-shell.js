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
 */

/** A visual viewport this much shorter than the layout one is a keyboard. */
const KEYBOARD_MIN_PX = 150;

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
  let pinned = '';

  function cancelPending() {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    for (const timer of timers) win.clearTimeout(timer);
    timers = [];
  }

  function place() {
    if (!viewport) return;
    // Pinch zoom also shrinks visualViewport.height; it must not relayout the UI.
    if (Math.abs((viewport.scale ?? 1) - 1) > 0.01) return;
    const layoutHeight = Math.max(win.innerHeight || 0, root.clientHeight || 0);
    const keyboard = layoutHeight - viewport.height >= KEYBOARD_MIN_PX && typingFocused(doc);
    const next = keyboard
      ? `${Math.round(viewport.offsetTop || 0)}:${Math.round(viewport.height)}`
      : '';
    if (next === pinned) return;
    pinned = next;
    if (keyboard) {
      const [top, height] = next.split(':');
      root.style.setProperty('--keyboard-shell-top', `${top}px`);
      root.style.setProperty('--keyboard-shell-height', `${height}px`);
      root.classList.add('keyboard-shell');
    } else {
      root.classList.remove('keyboard-shell');
      root.style.removeProperty('--keyboard-shell-top');
      root.style.removeProperty('--keyboard-shell-height');
      // The app never scrolls the document itself; drop any pan iOS left behind.
      if (win.scrollY) win.scrollTo(0, 0);
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
    for (const [target, type] of bindings) target.removeEventListener(type, refresh);
  };
}
