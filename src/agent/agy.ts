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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AttachmentMeta } from '../discord/attachments.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { downloadAttachments } from '../session/media.js';
import { UNTIL_DONE_MARKER } from './invoke.js';
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
  max: 'high',
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
      // agy caps reasoning at "high"; extended Pi levels fold down.
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

/**
 * Stateful wrapper over translateAgyEvent that makes a run's narration visible.
 *
 * agy emits no `thinking` steps at all, and its running commentary arrives as
 * `agent_response` steps whose text the bare translator only accumulates. A run
 * whose steps are mostly reasoning therefore showed nothing at all until the
 * final answer landed in one lump.
 *
 * Intermediate narration is surfaced as thinking blocks instead. The catch is
 * that the *last* agent_response is the final answer, which is delivered
 * separately; emitting it here too would print it twice. So each response is
 * held back and only flushed once something else follows it, and whatever is
 * still held when `result` arrives is dropped.
 */
export function createAgyEventTranslator() {
  let pending = '';

  const flushInto = (events: AgyPiEvent[]) => {
    const text = pending.trim();
    pending = '';
    if (text) {
      events.push({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_end', content: text },
      });
    }
  };

  return (raw: any) => {
    const translated = translateAgyEvent(raw);

    if (translated.finalText !== undefined) {
      // The held text is the final answer; the caller delivers it.
      pending = '';
      return translated;
    }

    if (translated.textDelta !== undefined) {
      pending += translated.textDelta;
      return translated;
    }

    if (translated.events.length === 0) return translated;

    // A tool call (or anything else visible) means the narration before it was
    // a step in the run, not the conclusion — show it, ahead of this event.
    const events: AgyPiEvent[] = [];
    flushInto(events);
    events.push(...translated.events);
    return { ...translated, events };
  };
}

/**
 * `/until goal …` prepends UNTIL_DONE_MARKER to the message. agy has no
 * equivalent of pi's --until-done loop, so rather than leaking the sentinel
 * into the Gemini prompt the goal is unwrapped and restated as an autonomous
 * instruction agy can actually act on.
 */
export function unwrapUntilDoneGoal(promptText: string): string {
  const markerIdx = promptText.indexOf(UNTIL_DONE_MARKER);
  if (markerIdx === -1) return promptText;

  const goal = promptText.slice(markerIdx + UNTIL_DONE_MARKER.length).trim();
  const preamble = promptText.slice(0, markerIdx).trim();
  if (!goal) return preamble;

  return (
    `${preamble}\nGoal: ${goal}\n` +
    'Work autonomously until this goal is done and verified, without pausing to ask ' +
    'for confirmation, then give a brief summary of what you did.'
  ).trim();
}

/**
 * agy signals produced files the way a chat model naturally would — markdown
 * (`![chart](/home/me/chart.png)`) — while Piweb's attachment pipeline only
 * understands pi's outbox convention (`[[file: …]]`). Without a translation the
 * image silently never arrives and the reply is left with a dangling `!` and a
 * caption, which is exactly what a user reports as "圖片沒辦法傳過來".
 *
 * Only links resolving to a file that actually exists on disk are converted, so
 * ordinary http(s) links and prose survive untouched.
 */
const MARKDOWN_LINK_RE = /(!?)\[([^\]]*)\]\(([^()]+)\)/g;

export function convertLocalMediaLinks(text: string, baseDir = config.piCwd): string {
  if (!text) return text;

  return text.replace(MARKDOWN_LINK_RE, (whole, bang: string, label: string, target: string) => {
    let candidate = target.trim().replace(/^['"<]+|['">]+$/g, '');
    if (!candidate || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      // Absolute URLs stay as they are; only file:// is unwrapped to a path.
      if (!/^file:\/\//i.test(candidate)) return whole;
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        return whole;
      }
    }

    const abs = isAbsolute(candidate) ? candidate : resolve(baseDir, candidate);
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) return whole;
    } catch {
      return whole;
    }

    // Keep the caption the model wrote; the marker itself is stripped later by
    // parseOutboxMarkers, which is what actually attaches the file.
    const caption = label.trim();
    const marker = `[[file: ${abs}]]`;
    return caption && !bang ? `${caption} ${marker}` : marker;
  });
}

/** "run_command ./scripts/verify_x.sh" — enough to recognise which call is stuck. */
export function describeToolCall(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return name;
  const values = Object.values(args as Record<string, unknown>)
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => String(v).replace(/\s+/g, ' ').trim());
  if (values.length === 0) return name;
  return `${name} ${_compactArg(values[0])}`;
}

function _compactArg(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 80)}…`;
}

/** "2 分 30 秒" */
export function humanizeDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds} 秒`;
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** Parse Go-style duration strings ('60m', '5m', '30s', '1h') to milliseconds. */
export function parseDurationMs(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  const match = /^(\d+)(s|m|h|d)?$/.exec(duration.trim());
  if (!match) return undefined;
  const val = Number(match[1]);
  const unit = match[2] || 's';
  switch (unit) {
    case 's': return val * 1000;
    case 'm': return val * 60 * 1000;
    case 'h': return val * 60 * 60 * 1000;
    case 'd': return val * 24 * 60 * 60 * 1000;
    default: return undefined;
  }
}

let workerShuttingDown = false;
process.on('SIGTERM', () => {
  workerShuttingDown = true;
});
process.on('SIGINT', () => {
  workerShuttingDown = true;
});

export interface FormatAgyErrorOptions {
  elapsedMs?: number;
  printTimeoutMs?: number;
  signal?: NodeJS.Signals | string | null;
  exitCode?: number | null;
  isWorkerStopping?: boolean;
}

/** Turn an agy failure into a message worth showing the user. */
export function formatAgyError(
  status: string,
  text: string,
  opts?: FormatAgyErrorOptions,
): string {
  // If the process was terminated by SIGTERM / SIGKILL or during worker shutdown
  if (
    opts?.signal === 'SIGTERM' ||
    opts?.signal === 'SIGKILL' ||
    opts?.exitCode === 143 ||
    opts?.exitCode === 137 ||
    opts?.isWorkerStopping
  ) {
    const code = opts?.exitCode ?? (opts?.signal === 'SIGKILL' ? 137 : 143);
    const sig = opts?.signal ?? 'SIGTERM';
    return `exited with code ${code} (${sig})`;
  }

  const combined = `${status} ${text}`;

  // agy's own wording for hitting --print-timeout. On its own it reads like the
  // model stopped responding; in fact the turn was cut off by our own cap, and
  // the conversation survives, so say both.
  // Note: agy also emits "timeout waiting for response" on context cancellation
  // (e.g. premature tool exit, process kill or network drop). Only blame print-timeout
  // if the elapsed time actually approached our timeout budget.
  if (/timeout waiting for response/i.test(combined)) {
    const isRealPrintTimeout =
      opts?.elapsedMs === undefined ||
      opts?.printTimeoutMs === undefined ||
      opts.elapsedMs >= opts.printTimeoutMs * 0.8;

    if (isRealPrintTimeout) {
      return (
        'agy 這一輪超過 print-timeout 被中止（目前上限 ' +
        `${config.agyPrintTimeout}）。對話本身沒有遺失 —— 直接接著問就會從剛才的進度繼續；` +
        '若這類長任務很常見，調高 AGY_PRINT_TIMEOUT。'
      );
    }

    return `agy 執行過程被中斷或連線超時 (timeout waiting for response, exit ${opts?.exitCode ?? 1})`;
  }

  if (/^stalled-tool:/.test(text)) {
    return text.slice('stalled-tool:'.length).trim();
  }
  if (/RESOURCE_EXHAUSTED|quota|429/i.test(combined)) {
    const resets = /Resets in ([0-9hms]+)/i.exec(combined)?.[1];
    return resets
      ? `agy (Gemini) quota exhausted — resets in ${resets}.`
      : 'agy (Gemini) quota exhausted; try again later or switch models.';
  }
  if (/(?:502|503|504|Bad Gateway|Server Error)/i.test(combined) && /(?:Eligibility check failed|request failed)/i.test(combined)) {
    return 'Google 雲端伺服器暫時性異常 (HTTP 502/503 Server Error)，請稍候直接重新發送訊息即可。';
  }
  const cleanText = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return cleanText ? `agy failed (${status}): ${cleanText}` : `agy failed (${status})`;
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
  let promptText = unwrapUntilDoneGoal(userText);
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

  const turnStartedAt = Date.now();
  const printTimeoutMs = parseDurationMs(config.agyPrintTimeout) ?? 3_600_000;

  return new Promise<AgentResult>((resolve) => {
    // detached makes agy a process-group leader so the whole group can be
    // signalled. agy's tools freely spawn long-lived grandchildren (it was seen
    // starting the nodriver browser daemon in the foreground); killing only agy
    // leaves those running, and they inherit its stdout.
    const proc = spawn(config.agyBin, args, {
      cwd: opts?.cwd || config.piCwd,
      env: {
        ...process.env,
        PIWEB_CHANNEL_JID: opts?.channelJid ?? '',
        PIWEB_CHANNEL_FOLDER: channelFolder,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    /** Signal the whole process group, falling back to the child alone. */
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (proc.pid) process.kill(-proc.pid, signal);
      } catch {
        try {
          proc.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const translate = createAgyEventTranslator();
    // Which tool call is currently outstanding (ACTIVE with no DONE yet). A
    // wedged command is otherwise invisible — the row is already on screen with
    // no result, and nothing tells "slow" apart from "hung".
    let outstanding: { label: string; startedAt: number } | null = null;
    let stallWarned = false;
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
      killTree('SIGTERM');
      // A grandchild that ignores SIGTERM would otherwise keep the group alive.
      setTimeout(() => killTree('SIGKILL'), 5_000).unref();
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

      const step = parsed?.step_update;
      if (step?.step_type === 'tool') {
        if (step.state === 'ACTIVE') {
          outstanding = {
            label: describeToolCall(
              String(step.tool_name || step.tool_info?.name || 'tool'),
              step.tool_info?.parameters,
            ),
            startedAt: Date.now(),
          };
          stallWarned = false;
        } else if (step.state === 'DONE') {
          outstanding = null;
        }
      }

      const translated = translate(parsed);
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

    // Say so in the transcript while it is still happening, not only at the end.
    const stallTimer = setInterval(() => {
      if (!outstanding || stallWarned) return;
      const elapsed = Date.now() - outstanding.startedAt;
      if (elapsed < config.agyToolStallWarnMs) return;
      stallWarned = true;
      emit({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          content:
            `⏳ 這個工具呼叫已經執行 ${humanizeDuration(elapsed)} 還沒回應：\n` +
            `${outstanding.label}\n` +
            '常見原因是它啟動了不會自己結束的程式（例如前景啟動 daemon）。' +
            '可以用 /pi stop 中止這一輪。',
        },
      });
    }, 15_000);

    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    proc.on('error', (err: any) => {
      clearInterval(stallTimer);
      opts?.signal?.removeEventListener('abort', onAbort);
      resolve({ ok: false, text: '', error: `Failed to spawn agy: ${err.message}` });
    });

    // `close` waits for every stdio pipe to close, and a surviving grandchild
    // holds agy's stdout open — that wedged a channel in "processing" for two
    // hours with no agy process left alive. `exit` fires on process exit
    // regardless, so settle on that and give trailing output a bounded window.
    let settled = false;
    proc.on('exit', (code, signal) => {
      if (settled) return;
      const finish = () => {
        if (settled) return;
        settled = true;
        finalize(code, signal);
      };
      let drained = false;
      proc.stdout.once('end', () => {
        drained = true;
        finish();
      });
      setTimeout(() => {
        if (!drained) {
          logger.warn(
            { channelFolder },
            'agy exited but stdout stayed open; a grandchild still holds it',
          );
        }
        finish();
      }, 2_000).unref();
    });

    const finalize = (code: number | null, signal: NodeJS.Signals | null = null) => {
      clearInterval(stallTimer);
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

      const text = convertLocalMediaLinks((finalText ?? assistantText).trim(), opts?.cwd || config.piCwd);
      const stderrText = Buffer.concat(errChunks).toString('utf8').trim();

      if (status === 'SUCCESS' || (code === 0 && text)) {
        resolve({ ok: true, text });
        return;
      }

      const elapsedMs = Date.now() - turnStartedAt;
      let error = formatAgyError(
        status === 'UNKNOWN' ? `exit ${code}` : status,
        agyErrorText || stderrText || text,
        {
          elapsedMs,
          printTimeoutMs,
          signal,
          exitCode: code,
          isWorkerStopping: workerShuttingDown,
        },
      );
      // The single most useful fact about a stalled turn is which call never
      // returned; without it the user is left guessing at a wall of tool rows.
      if (outstanding) {
        error +=
          `\n\n最後一個沒有回應的工具呼叫（已執行 ${humanizeDuration(Date.now() - outstanding.startedAt)}）：\n` +
          outstanding.label;
      }
      resolve({ ok: false, text, error });
    };
  });
}
