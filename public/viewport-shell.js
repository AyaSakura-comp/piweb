/**
 * Viewport change notifications for the transcript/composer/sheet policies.
 *
 * This deliberately does NOT size the shell. `.app` stays `100dvh` (the layout
 * viewport) and iOS pans the visual viewport over it to keep the focused input
 * above the keyboard. Shrinking the shell to `visualViewport.height` fights that
 * pan: WebKit keeps the pan offset it computed for the full-height page, so the
 * shortened shell is scrolled up and the composer floats at the top with a
 * blank band between it and the keyboard. The iOS 26 standalone "page is short
 * by the status bar height" bug is fixed in CSS (`app.css`, display-mode:
 * standalone), not here.
 *
 * iOS may finish keyboard/rotation layout after its last viewport event, so
 * sample again over a bounded settling window.
 */
export function bindViewportShell(win, doc, onViewportChange = () => {}) {
  const viewport = win.visualViewport;
  let frame = 0;
  let timers = [];
  let disposed = false;

  function cancelPending() {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    for (const timer of timers) win.clearTimeout(timer);
    timers = [];
  }

  function notify() {
    if (disposed || doc.visibilityState === 'hidden') return;
    onViewportChange();
  }

  function refresh() {
    cancelPending();
    notify();
    if (disposed || doc.visibilityState === 'hidden') return;
    frame = win.requestAnimationFrame(() => { frame = 0; notify(); });
    timers = [120, 350, 700].map(delay => win.setTimeout(notify, delay));
  }

  const bindings = [
    [win, 'resize'],
    [win, 'orientationchange'],
    [win, 'pageshow'],
    [doc, 'visibilitychange'],
    ...(viewport ? [[viewport, 'resize'], [viewport, 'scroll']] : []),
  ];
  for (const [target, type] of bindings) target.addEventListener(type, refresh);

  return () => {
    disposed = true;
    cancelPending();
    for (const [target, type] of bindings) target.removeEventListener(type, refresh);
  };
}
