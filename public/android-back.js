/**
 * Android's back gesture, kept inside the app.
 *
 * With gesture navigation, Android owns a swipe in from either screen edge as
 * Back, so the left-edge swipe that pulls out the session drawer usually never
 * reaches the page; the phone left piweb instead. A page cannot turn that system
 * gesture off, but it can decide what Back means: one history entry is kept on
 * top of the current one, and Back popping it becomes an in-app step (close
 * what is open, else show the sessions) instead of leaving.
 *
 * The entry is added only once the page has had a user activation. Chrome
 * skips entries a page pushed before any, when the user goes back, so a guard
 * pushed at load would not hold. Its intervention looks at sticky activation
 * (navigator.userActivation.hasBeenActive), so after the first tap the guard
 * is put back straight after each consumed Back: open sessions, Back closes
 * them, Back opens them again. Leaving is the Home gesture, as in an app.
 */

const MARK = 'piwebBack';

export function isAndroid(nav = globalThis.navigator) {
  const platform = nav?.userAgentData?.platform;
  if (platform) return platform === 'Android';
  return /\bAndroid\b/i.test(nav?.userAgent ?? '');
}

/**
 * @param {object} options
 * @param {Window} [options.win]
 * @param {() => boolean} options.shouldArm  whether Back should stay in the app now
 * @param {() => void} options.onBack        the in-app step for one Back
 */
export function bindAndroidBack({ win = window, shouldArm, onBack }) {
  // A reload restores the history stack, guard entry included.
  let armed = win.history.state?.[MARK] === true;

  function arm() {
    if (armed || !shouldArm()) return;
    const current = win.history.state;
    const next = current && typeof current === 'object' ? { ...current, [MARK]: true } : { [MARK]: true };
    win.history.pushState(next, '', win.location.href);
    armed = true;
  }

  // Events that carry a user activation in Chrome (pointerup for touch and pen,
  // touchend, keydown, click), seen before any handler can stop them.
  for (const type of ['pointerup', 'touchend', 'keydown', 'click']) {
    win.addEventListener(type, arm, { capture: true, passive: true });
  }

  win.addEventListener('popstate', (event) => {
    // Forward onto the guard again: it holds the next Back.
    if (event.state?.[MARK] === true) {
      armed = true;
      return;
    }
    if (!armed) return;
    armed = false;
    onBack();
    if (win.navigator?.userActivation?.hasBeenActive === true) arm();
  });

  return {
    arm,
    get armed() {
      return armed;
    },
  };
}
