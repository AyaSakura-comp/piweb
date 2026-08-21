const DEFAULT_LONG_PRESS_MS = 550;
const DEFAULT_MOVE_TOLERANCE_PX = 10;
const DEFAULT_BOTTOM_THRESHOLD_PX = 16;

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
