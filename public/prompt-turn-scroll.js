const SPACE_PROPERTY = '--prompt-turn-space';
const VIEWPORT_QUIET_MS = 120;
const KEYBOARD_GUARD_MS = 220;
const MAX_KEYBOARD_WAIT_MS = 1000;
const SCROLL_DURATION_MS = 360;

/** Reserve one visible turn, not a screen-sized spacer after every message. */
export function getPromptTurnLayout(
  viewportHeight,
  anchorTop,
  contentBottom,
  inset,
  bottomPadding,
) {
  return {
    top: Math.max(0, anchorTop - inset),
    space: Math.max(
      0,
      Math.ceil(viewportHeight - inset - (contentBottom - anchorTop) - bottomPadding),
    ),
  };
}

/** Browser-local send navigation. A durable ack and its SSE row must agree. */
export function createPromptTurnScroll({ scroller, getOwner }) {
  let pending = null;
  let turn = null;
  let frame = 0;
  let dirty = false;
  let updating = false;
  let viewportAt = -Infinity;
  let viewportState = viewportSnapshot();
  const observed = new Set();
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;

  function viewportSnapshot() {
    const vv = globalThis.visualViewport;
    return [
      vv?.height,
      vv?.offsetTop,
      vv?.width,
      globalThis.innerHeight,
      scroller.clientHeight,
    ].join(':');
  }

  function keyboardOpen() {
    return Boolean(
      globalThis.visualViewport && globalThis.innerHeight - globalThis.visualViewport.height > 120,
    );
  }

  function reducedMotion() {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }

  function owned() {
    return turn && turn.owner === getOwner() && scroller.contains(turn.node);
  }

  function requestFrame() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function schedule() {
    dirty = true;
    requestFrame();
  }

  function stopMotion() {
    if (turn) turn.motion = null;
    delete scroller.dataset.promptMotion;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function viewportChanged() {
    const next = viewportSnapshot();
    if (next !== viewportState) {
      viewportState = next;
      viewportAt = performance.now();
      if (turn?.motion) {
        turn.motion.phase = 'waiting';
        turn.motion.readyFrames = 0;
        scroller.dataset.promptMotion = 'waiting';
      }
    }
    if (pending || turn) schedule();
  }

  function watch() {
    mutations?.observe(scroller, { childList: true, subtree: true, characterData: true });
    resize?.observe(scroller);
    for (const row of observed) {
      if (!scroller.contains(row)) {
        resize?.unobserve(row);
        observed.delete(row);
      }
    }
    for (const row of scroller.children) {
      if (!observed.has(row)) {
        resize?.observe(row);
        observed.add(row);
      }
    }
  }

  function clear() {
    pending = null;
    stopMotion();
    turn = null;
    dirty = false;
    mutations?.disconnect();
    resize?.disconnect();
    observed.clear();
    scroller.style.removeProperty(SPACE_PROPERTY);
    delete scroller.dataset.promptTurn;
  }

  function current(ticket) {
    return ticket === pending && ticket?.owner === getOwner();
  }

  function update() {
    if (updating) return;
    updating = true;
    dirty = false;
    try {
      if (pending && pending.owner !== getOwner()) pending = null;
      if (turn && !owned()) {
        clear();
        return;
      }
      if (pending?.eventId) {
        const node = Array.from(scroller.children).find(
          (row) =>
            row.dataset.eventId === String(pending.eventId) && row.classList.contains('msg-user'),
        );
        if (node) {
          node.classList.remove('pop-in');
          turn = {
            node,
            owner: pending.owner,
            pin: true,
            height: -1,
            goal: null,
            motion: {
              phase: 'waiting',
              readyFrames: 0,
              began: pending.began,
              keyboard: pending.keyboard,
            },
          };
          pending = null;
          scroller.dataset.promptMotion = 'waiting';
        }
      }
      if (!turn) {
        if (!pending) clear();
        return;
      }
      watch();
      const previousSpace = Number.parseFloat(scroller.style.getPropertyValue(SPACE_PROPERTY)) || 0;
      const style = getComputedStyle(scroller);
      const inset = Number.parseFloat(style.paddingTop) || 0;
      const bottomPadding = (Number.parseFloat(style.paddingBottom) || 0) - previousSpace;
      const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
      const anchorTop = turn.node.getBoundingClientRect().top - origin;
      const bottom = Math.max(
        anchorTop,
        ...Array.from(scroller.children).map((row) => row.getBoundingClientRect().bottom - origin),
      );
      const layout = getPromptTurnLayout(
        scroller.clientHeight,
        anchorTop,
        bottom,
        inset,
        bottomPadding,
      );
      const pin =
        turn.pin && (turn.height !== scroller.clientHeight || scroller.scrollTop < layout.top - 1);
      if (turn.motion && turn.goal !== null && Math.abs(turn.goal - layout.top) > 1) {
        turn.motion.phase = 'waiting';
        turn.motion.readyFrames = 0;
      }
      turn.goal = layout.top;
      turn.height = scroller.clientHeight;
      scroller.dataset.promptTurn = 'active';
      if (previousSpace !== layout.space)
        scroller.style.setProperty(SPACE_PROPERTY, `${layout.space}px`);
      if (turn.motion) {
        // Reduced motion can retain synchronous placement on a stable desktop.
        // It does not exempt an iPhone send from keyboard/layout settlement.
        if (
          reducedMotion() &&
          !turn.motion.keyboard &&
          performance.now() - viewportAt >= VIEWPORT_QUIET_MS
        ) {
          scroller.scrollTo({ top: turn.goal, behavior: 'auto' });
          stopMotion();
        } else requestFrame();
      } else if (pin) {
        // Restore native upward clamp only while this turn still owns intent.
        scroller.scrollTo({ top: layout.top, behavior: 'auto' });
      }
    } finally {
      updating = false;
    }
  }

  function tick(now) {
    frame = 0;
    if (dirty) update();
    if (turn && !owned()) {
      clear();
      return;
    }
    if (!turn?.motion) return;
    const motion = turn.motion;
    if (motion.phase === 'waiting') {
      motion.readyFrames++;
      const elapsed = now - motion.began;
      const quiet = now - viewportAt >= VIEWPORT_QUIET_MS;
      const keyboardReady = !motion.keyboard || (elapsed >= KEYBOARD_GUARD_MS && !keyboardOpen());
      const fallback = motion.keyboard && elapsed >= MAX_KEYBOARD_WAIT_MS;
      // A stale keyboard report can time out; fresh viewport geometry cannot.
      if (motion.readyFrames < 2 || !quiet || (!keyboardReady && !fallback)) {
        requestFrame();
        return;
      }
      motion.phase = 'moving';
      motion.from = scroller.scrollTop;
      motion.start = now;
      scroller.dataset.promptMotion = 'moving';
    }
    const progress = reducedMotion() ? 1 : Math.min(1, (now - motion.start) / SCROLL_DURATION_MS);
    const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    scroller.scrollTo({ top: motion.from + (turn.goal - motion.from) * eased, behavior: 'auto' });
    if (progress === 1) stopMotion();
    else requestFrame();
  }

  return {
    begin() {
      if (turn && !owned()) clear();
      stopMotion();
      if (turn) turn.pin = false;
      viewportChanged();
      pending = {
        owner: getOwner(),
        eventId: null,
        began: performance.now(),
        keyboard: keyboardOpen(),
      };
      watch();
      return pending;
    },
    get navigating() {
      return Boolean(pending || turn?.motion);
    },
    isCurrent: current,
    acknowledge(ticket, eventId) {
      if (!current(ticket)) return;
      if (!Number.isSafeInteger(eventId) || eventId <= 0) {
        pending = null;
        if (!turn) clear();
        return;
      }
      ticket.eventId = eventId;
      update();
    },
    cancel(ticket) {
      if (pending === ticket) pending = null;
      if (!pending && !turn) clear();
    },
    release() {
      pending = null;
      stopMotion();
      if (turn) turn.pin = false;
      else clear();
    },
    /** Recompute owned padding before a disclosure's native clamp can paint. */
    preserveLayout(change) {
      const active = owned() ? turn : null;
      const top = scroller.scrollTop;
      change();
      update();
      // Do not reclaim a reader-released pin or restore another selection.
      if (active && turn === active && owned()) scroller.scrollTo({ top, behavior: 'auto' });
    },
    viewportChanged,
    update,
    clear,
  };
}
