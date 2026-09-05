/**
 * Message processing loop.
 *
 * Polls SQLite for pending messages, dispatches to pi agent, sends the response
 * back through the installed transport. Enforces per-channel serial processing
 * and a global concurrency limit.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  beginChannelOperation,
  channelsWithPending,
  channelsWithInterruptingPending,
  claimNextMessage,
  clearPendingMessages,
  finishChannelOperation,
  markMessageAborted,
  markMessageDone,
  markMessageFailed,
  requeueMessage,
  recoverStuckMessages,
  logMessage,
  getChannel,
  isChannelGenerationCurrent,
  touchChannelOperation,
} from '../db.js';
import { invokeAgent, UNTIL_DONE_MARKER } from './invoke.js';
import { invokeAgy, isAgyModelRef } from './agy.js';
import {
  abortRpcSession,
  getRpcSession,
  closeAllRpcSessions,
  closeRpcSession,
} from './rpc-session.js';
import { parseOutboxMarkers } from './outbox.js';
import { getTransport } from '../transport/index.js';
import { computeEffectiveChannelSettings } from './channel-settings.js';

/** Channels currently being processed (per-channel serial lock) */
const activeChannels = new Set<string>();
const activeTaskPromises = new Set<Promise<void>>();
const activeTaskControllers = new Map<number, AbortController>();
const activeChannelControllers = new Map<string, AbortController>();
/** Immutable generation owned by each active JID; JID and folder may both be reused. */
const activeChannelFolders = new Map<
  string,
  { folder: string; storageToken: string; ownershipEpoch: number }
>();
/** Channels whose next queued user message explicitly replaces the aborted task. */
const supersededChannels = new Set<string>();

let running = false;
let pollTimer: NodeJS.Timeout | undefined;
let stopPromise: Promise<void> | null = null;

// How many times a message killed by SIGTERM has been auto-resumed. In-memory:
// the loop we guard against is a message that reliably OOMs pi while the worker
// stays up; a worker restart legitimately resets this (and is a one-off, not a
// loop). Keyed by message rowid, which survives a requeue (same row).
const sigtermRetries = new Map<number, number>();
const MAX_SIGTERM_RETRIES = 2;

export function isChannelProcessing(jid: string): boolean {
  return activeChannels.has(jid);
}

export function abortChannelTask(jid: string): { aborted: boolean; cleared: number } {
  const controller = activeChannelControllers.get(jid);
  const aborted = Boolean(controller);
  if (controller) {
    controller.abort();
  }
  const cleared = clearPendingMessages(jid);
  return { aborted, cleared };
}

/** Stop the active turn, preferring Pi's session-preserving RPC abort. */
export function stopChannelTask(jid: string): {
  aborted: boolean;
  cleared: number;
  preservedSession: boolean;
} {
  const channel = getChannel(jid);
  if (channel && abortRpcSession(channel.folder)) {
    return { aborted: true, cleared: 0, preservedSession: true };
  }

  const controller = activeChannelControllers.get(jid);
  if (controller) controller.abort();
  return { aborted: Boolean(controller), cleared: 0, preservedSession: false };
}

/**
 * Interrupt the in-flight run for a channel WITHOUT clearing queued messages.
 *
 * Used when a new user message should pre-empt the current run ("pi stop" then
 * process the new message). Aborts the active controller (SIGTERM → SIGKILL the
 * pi subprocess); the aborted task marks its own message failed and frees the
 * per-channel lock, so the next poll dispatches whatever is queued (including
 * the new message the caller enqueues afterwards).
 *
 * Returns true only if a live, not-already-aborted run was interrupted — so a
 * burst of messages during a single run reports the interrupt exactly once.
 */
export function interruptChannelTask(jid: string): boolean {
  const controller = activeChannelControllers.get(jid);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

export function startProcessingLoop(): void {
  if (running) return;

  running = true;
  stopPromise = null;

  // Recover any messages stuck in 'processing' from a previous crash.
  const recovered = recoverStuckMessages();
  if (recovered > 0) {
    logger.info({ count: recovered }, 'Recovered stuck messages');
  }

  schedulePoll(0);
}

export function stopProcessingLoop(opts: { timeoutMs?: number } = {}): Promise<void> {
  if (stopPromise) {
    return stopPromise;
  }

  running = false;
  clearPollTimer();

  stopPromise = drainActiveTasks(opts.timeoutMs ?? config.shutdownTimeoutMs).finally(() =>
    closeAllRpcSessions(),
  );
  return stopPromise;
}

function schedulePoll(delayMs = config.pollInterval): void {
  if (!running || pollTimer) return;

  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    poll();
  }, delayMs);
}

function clearPollTimer(): void {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

/**
 * Pre-empt an in-flight run when a newer message arrives for the same channel.
 *
 * In piscord this lived in the Discord message handler, which fired before
 * enqueuing. piweb's web tier only enqueues (it is a separate process and can't
 * reach the worker's AbortController), so the trigger has to run here: a channel
 * that is *both* actively processing and has a *pending* message means the user
 * sent something mid-run and wants it to interrupt. Abort the current run; the
 * aborted task frees the per-channel lock and the next poll dispatches the new
 * message. The old message's partial work is discarded (that is the point of an
 * interrupt); the session it may leave mid-tool-loop is healed by
 * repairSessionForContinue on the next spawn.
 */
function interruptSupersededRuns(): void {
  if (!config.interruptOnNewMessage) return;
  for (const jid of channelsWithInterruptingPending()) {
    if (!activeChannels.has(jid)) continue;

    // Persistent RPC prompts do not observe the queue's AbortController. Abort
    // them through Pi's RPC protocol; retain the controller path only for
    // attachment/until-done turns that still use the one-shot process.
    const channel = getChannel(jid);
    const activeGeneration = activeChannelFolders.get(jid);
    // A terminal old-Life worker may still be cleaning up after its lease was
    // expired and rotated. A fresh web:life message is a different generation,
    // not an interruption or handoff for that archived turn.
    if (
      !channel ||
      !activeGeneration ||
      channel.folder !== activeGeneration.folder ||
      channel.storageToken !== activeGeneration.storageToken ||
      channel.ownershipEpoch !== activeGeneration.ownershipEpoch
    )
      continue;
    const rpcAborted = Boolean(config.rpcSteer && abortRpcSession(channel.folder));
    const interrupted = rpcAborted || interruptChannelTask(jid);
    if (!interrupted) continue;

    supersededChannels.add(jid);
    logger.info(
      { jid, mode: rpcAborted ? 'rpc' : 'process' },
      'Interrupting in-flight run for a newer message',
    );
    void getTransport().sendNotice?.(
      jid,
      '⏹ Stopped the previous task — running your new message.',
      {
        expectedFolder: activeGeneration.folder,
        expectedStorageToken: activeGeneration.storageToken,
        expectedOwnershipEpoch: activeGeneration.ownershipEpoch,
      },
    );
  }
}

function poll(): void {
  if (!running) return;

  try {
    interruptSupersededRuns();
    dispatch();
  } catch (err: any) {
    logger.error({ err: err.message }, 'Poll error');
  } finally {
    schedulePoll();
  }
}

function dispatch(): void {
  if (activeTaskPromises.size >= config.maxConcurrency) return;

  for (const jid of channelsWithPending()) {
    if (activeChannels.has(jid)) continue;
    if (activeTaskPromises.size >= config.maxConcurrency) break;

    const msg = claimNextMessage(jid);
    if (!msg) continue;

    const controller = new AbortController();
    const activeOwner = getChannel(jid);
    activeChannels.add(jid);
    activeTaskControllers.set(msg.rowid, controller);
    activeChannelControllers.set(jid, controller);
    if (activeOwner) {
      activeChannelFolders.set(jid, {
        folder: activeOwner.folder,
        storageToken: activeOwner.storageToken || '',
        ownershipEpoch: activeOwner.ownershipEpoch ?? 0,
      });
    }

    const taskPromise = processMessage(
      jid,
      msg.rowid,
      msg.sender_name,
      msg.content,
      controller,
      msg.attachments,
    ).finally(() => {
      activeChannels.delete(jid);
      activeTaskControllers.delete(msg.rowid);
      activeChannelControllers.delete(jid);
      activeChannelFolders.delete(jid);
      activeTaskPromises.delete(taskPromise);

      if (running) {
        schedulePoll(0);
      }
    });

    activeTaskPromises.add(taskPromise);
  }
}

async function drainActiveTasks(timeoutMs: number): Promise<void> {
  if (activeTaskPromises.size === 0) {
    return;
  }

  const initialDrain = Promise.allSettled([...activeTaskPromises]);
  const drainedGracefully = await waitForPromise(initialDrain, timeoutMs);
  if (drainedGracefully) {
    return;
  }

  logger.warn(
    { timeoutMs, activeTasks: activeTaskPromises.size },
    'Shutdown timeout reached; aborting in-flight message processing',
  );

  for (const controller of activeTaskControllers.values()) {
    controller.abort();
  }

  if (activeTaskPromises.size > 0) {
    await Promise.race([
      Promise.allSettled([...activeTaskPromises]),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

async function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs === 0) {
    return false;
  }

  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return activeTaskPromises.size === 0;
}

async function processMessage(
  jid: string,
  rowid: number,
  senderName: string,
  content: string,
  controller: AbortController,
  attachments?: string | null,
): Promise<void> {
  const signal = controller.signal;
  const channel = getChannel(jid);
  if (!channel) {
    logger.warn({ jid }, 'Channel disappeared during processing');
    markMessageFailed(rowid);
    return;
  }

  const workerOperationId = beginChannelOperation(
    jid,
    channel.folder,
    channel.storageToken,
    channel.ownershipEpoch,
  );
  if (!workerOperationId) {
    logger.warn({ jid, rowid }, 'Channel generation changed before worker ownership began');
    markMessageFailed(rowid);
    return;
  }

  logger.info({ jid, senderName, len: content.length }, 'Processing message');

  const writeFence = {
    expectedFolder: channel.folder,
    expectedStorageToken: channel.storageToken,
    expectedOwnershipEpoch: channel.ownershipEpoch,
  };
  let workerLeaseValid = true;
  let lastLeaseCheckAt = Date.now();
  const loseWorkerLease = (reason: string): false => {
    if (!workerLeaseValid) return false;
    workerLeaseValid = false;
    controller.abort();
    abortRpcSession(channel.folder);
    logger.warn({ jid, rowid, reason }, 'Worker ownership was fenced');
    return false;
  };
  const renewWorkerLease = (force = false): boolean => {
    if (!workerLeaseValid) return false;
    const now = Date.now();
    // Event stream callbacks can fire per token. A monotonic-enough wall-clock
    // check catches a resumed/suspended worker without writing SQLite per token.
    if (!force && now - lastLeaseCheckAt < 30_000) return true;
    try {
      const owned = workerOperationId
        ? touchChannelOperation(workerOperationId)
        : isChannelGenerationCurrent(
            jid,
            channel.folder,
            channel.storageToken,
            channel.ownershipEpoch,
          );
      if (!owned) return loseWorkerLease('lease missing or generation ended');
      lastLeaseCheckAt = now;
      return true;
    } catch (err: any) {
      return loseWorkerLease(`heartbeat failed: ${err.message}`);
    }
  };

  const operationHeartbeat = workerOperationId
    ? setInterval(() => renewWorkerLease(true), 60_000)
    : undefined;
  operationHeartbeat?.unref?.();
  const typingLoop = createTypingLoop(jid, writeFence, renewWorkerLease);

  try {
    const supersedesPrevious = supersededChannels.delete(jid);
    const handoff = supersedesPrevious
      ? '[System handoff: The user interrupted the previous task. Do not resume or continue the previous task. Follow only the latest instruction below. If asked for a screenshot, take it and immediately return it using [[file: /absolute/path/to/screenshot.png]].]\n'
      : '';
    const prompt = `${handoff}[Web user: ${senderName}]\n${content}`;

    logMessage(jid, 'user', content, writeFence);

    const effective = await computeEffectiveChannelSettings(channel, { signal });

    // Settings resolution can finish concurrently with cancellation (notably
    // while the Life defaults probe is closing). Never start a stale turn once
    // ownership of this queued message has been aborted.
    if (!renewWorkerLease(true) || signal.aborted) {
      markMessageFailed(rowid);
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    // Stream pi's intermediate thinking/tool events into the channel live so
    // the user can watch what the agent is doing instead of staring at a
    // typing indicator. Final assistant text still falls through to the
    // outbox/marker path below.
    const streamEvent = getTransport().createEventStreamer(jid, writeFence);
    const onEvent = async (event: unknown): Promise<void> => {
      if (!renewWorkerLease()) return;
      await streamEvent(event);
    };

    // Persistent RPC session path (steer-able). Falls back to the one-shot
    // print path for attachments and the until-done loop, which the RPC prompt
    // path doesn't carry. The session stays warm for in-flight steering.
    const useRpc = config.rpcSteer && !attachments && content.indexOf(UNTIL_DONE_MARKER) === -1;

    // agy models are not pi models: the whole turn is delegated to the
    // Antigravity CLI, which owns its own tools and conversation store. It has
    // no RPC/steer mode, so this branch precedes the RPC one.
    const useAgy = isAgyModelRef(effective.rawModelRef);

    // Attachments and until-done use the one-shot process, which writes the
    // same history files as RPC. Retire an idle warm session first so the next
    // text turn reloads those additions instead of following a stale branch.
    if (!useAgy && !useRpc) await closeRpcSession(channel.folder);

    let result;
    if (useAgy) {
      result = await invokeAgy(channel.folder, prompt, {
        channelJid: channel.jid,
        model: effective.rawModelRef,
        thinking: effective.hasManagedThinking ? effective.effectiveThinking : undefined,
        cwd: effective.effectiveCwd,
        signal,
        attachments,
        onEvent,
      });
    } else if (useRpc) {
      try {
        result = await getRpcSession(channel.folder, {
          channelJid: channel.jid,
          channelStorageToken: channel.storageToken,
          channelOwnershipEpoch: channel.ownershipEpoch,
          model: effective.rawModelRef || undefined,
          thinking: effective.hasManagedThinking ? effective.effectiveThinking : undefined,
          cwd: effective.effectiveCwd,
        }).prompt(prompt, onEvent);
      } finally {
        // Life folders are archive generations. A warm idle RPC would keep its
        // durable lease until the generic timeout and make New Life appear
        // busy after a completed turn. Standard sessions intentionally remain
        // warm; Life retires and confirms child exit before response delivery.
        if (channel.kind === 'life') await closeRpcSession(channel.folder);
      }
    } else {
      result = await invokeAgent(channel.folder, prompt, {
        channelJid: channel.jid,
        model: effective.rawModelRef || undefined,
        thinking: effective.hasManagedThinking ? effective.effectiveThinking : undefined,
        cwd: effective.effectiveCwd,
        signal,
        attachments,
        onEvent,
      });
    }

    if (!renewWorkerLease(true)) {
      markMessageFailed(rowid);
      return;
    }

    if (result.aborted) {
      markMessageAborted(rowid);
      logger.info({ jid, rowid }, 'Message processing aborted with session preserved');
      return;
    }

    if (signal.aborted) {
      markMessageFailed(rowid);
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    if (result.ok) {
      // Method C: extract [[image:/file:]] markers; attach those files, send the rest as text.
      const { text: outText, files: outFiles, rawText } = parseOutboxMarkers(result.text);
      const sent =
        outFiles.length > 0
          ? await getTransport().sendFilesResponse(
              jid,
              rawText ?? result.text,
              outFiles,
              writeFence,
            )
          : await getTransport().sendResponse(jid, outText, writeFence);
      if (!sent) {
        markMessageFailed(rowid);
        logger.warn({ jid }, 'Agent response generated but could not be delivered');
        return;
      }

      logMessage(jid, 'assistant', result.text, writeFence);
      sigtermRetries.delete(rowid);
      markMessageDone(rowid);
      logger.info({ jid, responseLen: result.text.length }, 'Message processed');
      return;
    }

    const rawError = result.error ?? '';

    // Exit code 143 = SIGTERM / Exit code 137 = SIGKILL: pi was KILLED, not
    // crashed — by a worker restart/shutdown or an OOM kill (a user-initiated
    // interrupt takes the signal.aborted path above). The request never got an
    // answer, so re-queue it: the same session continues
    // (repairSessionForContinue drops only the aborted turn's partial work) and
    // pi re-runs the original message. Capped so a message that reliably kills
    // pi can't loop forever.
    if (
      /(?:exited (?:with )?code (?:143|137)|\(code (?:143|137)\)|SIGTERM|SIGKILL|oom-kill)/i.test(
        rawError,
      )
    ) {
      const attempts = (sigtermRetries.get(rowid) ?? 0) + 1;
      const isOom = /137|143|oom-kill|SIGKILL/i.test(rawError);
      if (attempts <= MAX_SIGTERM_RETRIES) {
        sigtermRetries.set(rowid, attempts);
        logger.info(
          { jid, rowid, attempts, isOom },
          'Run terminated (SIGTERM/OOM) — resuming original message',
        );
        requeueMessage(rowid);
        return;
      }
      sigtermRetries.delete(rowid);
      logger.warn({ jid, rowid }, 'Run terminated repeatedly — giving up');
      if (getTransport().sendNotice) {
        await getTransport().sendNotice!(
          jid,
          isOom
            ? '⚠️ 系統記憶體不足 (OOM / SIGTERM 終止)。建議將任務拆解或稍後再試。'
            : '⚠️ 任務在完成前多次被系統終止。請嘗試重新發送您的訊息。',
          writeFence,
        );
      }
      markMessageFailed(rowid);
      return;
    }

    let errMsg = `⚠️ Agent error: ${rawError.slice(0, 300) || 'unknown error'}`;
    // "image input is not supported / mmproj" means the current model is
    // text-only. The raw message is opaque to a user, so add a plain hint.
    if (/image input is not supported|mmproj/i.test(rawError)) {
      errMsg +=
        '\n\nℹ️ This model cannot see images. Tap the model icon and switch to a ' +
        'vision-capable one (e.g. Gemini or a GPT model) to send pictures.';
    }
    if (!renewWorkerLease(true)) return;
    await getTransport().sendResponse(jid, errMsg, writeFence);
    markMessageFailed(rowid);
    logger.warn({ jid, error: result.error }, 'Agent returned error');
  } catch (err: any) {
    if (signal.aborted) {
      markMessageFailed(rowid);
      logger.info({ jid, rowid }, 'Message abandoned: shutdown interrupted processing');
      return;
    }

    logger.error({ jid, err: err.message }, 'processMessage failed');
    markMessageFailed(rowid);
    try {
      if (renewWorkerLease(true)) {
        await getTransport().sendResponse(
          jid,
          `⚠️ Internal error: ${err.message?.slice(0, 200)}`,
          writeFence,
        );
      }
    } catch {
      // Nothing else to do here.
    }
  } finally {
    try {
      // The message row may already be terminal. Keep the persisted generation lease
      // until all stream timers and the busy mirror have been cleared so those
      // final writes cannot land on a replacement web:life generation.
      await typingLoop.stop();
    } finally {
      if (operationHeartbeat) clearInterval(operationHeartbeat);
      if (workerOperationId) finishChannelOperation(workerOperationId);
    }
  }
}

function createTypingLoop(
  jid: string,
  writeFence:
    | {
        expectedFolder?: string;
        expectedStorageToken?: string;
        expectedOwnershipEpoch?: number;
      }
    | undefined,
  renewOwnership: (force?: boolean) => boolean,
): { stop: () => Promise<void> } {
  let typingAlive = true;
  let cancelTypingDelay = () => {};

  const loop = (async () => {
    while (typingAlive) {
      if (!renewOwnership()) break;
      await getTransport().setTyping(jid, writeFence);
      if (!typingAlive) break;

      const delay = cancellableSleep(8000);
      cancelTypingDelay = delay.cancel;
      await delay.promise;
      cancelTypingDelay = () => {};
    }
  })();

  return {
    stop: async () => {
      typingAlive = false;
      cancelTypingDelay();
      await loop;
      // Always ask the transport to discard its in-memory stream buffer. The
      // generation fence makes the persisted clear a no-op after rotation.
      renewOwnership(true);
      await getTransport().clearTyping(jid, writeFence);
    },
  };
}

function cancellableSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  let resolvePromise: () => void = () => {};

  const promise = new Promise<void>((resolve) => {
    resolvePromise = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(resolvePromise, ms);
  });

  return {
    promise,
    cancel: resolvePromise,
  };
}
