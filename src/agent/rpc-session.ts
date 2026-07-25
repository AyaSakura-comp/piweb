/**
 * Persistent pi RPC sessions (one long-lived `pi --mode rpc` child per channel).
 *
 * The one-shot print path (invoke.ts) spawns a fresh `pi -p` per message and
 * can only "interrupt" by killing the process. RPC mode instead keeps the agent
 * alive and speaks a JSONL protocol on stdin/stdout, which lets a message that
 * arrives mid-turn be **steered** into the running turn (redirect the agent
 * in-flight) instead of stopping it.
 *
 * Protocol (verified against @earendil-works/pi-coding-agent):
 *   stdin  : {type:"prompt"|"steer"|"abort", message?, id?}\n
 *   stdout : AgentSessionEvent objects (same shape as `--mode json`), plus
 *            {type:"response",command,success}, {type:"extension_ui_request",…}
 *   turn lifecycle: agent_start → turn_start → message_* → turn_end → agent_end
 *
 * Events are the *same* objects the print path emits, so the existing
 * createEventStreamer and final-text extraction are reused verbatim.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { repairSessionForContinue, resolveChannelSessionDir } from '../session/path.js';
import { formatStreamError, resolvePiSpawn } from './invoke.js';
import type { AgentResult } from '../types.js';

export interface RpcSessionOpts {
  model?: string;
  thinking?: string;
  cwd?: string;
}

interface PendingTurn {
  onEvent?: (event: any) => void | Promise<void>;
  inAssistant: boolean;
  currentAssistantText: string;
  lastAssistantText: string;
  lastError: string;
  resolve: (result: AgentResult) => void;
}

class RpcSession {
  private proc?: ChildProcess;
  private stdoutBuf = '';
  private streaming = false;
  private pending?: PendingTurn;
  private idleTimer?: NodeJS.Timeout;
  private starting = false;

  constructor(
    private readonly folder: string,
    private readonly opts: RpcSessionOpts,
  ) {}

  get isStreaming(): boolean {
    return this.streaming;
  }

  get isAlive(): boolean {
    return Boolean(this.proc) && !this.proc!.killed;
  }

  private ensureProc(): void {
    if (this.isAlive) return;
    const dir = resolveChannelSessionDir(this.folder);
    mkdirSync(dir, { recursive: true });
    // Heal a session left non-continuable by an interrupted run (see
    // repairSessionForContinue). No pi is writing this folder at spawn time.
    repairSessionForContinue(this.folder);
    const args = ['--mode', 'rpc', '--session-dir', dir, '--continue'];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.thinking) args.push('--thinking', this.opts.thinking);
    if (config.piExtraFlags) args.push(...config.piExtraFlags.split(/\s+/).filter(Boolean));
    const { bin, args: spawnArgs } = resolvePiSpawn(config.piBin, args);
    const proc = spawn(bin, spawnArgs, {
      cwd: this.opts.cwd || config.piCwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.stdoutBuf = '';
    this.streaming = false;
    proc.stdout!.on('data', (d: Buffer) => this.onData(d));
    proc.stderr!.on('data', (d: Buffer) =>
      logger.debug({ folder: this.folder, stderr: d.toString().slice(0, 200) }, 'rpc stderr'),
    );
    proc.on('exit', (code) => this.onExit(code));
    proc.on('error', (err) => {
      logger.error({ folder: this.folder, err: err.message }, 'rpc session spawn error');
      this.onExit(null);
    });
    logger.info({ folder: this.folder }, 'Started persistent RPC session');
  }

  private onData(d: Buffer): void {
    this.stdoutBuf += d.toString();
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    // Command acks and extension UI prompts are protocol noise (the latter are
    // non-blocking — turns complete without a client response).
    if (event.type === 'response' || event.type === 'extension_ui_request') return;

    const turn = this.pending;
    if (turn) {
      // Capture in-stream provider errors (e.g. Codex 429) so an empty turn
      // surfaces the error instead of "(empty response)".
      const errMsg = event?.message?.errorMessage ?? event?.errorMessage;
      if (typeof errMsg === 'string' && errMsg) turn.lastError = errMsg;

      // Final assistant text — same accumulation as the print path.
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        turn.inAssistant = true;
        turn.currentAssistantText = '';
      } else if (event.type === 'message_end' && turn.inAssistant) {
        const fromMessage = (event.message?.content ?? [])
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text)
          .join('');
        turn.lastAssistantText = fromMessage || turn.currentAssistantText;
        turn.inAssistant = false;
      } else if (event.type === 'message_update' && turn.inAssistant) {
        const ev = event.assistantMessageEvent;
        if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
          turn.currentAssistantText += ev.delta;
        }
      }

      if (turn.onEvent) Promise.resolve(turn.onEvent(event)).catch(() => {});
    }

    if (event.type === 'agent_start' || event.type === 'turn_start') this.streaming = true;
    if (event.type === 'agent_end') {
      this.streaming = false;
      this.finishTurn();
    }
  }

  private finishTurn(): void {
    const turn = this.pending;
    if (!turn) return;
    this.pending = undefined;
    if (!turn.lastAssistantText && turn.lastError) {
      turn.resolve({ ok: false, text: '', error: formatStreamError(turn.lastError) });
    } else {
      turn.resolve({ ok: true, text: turn.lastAssistantText || '(empty response)' });
    }
    this.armIdleTimer();
  }

  private onExit(code: number | null): void {
    logger.info({ folder: this.folder, code }, 'RPC session exited');
    this.proc = undefined;
    this.streaming = false;
    this.clearIdleTimer();
    // A turn in flight when the process died resolves as an error so the caller
    // isn't left hanging; the next prompt respawns the session.
    if (this.pending) {
      const turn = this.pending;
      this.pending = undefined;
      turn.resolve({ ok: false, text: '', error: `pi rpc session exited (code ${code})` });
    }
  }

  private send(cmd: object): void {
    this.proc?.stdin?.write(JSON.stringify(cmd) + '\n');
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.isAlive && !this.streaming && !this.pending) {
        logger.info({ folder: this.folder }, 'RPC session idle timeout — shutting down');
        this.close();
      }
    }, config.rpcIdleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Run a new turn. Must only be called when not already streaming. */
  prompt(
    message: string,
    onEvent?: (event: any) => void | Promise<void>,
  ): Promise<AgentResult> {
    this.ensureProc();
    this.clearIdleTimer();
    return new Promise<AgentResult>((resolve) => {
      this.pending = {
        onEvent,
        inAssistant: false,
        currentAssistantText: '',
        lastAssistantText: '',
        lastError: '',
        resolve,
      };
      this.send({ type: 'prompt', message });
    });
  }

  /** Inject a message into the running turn (redirect the agent in-flight). */
  steer(message: string): boolean {
    if (!this.isAlive) return false;
    this.send({ type: 'steer', message });
    return true;
  }

  close(): void {
    this.clearIdleTimer();
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    try {
      proc.stdin?.end();
    } catch {
      // ignore
    }
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 3000).unref?.();
  }
}

const sessions = new Map<string, RpcSession>();

function keyFor(folder: string): string {
  return folder;
}

/** Get (or lazily create) the persistent RPC session for a channel folder. */
export function getRpcSession(folder: string, opts: RpcSessionOpts): RpcSession {
  const key = keyFor(folder);
  let session = sessions.get(key);
  if (!session) {
    session = new RpcSession(folder, opts);
    sessions.set(key, session);
  }
  return session;
}

/** True if a live RPC session for this folder is mid-turn (steer-able). */
export function rpcSessionIsStreaming(folder: string): boolean {
  const session = sessions.get(keyFor(folder));
  return Boolean(session && session.isAlive && session.isStreaming);
}

/** Steer a message into the running turn. Returns false if not steer-able. */
export function steerRpcSession(folder: string, message: string): boolean {
  const session = sessions.get(keyFor(folder));
  if (!session || !session.isAlive || !session.isStreaming) return false;
  return session.steer(message);
}

/** Shut down every RPC session (graceful gateway stop). */
export function closeAllRpcSessions(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}
