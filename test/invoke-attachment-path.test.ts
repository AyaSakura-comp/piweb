import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, downloadAttachmentsMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  downloadAttachmentsMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: spawnMock };
});

vi.mock('../src/session/media.js', () => ({
  downloadAttachments: downloadAttachmentsMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  Object.assign(process.env, originalEnv);
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('invokeAgent attachment paths', () => {
  it('passes non-image uploads as local paths without inlining their contents', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-invoke-document-'));
    tempDirs.push(tempDir);
    process.env.SESSIONS_DIR = join(tempDir, 'sessions');
    process.env.PI_BIN = 'pi';
    process.env.VOICE_ASR_ENABLED = 'false';

    const documentPath = join(tempDir, 'large-notes.txt');
    const documentContents = 'SECRET_DOCUMENT_CONTENT_SHOULD_NOT_BE_IN_PROMPT';
    writeFileSync(documentPath, documentContents);
    downloadAttachmentsMock.mockResolvedValue([
      { filePath: documentPath, originalName: 'large-notes.txt', size: documentContents.length },
    ]);
    spawnMock.mockImplementation(fakeSuccessfulPi);

    const { invokeAgent } = await import('../src/agent/invoke.js');
    await invokeAgent('web_document', '[Web user: Aya]\n請分析附件', {
      attachments: JSON.stringify([
        {
          url: `file://${documentPath}`,
          name: 'large-notes.txt',
          contentType: 'text/plain',
          size: documentContents.length,
        },
      ]),
    });

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const prompt = args[args.indexOf('-p') + 1];
    expect(args).not.toContain(`@${documentPath}`);
    expect(prompt).toContain(`[Uploaded file: ${documentPath}]`);
    expect(prompt).toContain('read tool');
    expect(prompt).not.toContain(documentContents);
  });

  it('passes Piweb audio uploads by path without injecting an ASR transcript', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-invoke-audio-'));
    tempDirs.push(tempDir);
    process.env.SESSIONS_DIR = join(tempDir, 'sessions');
    process.env.PI_BIN = 'pi';
    process.env.VOICE_ASR_ENABLED = 'true';
    process.env.VOICE_ASR_URL = 'http://127.0.0.1:8025';

    const audioPath = join(tempDir, 'meeting.mp3');
    writeFileSync(audioPath, Buffer.from('audio-data'));
    downloadAttachmentsMock.mockResolvedValue([
      { filePath: audioPath, originalName: 'meeting.mp3', size: 10 },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ text: 'TRANSCRIPT_MUST_NOT_BE_INJECTED' }))),
    );
    spawnMock.mockImplementation(fakeSuccessfulPi);

    const { invokeAgent } = await import('../src/agent/invoke.js');
    await invokeAgent('web_audio', '[Web user: Aya]\n處理音訊', {
      attachments: JSON.stringify([
        {
          url: `file://${audioPath}`,
          name: 'meeting.mp3',
          contentType: 'audio/mpeg',
          size: 10,
        },
      ]),
    });

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const prompt = args[args.indexOf('-p') + 1];
    expect(args).not.toContain(`@${audioPath}`);
    expect(prompt).toContain(`[Binary attachment: ${audioPath}]`);
    expect(prompt).not.toContain('TRANSCRIPT_MUST_NOT_BE_INJECTED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('continues passing image uploads through pi image attachment handling', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-invoke-image-'));
    tempDirs.push(tempDir);
    process.env.SESSIONS_DIR = join(tempDir, 'sessions');
    process.env.PI_BIN = 'pi';
    process.env.VOICE_ASR_ENABLED = 'false';

    const imagePath = join(tempDir, 'photo.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    downloadAttachmentsMock.mockResolvedValue([
      { filePath: imagePath, originalName: 'photo.png', size: 4 },
    ]);
    spawnMock.mockImplementation(fakeSuccessfulPi);

    const { invokeAgent } = await import('../src/agent/invoke.js');
    await invokeAgent('web_image', '[Web user: Aya]\n看圖片', {
      attachments: JSON.stringify([
        {
          url: `file://${imagePath}`,
          name: 'photo.png',
          contentType: 'image/png',
          size: 4,
        },
      ]),
    });

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain(`@${imagePath}`);
  });
});

function fakeSuccessfulPi() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  setImmediate(() => {
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'message_start', message: { role: 'assistant' } }) +
          '\n' +
          JSON.stringify({
            type: 'message_end',
            message: { content: [{ type: 'text', text: 'ok' }] },
          }) +
          '\n',
      ),
    );
    proc.emit('close', 0);
  });
  return proc;
}
