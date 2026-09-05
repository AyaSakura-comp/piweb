import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseOutboxMarkers, embedOutboxMediaUrls } from '../src/agent/outbox.js';

describe('outbox markers', () => {
  it('extracts existing files and returns cleaned text as well as rawText', () => {
    const tmp1 = join(tmpdir(), `test-outbox-1-${Date.now()}.png`);
    const tmp2 = join(tmpdir(), `test-outbox-2-${Date.now()}.jpg`);
    writeFileSync(tmp1, 'fake-png');
    writeFileSync(tmp2, 'fake-jpg');

    try {
      const raw = `Here are the files:\n\n[[image: ${tmp1}]]\n\nAnd another one:\n[[image: ${tmp2}]]\n\n[[image: /nonexistent/file.png]]`;
      const res = parseOutboxMarkers(raw);

      expect(res.files).toEqual([tmp1, tmp2]);
      expect(res.rawText).toBe(raw);
      expect(res.text).toBe('Here are the files:\n\nAnd another one:');
    } finally {
      try {
        unlinkSync(tmp1);
      } catch {}
      try {
        unlinkSync(tmp2);
      } catch {}
    }
  });

  it('embedOutboxMediaUrls replaces published paths and strips unpublished paths', () => {
    const published = new Map<string, string>([
      ['/tmp/photo1.jpg', '/media/web_life/abc-photo1.jpg'],
      ['/tmp/photo2.png', '/media/web_life/def-photo2.png'],
    ]);

    const raw = `Check this:
[[image: /tmp/photo1.jpg]]
And this:
[[image: /tmp/photo2.png]]
And missing:
[[image: /tmp/missing.png]]`;

    const embedded = embedOutboxMediaUrls(raw, published);

    expect(embedded).toBe(`Check this:
[[image: /media/web_life/abc-photo1.jpg]]
And this:
[[image: /media/web_life/def-photo2.png]]
And missing:`);
  });

  it('embedOutboxMediaUrls preserves already published or http URLs', () => {
    const published = new Map<string, string>();
    const text = 'See [[image: /media/existing.jpg]] and [[image: https://example.com/remote.png]]';
    expect(embedOutboxMediaUrls(text, published)).toBe(text);
  });
});
