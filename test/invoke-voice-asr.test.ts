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
  return {
    ...actual,
    spawn: spawnMock,
  };
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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('invokeAgent voice ASR integration', () => {
  it('transcribes downloaded Discord voice attachments before prompting pi', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-invoke-voice-'));
    tempDirs.push(tempDir);
    process.env.SESSIONS_DIR = join(tempDir, 'sessions');
    process.env.PI_BIN = 'pi';
    process.env.VOICE_ASR_ENABLED = 'true';
    process.env.VOICE_ASR_URL = 'http://127.0.0.1:8025';

    const voicePath = join(tempDir, 'voice-message.ogg');
    writeFileSync(voicePath, Buffer.from('ogg-data'));
    downloadAttachmentsMock.mockResolvedValue([
      { filePath: voicePath, originalName: 'voice-message.ogg', size: 1234 },
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ text: '這是語音轉文字內容' }), { status: 200 })),
    );

    spawnMock.mockImplementation(() => {
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
    });

    const { invokeAgent } = await import('../src/agent/invoke.js');
    const result = await invokeAgent('ch_voice', '[Discord user: Aya]\n[Attachment-only message: 1 file attached.]', {
      attachments: JSON.stringify([
        {
          url: 'https://discord.example/voice-message.ogg',
          name: 'voice-message.ogg',
          contentType: 'audio/ogg',
          size: 1234,
        },
      ]),
    });

    expect(result).toEqual({ ok: true, text: 'ok' });
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt).toContain('[Voice message transcription: voice-message.ogg]');
    expect(prompt).toContain('這是語音轉文字內容');
    expect(prompt).not.toContain('[Attachment-only message: 1 file attached.]');
    expect(args).not.toContain(`@${voicePath}`);
  });
});
