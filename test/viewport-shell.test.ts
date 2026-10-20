import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindViewportShell } from '../public/viewport-shell.js';

function setup() {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), { height: 844, scale: 1 });
  const win = Object.assign(new EventTarget(), {
    innerHeight: 932,
    visualViewport: viewport,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 16),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setTimeout, clearTimeout,
  });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    documentElement: { style: { setProperty: vi.fn() } },
  });
  const onChange = vi.fn();
  const dispose = bindViewportShell(win, doc, onChange);
  return { win, doc, viewport, dispose, onChange };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('viewport change notifications', () => {
  it('never writes a shell height: iOS pans the visual viewport over the 100dvh shell', () => {
    const { viewport, doc } = setup();
    viewport.height = 480;
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);
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
