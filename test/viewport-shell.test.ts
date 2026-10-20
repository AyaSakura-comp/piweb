import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindViewportShell } from '../public/viewport-shell.js';

function setup() {
  vi.useFakeTimers();
  const properties = new Map<string, string>();
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
    activeElement: { tagName: 'TEXTAREA' },
    documentElement: { style: {
      setProperty: vi.fn((key: string, value: string) => properties.set(key, value)),
    } },
  });
  const onChange = vi.fn();
  const dispose = bindViewportShell(win, doc, onChange);
  return { win, doc, viewport, properties, dispose, onChange };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('shared visual viewport shell sizing', () => {
  it('uses the visible height rather than an independent CSS/layout viewport', () => {
    const { properties } = setup();
    expect(properties.get('--app-viewport-height')).toBe('844px');
  });

  it('restores full height on keyboard dismissal even while the textarea retains focus', () => {
    const { viewport, properties } = setup();
    viewport.height = 480;
    viewport.dispatchEvent(new Event('resize'));
    expect(properties.get('--app-viewport-height')).toBe('480px');
    viewport.height = 844;
    viewport.dispatchEvent(new Event('resize'));
    expect(properties.get('--app-viewport-height')).toBe('844px');
  });

  it('remeasures after delayed WebKit orientation layout without needing another rotation', () => {
    const { win, viewport, properties } = setup();
    viewport.height = 390;
    win.dispatchEvent(new Event('orientationchange'));
    expect(properties.get('--app-viewport-height')).toBe('390px');
    vi.advanceTimersByTime(50);
    viewport.height = 844; // WebKit settles after its last resize/orientation event.
    vi.advanceTimersByTime(750);
    expect(properties.get('--app-viewport-height')).toBe('844px');
  });

  it('resynchronizes after bfcache/page restoration and visibility changes', () => {
    const { win, doc, viewport, properties } = setup();
    viewport.height = 810;
    win.dispatchEvent(new Event('pageshow'));
    expect(properties.get('--app-viewport-height')).toBe('810px');
    viewport.height = 844;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(properties.get('--app-viewport-height')).toBe('844px');
  });

  it('does not collapse the layout during pinch zoom and ignores invalid measurements', () => {
    const { viewport, properties } = setup();
    viewport.scale = 2;
    viewport.height = 422;
    viewport.dispatchEvent(new Event('resize'));
    expect(properties.get('--app-viewport-height')).toBe('844px');
    viewport.scale = 1;
    viewport.height = 0;
    viewport.dispatchEvent(new Event('resize'));
    expect(properties.get('--app-viewport-height')).toBe('844px');
  });

  it('uses innerHeight when VisualViewport is unavailable', () => {
    const { win, doc, properties, dispose } = setup();
    dispose();
    win.visualViewport = null as any;
    const cleanup = bindViewportShell(win, doc);
    expect(properties.get('--app-viewport-height')).toBe('932px');
    cleanup();
  });

  it('does not rewrite unchanged heights and cleans up listeners and deferred samples', () => {
    const { win, doc, viewport, dispose, properties } = setup();
    win.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);
    expect(doc.documentElement.style.setProperty).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event('orientationchange'));
    dispose();
    viewport.height = 700;
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1000);
    expect(properties.get('--app-viewport-height')).toBe('844px');
  });
});
