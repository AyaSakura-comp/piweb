import { describe, expect, it, vi } from 'vitest';
import { bindAndroidBack, isAndroid } from '../public/android-back.js';

/** A window with a real-enough history stack: push, back, forward, popstate. */
function fakeWindow(initialState: unknown = null, { activated = false } = {}) {
  const win = new EventTarget() as EventTarget & {
    history: { state: unknown; pushState: (s: unknown, t: string, u?: string) => void };
    location: { href: string };
    back: () => void;
    forward: () => void;
    entries: unknown[];
    navigator: { userActivation: { hasBeenActive: boolean } };
  };
  const entries: unknown[] = [initialState];
  let index = 0;
  const pop = () => {
    const event = new Event('popstate') as Event & { state: unknown };
    event.state = entries[index];
    win.dispatchEvent(event);
  };
  win.entries = entries;
  win.navigator = { userActivation: { hasBeenActive: activated } };
  win.location = { href: 'https://piweb.test/' };
  win.history = {
    get state() {
      return entries[index];
    },
    pushState(state) {
      entries.splice(index + 1);
      entries.push(structuredClone(state));
      index++;
    },
  };
  win.back = () => {
    if (index === 0) throw new Error('left the page');
    index--;
    pop();
  };
  win.forward = () => {
    index++;
    pop();
  };
  return win;
}

const tap = (win: ReturnType<typeof fakeWindow>) => {
  win.navigator.userActivation.hasBeenActive = true;
  win.dispatchEvent(new Event('pointerup'));
};

describe('Android back stays in the app', () => {
  it('detects Android from client hints, else the user agent', () => {
    expect(isAndroid({ userAgentData: { platform: 'Android' } })).toBe(true);
    expect(isAndroid({ userAgentData: { platform: 'macOS' } })).toBe(false);
    expect(
      isAndroid({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile' }),
    ).toBe(true);
    expect(
      isAndroid({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15' }),
    ).toBe(false);
  });

  it('adds its entry only from a user activation, then turns one Back into one step', () => {
    const win = fakeWindow();
    const onBack = vi.fn();
    const back = bindAndroidBack({ win: win as unknown as Window, shouldArm: () => true, onBack });
    expect(back.armed).toBe(false);
    expect(win.entries).toHaveLength(1);

    tap(win);
    tap(win);
    expect(win.entries).toHaveLength(2);
    win.back();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('after the first tap, Back after Back keeps stepping inside (open, close, open)', () => {
    const win = fakeWindow();
    const onBack = vi.fn();
    const back = bindAndroidBack({ win: win as unknown as Window, shouldArm: () => true, onBack });
    tap(win);
    win.back();
    win.back();
    win.back();
    expect(onBack).toHaveBeenCalledTimes(3);
    expect(back.armed).toBe(true);
    expect(win.entries).toHaveLength(2);
  });

  it('without any activation it never re-arms, so Back still leaves', () => {
    // Reloaded onto its old entry, no tap since: that Back is consumed, the
    // next one leaves, because a guard pushed now would not hold in Chrome.
    const win = fakeWindow();
    win.history.pushState({ piwebBack: true }, '');
    const onBack = vi.fn();
    bindAndroidBack({ win: win as unknown as Window, shouldArm: () => true, onBack });
    win.back();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(() => win.back()).toThrow('left the page');
  });

  it('re-arms on the next tap, so Back works again and again', () => {
    const win = fakeWindow();
    const onBack = vi.fn();
    bindAndroidBack({ win: win as unknown as Window, shouldArm: () => true, onBack });
    for (let i = 0; i < 3; i++) {
      tap(win);
      win.back();
    }
    expect(onBack).toHaveBeenCalledTimes(3);
    expect(win.entries).toHaveLength(2);
  });

  it('keeps the page state it found and the address', () => {
    const win = fakeWindow({ keep: 1 });
    bindAndroidBack({ win: win as unknown as Window, shouldArm: () => true, onBack: () => {} });
    tap(win);
    expect(win.history.state).toEqual({ keep: 1, piwebBack: true });
  });

  it('stays out while it should not arm (login, wide layout)', () => {
    const win = fakeWindow();
    let allowed = false;
    bindAndroidBack({ win: win as unknown as Window, shouldArm: () => allowed, onBack: () => {} });
    tap(win);
    expect(win.entries).toHaveLength(1);
    allowed = true;
    tap(win);
    expect(win.entries).toHaveLength(2);
  });

  it('forward onto its entry holds the next Back again', () => {
    const win = fakeWindow();
    const onBack = vi.fn();
    const back = bindAndroidBack({ win: win as unknown as Window, shouldArm: () => true, onBack });
    back.arm();
    win.back(); // no activation yet, so it is not put back
    expect(back.armed).toBe(false);
    win.forward();
    expect(back.armed).toBe(true);
    expect(win.entries).toHaveLength(2);
    win.back();
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('after a reload on its entry it does not stack a second one', () => {
    const win = fakeWindow({ piwebBack: true });
    const back = bindAndroidBack({ win: win as unknown as Window, shouldArm: () => true, onBack: () => {} });
    expect(back.armed).toBe(true);
    tap(win);
    expect(win.entries).toHaveLength(1);
  });
});
