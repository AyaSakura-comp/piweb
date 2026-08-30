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
import { beginChannelOperation, finishChannelOperation, touchChannelOperation } from '../db.js';
import { logger } from '../logger.js';
import { repairSessionForContinue, resolveChannelSessionDir } from '../session/path.js';
import { formatStreamError, resolvePiSpawn } from './invoke.js';
import type { AgentResult } from '../types.js';

export interface RpcSessionOpts {
  channelJid?: string;
  channelStorageToken?: string;
  channelOwnershipEpoch?: number;
  model?: string;
  thinking?: string;
  cwd?: string;
}

interface PendingTurn {
  proc?: ChildProcess;
  onEvent?: (event: any) => void | Promise<void>;
  inAssistant: boolean;
  currentAssistantText: string;
  lastAssistantText: string;
  lastError: string;
  userPromptPersisted: boolean;
  abortRequested: boolean;
  abortSent: boolean;
  aborted: boolean;
  resolve: (result: AgentResult) => void;
}

class RpcSession {
  private proc?: ChildProcess;
  private stdoutBuf = '';
  private streaming = false;
  private pending?: PendingTurn;
  private idleTimer?: NodeJS.Timeout;
  private ownershipTimer?: NodeJS.Timeout;
  private ownershipOperationId?: string;
  private procExit?: Promise<void>;
  private resolveProcExit?: () => void;
  private closingPromise?: Promise<void>;
  private killTimer?: NodeJS.Timeout;
  private startBarrier?: Promise<void>;
  private closed = false;

  constructor(
    private readonly folder: string,
    private readonly opts: RpcSessionOpts,
    startBarrier?: Promise<void>,
  ) {
    this.startBarrier = startBarrier;
  }

  get isStreaming(): boolean {
    // A prompt is active as soon as it has been written, before agent_start.
    return this.streaming || Boolean(this.pending);
  }

  get isAlive(): boolean {
    return Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  matchesOptions(opts: RpcSessionOpts): boolean {
    return (
      this.opts.channelJid === opts.channelJid &&
      this.opts.channelStorageToken === opts.channelStorageToken &&
      this.opts.channelOwnershipEpoch === opts.channelOwnershipEpoch &&
      this.opts.model === opts.model &&
      this.opts.thinking === opts.thinking &&
      this.opts.cwd === opts.cwd
    );
  }

  private acquireOwnership(): void {
    if (!this.opts.channelJid || this.ownershipOperationId) return;
    const operationId = beginChannelOperation(
      this.opts.channelJid,
      this.folder,
      this.opts.channelStorageToken,
      this.opts.channelOwnershipEpoch,
    );
    if (!operationId) {
      throw new Error('RPC session channel ownership changed before process start');
    }
    this.ownershipOperationId = operationId;
    this.ownershipTimer = setInterval(() => {
      if (this.renewOwnership()) return;
      logger.warn(
        { folder: this.folder, jid: this.opts.channelJid },
        'RPC session lost durable channel ownership — shutting down',
      );
      void retireSession(this).then(() => {
        if (sessions.get(keyFor(this.folder)) === this) {
          sessions.delete(keyFor(this.folder));
        }
      });
    }, 1000);
    this.ownershipTimer.unref?.();
  }

  /** Revalidate before every reuse, not only on the heartbeat timer. */
  renewOwnership(): boolean {
    if (!this.opts.channelJid) return true;
    if (!this.ownershipOperationId) return false;
    try {
      return touchChannelOperation(this.ownershipOperationId);
    } catch {
      return false;
    }
  }

  private releaseOwnership(): void {
    if (this.ownershipTimer) {
      clearInterval(this.ownershipTimer);
      this.ownershipTimer = undefined;
    }
    const operationId = this.ownershipOperationId;
    this.ownershipOperationId = undefined;
    if (!operationId) return;
    try {
      finishChannelOperation(operationId);
    } catch {
      // DB shutdown or a purge fence may already have removed the lease.
    }
  }

  private async ensureProc(): Promise<void> {
    if (this.closed) throw new Error('RPC session closed before process start');
    if (this.startBarrier) {
      const barrier = this.startBarrier;
      this.startBarrier = undefined;
      await barrier;
    }
    if (this.closingPromise) await this.closingPromise;
    if (this.closed) throw new Error('RPC session closed before process start');
    if (this.isAlive) {
      if (this.renewOwnership()) return;
      await retireSession(this);
      throw new Error('RPC session channel ownership changed before reuse');
    }
    this.acquireOwnership();
    try {
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
        env: {
          ...process.env,
          PIWEB_CHANNEL_JID: this.opts.channelJid ?? '',
          PIWEB_CHANNEL_FOLDER: this.folder,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      this.procExit = new Promise<void>((resolveExit) => {
        this.resolveProcExit = resolveExit;
      });
      this.stdoutBuf = '';
      this.streaming = false;
      proc.stdout!.on('data', (d: Buffer) => this.onData(d));
      proc.stderr!.on('data', (d: Buffer) =>
        logger.debug({ folder: this.folder, stderr: d.toString().slice(0, 200) }, 'rpc stderr'),
      );
      proc.once('exit', (code) => this.onExit(proc, code));
      proc.on('error', (err) => {
        logger.error({ folder: this.folder, err: err.message }, 'RPC child process error');
        // Node reports an unspawnable executable with no pid and no process whose
        // exit can be observed. Only that demonstrable pre-spawn failure may
        // release ownership here. Errors after a pid existed are not proof of
        // exit: keep the durable lease until the actual `exit` event.
        if (proc.pid === undefined) this.onExit(proc, null);
      });
      logger.info({ folder: this.folder }, 'Started persistent RPC session');
    } catch (error) {
      this.releaseOwnership();
      throw error;
    }
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

    const turn = this.pending?.proc === this.proc ? this.pending : undefined;
    if (turn) {
      // Capture in-stream provider errors (e.g. Codex 429) so an empty turn
      // surfaces the error instead of "(empty response)".
      const errMsg = event?.message?.errorMessage ?? event?.errorMessage;
      if (typeof errMsg === 'string' && errMsg) turn.lastError = errMsg;

      // Final assistant text — same accumulation as the print path.
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        turn.inAssistant = true;
        turn.currentAssistantText = '';
      } else if (event.type === 'message_end' && event.message?.role === 'user') {
        turn.userPromptPersisted = true;
        if (turn.abortRequested) this.sendAbort(turn);
      } else if (event.type === 'message_end' && turn.inAssistant) {
        const fromMessage = (event.message?.content ?? [])
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text)
          .join('');
        turn.lastAssistantText = fromMessage || turn.currentAssistantText;
        turn.aborted = turn.aborted || event.message?.stopReason === 'aborted';
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
    // agent_end can be followed by retry, compaction, or another low-level run.
    // agent_settled is the durable session-level completion boundary.
    if (event.type === 'agent_settled') {
      this.streaming = false;
      if (turn) this.finishTurn();
    }
  }

  private finishTurn(): void {
    const turn = this.pending;
    if (!turn) return;
    this.pending = undefined;
    if (turn.abortRequested || turn.aborted) {
      turn.resolve({ ok: false, text: '', error: 'Agent invocation aborted', aborted: true });
    } else if (!turn.lastAssistantText && turn.lastError) {
      turn.resolve({ ok: false, text: '', error: formatStreamError(turn.lastError) });
    } else {
      turn.resolve({ ok: true, text: turn.lastAssistantText || '(empty response)' });
    }
    this.armIdleTimer();
  }

  private onExit(proc: ChildProcess, code: number | null): void {
    if (this.proc !== proc) return;
    logger.info({ folder: this.folder, code }, 'RPC session exited');
    this.proc = undefined;
    this.streaming = false;
    this.clearIdleTimer();
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    this.releaseOwnership();
    // A turn in flight when the process died resolves as an error so the caller
    // isn't left hanging; the next prompt respawns the session.
    if (this.pending?.proc === proc) {
      const turn = this.pending;
      this.pending = undefined;
      turn.resolve({ ok: false, text: '', error: `pi rpc session exited (code ${code})` });
    }
    const resolveExit = this.resolveProcExit;
    this.resolveProcExit = undefined;
    this.procExit = undefined;
    resolveExit?.();
  }

  private send(cmd: object): void {
    this.proc?.stdin?.write(JSON.stringify(cmd) + '\n');
  }

  private sendAbort(turn: PendingTurn): void {
    if (turn.abortSent) return;
    turn.abortSent = true;
    this.send({ type: 'abort' });
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.isAlive && !this.streaming && !this.pending) {
        logger.info({ folder: this.folder }, 'RPC session idle timeout — shutting down');
        void retireSession(this).then(() => {
          if (sessions.get(keyFor(this.folder)) === this) {
            sessions.delete(keyFor(this.folder));
          }
        });
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
  prompt(message: string, onEvent?: (event: any) => void | Promise<void>): Promise<AgentResult> {
    // ensureProc starts the common no-barrier process path synchronously. Install
    // pending before its resolved promise yields so an immediate /pi stop can
    // mark this prompt for abort before Pi persists the user message.
    const ready = this.ensureProc();
    this.clearIdleTimer();
    return new Promise<AgentResult>((resolve, reject) => {
      const turn: PendingTurn = {
        onEvent,
        inAssistant: false,
        currentAssistantText: '',
        lastAssistantText: '',
        lastError: '',
        userPromptPersisted: false,
        abortRequested: false,
        abortSent: false,
        aborted: false,
        resolve,
      };
      this.pending = turn;
      void ready.then(
        () => {
          if (this.pending !== turn) return;
          turn.proc = this.proc;
          this.send({ type: 'prompt', message });
        },
        (error) => {
          if (this.pending === turn) this.pending = undefined;
          reject(error);
        },
      );
    });
  }

  /** Inject a message into the running turn (redirect the agent in-flight). */
  steer(message: string): boolean {
    if (!this.isAlive || !this.pending) return false;
    this.send({ type: 'steer', message });
    return true;
  }

  /** Abort after Pi has persisted the active user prompt in the session. */
  requestAbort(): boolean {
    const turn = this.pending;
    if (!turn || turn.abortRequested) return false;
    turn.abortRequested = true;
    if (this.isAlive && turn.userPromptPersisted) this.sendAbort(turn);
    return true;
  }

  close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    if (this.closingPromise) return this.closingPromise;
    const proc = this.proc;
    if (!proc) {
      const barrier = this.startBarrier;
      this.startBarrier = undefined;
      if (!barrier) {
        this.releaseOwnership();
        return Promise.resolve();
      }
      this.closingPromise = barrier.finally(() => {
        this.releaseOwnership();
        this.closingPromise = undefined;
      });
      return this.closingPromise;
    }

    const exited = this.procExit ?? Promise.resolve();
    this.closingPromise = exited.finally(() => {
      this.closingPromise = undefined;
    });
    try {
      proc.stdin?.end();
    } catch {
      // ignore
    }
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      // ChildProcess.killed only says a signal was sent. Ownership cannot be
      // released until the process actually reports exit.
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 3000);
    this.killTimer.unref?.();
    return this.closingPromise;
  }
}

const sessions = new Map<string, RpcSession>();
const retiringSessions = new Set<Promise<void>>();

/** Keep every confirmed-exit barrier visible even after its session map entry is removed. */
function retireSession(session: RpcSession): Promise<void> {
  const retirement = session.close();
  retiringSessions.add(retirement);
  void retirement.then(
    () => retiringSessions.delete(retirement),
    () => retiringSessions.delete(retirement),
  );
  return retirement;
}

function keyFor(folder: string): string {
  return folder;
}

/** Get (or lazily create) the persistent RPC session for a channel folder. */
export function getRpcSession(folder: string, opts: RpcSessionOpts): RpcSession {
  const key = keyFor(folder);
  let session = sessions.get(key);
  let startBarrier: Promise<void> | undefined;
  if (
    session &&
    (session.isClosed ||
      !session.matchesOptions(opts) ||
      (session.isAlive && !session.renewOwnership()))
  ) {
    startBarrier = retireSession(session);
    sessions.delete(key);
    session = undefined;
  }
  if (!session) {
    session = new RpcSession(folder, opts, startBarrier);
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

/** Abort an active RPC turn without terminating its persistent Pi process. */
export function abortRpcSession(folder: string): boolean {
  const session = sessions.get(keyFor(folder));
  return session?.requestAbort() ?? false;
}

/**
 * Terminate the persistent Pi process for one channel and forget it.
 *
 * Required whenever the channel's session directory changes underneath it.
 * A warm RPC session was started with `--session-dir <dir>` and has already
 * resolved a session file inside it; `/pi new` renames that directory to
 * `<folder>__archived_<ts>`, so the next prompt into the surviving process
 * opens a path that no longer exists and the turn dies with
 * "ENOENT: no such file or directory, open '.../<uuid>.jsonl'".
 */
export async function closeRpcSession(folder: string): Promise<boolean> {
  const key = keyFor(folder);
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  await retireSession(session);
  return true;
}

/**
 * Poll durable ownership independently of message traffic. Soft deletion makes
 * touchChannelOperation fail, so idle children retire before purge can claim
 * and detach their session directories.
 */
export async function sweepRpcSessionOwnership(): Promise<number> {
  const retirements: Promise<void>[] = [];
  let closed = 0;
  for (const [key, session] of sessions) {
    if (!session.isAlive || session.renewOwnership()) continue;
    sessions.delete(key);
    retirements.push(retireSession(session));
    closed += 1;
  }
  await Promise.all(retirements);
  return closed;
}

/** Shut down every RPC session and wait for every confirmed child exit. */
export async function closeAllRpcSessions(): Promise<void> {
  const active = [...sessions.values()];
  sessions.clear();
  const activeRetirements = active.map((session) => retireSession(session));
  // Include retirements removed from `sessions` by closeRpcSession, option
  // replacement, ownership loss, idle timeout, or a concurrent sweep.
  await Promise.all([...new Set([...activeRetirements, ...retiringSessions])]);
}
