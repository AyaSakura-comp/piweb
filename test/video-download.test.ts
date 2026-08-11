import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVideoAttachment, downloadNameFromMediaUrl } from '../public/media-files.js';

type FakeEvent = { preventDefault: () => void };
type FakeListener = (event: FakeEvent) => void | Promise<void>;

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, FakeListener>();
  className = '';
  textContent = '';
  src = '';
  href = '';
  download = '';
  type = '';
  disabled = false;
  controls = false;
  playsInline = false;

  constructor(readonly tagName: string) {}

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: FakeListener): void {
    this.listeners.set(name, listener);
  }

  async emit(name: string): Promise<void> {
    await this.listeners.get(name)?.({ preventDefault: () => undefined });
  }
}

class FakeFile {
  constructor(
    readonly parts: BlobPart[],
    readonly name: string,
    readonly options: FilePropertyBag,
  ) {}
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

  it('uses a two-tap native file share in an iOS home-screen app without opening the MP4 URL', async () => {
    const shared: Array<{ files: FakeFile[]; title: string }> = [];
    let fetches = 0;
    const runtime = {
      navigator: {
        standalone: true,
        canShare: ({ files }: { files: FakeFile[] }) => files.length === 1,
        share: async (data: { files: FakeFile[]; title: string }) => {
          shared.push(data);
        },
      },
      fetch: async () => {
        fetches += 1;
        return {
          ok: true,
          blob: async () => new Blob(['video'], { type: 'video/mp4' }),
        };
      },
      File: FakeFile,
      alert: () => undefined,
    };
    const card = createVideoAttachment(
      '/media/web_demo/a1b2c3d4-clip.mp4',
      fakeDocument,
      runtime,
    ) as unknown as FakeElement;
    const save = card.children[1];

    expect(save.tagName).toBe('button');
    expect(save.href).toBe('');
    expect(save.type).toBe('button');
    expect(save.attributes.get('aria-label')).toBe('Save video clip.mp4');

    await save.emit('click');
    expect(fetches).toBe(1);
    expect(shared).toHaveLength(0);
    expect(save.textContent).toContain('Tap again');
    expect(save.attributes.get('aria-label')).toBe('Tap again to save clip.mp4');

    await save.emit('click');
    expect(fetches).toBe(1);
    expect(shared).toHaveLength(1);
    expect(shared[0].files[0].name).toBe('clip.mp4');
    expect(shared[0].files[0].options.type).toBe('video/mp4');
  });

  it('keeps iOS home-screen users in piweb when native file sharing is unavailable', async () => {
    const alerts: string[] = [];
    const runtime = {
      navigator: {
        standalone: true,
        canShare: () => false,
        share: async () => undefined,
      },
      fetch: async () => ({
        ok: true,
        blob: async () => new Blob(['video'], { type: 'video/mp4' }),
      }),
      File: FakeFile,
      alert: (message: string) => alerts.push(message),
    };
    const card = createVideoAttachment(
      '/media/web_demo/a1b2c3d4-clip.mp4',
      fakeDocument,
      runtime,
    ) as unknown as FakeElement;
    const save = card.children[1];

    await save.emit('click');

    expect(save.tagName).toBe('button');
    expect(save.href).toBe('');
    expect(alerts[0]).toContain('Safari');
  });
});

describe('video download styles', () => {
  it('keeps the player responsive and gives the download action a touch-sized target', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../public/app.css'), 'utf8');

    expect(css).toMatch(/\.video-file \{[^}]*max-width: min\(100%, 320px\)/);
    expect(css).toMatch(/\.video-download \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.video-download \{[^}]*width: 100%/);
    expect(css).toMatch(/\.video-download \{[^}]*border: 0/);
  });
});
