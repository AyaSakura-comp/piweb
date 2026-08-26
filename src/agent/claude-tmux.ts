import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { AttachmentMeta } from '../discord/attachments.js';
import { downloadAttachments } from '../session/media.js';
import { resolveChannelSessionDir } from '../session/path.js';
import type { AgentResult, ThinkingLevel } from '../types.js';
import { convertLocalMediaLinks } from './local-media-links.js';
import type { AvailableModelInfo } from './model-catalog.js';

export const CLAUDE_TMUX_PROVIDER = 'claude-code';

export const AUTONOMOUS_SYSTEM_PROMPT =
  'Piweb is controlling this session autonomously. Never ask for confirmation or clarification. ' +
  'Make reasonable assumptions and proceed. Only stop when the task is technically impossible or ' +
  'a required credential is missing. When returning a local file or screenshot, include exactly ' +
  '[[file: /absolute/path/to/file]] in the final response so Piweb can deliver it.';

const CLAUDE_MODELS: AvailableModelInfo[] = [
  {
    ref: `${CLAUDE_TMUX_PROVIDER}/haiku`,
    provider: CLAUDE_TMUX_PROVIDER,
    id: 'haiku',
    name: 'Claude Haiku (Claude Code)',
    reasoning: true,
    supportsXhigh: true,
  },
  {
    ref: `${CLAUDE_TMUX_PROVIDER}/sonnet`,
    provider: CLAUDE_TMUX_PROVIDER,
    id: 'sonnet',
    name: 'Claude Sonnet (Claude Code)',
    reasoning: true,
    supportsXhigh: true,
  },
  {
    ref: `${CLAUDE_TMUX_PROVIDER}/opus`,
    provider: CLAUDE_TMUX_PROVIDER,
    id: 'opus',
    name: 'Claude Opus (Claude Code)',
    reasoning: true,
    supportsXhigh: true,
  },
];

export function listClaudeTmuxModels(enabled: boolean): AvailableModelInfo[] {
  return enabled ? CLAUDE_MODELS.map((model) => ({ ...model })) : [];
}

export function isClaudeTmuxModelRef(ref: string | undefined): boolean {
  return Boolean(ref?.trim().toLowerCase().startsWith(`${CLAUDE_TMUX_PROVIDER}/`));
}

export function claudeModelId(ref: string): string {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function tmuxSessionName(channelFolder: string): string {
  const digest = createHash('sha256').update(channelFolder).digest('hex').slice(0, 16);
  return `piweb-cc-${digest}`;
}

const EFFORT_BY_THINKING: Partial<Record<ThinkingLevel, string>> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

export function buildClaudeArgs(options: {
  sessionId: string;
  modelRef: string;
  thinking?: ThinkingLevel;
  resume: boolean;
}): string[] {
  const args = options.resume
    ? ['--resume', options.sessionId]
    : ['--session-id', options.sessionId];
  const model = claudeModelId(options.modelRef);
  if (model) args.push('--model', model);
  const effort = options.thinking ? EFFORT_BY_THINKING[options.thinking] : undefined;
  if (effort) args.push('--effort', effort);
  args.push(
    '--permission-mode',
    'bypassPermissions',
    '--disallowedTools',
    'AskUserQuestion',
    '--no-chrome',
    '--append-system-prompt',
    AUTONOMOUS_SYSTEM_PROMPT,
  );
  return args;
}

export interface ClaudeTranslatedRecord {
  events: any[];
  finalText?: string;
  turnComplete?: boolean;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const item = part as Record<string, unknown>;
      if (typeof item.text === 'string') return item.text;
      return contentText(item.content);
    })
    .filter(Boolean)
    .join('\n');
}

export function translateClaudeTranscriptRecord(raw: any): ClaudeTranslatedRecord {
  if (!raw || typeof raw !== 'object' || raw.isSidechain) return { events: [] };
  if (raw.type === 'system' && raw.subtype === 'turn_duration') {
    return { events: [], turnComplete: true };
  }

  const message = raw.message;
  const parts = Array.isArray(message?.content) ? message.content : [];
  const events: any[] = [];

  if (raw.type === 'assistant' && message?.role === 'assistant') {
    const hasToolUse = parts.some((part: any) => part?.type === 'tool_use');
    for (const part of parts) {
      if (part?.type === 'thinking') {
        const text = String(part.thinking ?? '').trim();
        if (text) {
          events.push({
            type: 'message_update',
            assistantMessageEvent: { type: 'thinking_end', content: text },
          });
        }
      } else if (
        part?.type === 'text' &&
        (hasToolUse || message.stop_reason === 'tool_use')
      ) {
        const text = String(part.text ?? '').trim();
        if (text) {
          events.push({
            type: 'message_update',
            assistantMessageEvent: { type: 'thinking_end', content: text },
          });
        }
      } else if (part?.type === 'tool_use') {
        events.push({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            toolCall: { name: String(part.name || 'tool'), arguments: part.input ?? {} },
          },
        });
      }
    }

    const finalText =
      message.stop_reason === 'end_turn' && !hasToolUse
        ? parts
            .filter((part: any) => part?.type === 'text')
            .map((part: any) => String(part.text ?? ''))
            .join('\n')
            .trim()
        : '';
    return { events, ...(finalText ? { finalText } : {}) };
  }

  if (raw.type === 'user' && message?.role === 'user') {
    for (const part of parts) {
      if (part?.type !== 'tool_result') continue;
      const text = contentText(part.content).trim();
      if (!text) continue;
      events.push({
        type: 'message_end',
        message: { role: 'tool', content: [{ type: 'text', text }] },
      });
    }
  }

  return { events };
}

const STATE_FILE = 'claude-tmux-session.json';

interface ClaudeTmuxActiveTurn {
  turnId: string;
  transcriptPath?: string;
  transcriptOffset: number;
}

interface ClaudeTmuxState {
  sessionId: string;
  transcriptPath?: string;
  cwd: string;
  modelRef: string;
  thinking: ThinkingLevel | '';
  activeTurn?: ClaudeTmuxActiveTurn;
}

export interface ClaudeTmuxDependencies {
  randomUUID: () => string;
  resolveSessionDir: (folder: string) => string;
  findTranscript: (sessionId: string) => string | undefined;
  prepareAttachments?: (
    serialized: string,
    channelFolder: string,
    signal?: AbortSignal,
  ) => Promise<string[]>;
  loadBuffer: (text: string, bufferName: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  tmux: (args: string[]) => Promise<string>;
  claudeBin: string;
  pollMs: number;
  startupTimeoutMs: number;
  turnTimeoutMs: number;
}

const defaultDependencies: ClaudeTmuxDependencies = {
  randomUUID: nodeRandomUUID,
  resolveSessionDir: resolveChannelSessionDir,
  findTranscript: findClaudeTranscript,
  prepareAttachments: prepareClaudeAttachments,
  loadBuffer: loadTmuxBuffer,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tmux: runTmux,
  claudeBin: config.claudeTmuxBin,
  pollMs: config.claudeTmuxPollMs,
  startupTimeoutMs: config.claudeTmuxStartupTimeoutMs,
  turnTimeoutMs: config.claudeTmuxTurnTimeoutMs,
};

export function closeClaudeTmuxSession(channelFolder: string): boolean {
  const name = tmuxSessionName(channelFolder);
  try {
    execFileSync(config.claudeTmuxTmuxBin, ['kill-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function invokeClaudeTmux(
  channelFolder: string,
  userText: string,
  opts?: {
    channelJid?: string;
    turnId?: string | number;
    model?: string;
    thinking?: ThinkingLevel;
    cwd?: string;
    signal?: AbortSignal;
    attachments?: string | null;
    onEvent?: (event: any) => void | Promise<void>;
    dependencies?: ClaudeTmuxDependencies;
  },
): Promise<AgentResult> {
  const deps = opts?.dependencies ?? defaultDependencies;
  const cwd = opts?.cwd || config.piCwd;
  const modelRef = opts?.model || `${CLAUDE_TMUX_PROVIDER}/sonnet`;
  const thinking = opts?.thinking ?? '';
  const turnId = String(opts?.turnId ?? nodeRandomUUID());
  const name = tmuxSessionName(channelFolder);
  const sessionDir = deps.resolveSessionDir(channelFolder);
  const stateFile = join(sessionDir, STATE_FILE);
  const signal = opts?.signal;
  let pane: string | undefined;
  let pasted = false;
  let submitted = false;
  let aborted = Boolean(signal?.aborted);
  let abortPromise: Promise<unknown> | undefined;

  const onAbort = () => {
    aborted = true;
    // Ctrl-C is correct only after Enter handed work to Claude. During startup,
    // attachment staging, or paste acknowledgement it could interrupt unrelated
    // pane state and still allow the prompt to be submitted afterward.
    if (submitted && pane && !abortPromise) {
      abortPromise = deps.tmux(['send-keys', '-t', pane, 'C-c']).catch(() => undefined);
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const ensureNotAborted = () => {
    if (aborted || signal?.aborted) throw new ClaudeTmuxAbortError();
  };

  try {
    ensureNotAborted();
    mkdirSync(sessionDir, { recursive: true });
    let state = readState(stateFile);
    let live = await tmuxSessionExists(name, deps);
    ensureNotAborted();

    // A model or working-directory change must take effect on the next turn.
    // Restart the TUI but resume its Claude conversation rather than silently
    // continuing with the old launch options.
    if (
      live &&
      state &&
      (state.cwd !== cwd || state.modelRef !== modelRef || state.thinking !== thinking)
    ) {
      await deps.tmux(['kill-session', '-t', name]).catch(() => undefined);
      ensureNotAborted();
      live = false;
    }

    if (!state) {
      // A stale tmux pane can survive after `/pi new` rotated the state file.
      // Never let the fresh Piweb session inherit that Claude conversation.
      if (live) {
        await deps.tmux(['kill-session', '-t', name]).catch(() => undefined);
        ensureNotAborted();
      }
      state = { sessionId: deps.randomUUID(), cwd, modelRef, thinking };
      live = false;
    }

    const recoveringTurn = state.activeTurn?.turnId === turnId;
    if (!live) {
      const transcriptPath = state.transcriptPath || deps.findTranscript(state.sessionId);
      const resume = Boolean(transcriptPath && existsSync(transcriptPath));
      const args = buildClaudeArgs({
        sessionId: state.sessionId,
        modelRef,
        thinking: thinking || undefined,
        resume,
      });
      await deps.tmux(['new-session', '-d', '-s', name, '-c', cwd, deps.claudeBin, ...args]);
      ensureNotAborted();
      state = {
        ...state,
        cwd,
        modelRef,
        thinking,
        ...(transcriptPath ? { transcriptPath } : {}),
      };
      live = true;
    }

    writeState(stateFile, state);
    pane = await getClaudePane(name, deps);
    ensureNotAborted();

    const activeTurn = recoveringTurn ? state.activeTurn : undefined;
    let transcriptPath =
      activeTurn?.transcriptPath || state.transcriptPath || deps.findTranscript(state.sessionId);
    let offset = activeTurn?.transcriptOffset ?? fileSize(transcriptPath);
    let remainder = '';
    let finalText = '';
    let turnComplete = false;
    let shouldSubmit = !recoveringTurn;

    if (recoveringTurn) {
      const screen = await deps.tmux(['capture-pane', '-p', '-t', pane]);
      ensureNotAborted();
      if (!transcriptPath) transcriptPath = deps.findTranscript(state.sessionId);
      const hasTranscriptBytes = fileSize(transcriptPath) > offset;
      // A non-idle pane is the strongest evidence that Enter already happened,
      // including the window before Claude has flushed its first JSONL record.
      // Do not wait for startup readiness while that recovered turn is running.
      shouldSubmit = !hasTranscriptBytes && isReadyPaneScreen(screen);
    }

    if (shouldSubmit) {
      if (!recoveringTurn) pane = await waitForReadyPane(name, deps, signal);
      ensureNotAborted();

      let promptText = userText;
      if (opts?.attachments) {
        const files = await (deps.prepareAttachments ?? prepareClaudeAttachments)(
          opts.attachments,
          channelFolder,
          signal,
        );
        ensureNotAborted();
        for (const file of files) promptText += `\n[Uploaded file: ${file}]`;
      }

      if (!transcriptPath) transcriptPath = deps.findTranscript(state.sessionId);
      offset = fileSize(transcriptPath);
      state.activeTurn = {
        turnId,
        ...(transcriptPath ? { transcriptPath } : {}),
        transcriptOffset: offset,
      };
      writeState(stateFile, state);

      const bufferName = `${name}-input`;
      await deps.loadBuffer(promptText, bufferName);
      ensureNotAborted();
      const beforePaste = await deps.tmux(['capture-pane', '-p', '-t', pane]);
      ensureNotAborted();
      await deps.tmux(['paste-buffer', '-d', '-b', bufferName, '-t', pane]);
      pasted = true;
      ensureNotAborted();
      await waitForPastedPrompt(pane, promptText, beforePaste, deps, signal);
      ensureNotAborted();

      // Mark active before awaiting tmux: once send-keys starts, an abort must
      // Ctrl-C because Enter may already have reached Claude.
      submitted = true;
      await deps.tmux(['send-keys', '-t', pane, 'Enter']);
      ensureNotAborted();
    }

    const deadline = Date.now() + deps.turnTimeoutMs;
    while (!turnComplete && Date.now() < deadline) {
      ensureNotAborted();
      if (!transcriptPath) transcriptPath = deps.findTranscript(state.sessionId);
      if (transcriptPath && existsSync(transcriptPath)) {
        const next = readTranscriptChunk(transcriptPath, offset, remainder);
        offset = next.offset;
        remainder = next.remainder;
        for (const line of next.lines) {
          let record: any;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          const translated = translateClaudeTranscriptRecord(record);
          for (const event of translated.events) await opts?.onEvent?.(event);
          if (translated.finalText !== undefined) finalText = translated.finalText;
          if (translated.turnComplete) turnComplete = true;
        }
      }
      if (!turnComplete) await deps.sleep(deps.pollMs);
    }

    ensureNotAborted();
    if (!turnComplete) {
      await deps.tmux(['send-keys', '-t', pane, 'C-c']).catch(() => undefined);
      return { ok: false, text: '', error: 'Claude Code tmux turn timed out' };
    }

    if (transcriptPath) {
      state.transcriptPath = transcriptPath;
      // Keep the completed turn's start offset until the queue commits the same
      // rowid. If the worker dies in that gap, recovery tails this output rather
      // than submitting the user message a second time.
      state.activeTurn = {
        turnId,
        transcriptPath,
        transcriptOffset: state.activeTurn?.transcriptOffset ?? offset,
      };
      writeState(stateFile, state);
    }
    const text = convertLocalMediaLinks(finalText.trim(), cwd);
    if (!text) return { ok: false, text: '', error: 'Claude Code completed without a final reply' };
    return { ok: true, text };
  } catch (err: any) {
    if (err instanceof ClaudeTmuxAbortError || aborted || signal?.aborted) {
      if (pasted && !submitted && pane) {
        await deps.tmux(['send-keys', '-t', pane, 'C-u']).catch(() => undefined);
      }
      return { ok: false, text: '', aborted: true };
    }
    logger.warn({ err: err.message, channelFolder }, 'Claude Code tmux bridge failed');
    return { ok: false, text: '', error: `Claude Code tmux bridge failed: ${err.message}` };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (abortPromise) await abortPromise;
  }
}

function readState(file: string): ClaudeTmuxState | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value?.sessionId || !value?.cwd || !value?.modelRef) return undefined;
    return { ...value, thinking: value.thinking || '' } as ClaudeTmuxState;
  } catch {
    return undefined;
  }
}

function writeState(file: string, state: ClaudeTmuxState): void {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function tmuxSessionExists(name: string, deps: ClaudeTmuxDependencies): Promise<boolean> {
  try {
    await deps.tmux(['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

class ClaudeTmuxAbortError extends Error {}

async function getClaudePane(name: string, deps: ClaudeTmuxDependencies): Promise<string> {
  const pane = (await deps.tmux(['list-panes', '-t', name, '-F', '#{pane_id}']))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!pane) throw new Error('Claude tmux session has no pane');
  return pane;
}

function isReadyPaneScreen(screen: string): boolean {
  return /bypass permissions on/i.test(screen) && /(?:^|\n)\s*❯/u.test(screen);
}

async function waitForReadyPane(
  name: string,
  deps: ClaudeTmuxDependencies,
  signal?: AbortSignal,
): Promise<string> {
  const pane = await getClaudePane(name, deps);
  const deadline = Date.now() + deps.startupTimeoutMs;
  let acceptedTrust = false;
  let lastScreen = '';
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ClaudeTmuxAbortError();
    lastScreen = await deps.tmux(['capture-pane', '-p', '-t', pane]);
    if (signal?.aborted) throw new ClaudeTmuxAbortError();
    if (/Yes, I trust this folder/i.test(lastScreen) && !acceptedTrust) {
      acceptedTrust = true;
      await deps.tmux(['send-keys', '-t', pane, 'Enter']);
    } else if (isReadyPaneScreen(lastScreen)) {
      // The status bar appears before Ink has mounted the editable prompt.
      // Sending the tmux paste in that narrow window is silently discarded, so
      // require both the bypass indicator and the actual prompt glyph.
      return pane;
    }
    await deps.sleep(deps.pollMs);
  }
  throw new Error(`Claude Code did not become ready: ${lastScreen.trim().slice(-300)}`);
}

function pasteMarkers(screen: string): Set<string> {
  return new Set(screen.match(/\[Pasted text #\d+\]/giu) ?? []);
}

function currentPrompt(screen: string): string {
  const lines = screen.split(/\r?\n/u);
  let promptLine = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*❯/u.test(lines[i])) {
      promptLine = i;
      break;
    }
  }
  if (promptLine < 0) return '';
  const end = lines.findIndex(
    (line, index) => index > promptLine && /bypass permissions on/i.test(line),
  );
  return lines
    .slice(promptLine, end < 0 ? undefined : end)
    .join('\n')
    .replace(/^\s*❯\s*/u, '');
}

async function waitForPastedPrompt(
  pane: string,
  promptText: string,
  beforePaste: string,
  deps: ClaudeTmuxDependencies,
  signal?: AbortSignal,
): Promise<void> {
  const sample = promptText.replace(/\s+/gu, ' ').trim().slice(0, 32);
  const previousMarkers = pasteMarkers(beforePaste);
  const deadline = Date.now() + deps.startupTimeoutMs;
  let lastScreen = '';
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ClaudeTmuxAbortError();
    lastScreen = await deps.tmux(['capture-pane', '-p', '-t', pane]);
    if (signal?.aborted) throw new ClaudeTmuxAbortError();
    const input = currentPrompt(lastScreen);
    const normalizedInput = input.replace(/\s+/gu, ' ');
    const currentMarkers = pasteMarkers(input);
    const hasNewMarker = [...pasteMarkers(lastScreen)].some(
      (marker) => !previousMarkers.has(marker),
    );
    // Match ordinary text only inside the editable prompt, never in stale pane
    // history. Claude may render a bracketed multiline paste elsewhere in the
    // current frame, but in that case its numbered marker must have changed.
    if (
      (sample && normalizedInput.includes(sample)) ||
      currentMarkers.size > 0 ||
      hasNewMarker
    ) {
      return;
    }
    await deps.sleep(deps.pollMs);
  }
  throw new Error(`Claude Code did not accept the pasted prompt: ${lastScreen.trim().slice(-300)}`);
}

function fileSize(file: string | undefined): number {
  if (!file) return 0;
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function readTranscriptChunk(
  file: string,
  offset: number,
  priorRemainder: string,
): { lines: string[]; remainder: string; offset: number } {
  const size = fileSize(file);
  if (size <= offset) return { lines: [], remainder: priorRemainder, offset };
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    const bytes = readSync(fd, buffer, 0, buffer.length, offset);
    const text = priorRemainder + buffer.subarray(0, bytes).toString('utf8');
    const parts = text.split('\n');
    const remainder = parts.pop() ?? '';
    return { lines: parts.filter(Boolean), remainder, offset: offset + bytes };
  } finally {
    closeSync(fd);
  }
}

async function prepareClaudeAttachments(
  serialized: string,
  channelFolder: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const metas: AttachmentMeta[] = JSON.parse(serialized);
  const messageId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const files = await downloadAttachments(metas, channelFolder, messageId, signal);
  return files.map((file) => file.filePath);
}

function findClaudeTranscript(sessionId: string): string | undefined {
  const root = join(homedir(), '.claude', 'projects');
  try {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const candidate = join(root, project.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function runTmux(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(config.claudeTmuxTmuxBin, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function loadTmuxBuffer(text: string, bufferName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.claudeTmuxTmuxBin, ['load-buffer', '-b', bufferName, '-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const errors: Buffer[] = [];
    proc.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            Buffer.concat(errors).toString('utf8').trim() || `tmux load-buffer exited ${code}`,
          ),
        );
    });
    proc.stdin.end(text);
  });
}
