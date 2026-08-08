import { describe, expect, it, vi } from 'vitest';
import { bindLongPress, setDrawerCollapsed } from '../public/session-ui.js';

type Listener = (event: FakeEvent) => void;

class FakeEvent {
  button = 0;
  isPrimary = true;
  pointerId = 1;
  clientX = 10;
  clientY = 20;
  defaultPrevented = false;
  propagationStopped = false;

  constructor(values: Partial<FakeEvent> = {}) {
    Object.assign(this, values);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeTarget {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, values: Partial<FakeEvent> = {}): FakeEvent {
    const event = new FakeEvent(values);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

class FakeClassList {
  values = new Set<string>();

  toggle(name: string, force: boolean): void {
    if (force) this.values.add(name);
    else this.values.delete(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class FakeElement {
  classList = new FakeClassList();
  attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

describe('bindLongPress', () => {
  it('fires only after the hold duration and suppresses the resulting click', () => {
    vi.useFakeTimers();
    const target = new FakeTarget();
    const onLongPress = vi.fn();
    bindLongPress(target, onLongPress, { delay: 500 });

    target.dispatch('pointerdown');
    vi.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledOnce();

    const click = target.dispatch('click');
    expect(click.defaultPrevented).toBe(true);
    expect(click.propagationStopped).toBe(true);

    vi.useRealTimers();
  });

  it('cancels when the pointer is released or moves far enough to be a scroll', () => {
    vi.useFakeTimers();
    const target = new FakeTarget();
    const onLongPress = vi.fn();
    bindLongPress(target, onLongPress, { delay: 500, moveTolerance: 8 });

    target.dispatch('pointerdown');
    target.dispatch('pointerup');
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();

    target.dispatch('pointerdown', { pointerId: 2 });
    target.dispatch('pointermove', { pointerId: 2, clientX: 25, clientY: 20 });
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('setDrawerCollapsed', () => {
  it('collapses the desktop drawer and exposes an accurately labelled restore button', () => {
    const app = new FakeElement();
    const menuButton = new FakeElement();

    setDrawerCollapsed(app, menuButton, true);
    expect(app.classList.contains('drawer-collapsed')).toBe(true);
    expect(menuButton.attributes.get('aria-expanded')).toBe('false');
    expect(menuButton.attributes.get('aria-label')).toBe('Show sessions');

    setDrawerCollapsed(app, menuButton, false);
    expect(app.classList.contains('drawer-collapsed')).toBe(false);
    expect(menuButton.attributes.get('aria-expanded')).toBe('true');
    expect(menuButton.attributes.get('aria-label')).toBe('Open sessions');
  });
});
