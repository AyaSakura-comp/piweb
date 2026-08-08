import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bindCodeCopy, codeTextFromTarget } from '../public/message-copy.js';

class FakeTarget {
  constructor(
    private readonly code: { textContent: string } | null,
    private readonly insideMessages = true,
    private readonly insideLink = false,
  ) {}

  closest(selector: string): { textContent: string } | Record<string, never> | null {
    if (selector === 'a') return this.insideLink ? {} : null;
    if (!this.insideMessages) return null;
    if (selector !== '#messages .msg-text code, #messages .event-body code') return null;
    return this.code;
  }
}

class FakeRoot {
  private clickListener?: (event: { target: FakeTarget; preventDefault: () => void }) => Promise<void>;

  constructor(private readonly selection = '') {}

  addEventListener(type: string, listener: typeof this.clickListener): void {
    if (type === 'click') this.clickListener = listener;
  }

  getSelection(): { toString: () => string } {
    return { toString: () => this.selection };
  }

  async click(target: FakeTarget): Promise<{ defaultPrevented: boolean }> {
    let defaultPrevented = false;
    await this.clickListener?.({
      target,
      preventDefault: () => {
        defaultPrevented = true;
      },
    });
    return { defaultPrevented };
  }
}

describe('codeTextFromTarget', () => {
  it('returns the exact inline-code text tapped in a message', () => {
    expect(codeTextFromTarget(new FakeTarget({ textContent: 'origin/main' }))).toBe('origin/main');
  });

  it('preserves line breaks and indentation from a fenced code block', () => {
    const code = 'npm test\n  npm run build';
    expect(codeTextFromTarget(new FakeTarget({ textContent: code }))).toBe(code);
  });

  it('ignores code outside the message transcript', () => {
    expect(codeTextFromTarget(new FakeTarget({ textContent: 'secret' }, false))).toBeNull();
  });
});

describe('copyable code styles', () => {
  it('shows that message and event code can be tapped to copy', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../public/app.css'), 'utf8');

    expect(css).toMatch(/\.msg-text code,\s*\.event-body code \{[^}]*cursor: copy/);
  });
});

describe('bindCodeCopy', () => {
  it('copies markdown code on a single tap and reports success', async () => {
    const root = new FakeRoot();
    const copyText = vi.fn().mockResolvedValue(true);
    const onResult = vi.fn();
    bindCodeCopy(root, { copyText, onResult });

    const event = await root.click(new FakeTarget({ textContent: 'git status' }));

    expect(event.defaultPrevented).toBe(true);
    expect(copyText).toHaveBeenCalledWith('git status');
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it('leaves ordinary transcript text alone', async () => {
    const root = new FakeRoot();
    const copyText = vi.fn().mockResolvedValue(true);
    bindCodeCopy(root, { copyText, onResult: vi.fn() });

    const event = await root.click(new FakeTarget(null));

    expect(event.defaultPrevented).toBe(false);
    expect(copyText).not.toHaveBeenCalled();
  });

  it('does not overwrite a manual code-text selection', async () => {
    const root = new FakeRoot('git');
    const copyText = vi.fn().mockResolvedValue(true);
    bindCodeCopy(root, { copyText, onResult: vi.fn() });

    const event = await root.click(new FakeTarget({ textContent: 'git status' }));

    expect(event.defaultPrevented).toBe(false);
    expect(copyText).not.toHaveBeenCalled();
  });

  it('does not override a link activation', async () => {
    const root = new FakeRoot();
    const copyText = vi.fn().mockResolvedValue(true);
    bindCodeCopy(root, { copyText, onResult: vi.fn() });

    const event = await root.click(new FakeTarget({ textContent: 'docs' }, true, true));

    expect(event.defaultPrevented).toBe(false);
    expect(copyText).not.toHaveBeenCalled();
  });
});
