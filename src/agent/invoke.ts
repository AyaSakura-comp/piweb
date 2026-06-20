import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { type AttachmentMeta } from '../discord/attachments.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { downloadAttachments } from '../session/media.js';
import {
  readSessionCreatedAt,
  resolveChannelSessionDir,
  resolveLatestChannelSessionFile,
} from '../session/path.js';
import type { AgentResult } from '../types.js';

/**
 * Sentinel that the `/until goal …` slash command prepends to a queued
 * message's content. invokeAgent detects it and launches pi's pi-until-done
 * autonomous loop via the `--until-done` flag instead of sending the text as a
 * plain prompt. Uses SOH control chars so it can never collide with real input.
 */
export const UNTIL_DONE_MARKER = 'UNTIL_DONE_GOAL';

/**
 * Turn a pi in-stream error string into a concise, user-facing message.
 * Special-cases the ChatGPT/Codex `usage_limit_reached` 429 (the common one) into
 * a readable "額度用完，約 HH:MM 重置" line; otherwise returns the trimmed raw text.
 */
export function formatStreamError(raw: string): string {
  // pi formats provider errors as: `Codex error: { ...json... }`
  const jsonStart = raw.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const obj = JSON.parse(raw.slice(jsonStart));
      const err = obj?.error ?? obj;
      if (err?.type === 'usage_limit_reached') {
        const plan = err.plan_type ? ` (方案: ${err.plan_type})` : '';
        let when = '';
        if (typeof err.resets_at === 'number') {
          const t = new Date(err.resets_at * 1000).toLocaleString('zh-TW', {
            timeZone: 'Asia/Taipei',
            hour12: false,
          });
          when = `，約 ${t} (台灣時間) 重置`;
        } else if (typeof err.resets_in_seconds === 'number') {
          when = `，約 ${Math.round(err.resets_in_seconds / 60)} 分鐘後重置`;
        }
        return `⏳ ChatGPT/Codex 用量已達上限${plan}${when}。可改用較省的模型 (gpt-5.4-mini) 或本機 qwen，或用 /gpt-usage 查額度。`;
      }
      if (err?.message) return `${err.type ? err.type + ': ' : ''}${err.message}`.slice(0, 400);
    } catch {
      // fall through to raw
    }
  }
  return raw.slice(0, 400);
}

export interface SessionTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface ChannelSessionStatus {
  sessionFile?: string;
  createdAt?: string;
  tokens?: SessionTokenUsage;
  contextUsage?: SessionContextUsage;
  statsSource: 'rpc' | 'jsonl' | 'none';
}

/**
 * Invoke pi agent as a subprocess.
 *
 * Each channel gets its own session directory so conversation history persists.
 * Uses `pi --session-dir <dir> --continue -p <message>` (print mode, no TUI).
 */
export async function invokeAgent(
  channelFolder: string,
  userText: string,
  opts?: {
    model?: string;
    thinking?: string;
    cwd?: string;
    signal?: AbortSignal;
    attachments?: string | null;
    /**
     * Called for each JSON event emitted by `pi --mode json` as it streams.
     * Use this to forward intermediate events (thinking blocks, tool calls,
     * tool results, etc.) somewhere live. The final assistant text is still
     * returned in `AgentResult.text` for the caller's normal delivery path.
     */
    onEvent?: (event: any) => void | Promise<void>;
  },
): Promise<AgentResult> {
  const sessionDir = resolveChannelSessionDir(channelFolder);
  mkdirSync(sessionDir, { recursive: true });
  const effectiveCwd = opts?.cwd || config.piCwd;

  // `--session` expects a session *file* path. We want a dedicated directory per
  // Discord channel and to keep reusing the most recent session inside it.
  const args: string[] = ['--session-dir', sessionDir, '--continue'];

  // Model
  const model = opts?.model || config.piModel;
  if (model) args.push('--model', model);

  // Thinking
  const thinking = opts?.thinking || config.piThinking;
  if (thinking) args.push('--thinking', thinking);

  // Extra flags
  if (config.piExtraFlags) {
    args.push(...config.piExtraFlags.split(/\s+/).filter(Boolean));
  }

  // Download attachments and pass as @file args (pi handles all types natively)
  if (opts?.attachments) {
    try {
      const metas: AttachmentMeta[] = JSON.parse(opts.attachments);
      const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const downloaded = await downloadAttachments(metas, channelFolder, messageId, opts.signal);
      for (const file of downloaded) {
        args.push(`@${file.filePath}`);
      }
      if (downloaded.length > 0) {
        logger.info({ channelFolder, count: downloaded.length }, 'Attached files for pi');
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to process attachments');
    }
  }

  if (opts?.signal?.aborted) {
    return {
      ok: false,
      text: '',
      error: 'Agent invocation aborted during shutdown',
    };
  }

  // JSON mode: pi will dump every session event to stdout as one JSON object
  // per line (text/thinking deltas, tool calls/results, turn boundaries, …).
  // We parse them live and feed each event to opts.onEvent, while still
  // returning the final assistant text in AgentResult so the caller's outbox
  // marker / attachment path keeps working unchanged.
  args.push('--mode', 'json');

  // pi-until-done launcher: a message enqueued by the `/until goal` slash
  // command carries UNTIL_DONE_MARKER followed by the goal text. When present,
  // start pi's autonomous goal loop with `--until-done <goal>` and a kickoff
  // prompt that nudges autopilot so the loop doesn't stall on the (UI-less)
  // contract-approval dialog. Otherwise send the message text as a normal prompt.
  const markerIdx = userText.indexOf(UNTIL_DONE_MARKER);
  const untilDoneGoal =
    markerIdx !== -1 ? userText.slice(markerIdx + UNTIL_DONE_MARKER.length).trim() : '';
  if (untilDoneGoal) {
    args.push('--until-done', untilDoneGoal);
    args.push(
      '-p',
      'Begin now. Operate in autopilot mode — do not pause for contract approval. ' +
        'Keep working until the goal is done and verified, then give a brief summary.',
    );
  } else {
    // Prompt (must be last)
    args.push('-p', userText);
  }

  const { bin: effectiveBin, args: effectiveArgs } = resolvePiSpawn(config.piBin, args);

  logger.debug(
    { bin: effectiveBin, args: effectiveArgs.slice(0, -1), channelFolder, cwd: effectiveCwd },
    'Spawning pi',
  );

  return new Promise<AgentResult>((resolve, reject) => {
    const proc = spawn(effectiveBin, effectiveArgs, {
      cwd: effectiveCwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const errChunks: Buffer[] = [];

    // JSON-mode line buffer + accumulator for the final assistant message.
    // pi emits one event per line; we forward each event to onEvent() and
    // track the most recent assistant turn's text content for the return value.
    let lineBuf = '';
    let lastAssistantText = '';
    let currentAssistantText = '';
    let inAssistantMessage = false;
    // Capture provider/model errors that pi reports in-stream but otherwise
    // swallows into an empty turn (e.g. ChatGPT/Codex 429 usage_limit_reached).
    // Without this the gateway would send "(empty response)" instead of the error.
    let lastErrorMessage = '';

    const handleEvent = (event: any) => {
      try {
        // Record any in-stream error message (message_end/turn_end/agent_end carry
        // message.stopReason==='error' + message.errorMessage; auto_retry_start carries
        // errorMessage too). Keep the latest so a final empty turn can surface it.
        const errMsg = event?.message?.errorMessage ?? event?.errorMessage;
        if (typeof errMsg === 'string' && errMsg) {
          lastErrorMessage = errMsg;
        }
        // Track assistant text by accumulating text_delta within the current
        // assistant message; flip the "last" on message_end so multi-turn
        // runs only surface the final turn's text to AgentResult (matches the
        // prior text-mode behavior).
        if (event?.type === 'message_start' && event.message?.role === 'assistant') {
          inAssistantMessage = true;
          currentAssistantText = '';
        } else if (event?.type === 'message_end' && inAssistantMessage) {
          // Prefer the authoritative final message.content[type=text] over our
          // delta accumulator (the message has the canonical complete string).
          const fromMessage = (event.message?.content ?? [])
            .filter((c: any) => c?.type === 'text')
            .map((c: any) => c.text || '')
            .join('');
          lastAssistantText = (fromMessage || currentAssistantText).trim();
          inAssistantMessage = false;
        } else if (event?.type === 'message_update' && inAssistantMessage) {
          const ev = event.assistantMessageEvent;
          if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
            currentAssistantText += ev.delta;
          }
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, 'invoke: assistant-text accumulator error');
      }

      if (opts?.onEvent) {
        try {
          const r = opts.onEvent(event);
          // Fire-and-forget; we don't await here because back-pressuring pi
          // on a slow Discord send would stall the whole inference.
          if (r && typeof (r as any).then === 'function') {
            (r as Promise<void>).catch((err) =>
              logger.warn({ err: err?.message }, 'invoke: onEvent rejected'),
            );
          }
        } catch (err: any) {
          logger.warn({ err: err.message }, 'invoke: onEvent threw');
        }
      }
    };

    const flushLines = (final = false) => {
      let nl = lineBuf.indexOf('\n');
      while (nl !== -1) {
        const raw = lineBuf.slice(0, nl).replace(/\r$/, '').trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (raw) {
          try {
            handleEvent(JSON.parse(raw));
          } catch {
            // Non-JSON line on stdout (shouldn't happen in --mode json but be
            // defensive — log to debug rather than crashing the whole turn).
            logger.debug({ line: raw.slice(0, 200) }, 'invoke: non-JSON stdout line');
          }
        }
        nl = lineBuf.indexOf('\n');
      }
      if (final && lineBuf.trim()) {
        try {
          handleEvent(JSON.parse(lineBuf.trim()));
        } catch {
          logger.debug({ line: lineBuf.slice(0, 200) }, 'invoke: non-JSON trailing line');
        }
        lineBuf = '';
      }
    };

    proc.stdout.on('data', (c: Buffer) => {
      lineBuf += c.toString('utf-8');
      flushLines();
    });
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));

    // Abort support
    if (opts?.signal) {
      const onAbort = () => {
        if (process.platform === 'win32') {
          proc.kill();
        } else {
          proc.kill('SIGTERM');
          setTimeout(() => proc.kill('SIGKILL'), 5000);
        }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      proc.on('close', () => opts.signal!.removeEventListener('abort', onAbort));
    }

    proc.on('close', (code) => {
      flushLines(true);
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();

      if (code !== 0) {
        // pi's `--until-done` autonomous loop in print mode can exit non-zero
        // even after completing the work and emitting a final summary. If we
        // captured assistant text in that mode, surface it instead of an error.
        if (untilDoneGoal && lastAssistantText) {
          logger.warn(
            { code, channelFolder },
            'pi exited non-zero in until-done mode but produced output; returning text',
          );
          resolve({ ok: true, text: lastAssistantText });
          return;
        }
        logger.warn({ code, stderr: stderr.slice(0, 500), channelFolder }, 'pi exited with error');
        resolve({
          ok: false,
          text: '',
          error: stderr.slice(0, 600) || `pi exited with code ${code}`,
        });
        return;
      }

      // No assistant text but pi reported an in-stream error → surface it as an
      // error to Discord instead of a useless "(empty response)".
      if (!lastAssistantText && lastErrorMessage) {
        const friendly = formatStreamError(lastErrorMessage);
        logger.warn({ channelFolder, error: lastErrorMessage.slice(0, 300) }, 'pi turn produced no text but reported an error');
        resolve({ ok: false, text: '', error: friendly });
        return;
      }

      resolve({ ok: true, text: lastAssistantText || '(empty response)' });
    });

    proc.on('error', (err) => {
      logger.error({ err: err.message }, 'Failed to spawn pi');
      reject(err);
    });
  });
}

export async function getChannelSessionStatus(
  channelFolder: string,
  cwd = config.piCwd,
): Promise<ChannelSessionStatus> {
  const sessionFile = resolveLatestChannelSessionFile(channelFolder);
  if (!sessionFile) {
    return { statsSource: 'none' };
  }

  const createdAt = readSessionCreatedAt(sessionFile);

  try {
    const stats = await getSessionStatsViaRpc(sessionFile, cwd);
    return {
      sessionFile,
      createdAt,
      tokens: stats.tokens,
      contextUsage: stats.contextUsage,
      statsSource: 'rpc',
    };
  } catch (err: any) {
    logger.warn(
      { err: err.message, sessionFile },
      'Failed to query pi session stats via RPC; falling back to session JSONL',
    );

    return {
      sessionFile,
      createdAt,
      tokens: readSessionTokensFromJsonl(sessionFile),
      statsSource: 'jsonl',
    };
  }
}

interface RpcSessionStatsResponse {
  type: 'response';
  command: 'get_session_stats';
  success: boolean;
  data?: {
    tokens?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    contextUsage?: {
      tokens?: number | null;
      contextWindow?: number | null;
      percent?: number | null;
    };
  };
  error?: string;
}

async function getSessionStatsViaRpc(
  sessionFile: string,
  cwd: string,
): Promise<{ tokens: SessionTokenUsage; contextUsage?: SessionContextUsage }> {
  const args = ['--mode', 'rpc', '--session', sessionFile];
  const { bin: rpcBin, args: rpcArgs } = resolvePiSpawn(config.piBin, args);

  return new Promise((resolve, reject) => {
    const proc = spawn(rpcBin, rpcArgs, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const errChunks: Buffer[] = [];
    let stdout = '';
    let response: RpcSessionStatsResponse | undefined;
    let finished = false;

    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (err) {
        reject(err);
        return;
      }

      if (!response?.success || !response.data?.tokens) {
        reject(new Error(response?.error || 'pi did not return session stats'));
        return;
      }

      resolve({
        tokens: {
          input: toNumber(response.data.tokens.input),
          output: toNumber(response.data.tokens.output),
          cacheRead: toNumber(response.data.tokens.cacheRead),
          cacheWrite: toNumber(response.data.tokens.cacheWrite),
          total: toNumber(response.data.tokens.total),
        },
        contextUsage: response.data.contextUsage
          ? {
              tokens: toNullableNumber(response.data.contextUsage.tokens),
              contextWindow: toNullableNumber(response.data.contextUsage.contextWindow),
              percent: toNullableNumber(response.data.contextUsage.percent),
            }
          : undefined,
      });
    };

    const timeout = setTimeout(() => {
      if (process.platform === 'win32') {
        proc.kill();
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 1000);
      }
      finish(new Error('Timed out waiting for pi session stats'));
    }, 2500);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');

      let newlineIndex = stdout.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdout.slice(0, newlineIndex).replace(/\r$/, '').trim();
        stdout = stdout.slice(newlineIndex + 1);

        if (line) {
          try {
            const message = JSON.parse(line) as RpcSessionStatsResponse | { type?: string };
            if (
              message.type === 'response' &&
              (message as RpcSessionStatsResponse).command === 'get_session_stats'
            ) {
              response = message as RpcSessionStatsResponse;
            }
          } catch {
            // Ignore non-JSON or partial lines from stdout.
          }
        }

        newlineIndex = stdout.indexOf('\n');
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      const trailingLine = stdout.trim();
      if (trailingLine) {
        try {
          const message = JSON.parse(trailingLine) as RpcSessionStatsResponse | { type?: string };
          if (
            message.type === 'response' &&
            (message as RpcSessionStatsResponse).command === 'get_session_stats'
          ) {
            response = message as RpcSessionStatsResponse;
          }
        } catch {
          // Ignore malformed trailing output on shutdown.
        }
      }

      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
        finish(new Error(stderr || `pi exited with code ${code}`));
        return;
      }

      finish();
    });

    proc.stdin.end('{"type":"get_session_stats"}\n');
  });
}

function readSessionTokensFromJsonl(sessionFile: string): SessionTokenUsage {
  const totals: SessionTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const lines = readFileSync(sessionFile, 'utf-8').split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as {
        type?: string;
        message?: {
          role?: string;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            totalTokens?: number;
          };
        };
      };

      if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !entry.message.usage) {
        continue;
      }

      const input = toNumber(entry.message.usage.input);
      const output = toNumber(entry.message.usage.output);
      const cacheRead = toNumber(entry.message.usage.cacheRead);
      const cacheWrite = toNumber(entry.message.usage.cacheWrite);

      totals.input += input;
      totals.output += output;
      totals.cacheRead += cacheRead;
      totals.cacheWrite += cacheWrite;
      totals.total +=
        toNumber(entry.message.usage.totalTokens) || input + output + cacheRead + cacheWrite;
    } catch {
      // Ignore incomplete or malformed trailing JSONL lines.
    }
  }

  return totals;
}

function resolvePiSpawn(piBin: string, args: string[]): { bin: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { bin: piBin, args };
  }

  try {
    const shimPath = execSync(`where ${piBin}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .find((line) => line.trim().endsWith('.cmd'));

    if (shimPath) {
      const content = readFileSync(shimPath.trim(), 'utf8');
      const jsMatch = content.match(/"([^"]+\.js)"/);
      if (jsMatch) {
        const jsPath = pathResolve(dirname(shimPath.trim()), jsMatch[1]);
        if (existsSync(jsPath)) {
          return { bin: process.execPath, args: [jsPath, ...args] };
        }
      }
    }
  } catch {
    // Fall through to original.
  }

  return { bin: piBin, args };
}

function toNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toNullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
