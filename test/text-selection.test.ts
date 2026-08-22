import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bindCustomSelection,
  createRangeBetween,
  quotePreview,
  selectedTranscriptText,
} from '../public/text-selection.js';

describe('transcript text selection', () => {
  it('accepts a dragged selection only when it belongs to the transcript', () => {
    const inside = {};
    const root = { contains: (node: unknown) => node === inside };
    const selection = {
      rangeCount: 1,
      isCollapsed: false,
      toString: () => '  selected text  ',
      getRangeAt: () => ({ commonAncestorContainer: inside }),
    };

    expect(selectedTranscriptText(selection, root)).toBe('selected text');
    expect(
      selectedTranscriptText(
        { ...selection, getRangeAt: () => ({ commonAncestorContainer: {} }) },
        root,
      ),
    ).toBe('');
  });

  it('orders a backwards touch drag into a non-collapsed DOM range', () => {
    const calls: string[] = [];
    const textNode = { nodeType: 3, textContent: '0123456789' };
    const range = {
      collapsed: false,
      setStart: (_node: unknown, offset: number) => calls.push(`start:${offset}`),
      setEnd: (_node: unknown, offset: number) => calls.push(`end:${offset}`),
    };
    const document = { createRange: () => range };

    expect(
      createRangeBetween(
        document,
        { node: textNode, offset: 8 },
        { node: textNode, offset: 3 },
        () => 1,
      ),
    ).toBe(range);
    expect(calls).toEqual(['start:3', 'end:8']);
  });

  it('creates a short one-line preview while retaining the full quote elsewhere', () => {
    expect(quotePreview(' first\n\nsecond   third ', 17)).toBe('first second thi…');
  });

  it('provides quote and copy actions plus custom handles in html', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../public/index.html'), 'utf8');

    expect(html).toContain('id="selection-actions"');
    expect(html).toContain('id="selection-quote"');
    expect(html).toContain('id="selection-copy"');
    expect(html).toContain('id="quote-preview"');
    expect(html).toContain('id="custom-selection-overlay"');
    expect(html).toContain('id="sel-backdrop"');
    expect(html).toContain('id="sel-highlight-boxes"');
    expect(html).toContain('id="sel-handle-start"');
    expect(html).toContain('id="sel-handle-end"');
  });

  it('blocks iOS system callout on touch while styling custom selection handles', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../public/app.css'), 'utf8');

    expect(css).toContain('-webkit-user-select: none');
    expect(css).toContain('-webkit-touch-callout: none');
    expect(css).toContain('.sel-backdrop');
    expect(css).toContain('.sel-highlight-boxes');
    expect(css).toContain('.sel-highlight-rect');
    expect(css).toContain('.sel-handle');
    expect(css).toContain('.sel-handle-pin');
    expect(css).toContain('::highlight(piweb-selection)');
  });

  it('triggers custom touch selection on long-press and expands to word', () => {
    vi.useFakeTimers();
    const textNode = { nodeType: 3, textContent: 'hello world test' };
    const listeners = new Map<string, (event: any) => void>();

    class FakeRange {
      startOffset = 0;
      endOffset = 0;
      startContainer = textNode;
      setStart(_node: unknown, offset: number) { this.startOffset = offset; }
      setEnd(_node: unknown, offset: number) { this.endOffset = offset; }
      collapse() { this.endOffset = this.startOffset; }
      compareBoundaryPoints(_how: number, other: FakeRange) { return this.startOffset - other.startOffset; }
      toString() { return textNode.textContent.slice(this.startOffset, this.endOffset); }
      getClientRects() { return [{ left: 10, top: 20, right: 60, bottom: 35, width: 50, height: 15 }]; }
      getBoundingClientRect() { return { left: 10, top: 20, right: 60, bottom: 35, width: 50, height: 15 }; }
    }

    const highlights = new Map();
    const document = {
      defaultView: {
        CSS: { highlights },
        Highlight: class { constructor(public range: FakeRange) {} },
        navigator: { vibrate: vi.fn() },
        addEventListener: vi.fn(),
        setTimeout,
        clearTimeout,
      },
      createRange: () => new FakeRange(),
      caretPositionFromPoint: (x: number) => ({ offsetNode: textNode, offset: x }),
      createElement: () => ({ className: '', style: {} }),
    };

    const startHandle = { style: { left: '', top: '' }, addEventListener: vi.fn() };
    const endHandle = { style: { left: '', top: '' }, addEventListener: vi.fn() };
    const boxesContainer = { innerHTML: '', appendChild: vi.fn() };
    const backdropListeners = new Map<string, (e: any) => void>();
    const backdrop = {
      addEventListener: (type: string, fn: (e: any) => void) => backdropListeners.set(type, fn),
    };

    const overlayEl = {
      hidden: true,
      classList: { add: vi.fn(), remove: vi.fn() },
      querySelector: (sel: string) => {
        if (sel === '#sel-handle-start') return startHandle;
        if (sel === '#sel-handle-end') return endHandle;
        if (sel === '#sel-highlight-boxes') return boxesContainer;
        if (sel === '#sel-backdrop') return backdrop;
        return null;
      },
    };

    const root = {
      ownerDocument: document,
      contains: () => true,
      addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    };

    const onSelection = vi.fn();
    const onClear = vi.fn();
    const target = { closest: (sel: string) => sel.includes('msg-text') ? {} : null };

    bindCustomSelection(root, overlayEl, { onSelection, onClear });

    listeners.get('touchstart')?.({
      touches: [{ identifier: 1, clientX: 2, clientY: 5 }],
      target,
    });

    vi.advanceTimersByTime(320);

    expect(onSelection).toHaveBeenCalledWith('hello', expect.anything());
    expect(overlayEl.hidden).toBe(false);
    expect(startHandle.style.left).toBe('10px');
    expect(endHandle.style.left).toBe('60px');
    expect(boxesContainer.appendChild).toHaveBeenCalled();

    // Test backdrop touch clears selection
    backdropListeners.get('touchstart')?.({
      stopPropagation: vi.fn(),
      cancelable: true,
      preventDefault: vi.fn(),
    });

    expect(onClear).toHaveBeenCalled();
    expect(overlayEl.hidden).toBe(true);

    vi.useRealTimers();
  });

  it('locks start anchor and moves trailing pivot when dragging across text', () => {
    vi.useFakeTimers();
    const textNode = { nodeType: 3, textContent: 'first line\nsecond line\nthird line' };
    const globalListeners = new Map<string, (event: any) => void>();
    const rootListeners = new Map<string, (event: any) => void>();

    class FakeRange {
      startOffset = 0;
      endOffset = 0;
      startContainer = textNode;
      setStart(_node: unknown, offset: number) { this.startOffset = offset; }
      setEnd(_node: unknown, offset: number) { this.endOffset = offset; }
      collapse() { this.endOffset = this.startOffset; }
      compareBoundaryPoints(_how: number, other: FakeRange) { return this.startOffset - other.startOffset; }
      toString() { return textNode.textContent.slice(this.startOffset, this.endOffset); }
      getClientRects() { return [{ left: 10, top: 20, right: 60, bottom: 35, width: 50, height: 15 }]; }
      getBoundingClientRect() { return { left: 10, top: 20, right: 60, bottom: 35, width: 50, height: 15 }; }
    }

    const document = {
      defaultView: {
        CSS: { highlights: new Map() },
        Highlight: class { constructor(public range: FakeRange) {} },
        navigator: { vibrate: vi.fn() },
        addEventListener: (type: string, fn: (e: any) => void) => globalListeners.set(type, fn),
        setTimeout,
        clearTimeout,
      },
      createRange: () => new FakeRange(),
      caretPositionFromPoint: (x: number) => ({ offsetNode: textNode, offset: x }),
      createElement: () => ({ className: '', style: {} }),
    };

    const startHandle = { style: { left: '', top: '' }, addEventListener: vi.fn() };
    const endHandle = { style: { left: '', top: '' }, addEventListener: vi.fn() };
    const boxesContainer = { innerHTML: '', appendChild: vi.fn() };
    const overlayEl = {
      hidden: true,
      classList: { add: vi.fn(), remove: vi.fn() },
      querySelector: (sel: string) => {
        if (sel === '#sel-handle-start') return startHandle;
        if (sel === '#sel-handle-end') return endHandle;
        if (sel === '#sel-highlight-boxes') return boxesContainer;
        return null;
      },
    };

    const root = {
      ownerDocument: document,
      contains: () => true,
      addEventListener: (type: string, fn: (e: any) => void) => rootListeners.set(type, fn),
    };

    const onSelection = vi.fn();
    bindCustomSelection(root, overlayEl, { onSelection });

    // Long press on word "first" (offset 0..5)
    rootListeners.get('touchstart')?.({
      touches: [{ identifier: 1, clientX: 2, clientY: 5 }],
      target: { closest: (sel: string) => sel.includes('msg-text') ? {} : null },
    });
    vi.advanceTimersByTime(320);

    expect(onSelection).toHaveBeenLastCalledWith('first', expect.anything());

    // Drag finger forward to offset 22 ("first line\nsecond line")
    globalListeners.get('touchmove')?.({
      touches: [{ identifier: 1, clientX: 22, clientY: 45 }],
      cancelable: true,
      preventDefault: vi.fn(),
    });

    // Start anchor should remain locked at 0; trailing pivot moved to 22!
    expect(onSelection).toHaveBeenLastCalledWith('first line\nsecond line', expect.anything());

    vi.useRealTimers();
  });
});


