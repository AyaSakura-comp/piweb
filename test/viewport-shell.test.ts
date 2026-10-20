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
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    documentElement: {
      clientHeight: 844,
      style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      classList: { add: vi.fn(), remove: vi.fn() },
    },
  });
  const onChange = vi.fn();
  const dispose = bindViewportShell(win, doc, onChange);
  return { win, doc, viewport, dispose, onChange };
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

  it('releases the pin and any leftover page pan when the keyboard closes', () => {
    const { win, viewport, doc } = setup();
    const root = doc.documentElement;
    viewport.height = 480;
    viewport.offsetTop = 364;
    viewport.dispatchEvent(new Event('resize'));
    win.scrollY = 59;
    viewport.height = 844;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('resize'));
    expect(root.classList.remove).toHaveBeenCalledWith('keyboard-shell');
    expect(root.style.removeProperty).toHaveBeenCalledWith('--keyboard-shell-top');
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
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
