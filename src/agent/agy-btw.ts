import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ensureFreshAgyToken } from '../agy-usage.js';
import { config } from '../config.js';
import { resolveChannelSessionDir } from '../session/path.js';
import type { ThinkingLevel } from '../types.js';
import {
  EFFORT_BY_THINKING,
  agyModelId,
  modelIdEncodesEffort,
  readAgyConversationId,
} from './agy.js';

/**
 * BTW for AGY sessions: agy's own `/btw` side question.
 *
 * agy (1.5.x) answers `/btw` only in its TUI: print mode refuses it ("/btw is
 * not available in print mode"), and `agy acp` and `-i "/btw …"` send it to the
 * main conversation as an ordinary message. In the TUI, `/btw <question>`
 * forks the conversation into a side conversation (a copy of the history, a
 * side-question boundary and a read-only guardrail prompt), answers there and
 * never writes to the main one; the fork is deleted when the TUI exits.
 *
 * So each question opens the session's conversation in a TUI on a private
 * tmux server and pastes `/btw <question>` into it. The TUI's own log
 * (`--log-file`) names the fork when its answer starts ("Starting conversation
 * update stream for <fork>") and when it ends ("Stream goroutine exited for
 * <fork>"). The answer is then read from the fork through `agy acp`
 * `session/load`, which replays a conversation's messages, before the TUI is
 * closed. Nothing is typed into the main conversation, so this also works while
 * a main turn is running (the TUI only warns that the conversation is open
 * elsewhere).
 *
 * agy keeps no side thread between TUIs; Piweb keeps it in the session
 * directory (`agy-btw.json`) and puts the earlier side questions and answers in
 * front of a follow-up. It belongs to one agy conversation. Before the first
 * turn there is none, and agy's /btw fails there too ("plan model not
 * specified"), so the question is refused instead of answered out of context.
 */

const STORE_FILE = 'agy-btw.json';
/** A private tmux server: never the user's sessions or the Claude Code bridge's. */
const TMUX_SOCKET = 'piweb-agy-btw';
/** The TUI's status line once it takes input. */
const READY_MARKER = '? for shortcuts';
/** Earlier side questions and answers repeated in front of a follow-up, at most. */
const HISTORY_BUDGET = 12_000;
const HISTORY_ANSWER_MAX = 4_000;

export interface AgyBtwEntry {
  question: string;
  response: string;
}

export interface AgyBtwThread {
  messages: { role: 'user' | 'assistant'; content: string }[];
  pending: string[];
  streaming: never[];
}

export interface AgySideQuestion {
  conversationId: string;
  modelRef: string;
  thinking?: ThinkingLevel;
  cwd: string;
  /** What follows `/btw ` in the TUI. */
  prompt: string;
}

export interface AgyBtwRuntime {
  agyBin: string;
  tmuxBin: string;
  tmuxSocket: string;
  /** From the paste to the answer. */
  timeoutMs: number;
  /** From launch to the TUI taking input, and from Enter to the side question starting. */
  startTimeoutMs: number;
  pollMs: number;
}

export interface AgyBtwDependencies {
  resolveSessionDir: (folder: string) => string;
  readConversationId: (folder: string) => string | undefined;
  ask: (request: AgySideQuestion) => Promise<string>;
}

const defaultRuntime = (): AgyBtwRuntime => ({
  agyBin: config.agyBin,
  tmuxBin: config.agyTmuxBin,
  tmuxSocket: TMUX_SOCKET,
  // Below the web route's 610 s wait, so the error reaches the page.
  timeoutMs: 570_000,
  startTimeoutMs: 15_000,
  pollMs: 200,
});

const defaultDependencies: AgyBtwDependencies = {
  resolveSessionDir: (folder) => resolveChannelSessionDir(folder),
  readConversationId: (folder) => readAgyConversationId(folder),
  ask: async (request) => {
    await ensureFreshAgyToken().catch(() => undefined);
    return askAgySideQuestion(request, defaultRuntime());
  },
};

/** Questions still being answered, per channel folder, in order. */
const pendingByFolder = new Map<string, string[]>();
/** One side question at a time per channel, so each sees the previous answer. */
const chainByFolder = new Map<string, Promise<unknown>>();
let tuiCount = 0;

/** The TUI command line: the session's conversation, model and effort. */
export function buildAgyBtwTuiArgs(options: {
  conversationId: string;
  modelRef: string;
  thinking?: ThinkingLevel;
  cwd: string;
  logFile: string;
}): string[] {
  const args = ['--conversation', options.conversationId];
  const model = options.modelRef ? agyModelId(options.modelRef) : '';
  if (model) args.push('--model', model);
  const effort = options.thinking ? EFFORT_BY_THINKING[options.thinking] : undefined;
  if (effort && !modelIdEncodesEffort(model)) args.push('--effort', effort);
  args.push('--log-file', options.logFile);
  // The TUI stops at "Do you trust the contents of this project?" in a folder
  // it has not been told to trust; --settings applies to this run and is never saved.
  args.push('--settings', JSON.stringify({ trustedWorkspaces: [options.cwd] }));
  return args;
}

/**
 * The text pasted after `/btw `: the earlier side questions of this thread
 * (newest kept first within the budget, shown oldest first), then the question.
 * Control characters are dropped so the text cannot end the bracketed paste.
 */
export function agySideQuestionPrompt(question: string, history: AgyBtwEntry[]): string {
  const clean = (text: string) =>
    text
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .trim();
  const kept: string[] = [];
  let used = 0;
  for (const entry of [...history].reverse()) {
    const answer = clean(entry.response);
    const block = `Q: ${clean(entry.question)}\nA: ${
      answer.length > HISTORY_ANSWER_MAX ? `${answer.slice(0, HISTORY_ANSWER_MAX)}…` : answer
    }`;
    if (used + block.length > HISTORY_BUDGET) break;
    kept.unshift(block);
    used += block.length;
  }
  if (!kept.length) return clean(question);
  return (
    'Earlier side questions in this /btw thread (not part of the main conversation), oldest first:\n\n' +
    `${kept.join('\n\n')}\n\nNew side question:\n${clean(question)}`
  );
}

/** The replayed messages after the last user message: the side answer. */
export function sideAnswerFromReplay(
  messages: { role: 'user' | 'assistant'; text: string }[],
): string {
  const lastQuestion = messages.map((message) => message.role).lastIndexOf('user');
  return messages
    .slice(lastQuestion + 1)
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function run(bin: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { encoding: 'utf8', timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read a conversation's messages through `agy acp`: `session/load` replays
 * them as `session/update` notifications before it returns.
 */
export function replayAgyConversation(options: {
  bin: string;
  conversationId: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.bin, ['acp'], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages: { role: 'user' | 'assistant'; text: string }[] = [];
    const waiting = new Map<number, (message: any) => void>();
    let nextId = 1;
    let settled = false;
    let stderr = '';
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }, 2_000).unref();
      if (error) reject(error);
      else resolve(messages);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('agy acp did not replay the side question in time'));
    }, options.timeoutMs);
    const call = (method: string, params: unknown) =>
      new Promise<any>((done, fail) => {
        const id = nextId++;
        waiting.set(id, (message) =>
          message.error ? fail(new Error(message.error.message || method)) : done(message.result),
        );
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && !message.method) {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      } else if (message.id !== undefined && message.method) {
        // Nothing to grant while replaying.
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported' } })}\n`,
        );
      } else if (
        message.method === 'session/update' &&
        message.params?.sessionId === options.conversationId
      ) {
        const update = message.params.update;
        const text = update?.content?.type === 'text' ? String(update.content.text ?? '') : '';
        const role =
          update?.sessionUpdate === 'user_message_chunk'
            ? 'user'
            : update?.sessionUpdate === 'agent_message_chunk'
              ? 'assistant'
              : undefined;
        if (role) messages.push({ role, text });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(new Error(stderr.trim() || `agy acp exited (${code})`)));
    void (async () => {
      try {
        await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
        await call('session/load', {
          sessionId: options.conversationId,
          cwd: options.cwd,
          mcpServers: [],
        });
        await call('session/close', { sessionId: options.conversationId }).catch(() => undefined);
        finish(null);
      } catch (error: any) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

/** Ask agy's own /btw in a TUI beside the session's conversation and return the answer. */
export async function askAgySideQuestion(
  request: AgySideQuestion,
  runtime: AgyBtwRuntime,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'piweb-agy-btw-'));
  const logFile = join(dir, 'agy.log');
  const name = `btw-${process.pid}-${++tuiCount}`;
  // -f /dev/null: the private server does not load the user's tmux.conf.
  const tmux = (args: string[], input?: string) =>
    run(runtime.tmuxBin, ['-L', runtime.tmuxSocket, '-f', '/dev/null', ...args], input);
  const screen = () => tmux(['capture-pane', '-p', '-J', '-t', name]).catch(() => '');
  const log = () => {
    try {
      return readFileSync(logFile, 'utf8');
    } catch {
      return '';
    }
  };
  const lastLines = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6)
      .join(' / ');
  const waitFor = async <T>(
    probe: () => Promise<T | undefined>,
    ms: number,
    failure: () => Promise<string>,
  ) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(await failure());
      await sleep(runtime.pollMs);
    }
  };
  // What the TUI showed, else (a process that exits at once can take its last
  // output with it) the error lines of its own log.
  const failure = async (prefix: string) => {
    const shown = lastLines((await screen()).replace(/^Pane is dead.*$/gm, ''));
    const logged = log()
      .split('\n')
      .filter((line) => /^[EF]\d{4} /.test(line))
      .slice(-2)
      .map((line) => line.replace(/^\S+ \S+\s+\d+ \S+\] /, ''))
      .join(' / ');
    return `${prefix}：${shown || logged || '（沒有輸出）'}`;
  };
  const dead = async () =>
    (await tmux(['display-message', '-p', '-t', name, '#{pane_dead}']).catch(() => '1')).trim() ===
    '1';

  try {
    // remain-on-exit keeps a TUI that exits at once on screen for the error.
    // `timeout` ends a TUI orphaned by a worker restart; --foreground keeps it
    // the terminal's foreground process so it can read its input.
    await tmux([
      'start-server',
      ';',
      'set-option',
      '-g',
      'remain-on-exit',
      'on',
      ';',
      'new-session',
      '-d',
      '-s',
      name,
      '-x',
      '120',
      '-y',
      '50',
      '-c',
      request.cwd,
      'timeout',
      '--foreground',
      String(Math.ceil((runtime.timeoutMs + 2 * runtime.startTimeoutMs) / 1000) + 30),
      runtime.agyBin,
      ...buildAgyBtwTuiArgs({ ...request, logFile }),
    ]);
    await waitFor(
      async () => {
        if ((await screen()).includes(READY_MARKER)) return true;
        if (await dead()) throw new Error(await failure('agy 沒有開起來'));
        return undefined;
      },
      runtime.startTimeoutMs,
      () => failure('agy 沒有準備好接受 /btw'),
    );

    // A bracketed paste keeps the question's newlines from sending it early.
    // The terminal gets the paste and then Enter in that order, so Enter
    // cannot overtake it; the pause only lets the TUI draw it.
    await tmux(['load-buffer', '-b', name, '-'], `/btw ${request.prompt}`);
    await tmux(['paste-buffer', '-p', '-d', '-b', name, '-t', name]);
    await sleep(300);
    const before = log().length;
    await tmux(['send-keys', '-t', name, 'Enter']);

    // The side question is the first conversation other than the main one
    // whose update stream starts after Enter.
    const fork = await waitFor(
      async () => {
        for (const match of log()
          .slice(before)
          .matchAll(/Starting conversation update stream for ([0-9a-f-]{36})/g)) {
          if (match[1] !== request.conversationId) return match[1];
        }
        if (await dead()) throw new Error(await failure('agy 結束了'));
        return undefined;
      },
      runtime.startTimeoutMs,
      () => failure('agy 沒有開始回答 /btw'),
    );
    await waitFor(
      async () => {
        if (log().includes(`Stream goroutine exited for ${fork}`)) return true;
        if (await dead()) throw new Error(await failure('agy 在回答 /btw 時結束了'));
        return undefined;
      },
      runtime.timeoutMs,
      async () => 'agy BTW 等待逾時',
    );

    // Read it before the TUI closes: agy deletes the fork on exit.
    const answer = sideAnswerFromReplay(
      await replayAgyConversation({
        bin: runtime.agyBin,
        conversationId: fork,
        cwd: request.cwd,
        timeoutMs: 60_000,
      }),
    );
    if (answer) return answer;
    // A failed side question shows its error in the /btw card instead, below
    // the conversation (which may hold errors of its own).
    const error = [...(await screen()).matchAll(/Error:\s*(.+)/g)].at(-1)?.[1]?.trim();
    throw new Error(error ? `agy /btw：${error}` : 'agy 沒有回答這個 /btw');
  } finally {
    await tmux(['kill-session', '-t', name]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

function readEntries(sessionDir: string, conversationId: string): AgyBtwEntry[] {
  try {
    const value = JSON.parse(readFileSync(join(sessionDir, STORE_FILE), 'utf8'));
    if (value?.conversationId !== conversationId || !Array.isArray(value?.entries)) return [];
    return value.entries.filter(
      (entry: any) => typeof entry?.question === 'string' && typeof entry?.response === 'string',
    );
  } catch {
    return [];
  }
}

function writeEntries(sessionDir: string, conversationId: string, entries: AgyBtwEntry[]): void {
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, STORE_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ conversationId, entries }, null, 2)}\n`, 'utf8');
  renameSync(`${file}.tmp`, file);
}

/** The BTW control for an AGY channel: same thread shape as pi-btw's. */
export async function agyBtw(
  channelFolder: string,
  action: 'snapshot' | 'send' | 'clear',
  text: string | undefined,
  opts: {
    modelRef: string;
    thinking?: ThinkingLevel;
    cwd: string;
    dependencies?: AgyBtwDependencies;
  },
): Promise<AgyBtwThread> {
  const deps = opts.dependencies ?? defaultDependencies;
  const sessionDir = deps.resolveSessionDir(channelFolder);
  const conversation = () => deps.readConversationId(channelFolder) ?? '';
  const snapshot = (): AgyBtwThread => ({
    messages: readEntries(sessionDir, conversation()).flatMap((entry) => [
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
    writeEntries(sessionDir, conversation(), []);
    return snapshot();
  }

  const question = (text ?? '').trim();
  if (!question) throw new Error('Empty BTW question');
  if (!conversation()) throw new Error('agy 的 BTW 要等主對話開始後才能問（agy 還沒有這段對話）');
  const pending = pendingByFolder.get(channelFolder) ?? [];
  pending.push(question);
  pendingByFolder.set(channelFolder, pending);
  const ask = async () => {
    const conversationId = conversation();
    const history = readEntries(sessionDir, conversationId);
    const answer = await deps.ask({
      conversationId,
      modelRef: opts.modelRef,
      thinking: opts.thinking,
      cwd: opts.cwd,
      prompt: agySideQuestionPrompt(question, history),
    });
    writeEntries(sessionDir, conversationId, [...history, { question, response: answer }]);
  };
  const previous = chainByFolder.get(channelFolder) ?? Promise.resolve();
  const turn = previous.then(ask, ask);
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
