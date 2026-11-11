import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPromptTurnScroll, getPromptTurnLayout } from '../public/prompt-turn-scroll.js';

const geometry = (height = 400, top = 1000, bottom = 1060) =>
  getPromptTurnLayout(height, top, bottom, 4);

afterEach(() => vi.unstubAllGlobals());

describe('prompt turn viewport geometry', () => {
  it('reserves the empty remainder and aligns the new prompt with the clipping edge', () => {
    expect(geometry()).toEqual({ top: 1000, space: 336 });
  });
  it('spends reservation as the answer grows without moving the prompt', () => {
    expect(geometry(400, 1000, 1260)).toEqual({ top: 1000, space: 136 });
    expect(geometry(400, 1000, 1500)).toEqual({ top: 1000, space: 0 });
  });
  it('uses actual short viewport dimensions rather than a screen-height constant', () => {
    expect(geometry(200)).toEqual({ top: 1000, space: 136 });
    expect(geometry(0).space).toBe(0);
    expect(geometry(400, 5, 65).top).toBe(5);
  });
  it('rounds fractional anchors upward to avoid exposing a subpixel history sliver', () => {
    expect(geometry(400, 1000.4, 1060.4)).toEqual({ top: 1001, space: 337 });
    const { top, space } = geometry(400, 1000.4, 1060.4);
    // Native scrollHeight is integral; its maximum must still reach the target.
    expect(Math.round(1060.4 + 4 + space) - 400).toBeGreaterThanOrEqual(top);
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
  // The reservation is the transcript's ::after block, not its padding.
  vi.stubGlobal('getComputedStyle', () => ({ paddingTop: '12px', paddingBottom: '4px' }));
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
  it('places the preceding row fully above the viewport after Send', () => {
    const f = fixture();
    const previous = f.add(11, 940, 60, false);
    const ticket = f.controller.begin();
    const prompt = f.add(12);
    f.controller.acknowledge(ticket, 12);
    const edge = f.scroller.getBoundingClientRect().top;
    expect(previous.getBoundingClientRect().bottom).toBeLessThanOrEqual(edge);
    expect(prompt.getBoundingClientRect().top).toBe(edge);
  });
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
    expect(f.scroller.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1000, behavior: 'auto' });
    expect(f.space()).toBe(336);
  });
  it('also handles the saved SSE row arriving before the acknowledgement', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    const row = f.add(12);
    f.controller.acknowledge(ticket, 12);
    expect(f.scroller.scrollTop).toBe(1000);
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
    expect(f.space()).toBe(136);
    expect(f.scroller.scrollTop).toBe(1000);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
  });
  it('recalculates reservation for keyboard/viewport changes while still anchored', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.scroller.clientHeight = 700;
    f.controller.update();
    expect(f.space()).toBe(636);
    expect(f.scroller.scrollTop).toBe(1000);
  });
  // Live check 2026-10-29: with BTW in front the transcript is display:none and
  // measures as zero; the reservation computed from that was dropped, and on
  // the way back it was re-added under the restored position, short of the end.
  it('keeps the reservation while the transcript is hidden and recomputes once shown', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    const prompt = f.add(12);
    f.controller.acknowledge(ticket, 12);
    expect(f.space()).toBe(336);
    f.scroller.scrollTo.mockClear();
    const shown = { rect: f.scroller.getBoundingClientRect, rows: prompt.getBoundingClientRect };
    f.scroller.clientHeight = 0;
    f.scroller.scrollTop = 0;
    f.scroller.getBoundingClientRect = () => ({ top: 0 });
    prompt.getBoundingClientRect = () => ({ top: 0, bottom: 0 });
    f.controller.update();
    expect(f.space()).toBe(336);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    f.scroller.clientHeight = 400;
    f.scroller.scrollTop = 1000;
    f.scroller.getBoundingClientRect = shown.rect;
    prompt.getBoundingClientRect = shown.rows;
    f.add(13, 1060, 200, false);
    f.controller.update();
    expect(f.space()).toBe(136);
    expect(f.scroller.scrollTop).toBe(1000);
  });
  it('restores the prompt if a temporary rich-body replacement clamps native scrollTop', () => {
    const f = fixture();
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.scroller.scrollTop = 937;
    f.controller.update();
    expect(f.scroller.scrollTop).toBe(1000);
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
    expect(f.space()).toBe(316);
    expect(f.scroller.scrollTop).toBe(1000);
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
    // The reader at the end of the history (600 + 400 = its last row + padding).
    f.add(11, 900, 96, false);
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
    expect(f.scroller.scrollTop).toBe(1100);
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
    expect(f.space()).toBe(336);
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
    expect(f.scroller.scrollTop).toBe(1100);
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
    expect(f.scroller.scrollTop).toBe(1000);
    const positions = f.scroller.scrollTo.mock.calls.map(([call]) => call.top);
    expect(positions.length).toBeGreaterThan(10);
    expect(positions.every((top, i) => top >= (positions[i - 1] ?? 600) && top <= 1000)).toBe(true);
    expect(f.controller.navigating).toBe(false);
    expect(f.frameCount()).toBe(0);
  });
  // iPhone 2026-11-11: Send with the keyboard up slid the transcript down with
  // the keyboard, paused, then scrolled back up. Now it is one upward motion
  // that runs while the keyboard goes down.
  it('starts while the keyboard is still going down and keeps going through its reports', () => {
    const f = fixture({ animate: true });
    f.viewport.height = 210;
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    // The room the keyboard is about to free is reserved on top of the turn.
    expect(f.space()).toBe(336 + 190);
    f.advance(100);
    expect(f.scroller.scrollTop).toBeGreaterThan(600);
    for (const [height, offsetTop] of [
      [300, 40],
      [370, 10],
      [400, 0],
    ]) {
      f.viewport.height = height;
      f.viewport.offsetTop = offsetTop;
      f.controller.viewportChanged();
      f.advance(48);
    }
    f.advance(200);
    expect(f.scroller.scrollTop).toBe(1000);
    expect(f.space()).toBe(336);
    const positions = f.scroller.scrollTo.mock.calls.map(([call]) => call.top);
    expect(positions.length).toBeGreaterThan(10);
    expect(positions.every((top, i) => top >= (positions[i - 1] ?? 600) && top <= 1000)).toBe(true);
    expect(f.frameCount()).toBe(0);
  });
  it('holds the reader in place while the keyboard frees its room before the row arrives', () => {
    const f = fixture({ animate: true });
    // At the end of the history, in the shell pinned above a 190px keyboard:
    // the last row and the base padding end at the transcript's bottom.
    f.add(11, 900, 96, false);
    f.viewport.height = 210;
    f.scroller.clientHeight = 210;
    f.scroller.scrollTop = 790;
    const ticket = f.controller.begin();
    // Without it the growing transcript clamps the position and the history
    // rides down with the keyboard.
    expect(f.space()).toBe(190);
    expect(f.scroller.dataset.promptTurn).toBe('active');
    // Halfway down: the transcript grew into half of it, half is still to come.
    f.viewport.height = 300;
    f.scroller.clientHeight = 300;
    f.controller.viewportChanged();
    f.advance(32);
    expect(f.space()).toBe(190);
    expect(f.scroller.scrollTop).toBe(790);
    expect(f.scroller.scrollTo).not.toHaveBeenCalled();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.advance(500);
    expect(f.scroller.scrollTop).toBe(1000);
  });
  it('a failed send drops the hold', () => {
    const f = fixture({ animate: true });
    f.add(11, 900, 96, false);
    f.viewport.height = 210;
    const ticket = f.controller.begin();
    expect(f.space()).toBe(190);
    f.controller.cancel(ticket);
    expect(f.space()).toBe(0);
    expect(f.scroller.dataset.promptTurn).toBeUndefined();
  });
  it('without a keyboard or a shrinking composer nothing is held before the row arrives', () => {
    const f = fixture({ animate: true });
    f.add(11, 900, 96, false);
    f.controller.begin();
    expect(f.space()).toBe(0);
    expect(f.scroller.dataset.promptTurn).toBeUndefined();
  });
  it('the composer shrinking as Send clears a long draft does not drop the history', () => {
    const f = fixture({ animate: true });
    f.add(11, 900, 96, false);
    f.controller.begin();
    // Four lines of draft gone: the transcript grows 80px and the browser
    // clamps the end of the history down to its bottom.
    f.scroller.clientHeight = 480;
    f.scroller.scrollTop = 520;
    f.controller.update();
    expect(f.space()).toBe(80);
    expect(f.scroller.scrollTop).toBe(600);
  });
  it('a late acknowledgement moves after two layout frames, however recent the viewport change', () => {
    const f = fixture({ animate: true });
    f.viewport.height = 200;
    const ticket = f.controller.begin();
    f.add(12);
    f.advance(1100);
    f.viewport.height = 400;
    f.controller.viewportChanged();
    f.controller.acknowledge(ticket, 12);
    f.advance(48);
    expect(f.scroller.scrollTop).toBeGreaterThan(600);
    f.advance(400);
    expect(f.scroller.scrollTop).toBe(1000);
    expect(f.frameCount()).toBe(0);
  });
  it('a viewport that stays short after the keyboard has gone does not hold the motion', () => {
    const f = fixture({ animate: true });
    f.viewport.height = 200;
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.advance(420);
    expect(f.scroller.scrollTop).toBe(1000);
    expect(f.frameCount()).toBe(0);
  });
  it('content above the prompt resizing mid-motion moves the path with it, not the prompt', () => {
    const f = fixture({ animate: true });
    const previous = f.add(11, 900, 100, false);
    const ticket = f.controller.begin();
    const prompt = f.add(12);
    f.controller.acknowledge(ticket, 12);
    f.advance(180);
    const edge = f.scroller.getBoundingClientRect().top;
    const before = prompt.getBoundingClientRect().top - edge;
    expect(before).toBeGreaterThan(0);
    // The previous reply finishes rendering 40px taller.
    previous.height += 40;
    prompt.top += 40;
    f.controller.update();
    f.advance(16);
    const after = prompt.getBoundingClientRect().top - edge;
    expect(after).toBeLessThanOrEqual(before);
    expect(before - after).toBeLessThan(80);
    f.advance(400);
    expect(f.scroller.scrollTop).toBe(1040);
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
    expect(f.scroller.scrollTop).toBe(1100);
  });
  it('reduced motion places the prompt at once, even with the keyboard still going down', () => {
    const f = fixture();
    f.viewport.height = 200;
    const ticket = f.controller.begin();
    f.add(12);
    f.controller.acknowledge(ticket, 12);
    expect(f.scroller.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1000, behavior: 'auto' });
    f.viewport.height = 400;
    f.controller.viewportChanged();
    f.advance(200);
    expect(f.scroller.scrollTop).toBe(1000);
    expect(f.frameCount()).toBe(0);
  });
  it('switching reduced motion on during a tween finishes once and stops its RAF', () => {
    const f = sent();
    f.advance(150);
    f.setReduced(true);
    f.advance(30);
    expect(f.scroller.scrollTop).toBe(1000);
    expect(f.frameCount()).toBe(0);
  });
});
