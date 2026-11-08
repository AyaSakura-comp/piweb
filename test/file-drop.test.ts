import { describe, expect, it, vi } from 'vitest';
import {
  bindFileDropTarget,
  guardDocumentFileDrops,
  isFileDrag,
} from '../public/file-drop.js';

class FakeTarget extends EventTarget {
  classList = new Set<string>();
  constructor() {
    super();
    const set = this.classList;
    (this as any).classList = {
      add: (c: string) => set.add(c),
      remove: (c: string) => set.delete(c),
      contains: (c: string) => set.has(c),
    };
  }
}

function dragEvent(type: string, { types = ['Files'], files = [] as unknown[] } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    dataTransfer: { types: string[]; files: unknown[]; dropEffect: string };
  };
  e.dataTransfer = { types, files, dropEffect: '' };
  return e;
}

describe('file-drop', () => {
  it('recognises OS file drags only', () => {
    expect(isFileDrag(dragEvent('dragover'))).toBe(true);
    expect(isFileDrag(dragEvent('dragover', { types: ['text/piweb-session-jid'] }))).toBe(false);
  });

  it('hands dropped files to the target and stops the browser opening them', () => {
    const t = new FakeTarget();
    const onFiles = vi.fn();
    bindFileDropTarget(t as unknown as HTMLElement, onFiles);
    t.dispatchEvent(dragEvent('dragenter'));
    expect((t as any).classList.contains('file-drag-over')).toBe(true);
    const over = dragEvent('dragover');
    t.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const drop = dragEvent('drop', { files: ['a.ARW'] });
    t.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onFiles).toHaveBeenCalledWith(['a.ARW']);
    expect((t as any).classList.contains('file-drag-over')).toBe(false);
  });

  it('leaves session drags to the Dashboard', () => {
    const t = new FakeTarget();
    const onFiles = vi.fn();
    bindFileDropTarget(t as unknown as HTMLElement, onFiles);
    const drop = dragEvent('drop', { types: ['text/piweb-session-jid'] });
    t.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('swallows an unclaimed drop and only attaches while accepted', () => {
    const doc = new EventTarget();
    const onFiles = vi.fn();
    let ok = false;
    guardDocumentFileDrops(doc as unknown as Document, { accepts: () => ok, onFiles });
    const first = dragEvent('drop', { files: ['x.jpg'] });
    doc.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(onFiles).not.toHaveBeenCalled();
    ok = true;
    doc.dispatchEvent(dragEvent('drop', { files: ['x.jpg'] }));
    expect(onFiles).toHaveBeenCalledWith(['x.jpg']);
  });
});
