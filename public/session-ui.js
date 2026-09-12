const DEFAULT_LONG_PRESS_MS = 550;
const DEFAULT_MOVE_TOLERANCE_PX = 10;
const DEFAULT_BOTTOM_THRESHOLD_PX = 16;
const DEFAULT_VIEWPORT_RECOVERY_TOLERANCE_PX = 4;
const MIN_HISTORY_PREFETCH_PX = 300;
const HISTORY_PREFETCH_VIEWPORTS = 2;

/** Whether iOS left the standalone viewport shorter after dismissing its keyboard. */
export function needsViewportRecovery(
  maximumHeight,
  currentHeight,
  tolerance = DEFAULT_VIEWPORT_RECOVERY_TOLERANCE_PX,
) {
  return maximumHeight - currentHeight > tolerance;
}

/**
 * Force WebKit to remeasure a full-height shell after its standalone keyboard
 * leaves the viewport stuck short. Preserve the reader's transcript position.
 */
export function recoverViewportShell(shell, scroller, followLatest) {
  const display = shell.style.display;
  const scrollTop = scroller.scrollTop;
  shell.style.display = 'none';
  void shell.offsetHeight;
  shell.style.display = display;
  scroller.scrollTop = followLatest ? scroller.scrollHeight : scrollTop;
}

/**
 * Start the previous-page request well before touch momentum reaches the hard
 * top. A fixed 300px lead is shorter than one phone viewport, so Safari can hit
 * rubber-band overscroll while the request is still in flight and visibly snap
 * when the prepended page is re-anchored.
 */
export function shouldLoadOlderHistory(scroller) {
  const threshold = Math.max(
    MIN_HISTORY_PREFETCH_PX,
    scroller.clientHeight * HISTORY_PREFETCH_VIEWPORTS,
  );
  return scroller.scrollTop < threshold;
}

/** Whether the reader is close enough to the tail to keep following live output. */
export function isTranscriptNearBottom(scroller, threshold = DEFAULT_BOTTOM_THRESHOLD_PX) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < threshold;
}

/**
 * Preserve the reader's intent after transcript content changes: follow only
 * when they were already at the tail, otherwise expose the opt-in jump button.
 */
export function settleTranscriptUpdate(scroller, jumpButton, wasNearBottom, behavior = 'auto') {
  jumpButton.classList.toggle('visible', !wasNearBottom);
  if (wasNearBottom) scroller.scrollTo({ top: scroller.scrollHeight, behavior });
}

/** Return to the live tail without making later output force-scroll a reader who leaves it again. */
export function jumpToLatest(scroller, jumpButton) {
  jumpButton.classList.toggle('visible', false);
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
}

/**
 * Bind a pointer-based long press without mistaking a vertical drawer scroll
 * for a hold. The click browsers emit after a successful hold is swallowed so
 * the session row does not also open and close the drawer.
 */
export function bindLongPress(target, callback, options = {}) {
  const delay = options.delay ?? DEFAULT_LONG_PRESS_MS;
  const moveTolerance = options.moveTolerance ?? DEFAULT_MOVE_TOLERANCE_PX;
  let press = null;
  let suppressClick = false;

  function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  }

  function onPointerDown(event) {
    if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    cancelPress();
    const pending = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      if (press !== pending) return;
      press = null;
      suppressClick = true;
      callback(event);
    }, delay);
    press = pending;
  }

  function onPointerMove(event) {
    if (!press || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > moveTolerance) {
      cancelPress();
    }
  }

  function onClick(event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function onContextMenu(event) {
    if (suppressClick) event.preventDefault();
  }

  target.addEventListener('pointerdown', onPointerDown);
  target.addEventListener('pointermove', onPointerMove);
  target.addEventListener('pointerup', cancelPress);
  target.addEventListener('pointercancel', cancelPress);
  target.addEventListener('lostpointercapture', cancelPress);
  target.addEventListener('click', onClick);
  target.addEventListener('contextmenu', onContextMenu);

  return () => {
    cancelPress();
    target.removeEventListener('pointerdown', onPointerDown);
    target.removeEventListener('pointermove', onPointerMove);
    target.removeEventListener('pointerup', cancelPress);
    target.removeEventListener('pointercancel', cancelPress);
    target.removeEventListener('lostpointercapture', cancelPress);
    target.removeEventListener('click', onClick);
    target.removeEventListener('contextmenu', onContextMenu);
  };
}

/** Keep the shell class and the topbar restore button's accessibility state aligned. */
export function setDrawerCollapsed(app, menuButton, collapsed) {
  app.classList.toggle('drawer-collapsed', collapsed);
  menuButton.setAttribute('aria-expanded', String(!collapsed));
  menuButton.setAttribute('aria-label', collapsed ? 'Show sessions' : 'Open sessions');
}

/**
 * Clock face for a tool call that is still running.
 *
 * A wedged tool call looks exactly like a slow one — the row is on screen with
 * no result and nothing moves — so the elapsed time is the only signal the
 * reader has. Seconds up to a minute, then m:ss, then h:mm:ss.
 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  if (total >= 60) return `${minutes}:${pad(seconds)}`;
  return `${seconds}s`;
}

/**
 * The tool call currently in flight, or null.
 *
 * pi and agy both emit the result as the very next event, so the newest tool
 * row with nothing after it is the one still running — provided the session is
 * actually busy, which is what stops the clock on a turn that died.
 */
export function runningToolNode(messages, busy) {
  if (!busy || !messages) return null;
  const tools = messages.querySelectorAll('.event.tool');
  const last = tools[tools.length - 1];
  if (!last || last.nextElementSibling) return null;
  return last;
}
