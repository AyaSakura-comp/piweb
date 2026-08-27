import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const MAX_SESSION_TITLE_GRAPHEMES = 10;

const TITLE_SYSTEM_PROMPT =
  'You create short conversation titles in the user language. Summarize the user message as a ' +
  'noun phrase with at most 10 visible characters. Keep the user language and writing system. ' +
  'Return only the title: no label, quotes, markdown, explanation, or final punctuation. ' +
  'Example: 如何部署網站？ → 網站部署';
const SESSION_TITLE_KILL_GRACE_MS = 250;

function graphemes(value: string): string[] {
  return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value)].map(
    (part) => part.segment,
  );
}

function cleanTitleCandidate(value: string): string {
  const firstUsefulLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line && !/^```/u.test(line));

  return (firstUsefulLine ?? '')
    .replace(/^(?:title|session title|標題|标题)\s*[:：]\s*/iu, '')
    .replace(/^#+\s*/u, '')
    .replace(/^[`*_"'「『【《〈]+/u, '')
    .replace(/[`*_"'」』】》〉]+$/u, '')
    .replace(/[。.!！?？:：;；,，]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Normalize untrusted model output and enforce the ten-visible-character contract. */
export function normalizeSessionTitle(output: string, firstPrompt: string): string {
  const generated = cleanTitleCandidate(output);
  const fallback = cleanTitleCandidate(firstPrompt) || 'New session';
  return graphemes(generated || fallback)
    .slice(0, MAX_SESSION_TITLE_GRAPHEMES)
    .join('');
}

function escapeChatMl(value: string): string {
  return value.replace(/<\|/gu, '＜|');
}

function titlePrompt(firstPrompt: string): string {
  return (
    `<|im_start|>system\n${TITLE_SYSTEM_PROMPT}<|im_end|>\n` +
    `<|im_start|>user\n${escapeChatMl(firstPrompt.trim())}<|im_end|>\n` +
    '<|im_start|>assistant\n'
  );
}

export interface GenerateSessionTitleOptions {
  bin?: string;
  modelPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Generate a title in an ephemeral CPU-only llama.cpp process.
 *
 * The helper loads a dedicated tiny GGUF with GPU offload disabled, receives no
 * provider credentials or network tools, and exits after one generation. Its
 * private KV cache is freed without sharing the conversation model's KV state.
 */
export async function generateSessionTitle(
  firstPrompt: string,
  opts: GenerateSessionTitleOptions = {},
): Promise<string> {
  const bin = opts.bin ?? config.sessionTitleBin;
  const modelPath = opts.modelPath ?? config.sessionTitleModelPath;
  if (!bin) throw new Error('SESSION_TITLE_BIN is required for CPU session titles');
  if (!modelPath) throw new Error('SESSION_TITLE_MODEL_PATH is required for CPU session titles');

  // Node replaces unpaired UTF-16 surrogates while encoding argv. Compare
  // against that exact canonical UTF-8 form rather than an unspawnable string.
  const prompt = Buffer.from(titlePrompt(firstPrompt), 'utf8').toString('utf8');
  const spawnArgs = ['-m', modelPath, '-n', '32', '-ngl', '0', prompt];
  const timeoutMs = opts.timeoutMs ?? config.sessionTitleTimeoutMs;

  logger.debug(
    { bin, modelPath, promptLength: firstPrompt.length },
    'Generating one-shot CPU session title',
  );

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(bin, spawnArgs, {
      env: {
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let closed = false;
    let terminationError: Error | undefined;
    let killTimeout: NodeJS.Timeout | undefined;

    const onStdout = (chunk: Buffer) => stdout.push(chunk);
    const onStderr = (chunk: Buffer) => stderr.push(chunk);
    const onAbort = () => {
      terminate(new Error('Session title generation aborted'));
    };
    const finish = (error?: Error, title?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      opts.signal?.removeEventListener('abort', onAbort);
      proc.stdout.off('data', onStdout);
      proc.stderr.off('data', onStderr);
      proc.off('error', onError);
      proc.off('close', onClose);
      if (error) reject(error);
      else resolve(title!);
    };
    const signalChild = (signal: NodeJS.Signals) => {
      try {
        proc.kill(signal);
      } catch {
        // The child already exited between the deadline and the signal.
      }
    };
    function terminate(error: Error): void {
      if (settled || closed || terminationError) return;
      terminationError = error;
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
      signalChild('SIGTERM');
      killTimeout = setTimeout(() => {
        killTimeout = undefined;
        if (!closed) signalChild('SIGKILL');
      }, SESSION_TITLE_KILL_GRACE_MS);
    }
    const onError = (error: Error) => terminate(error);
    const onClose = (code: number | null) => {
      closed = true;
      if (terminationError) {
        finish(terminationError);
      } else if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        finish(new Error(detail || `CPU title process exited with code ${code}`));
      } else {
        const output = Buffer.concat(stdout).toString('utf8');
        if (!output.startsWith(prompt)) {
          finish(new Error('CPU title process did not echo the expected prompt'));
        } else {
          finish(undefined, normalizeSessionTitle(output.slice(prompt.length), firstPrompt));
        }
      }
    };

    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);
    proc.on('error', onError);
    proc.on('close', onClose);

    const timeout = setTimeout(() => {
      terminate(new Error(`Session title generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
