import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isTranscriptNearBottom,
  jumpToLatest,
  settleTranscriptUpdate,
} from '../public/session-ui.js';

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

function setupScroller() {
  return {
    scrollHeight: 1_000,
    scrollTop: 800,
    clientHeight: 200,
    scrollTo: vi.fn(),
  };
}

describe('transcript live scrolling', () => {
  it('animates completed live messages upward instead of snapping', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');
    const appendEvent =
      app.match(/function appendEvent\(event, live\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(appendEvent).toContain(
      "settleTranscriptUpdate(messages, $('jump-live'), followLatest, 'smooth')",
    );
  });

  it('does not treat a reader 50px above the tail as being at the bottom', () => {
    const scroller = setupScroller();
    scroller.scrollTop = 750;

    expect(isTranscriptNearBottom(scroller)).toBe(false);
  });

  it('follows new output only when the reader was already at the bottom', () => {
    const scroller = setupScroller();
    const button = { classList: new FakeClassList() };
    const wasNearBottom = isTranscriptNearBottom(scroller);

    scroller.scrollHeight = 1_200;
    settleTranscriptUpdate(scroller, button, wasNearBottom);

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1_200, behavior: 'auto' });
    expect(button.classList.contains('visible')).toBe(false);
  });

  it('does not force-scroll readers who moved away and shows the latest button', () => {
    const scroller = setupScroller();
    const button = { classList: new FakeClassList() };
    scroller.scrollTop = 400;
    const wasNearBottom = isTranscriptNearBottom(scroller);

    scroller.scrollHeight = 1_200;
    settleTranscriptUpdate(scroller, button, wasNearBottom);

    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(button.classList.contains('visible')).toBe(true);
  });

  it('jumps to the newest output and hides the button', () => {
    const scroller = setupScroller();
    const button = { classList: new FakeClassList() };
    button.classList.toggle('visible', true);

    jumpToLatest(scroller, button);

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'smooth' });
    expect(button.classList.contains('visible')).toBe(false);
  });
});
