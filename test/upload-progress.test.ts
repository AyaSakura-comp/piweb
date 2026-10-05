import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  hideUploadProgress,
  sendJsonWithUploadProgress,
  showUploadProgress,
} from '../public/upload-progress.js';

type Listener = (event?: { lengthComputable?: boolean; loaded?: number; total?: number }) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeRequest extends FakeEventTarget {
  readonly upload = new FakeEventTarget();
  method = '';
  path = '';
  async = false;
  withCredentials = false;
  headers = new Map<string, string>();
  sentBody = '';
  status = 200;
  responseText = '{"queued":true}';
  timeout = 0;

  open(method: string, path: string, async: boolean): void {
    this.method = method;
    this.path = path;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: string): void {
    this.sentBody = body;
  }
}

class FakeElement {
  hidden = true;
  textContent = '';
  style = { width: '' };
  attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

describe('sendJsonWithUploadProgress', () => {
  it('allows a slow upload to complete after more than two minutes', async () => {
    vi.useFakeTimers();
    try {
      const request = new FakeRequest();
      request.send = (body) => {
        request.sentBody = body;
        if (request.timeout > 0) {
          setTimeout(() => request.emit('timeout'), request.timeout);
        }
      };
      let settled = false;
      const result = sendJsonWithUploadProgress(
        '/api/messages',
        { attachments: [{ name: 'large.pdf', dataBase64: 'YWJj' }] },
        { createRequest: () => request, report: vi.fn() },
      ).then((value) => {
        settled = true;
        return value;
      });
      expect(request.timeout).toBe(300_000);
      await vi.advanceTimersByTimeAsync(121_000);
      expect(settled).toBe(false);
      request.emit('load');
      await expect(result).resolves.toEqual({ queued: true });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('rejects on the five-minute deadline and records the failure once', async () => {
    vi.useFakeTimers();
    try {
      const request = new FakeRequest();
      request.status = 0;
      request.send = () => {
        if (request.timeout > 0) setTimeout(() => request.emit('timeout'), request.timeout);
      };
      const report = vi.fn();
      const onProgress = vi.fn();
      const result = sendJsonWithUploadProgress(
        '/api/messages',
        {},
        {
          createRequest: () => request,
          report,
          onProgress,
        },
      );
      const rejected = expect(result).rejects.toThrow(/Upload timed out.*5 minutes/);
      await vi.advanceTimersByTimeAsync(300_000);
      await rejected;
      request.emit('error');
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', status: 0 }));
      expect(onProgress).not.toHaveBeenCalledWith(100);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('reports timings and sizes without attachment content or names', async () => {
    const request = new FakeRequest();
    const report = vi.fn();
    let clock = 100;
    const result = sendJsonWithUploadProgress(
      '/api/messages',
      {
        text: 'private',
        attachments: [{ name: 'secret.png', dataBase64: 'YWJj' }],
      },
      { createRequest: () => request, now: () => clock, report },
    );
    clock = 1100;
    request.upload.emit('load');
    clock = 1400;
    request.emit('load');
    await result;
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        fileBytes: 3,
        fileCount: 1,
        uploadMs: 1000,
        totalMs: 1300,
        status: 200,
        outcome: 'response',
      }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/private|secret|YWJj/);
  });

  it('records network failures without interfering with rejection', async () => {
    const request = new FakeRequest();
    const report = vi.fn();
    const result = sendJsonWithUploadProgress(
      '/api/messages',
      {},
      { createRequest: () => request, report },
    );
    request.emit('error');
    await expect(result).rejects.toThrow('Upload failed');
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', uploadMs: null }),
    );
  });
  it('uploads JSON with same-origin credentials and reports byte progress', async () => {
    const request = new FakeRequest();
    const onProgress = vi.fn();
    const result = sendJsonWithUploadProgress(
      '/api/sessions/one/messages',
      { text: 'look', attachments: [{ name: 'photo.png', dataBase64: 'abc' }] },
      { createRequest: () => request, onProgress },
    );

    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/sessions/one/messages');
    expect(request.async).toBe(true);
    expect(request.withCredentials).toBe(true);
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(request.sentBody)).toEqual({
      text: 'look',
      attachments: [{ name: 'photo.png', dataBase64: 'abc' }],
    });
    expect(onProgress).toHaveBeenCalledWith(0);

    request.upload.emit('progress', { lengthComputable: true, loaded: 3, total: 8 });
    expect(onProgress).toHaveBeenLastCalledWith(38);

    request.emit('load');
    await expect(result).resolves.toEqual({ queued: true });
    expect(onProgress).toHaveBeenLastCalledWith(100);
  });

  it('surfaces the server error and HTTP status', async () => {
    const request = new FakeRequest();
    request.status = 413;
    request.responseText = '{"error":"Attachment exceeds the size limit"}';

    const result = sendJsonWithUploadProgress(
      '/api/messages',
      {},
      {
        createRequest: () => request,
        onProgress: vi.fn(),
      },
    );
    request.emit('load');

    await expect(result).rejects.toMatchObject({
      message: 'Attachment exceeds the size limit',
      status: 413,
    });
  });

  it('preserves an HTTP error status when a proxy returns non-JSON', async () => {
    const request = new FakeRequest();
    request.status = 401;
    request.responseText = '<h1>Unauthorized</h1>';

    const result = sendJsonWithUploadProgress(
      '/api/messages',
      {},
      {
        createRequest: () => request,
      },
    );
    request.emit('load');

    await expect(result).rejects.toMatchObject({
      message: 'Request failed (401)',
      status: 401,
    });
  });
});

describe('upload progress UI', () => {
  it('shows an accessible percentage and resets when hidden', () => {
    const container = new FakeElement();
    const bar = new FakeElement();
    const percent = new FakeElement();

    showUploadProgress({ container, bar, percent }, 37.6);

    expect(container.hidden).toBe(false);
    expect(container.attributes.get('aria-valuenow')).toBe('38');
    expect(bar.style.width).toBe('38%');
    expect(percent.textContent).toBe('38%');

    hideUploadProgress({ container, bar, percent });

    expect(container.hidden).toBe(true);
    expect(container.attributes.get('aria-valuenow')).toBe('0');
    expect(bar.style.width).toBe('0%');
    expect(percent.textContent).toBe('0%');
  });

  it('includes a labelled progressbar in the composer', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../public/index.html'), 'utf8');

    expect(html).toMatch(
      /id="upload-progress"[^>]*role="progressbar"[^>]*aria-label="Uploading attachments"/,
    );
    expect(html).toContain('id="upload-progress-bar"');
    expect(html).toContain('id="upload-progress-percent"');
  });

  it('lets iPhone Files select documents even when iOS reports an unexpected MIME type', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../public/index.html'), 'utf8');
    const fileInput = html.match(/<input[^>]*id="file-input"[^>]*>/)?.[0] ?? '';

    expect(fileInput).toContain('type="file"');
    expect(fileInput).toContain('multiple');
    expect(fileInput).not.toContain('accept=');
  });

  it('connects attachment sends to the progress request and visible bar styles', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');
    const css = readFileSync(resolve(import.meta.dirname, '../public/app.css'), 'utf8');

    expect(app).toContain("from './upload-progress.js'");
    expect(app).toContain('sendJsonWithUploadProgress(');
    expect(css).toMatch(/\.upload-progress-track \{[^}]*overflow: hidden/);
    expect(css).toMatch(/\.upload-progress-bar \{[^}]*width: 0/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.upload-progress-bar \{[^}]*transition: none/,
    );
  });
});
