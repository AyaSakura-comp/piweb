/**
 * One visible-height authority for the chat, dashboard and drawer.
 * iOS may finish keyboard/rotation layout after its last viewport event; sample
 * again over a bounded settling window instead of hiding/remounting the shell.
 */
export function bindViewportShell(win, doc, onHeightChange = () => {}) {
  const viewport = win.visualViewport;
  let lastHeight = null;
  let frame = 0;
  let timers = [];
  let disposed = false;

  function cancelPending() {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    for (const timer of timers) win.clearTimeout(timer);
    timers = [];
  }

  function measure() {
    if (disposed || doc.visibilityState === 'hidden') return;
    // Pinch zoom changes visualViewport.height but must not relayout the UI.
    if (viewport && Math.abs((viewport.scale ?? 1) - 1) > 0.01) return;
    const height = viewport ? viewport.height : win.innerHeight;
    if (!Number.isFinite(height) || height <= 0) return;
    const rounded = Math.round(height);
    if (rounded !== lastHeight) {
      lastHeight = rounded;
      doc.documentElement.style.setProperty('--app-viewport-height', `${rounded}px`);
    }
    // Preserve existing composer/tail policies on viewport scroll events too,
    // even if only the visible offset changed and the height stayed constant.
    onHeightChange();
  }

  function refresh() {
    cancelPending();
    measure();
    if (disposed || doc.visibilityState === 'hidden') return;
    frame = win.requestAnimationFrame(() => { frame = 0; measure(); });
    timers = [120, 350, 700].map(delay => win.setTimeout(measure, delay));
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
  refresh();

  return () => {
    disposed = true;
    cancelPending();
    for (const [target, type] of bindings) target.removeEventListener(type, refresh);
  };
}
