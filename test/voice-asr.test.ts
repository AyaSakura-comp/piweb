import { describe, expect, it, vi } from 'vitest';
import {
  appendVoiceTranscriptions,
  isVoiceAudioFile,
  transcribeVoiceFile,
} from '../src/discord/voice-asr.js';

describe('voice ASR helpers', () => {
  it('detects Discord voice-message audio files', () => {
    expect(isVoiceAudioFile({ originalName: 'voice-message.ogg', filePath: '/tmp/voice-message.ogg' })).toBe(true);
    expect(isVoiceAudioFile({ originalName: 'notes.txt', filePath: '/tmp/notes.txt' })).toBe(false);
  });

  it('replaces attachment-only prompts with voice transcriptions', () => {
    expect(
      appendVoiceTranscriptions('[Attachment-only message: 1 file attached.]', [
        { originalName: 'voice-message.ogg', text: '你可以幫我測試嗎' },
      ]),
    ).toBe('[Voice message transcription: voice-message.ogg]\n你可以幫我測試嗎');
  });

  it('appends voice transcriptions to typed text prompts', () => {
    expect(
      appendVoiceTranscriptions('請照這段做摘要', [
        { originalName: 'voice-message.ogg', text: '這是錄音內容' },
      ]),
    ).toBe('請照這段做摘要\n\n[Voice message transcription: voice-message.ogg]\n這是錄音內容');
  });

  it('posts audio files to the configured Breeze ASR endpoint', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ text: 'hello from audio' }), { status: 200 });
    });

    const text = await transcribeVoiceFile('/tmp/fake.ogg', {
      endpoint: 'http://127.0.0.1:8025',
      fetchImpl: fetchMock as typeof fetch,
      readFileImpl: async () => Buffer.from('ogg-data'),
    });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8025/transcribe', expect.any(Object));
    expect(text).toBe('hello from audio');
  });

  it('retries once after Breeze ASR returns a transient server error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'CUDA error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'recovered text' }), { status: 200 }));

    const text = await transcribeVoiceFile('/tmp/fake.ogg', {
      endpoint: 'http://127.0.0.1:8025',
      fetchImpl: fetchMock as typeof fetch,
      readFileImpl: async () => Buffer.from('ogg-data'),
      retries: 1,
      retryDelayMs: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(text).toBe('recovered text');
  });
});
