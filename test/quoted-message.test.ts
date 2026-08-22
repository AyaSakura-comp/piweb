import { describe, expect, it } from 'vitest';
import { buildQuotedDisplay, buildQuotedPrompt, normalizeQuote } from '../src/quoted-message.js';

describe('quoted messages', () => {
  it('sends the full selected text to pi but keeps the visible user message compact', () => {
    const quote = 'This is a long selected passage with the exact detail pi needs to answer.';

    expect(buildQuotedPrompt('What does this mean?', quote)).toContain(quote);
    expect(buildQuotedPrompt('What does this mean?', quote)).toContain('What does this mean?');
    expect(buildQuotedDisplay('What does this mean?', quote)).toBe(
      '↪ 引用：「This is a long selected passage with the exact detail pi needs to…」\nWhat does this mean?',
    );
  });

  it('leaves ordinary messages unchanged', () => {
    expect(buildQuotedPrompt('hello', '')).toBe('hello');
    expect(buildQuotedDisplay('hello', '')).toBe('hello');
  });

  it('normalizes and bounds untrusted quote input', () => {
    expect(normalizeQuote(42)).toBe('');
    expect(normalizeQuote('  a\r\n\r\nb  ')).toBe('a\n\nb');
    expect(normalizeQuote('x'.repeat(20_000))).toHaveLength(12_000);
  });
});
