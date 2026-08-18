/**
 * Bridge to Google's Antigravity CLI (`agy`), exposing its Gemini models as
 * ordinary Piweb models.
 *
 * Design: agy is a complete agent in its own right — it owns its tools, its
 * permission model, and its conversation store. Piweb does not reimplement any
 * of that. This module only
 *
 *   1. advertises `agy models` as synthetic `agy/<id>` catalog entries so the
 *      existing model picker, `/model` command, and channel overrides work
 *      unchanged, and
 *   2. spawns `agy --output-format stream-json` and translates its event
 *      stream into the pi-shaped events the transports already render.
 *
 * Every action is delegated to the agy CLI; nothing here drives a model.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AttachmentMeta } from '../discord/attachments.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { downloadAttachments } from '../session/media.js';
import { resolveChannelSessionDir } from '../session/path.js';
import type { AgentResult, ThinkingLevel } from '../types.js';
import type { AvailableModelInfo } from './model-catalog.js';

export const AGY_PROVIDER = 'agy';

/**
 * Run an agy subcommand and collect stdout.
 *
 * stdin **must** be closed: given an open stdin pipe, `agy models` waits on it
 * and never returns, so an execFile-style call only ever ends in a timeout kill.
 */
function runAgy(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.agyBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`agy ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
        return;
      }
      reject(new Error(`agy ${args.join(' ')} exited with ${code}: ${Buffer.concat(err).toString('utf8').trim()}`));
    });
  });
}

/** agy exposes three reasoning efforts; Piweb's six thinking levels fold onto them. */
const EFFORT_BY_THINKING: Record<ThinkingLevel, 'low' | 'medium' | 'high' | undefined> = {
  off: undefined,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
};

/**
 * Most agy model ids already encode their reasoning effort as a suffix
 * (`gemini-3.5-flash-low`). Passing --effort alongside one is rejected outright:
 *   invalid model selection … --model gemini-3.5-flash-low conflicts with --effort=medium
 * so the id wins and the flag is suppressed for those models.
 */
const EFFORT_SUFFIX = /-(low|medium|high)$/;

export function modelIdEncodesEffort(id: string): boolean {
  return EFFORT_SUFFIX.test(id.trim());
}

const MODEL_CACHE_TTL_MS = 300_000;
const CONVERSATION_FILE = 'agy-conversation.json';

interface AgyModelCache {
  loadedAt: number;
  models: AvailableModelInfo[];
}

let modelCache: AgyModelCache | undefined;

export function isAgyModelRef(ref: string | undefined): boolean {
  return Boolean(ref && ref.trim().toLowerCase().startsWith(`${AGY_PROVIDER}/`));
}

/** Strip the synthetic `agy/` provider prefix to get the id agy itself expects. */
export function agyModelId(ref: string): string {
  const trimmed = ref.trim();
  return trimmed.slice(trimmed.indexOf('/') + 1);
}

/**
 * `agy models` output is two tab-separated columns: id and display name.
 * A leading "Fetching available models..." status line is ignored.
 */
export function parseAgyModels(stdout: string): AvailableModelInfo[] {
  const models: AvailableModelInfo[] = [];
  for (const line of stdout.split('\n')) {
    const [id, name] = line.split('\t');
    if (!id || !name) continue;
    const trimmedId = id.trim();
    if (!trimmedId || trimmedId.includes(' ')) continue;
    models.push({
      ref: `${AGY_PROVIDER}/${trimmedId}`,
      provider: AGY_PROVIDER,
      id: trimmedId,
      name: name.trim(),
      // agy runs every model as a reasoning agent and accepts --effort for all
      // of them, so thinking stays user-selectable rather than being forced off.
      reasoning: true,
      // agy caps reasoning at "high"; resolveThinkingForModel folds xhigh down.
      supportsXhigh: false,
    });
  }
  return models;
}

export async function listAgyModels(options?: { forceRefresh?: boolean }): Promise<
  AvailableModelInfo[]
> {
  if (!config.agyEnabled) return [];

  const now = Date.now();
  if (!options?.forceRefresh && modelCache && now - modelCache.loadedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.models;
  }

  try {
    const stdout = await runAgy(['models'], config.agyModelsTimeoutMs);
    const models = parseAgyModels(stdout);
    modelCache = { loadedAt: now, models };
    return models;
  } catch (err: any) {
    logger.warn({ err: err.message, bin: config.agyBin }, 'Failed to list agy models');
    // Cache the failure briefly so a missing binary does not stall every
    // model-picker render with a repeated spawn.
    modelCache = { loadedAt: now, models: modelCache?.models ?? [] };
    return modelCache.models;
  }
}

/** Synchronous read of whatever listAgyModels last fetched, for sync catalog callers. */
export function cachedAgyModels(): AvailableModelInfo[] {
  return modelCache?.models ?? [];
}

function conversationFile(channelFolder: string): string {
  return join(resolveChannelSessionDir(channelFolder), CONVERSATION_FILE);
}

/**
 * agy owns conversation history; Piweb only remembers which agy conversation
 * belongs to which channel so a channel keeps one continuous thread.
 */
export function readAgyConversationId(channelFolder: string): string | undefined {
  const file = conversationFile(channelFolder);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const id = typeof parsed?.conversationId === 'string' ? parsed.conversationId.trim() : '';
    return id || undefined;
  } catch {
    return undefined;
  }
}

export function writeAgyConversationId(channelFolder: string, conversationId: string): void {
  const dir = resolveChannelSessionDir(channelFolder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, CONVERSATION_FILE),
    `${JSON.stringify({ conversationId }, null, 2)}\n`,
    'utf8',
  );
}

export interface AgyPiEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Translate one agy stream-json event into the pi-shaped events the Discord and
 * web transports already know how to render. Returns zero or more events plus
 * any side-channel data (conversation id, assistant text, final result) the
 * caller needs to accumulate.
 */
export function translateAgyEvent(raw: any): {
  events: AgyPiEvent[];
  conversationId?: string;
  textDelta?: string;
  finalText?: string;
  status?: string;
  errorText?: string;
} {
  if (!raw || typeof raw !== 'object') return { events: [] };

  if (raw.event === 'init') {
    const conversationId =
      typeof raw.conversation_id === 'string' ? raw.conversation_id : undefined;
    return { events: [], conversationId };
  }

  if (raw.event === 'result') {
    const result = raw.result ?? {};
    return {
      events: [],
      conversationId:
        typeof result.conversation_id === 'string' ? result.conversation_id : undefined,
      finalText: typeof result.response === 'string' ? result.response : '',
      status: typeof result.status === 'string' ? result.status : 'UNKNOWN',
      // agy explains the failure here; without it the user only ever sees
      // "agy failed (ERROR)", which says nothing actionable.
      errorText: typeof result.error === 'string' ? result.error : undefined,
    };
  }

  if (raw.event !== 'step_update') return { events: [] };

  const step = raw.step_update ?? {};
  const events: AgyPiEvent[] = [];

  if (step.step_type === 'tool') {
    const info = step.tool_info ?? {};
    const name = String(step.tool_name || info.name || 'tool');

    // ACTIVE announces the call; DONE carries the output. Emit them as pi's
    // toolcall_end / role=tool message_end so both transports render them.
    if (step.state === 'ACTIVE') {
      events.push({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          toolCall: { name, arguments: info.parameters ?? {} },
        },
      });
    } else if (step.state === 'DONE' && info.output !== undefined && info.output !== null) {
      const output = typeof info.output === 'string' ? info.output : JSON.stringify(info.output);
      events.push({
        type: 'message_end',
        message: { role: 'tool', content: [{ type: 'text', text: output }] },
      });
    }
    return { events };
  }

  // agy reports reasoning as its own step type; surface it as a thinking block
  // when it actually carries text.
  if (step.step_type === 'thinking' || step.step_type === 'agent_thinking') {
    const text = String(step.text_delta ?? '').trim();
    if (step.state === 'DONE' && text) {
      events.push({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_end', content: text },
      });
    }
    return { events };
  }

  if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
    return { events: [], textDelta: step.text_delta };
  }

  return { events: [] };
}

/** Turn an agy failure into a message worth showing the user. */
export function formatAgyError(status: string, text: string): string {
  const combined = `${status} ${text}`;
  if (/RESOURCE_EXHAUSTED|quota|429/i.test(combined)) {
    const resets = /Resets in ([0-9hms]+)/i.exec(combined)?.[1];
    return resets
      ? `agy (Gemini) quota exhausted — resets in ${resets}.`
      : 'agy (Gemini) quota exhausted; try again later or switch models.';
  }
  const trimmed = text.trim();
  return trimmed ? `agy failed (${status}): ${trimmed}` : `agy failed (${status})`;
}

/**
 * Run one turn through the agy CLI.
 *
 * Mirrors invokeAgent's contract (same AgentResult, same onEvent stream) so the
 * queue can swap between them on the model ref alone.
 */
export async function invokeAgy(
  channelFolder: string,
  userText: string,
  opts?: {
    channelJid?: string;
    model?: string;
    thinking?: ThinkingLevel;
    cwd?: string;
    signal?: AbortSignal;
    /** Serialized AttachmentMeta[], same contract as invokeAgent. */
    attachments?: string | null;
    onEvent?: (event: any) => void | Promise<void>;
  },
): Promise<AgentResult> {
  const modelRef = opts?.model || '';
  const args = ['--output-format', 'stream-json'];

  const modelId = modelRef ? agyModelId(modelRef) : '';
  if (modelId) args.push('--model', modelId);

  const effort = opts?.thinking ? EFFORT_BY_THINKING[opts.thinking] : undefined;
  if (effort && !modelIdEncodesEffort(modelId)) args.push('--effort', effort);

  // Piweb has no UI for agy's interactive permission prompts; without this the
  // subprocess blocks forever on the first tool call.
  if (config.agySkipPermissions) args.push('--dangerously-skip-permissions');

  const conversationId = readAgyConversationId(channelFolder);
  if (conversationId) args.push('--conversation', conversationId);

  args.push('--print-timeout', config.agyPrintTimeout);

  // agy has its own file tools, so every upload — images included — is handed
  // over by absolute path rather than inlined into the prompt.
  let promptText = userText;
  if (opts?.attachments) {
    try {
      const metas: AttachmentMeta[] = JSON.parse(opts.attachments);
      const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const downloaded = await downloadAttachments(metas, channelFolder, messageId, opts.signal);
      for (const file of downloaded) {
        promptText += `\n[Uploaded file: ${file.filePath}]`;
      }
      if (downloaded.length > 0) {
        logger.info({ channelFolder, count: downloaded.length }, 'Attached files for agy');
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to process attachments for agy');
    }
  }
  args.push('--print', promptText);

  logger.debug(
    { bin: config.agyBin, model: modelRef, conversationId, channelFolder },
    'Spawning agy',
  );

  return new Promise<AgentResult>((resolve) => {
    const proc = spawn(config.agyBin, args, {
      cwd: opts?.cwd || config.piCwd,
      env: {
        ...process.env,
        PIWEB_CHANNEL_JID: opts?.channelJid ?? '',
        PIWEB_CHANNEL_FOLDER: channelFolder,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lineBuf = '';
    let assistantText = '';
    let finalText: string | undefined;
    let status = 'UNKNOWN';
    let agyErrorText = '';
    let seenConversationId = conversationId;
    let aborted = false;
    const errChunks: Buffer[] = [];

    const onAbort = () => {
      aborted = true;
      proc.kill('SIGTERM');
    };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    const emit = (event: AgyPiEvent) => {
      if (!opts?.onEvent) return;
      try {
        void opts.onEvent(event);
      } catch (err: any) {
        logger.warn({ err: err.message }, 'agy event handler failed');
      }
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }

      const translated = translateAgyEvent(parsed);
      for (const event of translated.events) emit(event);
      if (translated.conversationId) seenConversationId = translated.conversationId;
      if (translated.textDelta) assistantText += translated.textDelta;
      if (translated.finalText !== undefined) finalText = translated.finalText;
      if (translated.status) status = translated.status;
      if (translated.errorText) agyErrorText = translated.errorText;
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8');
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        handleLine(lineBuf.slice(0, idx));
        lineBuf = lineBuf.slice(idx + 1);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    proc.on('error', (err: any) => {
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve({ ok: false, text: '', error: `Failed to spawn agy: ${err.message}` });
    });

    proc.on('close', (code) => {
      opts?.signal?.removeEventListener('abort', onAbort);
      if (lineBuf.trim()) handleLine(lineBuf);

      // Persist the conversation id so the next turn in this channel resumes
      // the same agy thread. A brand-new conversation only becomes known here.
      if (seenConversationId && seenConversationId !== conversationId) {
        try {
          writeAgyConversationId(channelFolder, seenConversationId);
        } catch (err: any) {
          logger.warn({ err: err.message, channelFolder }, 'Failed to persist agy conversation id');
        }
      }

      if (aborted) {
        resolve({ ok: false, text: '', aborted: true });
        return;
      }

      const text = (finalText ?? assistantText).trim();
      const stderrText = Buffer.concat(errChunks).toString('utf8').trim();

      if (status === 'SUCCESS' || (code === 0 && text)) {
        resolve({ ok: true, text });
        return;
      }

      resolve({
        ok: false,
        text,
        error: formatAgyError(
          status === 'UNKNOWN' ? `exit ${code}` : status,
          agyErrorText || stderrText || text,
        ),
      });
    });
  });
}
