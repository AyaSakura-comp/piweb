import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { resolvePiSpawn } from './invoke.js';

export const MAX_SESSION_TITLE_GRAPHEMES = 10;

const TITLE_SYSTEM_PROMPT =
  'You create short conversation titles. Return only the title: no label, quotes, markdown, ' +
  'explanation, or final punctuation. Keep the user language and use at most 10 visible characters.';
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

function titlePrompt(firstPrompt: string): string {
  return (
    'Summarize this first user prompt as the session title. Output only the title.\n\n' +
    `<first_prompt>\n${firstPrompt.trim()}\n</first_prompt>`
  );
}

export interface GenerateSessionTitleOptions {
  bin?: string;
  cwd?: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Generate a title in an ephemeral pi process.
 *
 * --no-session is the key invariant: this auxiliary request never enters the
 * conversation being named and pi writes no reusable summary session. Project
 * context, extensions, skills, prompt templates, and tools are also disabled.
 */
export async function generateSessionTitle(
  firstPrompt: string,
  opts: GenerateSessionTitleOptions = {},
): Promise<string> {
  const args = [
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--thinking',
    'off',
    '--system-prompt',
    TITLE_SYSTEM_PROMPT,
    // Supplying an explicit empty append list prevents automatic discovery of
    // global or project .pi/APPEND_SYSTEM.md files.
    '--append-system-prompt',
    '',
  ];
  // PI_MODEL may be a gateway-only ref such as agy/..., which the pi CLI
  // cannot resolve. Use only the dedicated title override; otherwise let pi
  // select its own configured default.
  const model = opts.model ?? config.sessionTitleModel;
  if (model) args.push('--model', model);
  args.push('-p', titlePrompt(firstPrompt));

  const { bin, args: spawnArgs } = resolvePiSpawn(opts.bin ?? config.piBin, args);
  const cwd = opts.cwd ?? config.piCwd;
  const timeoutMs = opts.timeoutMs ?? config.sessionTitleTimeoutMs;

  logger.debug({ bin, cwd, promptLength: firstPrompt.length }, 'Generating one-shot session title');

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(bin, spawnArgs, {
      cwd,
      env: process.env,
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
        finish(new Error(detail || `pi title process exited with code ${code}`));
      } else {
        finish(
          undefined,
          normalizeSessionTitle(Buffer.concat(stdout).toString('utf8'), firstPrompt),
        );
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
