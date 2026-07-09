import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export interface VoiceAudioFile {
  filePath: string;
  originalName: string;
}

export interface VoiceTranscription {
  filePath: string;
  originalName: string;
  text: string;
}

export interface VoiceAsrOptions {
  endpoint: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  readFileImpl?: (path: string) => Promise<Buffer>;
}

const AUDIO_EXTENSIONS = new Set(['.ogg', '.opus', '.wav', '.mp3', '.m4a', '.webm', '.flac', '.aac']);

export function isVoiceAudioFile(file: VoiceAudioFile): boolean {
  const name = file.originalName || basename(file.filePath);
  const ext = extname(name || file.filePath).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

export function appendVoiceTranscriptions(
  userText: string,
  transcriptions: VoiceTranscription[],
): string {
  if (transcriptions.length === 0) return userText;

  const block = transcriptions
    .map(({ originalName, text }) => `[Voice message transcription: ${originalName}]\n${text}`)
    .join('\n\n');

  const attachmentOnlyPattern = /\n?\[Attachment-only message: \d+ files? attached\.\]/;
  if (attachmentOnlyPattern.test(userText)) {
    return userText.replace(attachmentOnlyPattern, `\n${block}`).trim();
  }

  return `${userText}\n\n${block}`;
}

export async function transcribeVoiceFile(filePath: string, opts: VoiceAsrOptions): Promise<string> {
  const endpoint = opts.endpoint.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readFileImpl = opts.readFileImpl ?? readFile;
  const timeoutSignal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  const signal = combineSignals(opts.signal, timeoutSignal);

  const bytes = await readFileImpl(filePath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), basename(filePath));

  const maxAttempts = (opts.retries ?? 0) + 1;
  let response: Response | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    response = await fetchImpl(`${endpoint}/transcribe`, {
      method: 'POST',
      body: form,
      signal,
    });

    if (response.ok || response.status < 500 || attempt === maxAttempts) {
      break;
    }

    await sleep(opts.retryDelayMs ?? 1000, signal);
  }

  if (!response?.ok) {
    throw new Error(`Breeze ASR request failed with status ${response?.status ?? 'unknown'}`);
  }

  const body = (await response.json()) as { text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    throw new Error('Breeze ASR response did not contain text');
  }
  return text;
}

export async function transcribeVoiceFiles(
  files: VoiceAudioFile[],
  opts: VoiceAsrOptions,
): Promise<VoiceTranscription[]> {
  const transcriptions: VoiceTranscription[] = [];

  for (const file of files) {
    if (!isVoiceAudioFile(file)) continue;
    const text = await transcribeVoiceFile(file.filePath, opts);
    transcriptions.push({
      filePath: file.filePath,
      originalName: file.originalName || basename(file.filePath),
      text,
    });
  }

  return transcriptions;
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];
  return AbortSignal.any(activeSignals);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new Error('Breeze ASR retry aborted');

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Breeze ASR retry aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  });
}
