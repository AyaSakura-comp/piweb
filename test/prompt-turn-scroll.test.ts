import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPromptTurnScroll, getPromptTurnLayout } from '../public/prompt-turn-scroll.js';

const geometry = (height = 400, top = 1000, bottom = 1060) =>
  getPromptTurnLayout(height, top, bottom, 12, 4);

afterEach(() => vi.unstubAllGlobals());

describe('prompt turn viewport geometry', () => {
  it('reserves the empty remainder and aligns the new prompt below top padding', () => {
    expect(geometry()).toEqual({ top: 988, space: 324 });
  });
  it('spends reservation as the answer grows without moving the prompt', () => {
    expect(geometry(400, 1000, 1260)).toEqual({ top: 988, space: 124 });
    expect(geometry(400, 1000, 1500)).toEqual({ top: 988, space: 0 });
  });
  it('uses actual short viewport dimensions rather than a screen-height constant', () => {
    expect(geometry(200)).toEqual({ top: 988, space: 124 });
    expect(geometry(0).space).toBe(0);
    expect(geometry(400, 5, 65).top).toBe(0);
  });
});

function fixture({ animate = false } = {}) {
  let owner = 'source:1';
  let time = 0;
  let reduced = !animate;
  let serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const viewport = { height: 400, offsetTop: 0, width: 390 };
  vi.stubGlobal('performance', { now: () => time });
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 400);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  function advance(ms: number) {
    const end = time + ms;
    while (time < end) {
      time = Math.min(end, time + 16);
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(time));
    }
  }
  const properties = new Map<string, string>();
  const rows: any[] = [];
  const scroller: any = {
    children: rows,
    dataset: {},
    clientHeight: 400,
    scrollTop: 600,
    style: {
      getPropertyValue: (key: string) => properties.get(key) || '',
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    },
    getBoundingClientRect: () => ({ top: 60 }),
    contains: (row: any) => rows.includes(row) && row.isConnected,
    scrollTo: vi.fn(({ top }: { top: number }) => {
      scroller.scrollTop = top;
    }),
  };
  vi.stubGlobal('getComputedStyle', () => ({
    paddingTop: '12px',
    paddingBottom: `${4 + space()}px`,
  }));
  vi.stubGlobal('MutationObserver', undefined);
  vi.stubGlobal('ResizeObserver', undefined);
  function space() {
    return Number.parseFloat(properties.get('--prompt-turn-space') || '0');
  }
  function add(id: number, top = 1000, height = 60, user = true) {
    const row: any = {
      dataset: { eventId: String(id) },
      isConnected: true,
      height,
      top,
      classList: { contains: (name: string) => user && name === 'msg-user', remove: vi.fn() },
      getBoundingClientRect: () => ({
        top: 60 + row.top - scroller.scrollTop,
        bottom: 60 + row.top + row.height - scroller.scrollTop,
      }),
    };
    rows.push(row);
    return row;
  }
  const controller = createPromptTurnScroll({ scroller, getOwner: () => owner });
  return {
    controller,
    scroller,
    add,
    space,
    advance,
    viewport,
    setReduced: (value: boolean) => {
      reduced = value;
    },
    frameCount: () => frames.size,
    setOwner: (value: string) => {
      owner = value;
    },
  };
}

describe('prompt turn ownership and lifecycle', () => {
  it('does not move while typing/requesting; only the acknowledged saved user ID anchors', () => {
    const f = fixture();
    f.add(11);
    const ticket = f.controller.begin();
    f.controller.update();
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    f.controller.acknowledge(ticket, 12);
    f.controller.update();
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    f.add(12);
    f.controller.update();
    expect(f.scroller.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 988, behavior: 'auto' });
    expect(f.space()).toBe(324);
  });
  it('also handles the saved SSE row arriving before the acknowledgement', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    const row = f.add(12);
    f.controller.acknowledge(ticket, 12);
    expect(f.scroller.scrollTop).toBe(988);
    expect(row.classList.remove).toHaveBeenCalledWith('pop-in');
  });
  it('reduces blank space on response growth without issuing follow-scrolls', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.scroller.scrollTo.mockClear();
    f.add(13, 1060, 200, false);
    f.controller.update();
    expect(f.space()).toBe(124);
    expect(f.scroller.scrollTop).toBe(988);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('recalculates reservation for keyboard/viewport changes while still anchored', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.scroller.clientHeight = 700;
    f.controller.update();
    expect(f.space()).toBe(624);
    expect(f.scroller.scrollTop).toBe(988);
  });
  it('restores the prompt if a temporary rich-body replacement clamps native scrollTop', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.scroller.scrollTop = 937;
    f.controller.update();
    expect(f.scroller.scrollTop).toBe(988);
  });
  it('restores the reader position synchronously after a disclosure clamps scrollTop', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    const answer = f.add(13, 1060, 200, false);
    f.controller.update();
    f.controller.release();
    f.scroller.scrollTo.mockClear();
    f.controller.preserveLayout(() => {
      answer.height = 20;
      // The native collapse shrinks scrollHeight before ResizeObserver runs.
      f.scroller.scrollTop = 808;
    });
    expect(f.space()).toBe(304);
    expect(f.scroller.scrollTop).toBe(988);
    // Preserving a disclosure must not reclaim a released viewport pin.
    f.scroller.scrollTop = 400;
    f.scroller.clientHeight = 700;
    f.controller.update();
    expect(f.scroller.scrollTop).toBe(400);
  });
  it('does not claim unowned history or move a new selection during disclosure changes', () => {
    const f = fixture();
    const change = vi.fn();
    f.controller.preserveLayout(change);
    expect(change).toHaveBeenCalledTimes(1);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.scroller.scrollTo.mockClear();
    f.controller.preserveLayout(() => {
      f.setOwner('other:2');
      f.scroller.scrollTop = 200;
    });
    expect(f.scroller.scrollTop).toBe(200);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    expect(f.space()).toBe(0);
  });
  it('reader interaction cancels delayed anchoring and prevents later viewport re-pinning', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    f.controller.release();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    const second = f.controller.begin();
    f.controller.acknowledge(second, 12);
    f.controller.release();
    f.scroller.scrollTo.mockClear();
    f.scroller.scrollTop = 400;
    f.scroller.clientHeight = 700;
    f.controller.update();
    expect(f.scroller.scrollTop).toBe(400);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('late success from another selection cannot move the newly selected conversation', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    f.add(12);
    f.setOwner('elsewhere:2');
    f.controller.acknowledge(ticket, 12);
    expect(f.space()).toBe(0);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('a newer submission invalidates older acknowledgements even for identical text', () => {
    const f = fixture();
    const first = f.controller.begin();
    const second = f.controller.begin();
    f.add(12);
    f.add(14, 1100);
    f.controller.acknowledge(first, 12);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    f.controller.acknowledge(second, 14);
    expect(f.scroller.scrollTop).toBe(1088);
  });
  it('failures and malformed acknowledgements do not navigate or clear an existing turn', () => {
    const f = fixture();
    const original = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(original, 12);
    f.scroller.scrollTo.mockClear();
    const failed = f.controller.begin();
    f.controller.cancel(failed);
    f.controller.acknowledge(failed, 13);
    f.controller.update();
    expect(f.space()).toBe(324);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    f.controller.acknowledge(f.controller.begin(), undefined);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('a fresh submission can own a new source after an old turn was active', () => {
    const f = fixture();
    const old = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(old, 12);
    f.setOwner('new:2');
    const fresh = f.controller.begin();
    f.add(14, 1100);
    f.controller.acknowledge(fresh, 14);
    expect(f.scroller.scrollTop).toBe(1088);
  });
  it('navigation/removal clears owned padding and manual jump cleanup is idempotent', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    const row = f.add(12);
    f.controller.acknowledge(ticket, 12);
    row.isConnected = false;
    f.controller.update();
    expect(f.space()).toBe(0);
    expect(f.scroller.dataset.promptTurn).toBeUndefined();
    f.controller.clear();
    f.controller.clear();
    expect(f.space()).toBe(0);
  });
});

describe('smooth prompt turn navigation', () => {
  function sent(options = {}) {
    const f = fixture({ animate: true, ...options });
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    return f;
  }
  it('moves gradually and monotonically to the question instead of snapping at acknowledgement', () => {
    const f = sent();
    expect(f.scroller.scrollTop).toBe(600);
    expect(f.controller.navigating).toBe(true);
    f.advance(180);
    expect(f.scroller.scrollTop).toBeGreaterThan(620);
    expect(f.scroller.scrollTop).toBeLessThan(970);
    f.advance(260);
    expect(f.scroller.scrollTop).toBe(988);
    const positions = f.scroller.scrollTo.mock.calls.map(([call]) => call.top);
    expect(positions.length).toBeGreaterThan(10);
    expect(positions.every((top, i) => top >= (positions[i - 1] ?? 600) && top <= 988)).toBe(true);
    expect(f.controller.navigating).toBe(false);
    expect(f.frameCount()).toBe(0);
  });
  it('waits for a still-open keyboard and for quiet after its final height and offset reports', () => {
    const f = fixture({ animate: true });
    f.viewport.height = 210;
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.advance(350);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    f.viewport.height = 350;
    f.controller.viewportChanged();
    f.advance(50);
    f.viewport.height = 400;
    f.viewport.offsetTop = 8;
    f.controller.viewportChanged();
    f.advance(70);
    f.viewport.offsetTop = 0;
    f.controller.viewportChanged();
    f.advance(100);
    expect(f.scroller.scrollTop).toBe(600);
    f.advance(450);
    expect(f.scroller.scrollTop).toBe(988);
  });
  it.each([false, true])(
    'late acknowledgement still waits for fresh viewport quiet (reduced=%s)',
    (reduced) => {
      const f = fixture({ animate: !reduced });
      f.viewport.height = 200;
      const ticket = f.controller.begin();
      f.add(12);
      f.advance(1100);
      f.viewport.height = 400;
      f.controller.viewportChanged();
      f.controller.acknowledge(ticket, 12);
      f.advance(96);
      expect(f.scroller.scrollTo).not.toHaveBeenCalled();
      expect(f.scroller.scrollTop).toBe(600);
      f.advance(500);
      expect(f.scroller.scrollTop).toBe(988);
      expect(f.frameCount()).toBe(0);
    },
  );
  it.each([false, true])(
    'geometry changes after keyboard fallback pause motion for fresh quiet (reduced=%s)',
    (reduced) => {
      const f = fixture({ animate: true });
      f.viewport.height = 200;
      const ticket = f.controller.begin();
      f.add(12);
      f.controller.acknowledge(ticket, 12);
      f.advance(1100);
      const current = f.scroller.scrollTop;
      expect(current).toBeGreaterThan(600);
      expect(current).toBeLessThan(988);
      f.setReduced(reduced);
      f.viewport.height = 400;
      f.controller.viewportChanged();
      f.scroller.scrollTo.mockClear();
      f.advance(96);
      expect(f.scroller.scrollTo).not.toHaveBeenCalled();
      expect(f.scroller.scrollTop).toBe(current);
      f.advance(500);
      expect(f.scroller.scrollTop).toBe(988);
      expect(f.frameCount()).toBe(0);
    },
  );
  it('bounds waiting if a dismissed keyboard leaves stale viewport reporting', () => {
    const f = fixture({ animate: true });
    f.viewport.height = 200;
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.advance(900);
    expect(f.scroller.scrollTop).toBe(600);
    f.advance(650);
    expect(f.scroller.scrollTop).toBe(988);
    expect(f.frameCount()).toBe(0);
  });
  it('pauses mid-motion on viewport changes and resumes from the current position', () => {
    const f = sent();
    f.advance(180);
    const current = f.scroller.scrollTop;
    f.viewport.height = 380;
    f.controller.viewportChanged();
    f.advance(80);
    expect(f.scroller.scrollTop).toBe(current);
    f.viewport.height = 400;
    f.controller.viewportChanged();
    f.advance(100);
    expect(f.scroller.scrollTop).toBe(current);
    f.advance(450);
    expect(f.scroller.scrollTop).toBe(988);
    const positions = f.scroller.scrollTo.mock.calls.map(([call]) => call.top);
    expect(positions.every((top, i) => top >= (positions[i - 1] ?? 600))).toBe(true);
  });
  it('reader release cancels an active tween without resetting their chosen position', () => {
    const f = sent();
    f.advance(180);
    f.controller.release();
    f.scroller.scrollTop = 400;
    f.scroller.scrollTo.mockClear();
    f.advance(1200);
    f.scroller.clientHeight = 700;
    f.controller.update();
    expect(f.scroller.scrollTop).toBe(400);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    expect(f.frameCount()).toBe(0);
  });
  it('source invalidation cancels queued frames and drops the owned reservation', () => {
    const f = sent();
    f.advance(180);
    f.setOwner('other:2');
    f.scroller.scrollTo.mockClear();
    f.advance(600);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    expect(f.space()).toBe(0);
    expect(f.frameCount()).toBe(0);
  });
  it('a newer send freezes the older tween until the new durable row arrives', () => {
    const f = sent();
    f.advance(180);
    const top = f.scroller.scrollTop;
    const fresh = f.controller.begin();
    f.advance(450);
    expect(f.scroller.scrollTop).toBe(top);
    f.add(14, 1100);
    f.controller.acknowledge(fresh, 14);
    f.advance(450);
    expect(f.scroller.scrollTop).toBe(1088);
  });
  it('reduced motion still waits for keyboard dismissal, then positions without a tween', () => {
    const f = fixture();
    f.viewport.height = 200;
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.advance(300);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    f.viewport.height = 400;
    f.controller.viewportChanged();
    f.advance(200);
    expect(f.scroller.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 988, behavior: 'auto' });
    expect(f.frameCount()).toBe(0);
  });
  it('switching reduced motion on during a tween finishes once and stops its RAF', () => {
    const f = sent();
    f.advance(150);
    f.setReduced(true);
    f.advance(30);
    expect(f.scroller.scrollTop).toBe(988);
    expect(f.frameCount()).toBe(0);
  });
});
