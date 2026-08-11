import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVideoAttachment, downloadNameFromMediaUrl } from '../public/media-files.js';

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  className = '';
  textContent = '';
  src = '';
  href = '';
  download = '';
  controls = false;
  playsInline = false;

  constructor(readonly tagName: string) {}

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

const fakeDocument = {
  createElement: (tagName: string) => new FakeElement(tagName),
};

describe('downloadNameFromMediaUrl', () => {
  it('restores the original video name from a stored media URL', () => {
    expect(downloadNameFromMediaUrl('/media/web_demo/a1b2c3d4-my_video.mp4')).toBe('my_video.mp4');
  });

  it('decodes names and ignores query strings or fragments', () => {
    expect(downloadNameFromMediaUrl('/media/demo/a1b2c3d4-night%20walk.mov?x=1#preview')).toBe(
      'night walk.mov',
    );
  });
});

describe('createVideoAttachment', () => {
  it('renders an inline player with an accessible same-origin download action', () => {
    const card = createVideoAttachment(
      '/media/web_demo/a1b2c3d4-clip.mp4',
      fakeDocument,
    ) as unknown as FakeElement;

    expect(card.className).toBe('video-file');
    const [video, download] = card.children;
    expect(video.tagName).toBe('video');
    expect(video.src).toBe('/media/web_demo/a1b2c3d4-clip.mp4');
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);

    expect(download.tagName).toBe('a');
    expect(download.className).toBe('video-download');
    expect(download.href).toBe('/media/web_demo/a1b2c3d4-clip.mp4');
    expect(download.download).toBe('clip.mp4');
    expect(download.textContent).toContain('Download video');
    expect(download.attributes.get('aria-label')).toBe('Download video clip.mp4');
  });
});

describe('video download styles', () => {
  it('keeps the player responsive and gives the download action a touch-sized target', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../public/app.css'), 'utf8');

    expect(css).toMatch(/\.video-file \{[^}]*max-width: min\(100%, 320px\)/);
    expect(css).toMatch(/\.video-download \{[^}]*min-height: 44px/);
  });
});
