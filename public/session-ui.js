const DEFAULT_LONG_PRESS_MS = 550;
const DEFAULT_MOVE_TOLERANCE_PX = 10;
const DEFAULT_BOTTOM_THRESHOLD_PX = 16;
const MIN_HISTORY_PREFETCH_PX = 300;
const HISTORY_PREFETCH_VIEWPORTS = 2;
const AUTO_SCROLL_KEY = 'piweb.autoScroll';

/** Local browser preference; following live output requires explicit opt-in. */
export function readAutoScrollPreference(storage) {
  try {
    return (storage ?? globalThis.localStorage).getItem(AUTO_SCROLL_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveAutoScrollPreference(enabled, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(AUTO_SCROLL_KEY, String(Boolean(enabled)));
  } catch {
    // Keep the in-memory choice when private mode or policy blocks persistence.
  }
}

// Not 'piweb.dashboard': that key holds the Dashboard's layout.
const WORKING_LABEL = 'pi is working…';
const BACKGROUND_LABEL = '等待背景命令…';

/**
 * A busy session that has replied and is held open only by background
 * commands: Claude Code and AGY hand over their reply while commands they
 * started keep running, and Piweb waits for those. True when a command row's
 * latest state is running and the newest row besides command updates is the
 * agent's reply; tool or thinking rows after it mean the agent is working again.
 */
export function isWaitingOnBackgroundCommands(transcript) {
  const states = new Map();
  let newest = null;
  for (const row of transcript.querySelectorAll(':scope > .msg, :scope > details.event')) {
    if (row.dataset.commandId) states.set(row.dataset.commandId, row.dataset.commandState);
    else newest = row;
  }
  if (![...states.values()].includes('running')) return false;
  return Boolean(newest?.matches('.msg:not(.msg-user):not(.msg-narration):not(.partial)'));
}

/**
 * Keep a typing line's label true to what the session waits for. Re-checks
 * whenever rows are added or removed; returns the check for busy changes.
 */
export function bindTypingLabel(typingEl, transcript) {
  const label = typingEl.querySelector('.typing-label');
  const sync = () => {
    const text = isWaitingOnBackgroundCommands(transcript) ? BACKGROUND_LABEL : WORKING_LABEL;
    if (label && label.textContent !== text) label.textContent = text;
  };
  const observer = new MutationObserver(sync);
  observer.observe(transcript, { childList: true });
  return { sync, disconnect: () => observer.disconnect() };
}

const DASHBOARD_KEY = 'piweb.dashboardEnabled';

/** Local browser preference; the Dashboard is on unless turned off here. */
export function readDashboardPreference(storage) {
  try {
    return (storage ?? globalThis.localStorage).getItem(DASHBOARD_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveDashboardPreference(enabled, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(DASHBOARD_KEY, enabled ? 'on' : 'off');
  } catch {
    // Keep the in-memory choice when private mode or policy blocks persistence.
  }
}

export function shouldAutoScrollTranscript(scroller, enabled, bottomLocked = false) {
  return Boolean(enabled && (bottomLocked || isTranscriptNearBottom(scroller)));
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
export function settleTranscriptUpdate(
  scroller,
  jumpButton,
  wasNearBottom,
  behavior = 'auto',
  autoScroll = true,
) {
  const follow = autoScroll && wasNearBottom;
  jumpButton.classList.toggle('visible', !follow && !isTranscriptNearBottom(scroller));
  if (follow) scroller.scrollTo({ top: scroller.scrollHeight, behavior });
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
  let clickGuardTimer = null;
  let clickGuardX = 0;
  let clickGuardY = 0;
  const ownerDocument = target.ownerDocument;

  function clearClickGuard() {
    if (clickGuardTimer) clearTimeout(clickGuardTimer);
    clickGuardTimer = null;
    ownerDocument?.removeEventListener('click', consumeLongPressClick, true);
  }

  function consumeLongPressClick(event) {
    if (!suppressClick) return;
    if (Math.hypot(event.clientX - clickGuardX, event.clientY - clickGuardY) > moveTolerance) {
      suppressClick = false;
      clearClickGuard();
      return;
    }
    suppressClick = false;
    clearClickGuard();
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
  }

  function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  }

  function onPointerDown(event) {
    if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    cancelPress();
    if (options.shouldStart && !options.shouldStart(event)) return;
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
      clickGuardX = pending.x;
      clickGuardY = pending.y;
      // The callback may replace `target` (Recently deleted re-renders its
      // rows when selection mode begins). Capture the synthetic post-hold click
      // at the document so it cannot land on the replacement row and undo the
      // selection. The timeout avoids consuming a later intentional tap on
      // platforms that do not emit a click after long-press.
      if (ownerDocument) {
        ownerDocument.addEventListener('click', consumeLongPressClick, true);
        clickGuardTimer = setTimeout(() => {
          suppressClick = false;
          clearClickGuard();
        }, 1_000);
      }
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
    consumeLongPressClick(event);
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
    suppressClick = false;
    clearClickGuard();
    target.removeEventListener('pointerdown', onPointerDown);
    target.removeEventListener('pointermove', onPointerMove);
    target.removeEventListener('pointerup', cancelPress);
    target.removeEventListener('pointercancel', cancelPress);
    target.removeEventListener('lostpointercapture', cancelPress);
    target.removeEventListener('click', onClick);
    target.removeEventListener('contextmenu', onContextMenu);
  };
}

const DRAWER_SLIDE_MS = 260;

/**
 * Keep the shell class and the topbar restore button's accessibility state
 * aligned. On a wide screen the docked drawer slides out (or in) by its own
 * width while the main view widens (or narrows) with it, instead of the view
 * jumping a frame later. `drawermotionstart` / `drawermotionend` on the app
 * bracket the slide, so a view can hold its text still and rewrap after.
 * An interrupting toggle picks the drawer up where it is.
 */
export function setDrawerCollapsed(app, menuButton, collapsed) {
  menuButton.setAttribute('aria-expanded', String(!collapsed));
  menuButton.setAttribute('aria-label', collapsed ? 'Show sessions' : 'Open sessions');
  const drawer = app.querySelector?.('.drawer');
  const moving = drawer?.motion;
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const docked = drawer && getComputedStyle(drawer).position !== 'fixed';
  if (!drawer?.animate || reduced || (!moving && !docked)) {
    moving?.cancel();
    app.classList.toggle('drawer-collapsed', collapsed);
    return;
  }
  if (!moving && app.classList.contains('drawer-collapsed') === collapsed) return;
  // Where the drawer is now: mid-slide, or fully in.
  const from = moving ? parseFloat(getComputedStyle(drawer).marginLeft) || 0 : null;
  moving?.cancel();
  app.classList.remove('drawer-collapsed');
  const width = drawer.offsetWidth;
  const start = from ?? (collapsed ? 0 : -width);
  const end = collapsed ? -width : 0;
  if (!moving) app.dispatchEvent(new CustomEvent('drawermotionstart'));
  const motion = drawer.animate([{ marginLeft: `${start}px` }, { marginLeft: `${end}px` }], {
    duration: DRAWER_SLIDE_MS * Math.min(1, Math.abs(end - start) / width),
    easing: 'cubic-bezier(.2,.8,.2,1)',
  });
  drawer.motion = motion;
  motion.onfinish = () => {
    drawer.motion = null;
    app.classList.toggle('drawer-collapsed', collapsed);
    app.dispatchEvent(new CustomEvent('drawermotionend'));
  };
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
 * What ends a call is its result, not merely something being written after it.
 * Requiring the tool row to be last was wrong: agy's own stall notice arrives
 * as a thinking row two minutes in, which took the clock off screen at exactly
 * the moment the reader most wanted it. Only a tool_result stops it — plus the
 * session's busy flag, which stops the clock on a turn that died.
 */
export function runningToolNode(messages, busy) {
  if (!busy || !messages) return null;
  const rows = messages.querySelectorAll('.event.tool, .event.tool_result');
  const last = rows[rows.length - 1];
  if (!last || !last.classList?.contains('tool')) return null;
  return last;
}
