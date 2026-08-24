import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMediaViewer } from '../public/media-files.js';

type FakeEvent = {
  target: FakeElement;
  key?: string;
  shiftKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
};
type FakeListener = (event: FakeEvent) => void | Promise<void>;

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, FakeListener>();
  readonly style = { overflow: '' };
  className = '';
  textContent = '';
  src = '';
  href = '';
  download = '';
  type = '';
  title = '';
  hidden = false;
  controls = false;
  playsInline = false;
  preload = '';
  pauseCalls = 0;
  loadCalls = 0;
  focusCalls = 0;

  constructor(readonly tagName: string) {}

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
    this.attributes.delete(name);
  }

  addEventListener(name: string, listener: FakeListener): void {
    this.listeners.set(name, listener);
  }

  async emit(name: string, init: Partial<FakeEvent> = {}): Promise<void> {
    await this.listeners.get(name)?.({
      target: init.target ?? this,
      key: init.key,
      shiftKey: init.shiftKey,
      preventDefault: init.preventDefault ?? (() => undefined),
      stopPropagation: init.stopPropagation ?? (() => undefined),
    });
  }

  focus(): void {
    this.focusCalls += 1;
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  load(): void {
    this.loadCalls += 1;
  }
}

function findByClass(root: FakeElement, className: string): FakeElement {
  if (root.className.split(' ').includes(className)) return root;
  for (const child of root.children) {
    try {
      return findByClass(child, className);
    } catch {
      // Search the next branch.
    }
  }
  throw new Error(`Missing .${className}`);
}

function createFakeDocument() {
  const body = new FakeElement('body');
  return {
    baseURI: 'https://piweb.local/',
    body,
    activeElement: body,
    createElement: (tagName: string) => new FakeElement(tagName),
  };
}

class FakeFile {
  constructor(
    readonly parts: BlobPart[],
    readonly name: string,
    readonly options: FilePropertyBag,
  ) {}
}

describe('createMediaViewer', () => {
  it('opens a gallery video in an in-app player with a top download icon', () => {
    const doc = createFakeDocument();
    const viewer = createMediaViewer(doc) as unknown as {
      element: FakeElement;
      open: (item: { type: string; url: string; name: string }) => void;
    };

    doc.body.append(viewer.element);
    viewer.open({
      type: 'video',
      url: '/media/web_demo/a1b2c3d4-demo-loop.webm',
      name: 'a1b2c3d4-demo-loop.webm',
    });

    const video = findByClass(viewer.element, 'media-player-video');
    const audio = findByClass(viewer.element, 'media-player-audio');
    const download = findByClass(viewer.element, 'media-player-download');

    expect(viewer.element.hidden).toBe(false);
    expect(viewer.element.attributes.get('role')).toBe('dialog');
    expect(viewer.element.attributes.get('aria-modal')).toBe('true');
    expect(video.hidden).toBe(false);
    expect(video.src).toBe('/media/web_demo/a1b2c3d4-demo-loop.webm');
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(audio.hidden).toBe(true);
    expect(download.tagName).toBe('a');
    expect(download.href).toBe('/media/web_demo/a1b2c3d4-demo-loop.webm');
    expect(download.download).toBe('demo-loop.webm');
    expect(download.attributes.get('aria-label')).toBe('Download video demo-loop.webm');
    expect(download.children[0].tagName).toBe('svg');
    expect(doc.body.style.overflow).toBe('hidden');
  });

  it('rejects executable and cross-origin media URLs', () => {
    const doc = createFakeDocument();
    const viewer = createMediaViewer(doc) as unknown as {
      element: FakeElement;
      open: (item: { type: string; url: string; name: string }) => boolean;
    };

    expect(viewer.open({ type: 'audio', url: 'javascript:alert(1).mp3', name: 'bad.mp3' })).toBe(
      false,
    );
    expect(
      viewer.open({ type: 'video', url: 'https://evil.example/trap.webm', name: 'trap.webm' }),
    ).toBe(false);
    expect(viewer.element.hidden).toBe(true);
    expect(findByClass(viewer.element, 'media-player-download').href).toBe('');
  });

  it('moves focus into the modal and restores the originating tile when closed', () => {
    const doc = createFakeDocument();
    const opener = new FakeElement('button');
    const viewer = createMediaViewer(doc) as unknown as {
      element: FakeElement;
      open: (item: { type: string; url: string; name: string }, opener?: FakeElement) => boolean;
      close: () => void;
    };

    viewer.open(
      { type: 'audio', url: '/fixtures/media/demo-tone.mp3', name: 'demo-tone.mp3' },
      opener,
    );

    expect(findByClass(viewer.element, 'media-player-close').focusCalls).toBe(1);
    viewer.close();
    expect(opener.focusCalls).toBe(1);
  });

  it('uses native file sharing instead of a raw-file link in an iOS home-screen app', async () => {
    const doc = createFakeDocument();
    const shared: Array<{ files: FakeFile[]; title: string }> = [];
    const runtime = {
      navigator: {
        standalone: true,
        canShare: ({ files }: { files: FakeFile[] }) => files.length === 1,
        share: async (data: { files: FakeFile[]; title: string }) => shared.push(data),
      },
      fetch: async () => ({
        ok: true,
        blob: async () => new Blob(['audio'], { type: 'audio/mpeg' }),
      }),
      File: FakeFile,
      alert: () => undefined,
    };
    const viewer = createMediaViewer(doc, runtime) as unknown as {
      element: FakeElement;
      open: (item: { type: string; url: string; name: string }) => boolean;
    };
    viewer.open({ type: 'audio', url: '/media/web_demo/a1b2c3d4-song.mp3', name: 'song.mp3' });
    const save = findByClass(viewer.element, 'media-player-download');

    expect(save.tagName).toBe('button');
    expect(save.href).toBe('');
    await save.emit('click');
    expect(save.attributes.get('data-ready')).toBe('true');
    expect(shared).toHaveLength(0);
    await save.emit('click');
    expect(shared).toHaveLength(1);
    expect(shared[0].files[0].name).toBe('song.mp3');
  });

  it('switches to an audio player and releases media when closed', () => {
    const doc = createFakeDocument();
    const viewer = createMediaViewer(doc) as unknown as {
      element: FakeElement;
      open: (item: { type: string; url: string; name: string }) => void;
      close: () => void;
    };
    const video = findByClass(viewer.element, 'media-player-video');
    const audio = findByClass(viewer.element, 'media-player-audio');

    viewer.open({ type: 'video', url: '/fixtures/media/demo-loop.webm', name: 'loop.webm' });
    viewer.open({ type: 'audio', url: '/fixtures/media/demo-tone.mp3', name: 'demo-tone.mp3' });

    expect(video.hidden).toBe(true);
    expect(video.src).toBe('');
    expect(video.pauseCalls).toBeGreaterThan(0);
    expect(audio.hidden).toBe(false);
    expect(audio.src).toBe('/fixtures/media/demo-tone.mp3');
    expect(audio.controls).toBe(true);
    expect(findByClass(viewer.element, 'media-player-download').attributes.get('aria-label')).toBe(
      'Download audio demo-tone.mp3',
    );

    viewer.close();

    expect(viewer.element.hidden).toBe(true);
    expect(audio.src).toBe('');
    expect(audio.pauseCalls).toBeGreaterThan(0);
    expect(doc.body.style.overflow).toBe('');
  });
});

describe('media gallery player integration', () => {
  it('routes video and audio tiles to the in-app viewer instead of a new original-file tab', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');

    expect(app).toContain('mediaViewer.open(item, tile)');
    expect(app).not.toContain("window.open(item.url, '_blank', 'noopener')");
  });

  it('keeps the player and its top actions inside a mobile-safe fixed surface', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../public/app.css'), 'utf8');

    expect(css).toMatch(/\.media-player \{[^}]*position: fixed;[^}]*z-index: 61;/s);
    expect(css).toMatch(/\.media-player-bar \{[^}]*display: flex;/s);
    expect(css).toMatch(/\.media-player-download \{[^}]*width: 44px;[^}]*height: 44px;/s);
    expect(css).toMatch(/\.media-player-(?:video|audio)[^{]*\{[^}]*max-width: 100%;/s);
  });
});
