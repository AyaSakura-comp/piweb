// Settings motion: on a phone Settings is a pushed page. It enters from the
// right, leaves to the right, and follows a rightward finger drag back to the
// chat — the same contract as Subagents and BTW (DESIGN.md "Settings motion").
// From 700px up it is a centred card that fades and lifts in and out instead.

const ENTER_MS = 220;
const EXIT_MS = 140;
const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
const CARD_HIDDEN = 'translateY(10px) scale(0.985)';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createSettingsMotion({ dialog, onClosed = () => {} }) {
  const isCard = () => matchMedia('(min-width: 700px)').matches;
  let animation = null;
  let backdropAnimation = null;
  let gesture = null;
  let epoch = 0;

  // The dimming behind the page fades with it. Animating ::backdrop is not
  // supported everywhere; there it simply appears and disappears.
  function animateBackdrop(from, to, duration, easing) {
    backdropAnimation?.cancel();
    try {
      backdropAnimation = dialog.animate([{ opacity: from }, { opacity: to }], {
        duration,
        easing,
        fill: 'forwards',
        pseudoElement: '::backdrop',
      });
    } catch {
      backdropAnimation = null;
    }
  }

  function currentX() {
    const transform = getComputedStyle(dialog).transform;
    return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m41 : 0;
  }

  function stop() {
    epoch += 1;
    animation?.cancel();
    backdropAnimation?.cancel();
    animation = null;
    backdropAnimation = null;
    gesture = null;
    dialog.style.transform = '';
    dialog.style.removeProperty('--settings-reveal');
    dialog.inert = false;
    delete dialog.dataset.motion;
  }

  function open({ animate = true } = {}) {
    // Reopening while the page is still leaving picks it up where it is.
    const from = dialog.open && dialog.dataset.motion === 'closing' ? currentX() : null;
    stop();
    if (!dialog.open) dialog.showModal();
    if (!animate || reduced() || from === 0) return Promise.resolve();
    if (isCard()) {
      animation = dialog.animate(
        [
          { opacity: 0, transform: CARD_HIDDEN },
          { opacity: 1, transform: 'none' },
        ],
        { duration: ENTER_MS, easing: EASE_OUT },
      );
    } else {
      const width = dialog.getBoundingClientRect().width || innerWidth;
      const start = from ?? width;
      animation = dialog.animate(
        [{ transform: `translateX(${start}px)` }, { transform: 'translateX(0)' }],
        { duration: Math.round((ENTER_MS * start) / width), easing: EASE_OUT },
      );
    }
    dialog.dataset.motion = 'opening';
    animateBackdrop(0, 1, ENTER_MS, 'ease-out');
    const mine = epoch;
    // Resolves once the page has fully covered what was under it (or the
    // entrance was interrupted), so callers can tidy up out of sight.
    return animation.finished.then(
      () => {
        if (mine === epoch) stop();
      },
      () => {},
    );
  }

  function finishClose() {
    stop();
    if (dialog.open) dialog.close();
    onClosed();
  }

  // User-initiated exits animate; programmatic ones (logout, navigation
  // from a sub-page) pass animate: false and close at once.
  function close({ animate = true } = {}) {
    if (!dialog.open || dialog.dataset.motion === 'closing') return;
    if (!animate || reduced()) {
      finishClose();
      return;
    }
    const card = isCard();
    const from = card ? 0 : currentX();
    stop();
    dialog.dataset.motion = 'closing';
    dialog.inert = true;
    animation = card
      ? dialog.animate(
          [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: CARD_HIDDEN },
          ],
          { duration: EXIT_MS, easing: 'ease-in', fill: 'forwards' },
        )
      : dialog.animate(
          [{ transform: `translateX(${from}px)` }, { transform: 'translateX(100%)' }],
          { duration: EXIT_MS, easing: 'ease-in', fill: 'forwards' },
        );
    animateBackdrop(1, 0, EXIT_MS, 'ease-in');
    const mine = epoch;
    animation.finished.then(
      () => mine === epoch && finishClose(),
      () => {},
    );
  }

  // ── finger-following right drag (phone page only) ──────────────────────

  function settle(start, commit) {
    const target = commit ? start.width : 0;
    const remaining = Math.abs(target - start.distance);
    const duration = reduced()
      ? 0
      : Math.max(120, Math.min(280, remaining / Math.max(0.6, Math.abs(start.velocity))));
    if (!duration) {
      if (commit) finishClose();
      else stop();
      return;
    }
    epoch += 1;
    const mine = epoch;
    dialog.dataset.motion = commit ? 'closing' : 'settling';
    dialog.inert = true;
    animation = dialog.animate(
      [{ transform: `translateX(${start.distance}px)` }, { transform: `translateX(${target}px)` }],
      { duration, easing: EASE_OUT, fill: 'forwards' },
    );
    animateBackdrop(1 - start.distance / start.width, commit ? 0 : 1, duration, EASE_OUT);
    animation.finished.then(
      () => {
        if (mine !== epoch) return;
        if (commit) finishClose();
        else stop();
      },
      () => {},
    );
  }

  function cancelGesture() {
    const start = gesture;
    gesture = null;
    if (start?.dragging) settle(start, false);
  }

  dialog.addEventListener(
    'touchstart',
    (event) => {
      gesture = null;
      if (isCard() || dialog.dataset.motion) return;
      if (event.touches.length !== 1 || window.getSelection()?.type === 'Range') return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Rows are buttons and make up most of the page, so they stay part of
      // the drag surface; text entry, links and pickers keep their gestures.
      if (
        target.closest(
          'a,input,textarea,select,summary,[contenteditable],.subscription-device-code',
        )
      )
        return;
      for (let node = target; node && node !== dialog; node = node.parentElement) {
        if (
          node.scrollWidth > node.clientWidth + 1 &&
          /auto|scroll/.test(getComputedStyle(node).overflowX)
        )
          return;
      }
      const touch = event.touches[0];
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        id: touch.identifier,
        width: dialog.getBoundingClientRect().width || innerWidth,
        dragging: false,
        distance: 0,
        velocity: 0,
        lastX: touch.clientX,
        lastTime: performance.now(),
      };
    },
    { passive: true },
  );

  dialog.addEventListener(
    'touchmove',
    (event) => {
      if (!gesture) return;
      if (event.touches.length !== 1) {
        cancelGesture();
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.dragging) {
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) {
          gesture = null;
          return;
        }
        // Claim clear rightward intent before iOS latches native scrolling.
        if (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5 && event.cancelable) event.preventDefault();
        if (dx <= 12 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
        gesture.dragging = true;
        dialog.dataset.motion = 'dragging';
      }
      if (event.cancelable) event.preventDefault();
      const now = performance.now();
      const elapsed = now - gesture.lastTime;
      if (elapsed > 0)
        gesture.velocity =
          0.5 * gesture.velocity +
          0.5 * Math.max(-3, Math.min(3, (touch.clientX - gesture.lastX) / elapsed));
      gesture.lastX = touch.clientX;
      gesture.lastTime = now;
      gesture.distance = Math.max(0, Math.min(gesture.width, dx));
      dialog.style.transform = `translateX(${gesture.distance}px)`;
      dialog.style.setProperty('--settings-reveal', (gesture.distance / gesture.width).toFixed(3));
    },
    { passive: false },
  );

  dialog.addEventListener('touchcancel', cancelGesture);
  dialog.addEventListener(
    'touchend',
    (event) => {
      const start = gesture;
      gesture = null;
      if (!start?.dragging) return;
      const touch = [...event.changedTouches].find((t) => t.identifier === start.id);
      if (event.touches.length || !touch) {
        settle(start, false);
        return;
      }
      // 28% of the width, or a ≥60px flick at ≥0.5px/ms whose 180ms
      // projection reaches 28%. Velocity expires after 100ms without movement.
      const velocity = performance.now() - start.lastTime > 100 ? 0 : start.velocity;
      const projected = start.distance + Math.max(0, velocity) * 180;
      const commit =
        start.distance >= start.width * 0.28 ||
        (start.distance >= 60 && velocity >= 0.5 && projected >= start.width * 0.28);
      settle(start, commit && velocity >= -0.2);
    },
    { passive: true },
  );

  // Escape and a click on the dimmed area beside the desktop card leave the
  // same way as the close button.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      close();
  });

  return { open, close, isOpen: () => dialog.open && dialog.dataset.motion !== 'closing' };
}
