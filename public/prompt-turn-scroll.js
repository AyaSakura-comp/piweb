const SPACE_PROPERTY = '--prompt-turn-space';
const SCROLL_DURATION_MS = 360;

/**
 * How much taller the transcript will get once the on-screen keyboard is down.
 * The app passes the pinned shell's shortfall; this fallback reads the visual
 * viewport for callers without a keyboard shell.
 */
function visualViewportCover() {
  const vv = globalThis.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round((globalThis.innerHeight || 0) - vv.height));
}

/** Reserve one visible turn, not a screen-sized spacer after every message. */
export function getPromptTurnLayout(
  viewportHeight,
  anchorTop,
  contentBottom,
  bottomPadding,
) {
  // Padding is not a clipping gutter: an inset exposes the previous row.
  // Round upward so fractional row edges cannot leave a sliver of history.
  const top = Math.max(0, Math.ceil(anchorTop));
  return {
    top,
    space: Math.max(
      0,
      // Reserve the rounding offset too, or scrollHeight clamps the last pixel.
      Math.ceil(viewportHeight - (contentBottom - anchorTop) - bottomPadding + top - anchorTop),
    ),
  };
}

/**
 * Browser-local send navigation. A durable ack and its SSE row must agree.
 *
 * Send with the keyboard up is one motion (iPhone, 2026-11-11): the scroll
 * starts as soon as the prompt's row is known and runs while iOS lowers the
 * keyboard. It used to wait for the keyboard to settle, and the transcript
 * meanwhile slid down with the growing viewport (its end clamped against the
 * bottom), paused, then scrolled back up. The target, the prompt flush with
 * the top edge, does not depend on the viewport height, so nothing has to
 * wait: the reservation instead covers the room the keyboard is about to free
 * (`keyboardCover`), from the tap on, so the growing viewport never clamps the
 * position and the history stays put until the prompt carries it up.
 */
export function createPromptTurnScroll({
  scroller,
  getOwner,
  keyboardCover = visualViewportCover,
}) {
  let pending = null;
  let turn = null;
  let frame = 0;
  let dirty = false;
  let updating = false;
  const observed = new Set();
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;

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

  // The keyboard going down only grows the viewport; the target stays put, so
  // a motion keeps going and the reservation is simply re-measured.
  function viewportChanged() {
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
            motion: { phase: 'waiting', readyFrames: 0 },
          };
          pending = null;
          scroller.dataset.promptMotion = 'waiting';
        }
      }
      if (!turn && !pending) {
        clear();
        return;
      }
      watch();
      // A hidden transcript (BTW in front) measures as zero: keep the last
      // layout; showing it again resizes it, which schedules a fresh update.
      if (!scroller.clientHeight) return;
      const previousSpace = Number.parseFloat(scroller.style.getPropertyValue(SPACE_PROPERTY)) || 0;
      // The reservation is the ::after block after the rows, not padding.
      const bottomPadding = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
      const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
      const anchorTop = turn ? turn.node.getBoundingClientRect().top - origin : 0;
      const bottom = Math.max(
        anchorTop,
        ...Array.from(scroller.children).map((row) => row.getBoundingClientRect().bottom - origin),
      );
      // While a send owns the transcript, reserve the room the keyboard is
      // still going to free: the viewport grows into it on every frame of
      // iOS lowering the keyboard, and without it the browser clamps the
      // position (the history slides down) before the next re-measure.
      const sending = Boolean(pending || turn?.motion || turn?.pin);
      const cover = sending ? keyboardCover() : 0;
      // Until the prompt's row exists, the history stays where the reader left
      // it: neither the composer shrinking as Send clears it nor the keyboard
      // going down may let its end ride down. (At the very top nothing can be
      // clamped, so nothing is held there.)
      const held =
        pending?.place > 0.5
          ? pending.place + scroller.clientHeight + cover - (bottom + bottomPadding)
          : 0;
      const hold = held > 0.5 ? Math.ceil(held) : 0;
      let space = hold;
      let layout = null;
      if (turn) {
        // The spacer exists to hold the prompt at the top, so it is sized for the
        // viewport it was held in. Once the reader has taken over (a scroll, a
        // tap), a taller viewport (full-screen reading, the keyboard going away)
        // must not grow it into a blank band under the newest message (iPhone
        // recording 2026-10-31); a reply that shrinks (a disclosure folding)
        // still does, so nothing on screen moves.
        if (turn.pin || turn.motion) turn.heldHeight = scroller.clientHeight;
        layout = getPromptTurnLayout(
          Math.min(scroller.clientHeight, turn.heldHeight ?? scroller.clientHeight),
          anchorTop,
          bottom,
          bottomPadding,
        );
        space = Math.max(hold, layout.space + cover);
      }
      if (previousSpace !== space) scroller.style.setProperty(SPACE_PROPERTY, `${space}px`);
      if (!turn && space) scroller.dataset.promptTurn = 'active';
      // Undo a clamp that landed before this re-measure, before it paints.
      if (pending && scroller.scrollTop < pending.place - 0.5)
        scroller.scrollTo({ top: pending.place, behavior: 'auto' });
      if (!turn) return;
      const pin =
        turn.pin && (turn.height !== scroller.clientHeight || scroller.scrollTop < layout.top - 1);
      // Content above the prompt changed size mid-motion: shift the path with
      // it, so the prompt keeps moving smoothly instead of jumping.
      if (turn.motion?.phase === 'moving' && turn.goal !== null)
        turn.motion.from += layout.top - turn.goal;
      turn.goal = layout.top;
      turn.height = scroller.clientHeight;
      scroller.dataset.promptTurn = 'active';
      if (turn.motion) {
        if (reducedMotion()) {
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
      // Two frames for the new row's own layout (fonts, Markdown) to settle.
      motion.readyFrames++;
      if (motion.readyFrames < 2) {
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
      // Call before the composer is cleared: where the reader is now is held.
      pending = { owner: getOwner(), eventId: null, place: scroller.scrollTop };
      // Reserve now, before iOS starts lowering the keyboard.
      update();
      return pending;
    },
    get navigating() {
      return Boolean(pending || turn?.motion);
    },
    /** A just-sent prompt is still being placed, or held, at the top (not yet released by the reader). */
    get holding() {
      return Boolean(pending || turn?.motion || (turn?.pin && owned()));
    },
    isCurrent: current,
    acknowledge(ticket, eventId) {
      if (!current(ticket)) return;
      if (!Number.isSafeInteger(eventId) || eventId <= 0) {
        pending = null;
        if (turn) update();
        else clear();
        return;
      }
      ticket.eventId = eventId;
      update();
    },
    cancel(ticket) {
      if (pending === ticket) pending = null;
      if (!pending && !turn) clear();
      else if (turn) schedule();
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
