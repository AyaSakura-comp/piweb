import { describe, expect, it, vi } from 'vitest';
import { itemText, readClipboard } from '../public/clipboard-paste.js';

// A clipboard item as the async Clipboard API hands it out.
const item = (data: Record<string, string | Blob>) => ({
  types: Object.keys(data),
  getType: async (type: string) => (data[type] instanceof Blob ? data[type] : new Blob([data[type] as string])),
});

describe('the 貼上 button reads the clipboard once', () => {
  it('a link copied with Safari\'s share sheet (text/uri-list only) pastes as the link', async () => {
    // 2026-11-01, iPad: read() found no media, then readText() found no
    // text/plain, and the box said the clipboard was empty.
    const clipboard = {
      read: vi.fn(async () => [item({ 'text/uri-list': '# from Safari\r\nhttps://arxiv.org/abs/2510.00001\r\n' })]),
      readText: vi.fn(async () => ''),
    };
    expect(await readClipboard(clipboard)).toEqual({ media: [], text: 'https://arxiv.org/abs/2510.00001' });
    expect(clipboard.read).toHaveBeenCalledTimes(1);
    expect(clipboard.readText).not.toHaveBeenCalled(); // iOS would ask again
  });

  it('plain text comes first, then the link, then the words of the HTML', async () => {
    expect(await itemText(item({ 'text/uri-list': 'https://a.example', 'text/plain': '標題 https://a.example' }))).toBe(
      '標題 https://a.example',
    );
    const parse = (html: string) => html.replace(/<[^>]+>/g, '');
    expect(await itemText(item({ 'text/html': '<p>論文<b>摘要</b></p>' }), parse)).toBe('論文摘要');
    expect(await itemText(item({ 'text/rtf': '{\\rtf1}' }))).toBe('');
  });

  it('media is attached, not pasted as text', async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const clip = await readClipboard({ read: async () => [item({ 'image/png': png, 'text/uri-list': 'https://x' })] });
    expect(clip?.media).toEqual([{ blob: png, type: 'image/png' }]);
    expect(clip?.text).toBe('');
  });

  it('falls back to readText() when read() is refused, and is null without either', async () => {
    const clipboard = {
      read: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
      readText: vi.fn(async () => '文字'),
    };
    expect(await readClipboard(clipboard)).toEqual({ media: [], text: '文字' });
    expect(await readClipboard({})).toBeNull();
    expect(await readClipboard(undefined)).toBeNull();
  });
});
