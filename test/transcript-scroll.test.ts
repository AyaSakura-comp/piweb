import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  formatElapsed,
  runningToolNode,
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
  it('keeps completed live messages locked to the tail without an in-flight smooth-scroll gap', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');
    const appendEvent =
      app.match(/function appendEvent\(event, live\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(appendEvent).toContain('const followLatest = shouldFollowTranscriptTail()');
    expect(appendEvent).toContain(
      "settleTranscriptUpdate(messages, $('jump-live'), followLatest, 'auto')",
    );
    expect(appendEvent).not.toContain("followLatest, 'smooth'");
    expect(app.match(/function renderPartial\(text, thinking = ''\) \{([\s\S]*?)\n\}/)?.[1]).toContain(
      'const followLatest = shouldFollowTranscriptTail()',
    );
  });

  it('reanchors the live tail when focusing the composer opens the mobile keyboard', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');
    const viewportSync = app.match(/function syncViewportSizes\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(app).toContain("input.addEventListener('focus', captureComposerBottomLock)");
    expect(app).toContain("input.addEventListener('blur', handleComposerBlur)");
    expect(app).toContain("$('btn-send').addEventListener('pointerdown', captureComposerSendIntent)");
    expect(app).toContain("$('btn-send').addEventListener('pointerup', scheduleComposerSendIntentCleanup)");
    expect(app).toContain("$('btn-send').addEventListener('pointerleave', cancelMouseSendIntentOnLeave)");
    expect(app).toContain('holdComposerBottomForSend(followAfterSend)');
    expect(app).toContain('scheduleComposerSendSettlement()');
    const sendSettlement =
      app.match(/function scheduleComposerSendSettlement\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(sendSettlement).not.toContain('needsViewportRecovery');
    expect(app).not.toContain('COMPOSER_SEND_LOCK_MS');
    expect(app).toContain("$('messages').addEventListener('pointerdown', releaseComposerBottomLock");
    expect(app).toContain("$('messages').addEventListener('touchmove', releaseComposerBottomLock");
    expect(app).toContain("$('messages').addEventListener('wheel', releaseComposerBottomLock");
    expect(app).toContain('if (shouldReleaseComposerBottomLock()) releaseComposerBottomLock()');
    expect(app).not.toContain('if (composerBottomLocked && !isNearBottom()) releaseComposerBottomLock()');
    expect(viewportSync).toContain('keepComposerBottomVisible()');
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

describe('running tool call clock', () => {
  it('reads seconds, then m:ss, then h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(9_400)).toBe('9s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(127_000)).toBe('2:07');
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('drives the clock from the busy state and refreshes it as events land', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');
    const setBusy = app.match(/function setBusy\(busy\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(setBusy).toContain('setToolElapsedTicking(busy)');
    // The result is the next event, so the badge must move off its row at once
    // rather than up to a second later.
    expect(app).toMatch(/messages\.append\(node\);\n\s*\/\/[\s\S]*?syncRunningTool\(\);/);
    expect(app).toContain("event.kind === 'tool' && event.createdAt");
  });

  it('ticks only on the newest tool row while the session is busy', () => {
    const messages = setupToolTranscript(['tool']);
    expect(runningToolNode(messages, true)?.dataset.id).toBe('t0');

    // A turn that died leaves the row on screen; the clock must not keep running.
    expect(runningToolNode(messages, false)).toBeNull();

    // The result arrives as the very next event, which ends the call.
    const withResult = setupToolTranscript(['tool', 'tool_result']);
    expect(runningToolNode(withResult, true)).toBeNull();

    // A second call after a finished one is the live one.
    const second = setupToolTranscript(['tool', 'tool_result', 'tool']);
    expect(runningToolNode(second, true)?.dataset.id).toBe('t2');

    expect(runningToolNode(setupToolTranscript([]), true)).toBeNull();
    expect(runningToolNode(null, true)).toBeNull();
  });
});

function setupToolTranscript(kinds: string[]): any {
  const nodes = kinds.map((kind, index) => {
    const node: any = { dataset: { id: `t${index}` }, kind };
    return node;
  });
  for (let i = 0; i < nodes.length; i++) nodes[i].nextElementSibling = nodes[i + 1] ?? null;
  return {
    querySelectorAll: (selector: string) =>
      selector === '.event.tool' ? nodes.filter((n) => n.kind === 'tool') : [],
  };
}
