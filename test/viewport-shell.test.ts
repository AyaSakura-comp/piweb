import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindViewportShell } from '../public/viewport-shell.js';

function setup() {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const win = Object.assign(new EventTarget(), {
    innerHeight: 844,
    scrollY: 0,
    scrollTo: vi.fn(),
    visualViewport: viewport,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setTimeout, clearTimeout,
  });
  // The composer has focus unless a test says otherwise: no focus, no keyboard.
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    activeElement: { tagName: 'TEXTAREA', readOnly: false, disabled: false } as any,
    documentElement: {
      clientHeight: 844,
      style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      classList: { add: vi.fn(), remove: vi.fn() },
    },
  });
  // Calls in order, to tell what the shell did before and after an eased move.
  const log: string[] = [];
  doc.documentElement.style.setProperty.mockImplementation((k: string, v: string) => log.push(`${k}=${v}`));
  doc.documentElement.classList.add.mockImplementation((...c: string[]) => log.push(`+${c.join(' +')}`));
  doc.documentElement.classList.remove.mockImplementation((...c: string[]) => log.push(`-${c.join(' -')}`));
  const onChange = vi.fn();
  const dispose = bindViewportShell(win, doc, onChange);
  return { win, doc, viewport, dispose, onChange, log };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('viewport shell', () => {
  it('pins the shell to the panned visual viewport while the keyboard is up', () => {
    const { viewport, doc } = setup();
    const root = doc.documentElement;
    viewport.height = 480;
    viewport.offsetTop = 364;
    viewport.dispatchEvent(new Event('resize'));
    expect(root.classList.add).toHaveBeenCalledWith('keyboard-shell');
    expect(root.style.setProperty).toHaveBeenCalledWith('--keyboard-shell-top', '364px');
    expect(root.style.setProperty).toHaveBeenCalledWith('--keyboard-shell-height', '480px');
    // iOS keeps panning after the resize; the shell follows the pan, not just the height.
    viewport.offsetTop = 300;
    viewport.dispatchEvent(new Event('scroll'));
    expect(root.style.setProperty).toHaveBeenLastCalledWith('--keyboard-shell-height', '480px');
    expect(root.style.setProperty).toHaveBeenCalledWith('--keyboard-shell-top', '300px');
    const writes = root.style.setProperty.mock.calls.length;
    vi.advanceTimersByTime(1000); // settling samples of an unchanged viewport write nothing
    expect(root.style.setProperty).toHaveBeenCalledTimes(writes);
  });

  it('eases a keyboard that iOS reports all at once along its pan', () => {
    const { viewport, log, onChange } = setup();
    // Opening: iOS reports the final viewport at once and animates its pan
    // after. The shell starts from its resting place and eases to the pin.
    viewport.height = 480;
    viewport.offsetTop = 364;
    viewport.dispatchEvent(new Event('resize'));
    expect(log).toEqual([
      '--keyboard-shell-top=0px', '--keyboard-shell-height=844px', '+keyboard-shell',
      '--keyboard-shell-ease=190ms cubic-bezier(0.3, 0.2, 0.6, 0.95)', '+keyboard-shell-easing',
      '--keyboard-shell-top=364px', '--keyboard-shell-height=480px', '+keyboard-shell',
    ]);
    // The composer re-anchors on every frame of the move, then easing ends.
    onChange.mockClear();
    vi.advanceTimersByTime(260);
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(12);
    expect(log.at(-1)).toBe('-keyboard-shell-easing');
    // A small follow-up move is a pan, followed as is.
    log.length = 0;
    viewport.offsetTop = 300;
    viewport.dispatchEvent(new Event('scroll'));
    expect(log).toEqual(['--keyboard-shell-top=300px', '--keyboard-shell-height=480px', '+keyboard-shell']);
  });

  it('snaps instead of easing for reduced motion', () => {
    const { win, viewport, log } = setup();
    (win as any).matchMedia = () => ({ matches: true });
    viewport.height = 480;
    viewport.offsetTop = 364;
    viewport.dispatchEvent(new Event('resize'));
    expect(log).toEqual(['--keyboard-shell-top=364px', '--keyboard-shell-height=480px', '+keyboard-shell']);
  });

  it('releases the pin and any leftover page pan when the keyboard closes', () => {
    const { win, viewport, doc, log } = setup();
    const root = doc.documentElement;
    viewport.height = 480;
    viewport.offsetTop = 364;
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(300);
    win.scrollY = 59;
    viewport.height = 844;
    viewport.offsetTop = 0;
    log.length = 0;
    viewport.dispatchEvent(new Event('resize'));
    // All at once: ease back to the resting place, then let go.
    expect(log).toContain('+keyboard-shell-leaving');
    expect(log).toContain('--keyboard-shell-top=0px');
    expect(root.classList.remove).not.toHaveBeenCalledWith('keyboard-shell', 'keyboard-shell-leaving');
    vi.advanceTimersByTime(320);
    expect(root.classList.remove).toHaveBeenCalledWith('keyboard-shell', 'keyboard-shell-leaving');
    expect(root.style.removeProperty).toHaveBeenCalledWith('--keyboard-shell-top');
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('follows the keyboard down after a tap on Send blurs the box', () => {
    const { viewport, doc, log } = setup();
    const root = doc.documentElement;
    viewport.height = 480;
    viewport.offsetTop = 364;
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(300);
    log.length = 0;
    // The tap blurs the box before iOS lowers the keyboard: the shell (and
    // Send under the finger) stays where it is.
    doc.activeElement = { tagName: 'BODY' };
    doc.dispatchEvent(new Event('focusout'));
    expect(log).toEqual([]);
    // iOS then reports the viewport frame by frame; the shell follows it.
    for (const [height, offsetTop] of [[560, 284], [700, 144], [800, 44]]) {
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.dispatchEvent(new Event('resize'));
      expect(log.slice(-3)).toEqual([`--keyboard-shell-top=${offsetTop}px`, `--keyboard-shell-height=${height}px`, '+keyboard-shell']);
    }
    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('resize'));
    expect(root.classList.remove).toHaveBeenLastCalledWith('keyboard-shell', 'keyboard-shell-leaving');
    expect(log.join()).not.toContain('easing');
  });

  it('releases the pin when typing focus goes, even if iOS 26 leaves the viewport short', () => {
    const { viewport, doc } = setup();
    const root = doc.documentElement;
    viewport.height = 480;
    viewport.offsetTop = 364;
    viewport.dispatchEvent(new Event('resize'));
    expect(root.classList.add).toHaveBeenCalledWith('keyboard-shell');
    // Keyboard dismissed: focus leaves the textarea, the viewport stays 480 (WebKit 301857).
    doc.activeElement = { tagName: 'BODY' };
    doc.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(1100); // the follow window, then easing back
    expect(root.classList.remove).toHaveBeenCalledWith('keyboard-shell', 'keyboard-shell-leaving');
    expect(root.style.removeProperty).toHaveBeenCalledWith('--keyboard-shell-height');
    // A later viewport event with the stale height does not pin it again.
    root.classList.add.mockClear();
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1000);
    expect(root.classList.add).not.toHaveBeenCalled();
    // Focus back in a text field with the keyboard up: pinned again.
    doc.activeElement = { tagName: 'INPUT', type: 'search' };
    doc.dispatchEvent(new Event('focusin'));
    expect(root.classList.add).toHaveBeenCalledWith('keyboard-shell');
  });

  it('a button or checkbox with focus is not a keyboard', () => {
    const { viewport, doc } = setup();
    for (const el of [{ tagName: 'BUTTON' }, { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'TEXTAREA', readOnly: true }]) {
      doc.activeElement = el;
      viewport.height = 480;
      viewport.dispatchEvent(new Event('resize'));
    }
    vi.advanceTimersByTime(1000);
    expect(doc.documentElement.classList.add).not.toHaveBeenCalled();
  });

  it('ignores browser-toolbar size changes and pinch zoom', () => {
    const { viewport, doc } = setup();
    viewport.height = 760; // Safari toolbar, not a keyboard
    viewport.dispatchEvent(new Event('resize'));
    viewport.height = 400;
    viewport.scale = 2; // pinch zoom
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);
    expect(doc.documentElement.classList.add).not.toHaveBeenCalled();
    expect(doc.documentElement.style.setProperty).not.toHaveBeenCalled();
  });

  it('notifies immediately and again over the WebKit settling window', () => {
    const { win, onChange } = setup();
    win.dispatchEvent(new Event('orientationchange'));
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(5); // now, rAF, 120, 350, 700ms
  });

  it('restarts the settling window on a newer event instead of stacking samples', () => {
    const { viewport, onChange } = setup();
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(100);
    viewport.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(2 + 5); // first burst cut after now+rAF
  });

  it('resynchronizes on page restoration and visibility, but not while hidden', () => {
    const { win, doc, onChange } = setup();
    win.dispatchEvent(new Event('pageshow'));
    expect(onChange).toHaveBeenCalledTimes(1);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('works without VisualViewport and cleans up listeners and deferred samples', () => {
    const { win, doc, dispose } = setup();
    dispose();
    win.visualViewport = null as any;
    const onChange = vi.fn();
    const cleanup = bindViewportShell(win, doc, onChange);
    win.dispatchEvent(new Event('resize'));
    cleanup();
    vi.advanceTimersByTime(1000);
    win.dispatchEvent(new Event('resize'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
