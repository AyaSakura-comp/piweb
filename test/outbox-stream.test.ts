import { describe, expect, it } from 'vitest';
import { continuesSource, tokenizeOutbox } from '../public/outbox-stream.js';

describe('outbox markers while streaming', () => {
  it('tokenizes a local marker so the text after it keeps streaming', () => {
    const partial = 'Before.\n\n[[image: /home/u/.pi-outbox/a.png]]\n\nAfter the image.';
    expect(tokenizeOutbox(partial, false)).toEqual({
      source: 'Before.\n\n[[media:0]]\n\nAfter the image.',
      media: [{ kind: 'image', url: null }],
    });
  });
  it('cuts only an unfinished marker at the very end', () => {
    for (const tail of [
      '[[',
      '[[i',
      '[[imag',
      '[[image',
      '[[image:',
      '[[image: /home/u/a.p',
      '[[image: /a.png]',
    ])
      expect(tokenizeOutbox(`Text ${tail}`, false).source).toBe('Text ');
    expect(tokenizeOutbox('a [[note]] b', false).source).toBe('a [[note]] b');
    expect(tokenizeOutbox('[link](x) [', false).source).toBe('[link](x) [');
  });
  it('gives the streamed and final reply identical sources, only the URL differs', () => {
    const streamed = tokenizeOutbox('Before.\n\n[[image: /home/u/a.png]]\n\nAfter', false);
    const final = tokenizeOutbox(
      'Before.\n\n[[image: /media/web_x/1-a.png]]\n\nAfter the image.',
      true,
    );
    expect(final.source.startsWith(streamed.source)).toBe(true);
    expect(final.media).toEqual([{ kind: 'image', url: '/media/web_x/1-a.png' }]);
  });
  it('treats publication as a continuation, a rewrite as a rewrite', () => {
    const raw = 'Before.\n\n[[image: /home/u/a.png]]\n\nAfter [[ima';
    const final = 'Before.\n\n[[image: /media/web_x/1-a.png]]\n\nAfter the image.';
    expect(continuesSource(final, raw)).toBe(true);
    expect(continuesSource(final, tokenizeOutbox(raw, false).source)).toBe(true);
    expect(continuesSource('Rewritten. [[image: /media/a.png]]', raw)).toBe(false);
  });
});
