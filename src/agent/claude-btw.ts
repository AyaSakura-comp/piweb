import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { resolveChannelSessionDir } from '../session/path.js';
import type { ThinkingLevel } from '../types.js';
import {
  AUTONOMOUS_SYSTEM_PROMPT,
  claudeEffort,
  claudeModelId,
  findClaudeTranscript,
  readClaudeTmuxState,
} from './claude-tmux.js';

/**
 * BTW for Claude Code sessions: Claude Code's own `/btw` side question.
 *
 * The TUI's `/btw` answers in a panel that is never written to the transcript,
 * and `-p "/btw …"` is refused ("/btw isn't available in this environment").
 * Its SDK form is: a headless `claude -p --input-format stream-json` that
 * resumes the session's conversation and receives a `side_question` control
 * request (`{ question, history }` → `{ response, synthetic }`, the request
 * the Agent SDK's `askSideQuestion()` sends). `--fork-session` plus
 * `--no-session-persistence` leave the main transcript and the running TUI
 * untouched, so a side question also works while the main turn is running.
 *
 * Claude keeps no side thread between processes; Piweb keeps it in the
 * session directory (`claude-btw.json`) and sends it back as `history`, so a
 * follow-up sees the earlier side answers. It belongs to one Claude
 * conversation: `/pi new` starts a new directory and a new conversation id.
 */

const STORE_FILE = 'claude-btw.json';
const REQUEST_ID = 'piweb-btw';

export interface ClaudeBtwEntry {
  question: string;
  response: string;
}

export interface ClaudeBtwThread {
  messages: { role: 'user' | 'assistant'; content: string }[];
  pending: string[];
  streaming: never[];
}

export interface ClaudeBtwDependencies {
  resolveSessionDir: (folder: string) => string;
  findTranscript: (sessionId: string) => string | undefined;
  claudeBin: string;
  timeoutMs: number;
}

const defaultDependencies: ClaudeBtwDependencies = {
  resolveSessionDir: resolveChannelSessionDir,
  findTranscript: findClaudeTranscript,
  claudeBin: config.claudeTmuxBin,
  // Below the web route's 610 s wait, so the error reaches the page.
  timeoutMs: 600_000,
};

/** Questions still being answered, per channel folder, in order. */
const pendingByFolder = new Map<string, string[]>();
/** One side question at a time per channel, so each sees the previous answer. */
const chainByFolder = new Map<string, Promise<unknown>>();

export function buildClaudeBtwArgs(options: {
  sessionId?: string;
  modelRef: string;
  thinking?: ThinkingLevel;
}): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (options.sessionId) args.push('--resume', options.sessionId, '--fork-session');
  args.push('--no-session-persistence');
  const model = claudeModelId(options.modelRef);
  if (model) args.push('--model', model);
  const effort = claudeEffort(options.thinking);
  if (effort) args.push('--effort', effort);
  // A side question runs no tools: no MCP servers to start, no hooks to fire.
  args.push(
    '--strict-mcp-config',
    '--no-chrome',
    '--settings',
    JSON.stringify({ remoteControlAtStartup: false, disableAllHooks: true }),
    '--append-system-prompt',
    AUTONOMOUS_SYSTEM_PROMPT,
  );
  return args;
}

function readEntries(sessionDir: string, sessionId: string): ClaudeBtwEntry[] {
  try {
    const value = JSON.parse(readFileSync(join(sessionDir, STORE_FILE), 'utf8'));
    if (value?.sessionId !== sessionId || !Array.isArray(value.entries)) return [];
    return value.entries.filter(
      (entry: any) => typeof entry?.question === 'string' && typeof entry?.response === 'string',
    );
  } catch {
    return [];
  }
}

function writeEntries(sessionDir: string, sessionId: string, entries: ClaudeBtwEntry[]): void {
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, STORE_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ sessionId, entries }, null, 2)}\n`, 'utf8');
  renameSync(`${file}.tmp`, file);
}

/** Send one side question to a headless Claude Code and return its answer. */
export function askClaudeSideQuestion(options: {
  bin: string;
  args: string[];
  cwd: string;
  question: string;
  history: ClaudeBtwEntry[];
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.bin, options.args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (error: Error | null, answer?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Closing its input ends the CLI; a hung one does not outlive the answer.
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }, 5_000).unref();
      if (error) reject(error);
      else resolve(answer!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('Claude BTW timed out'));
    }, options.timeoutMs);
    const handleLine = (line: string) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const response = message?.type === 'control_response' ? message.response : undefined;
      if (response?.request_id !== REQUEST_ID) return;
      if (response.subtype !== 'success') {
        finish(new Error(String(response.error || 'Claude BTW failed')));
        return;
      }
      const answer = response.response?.response;
      if (typeof answer !== 'string' || !answer.trim()) {
        finish(new Error('Claude did not answer the side question'));
      } else if (response.response.synthetic) {
        // A stand-in text, not the model's answer: show it as the error.
        finish(new Error(answer));
      } else {
        finish(null, answer);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        handleLine(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => finish(error));
    child.on('close', (code) =>
      finish(new Error(stderr.trim() || `Claude exited (${code}) before answering the side question`)),
    );
    child.stdin.write(
      `${JSON.stringify({
        type: 'control_request',
        request_id: REQUEST_ID,
        request: {
          subtype: 'side_question',
          question: options.question,
          ...(options.history.length ? { history: options.history } : {}),
        },
      })}\n`,
    );
  });
}

/** The BTW control for a Claude Code channel: same thread shape as pi-btw's. */
export async function claudeBtw(
  channelFolder: string,
  action: 'snapshot' | 'send' | 'clear',
  text: string | undefined,
  opts: {
    modelRef: string;
    thinking?: ThinkingLevel;
    cwd: string;
    dependencies?: ClaudeBtwDependencies;
  },
): Promise<ClaudeBtwThread> {
  const deps = opts.dependencies ?? defaultDependencies;
  const sessionDir = deps.resolveSessionDir(channelFolder);
  const conversation = () => readClaudeTmuxState(sessionDir);
  const snapshot = (): ClaudeBtwThread => ({
    messages: readEntries(sessionDir, conversation()?.sessionId ?? '').flatMap((entry) => [
      { role: 'user' as const, content: entry.question },
      { role: 'assistant' as const, content: entry.response },
    ]),
    pending: [...(pendingByFolder.get(channelFolder) ?? [])],
    streaming: [],
  });

  if (action === 'snapshot') return snapshot();
  if (action === 'clear') {
    if (pendingByFolder.get(channelFolder)?.length)
      throw new Error('Wait for the BTW answer before clearing');
    writeEntries(sessionDir, conversation()?.sessionId ?? '', []);
    return snapshot();
  }

  const question = (text ?? '').trim();
  if (!question) throw new Error('Empty BTW question');
  const pending = pendingByFolder.get(channelFolder) ?? [];
  pending.push(question);
  pendingByFolder.set(channelFolder, pending);
  const run = async () => {
    const current = conversation();
    const sessionId = current?.sessionId ?? '';
    // Before the first turn there is no conversation to resume yet.
    const resume = Boolean(sessionId && deps.findTranscript(sessionId));
    const history = readEntries(sessionDir, sessionId);
    const answer = await askClaudeSideQuestion({
      bin: deps.claudeBin,
      args: buildClaudeBtwArgs({
        sessionId: resume ? sessionId : undefined,
        modelRef: opts.modelRef,
        thinking: opts.thinking,
      }),
      // Claude finds a conversation by the project directory it was started in.
      cwd: current?.cwd || opts.cwd,
      question,
      history,
      timeoutMs: deps.timeoutMs,
    });
    writeEntries(sessionDir, sessionId, [...history, { question, response: answer }]);
  };
  const previous = chainByFolder.get(channelFolder) ?? Promise.resolve();
  const turn = previous.then(run, run);
  const settled = turn.catch(() => undefined);
  chainByFolder.set(channelFolder, settled);
  try {
    await turn;
  } finally {
    pending.splice(pending.indexOf(question), 1);
    if (!pending.length) pendingByFolder.delete(channelFolder);
    if (chainByFolder.get(channelFolder) === settled) chainByFolder.delete(channelFolder);
  }
  return snapshot();
}
