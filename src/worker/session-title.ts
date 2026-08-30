import { generateSessionTitle } from '../agent/session-title.js';
import {
  claimPendingSessionTitle,
  completeSessionTitle,
  failSessionTitle,
  recoverSessionTitleJobs,
  requeueInterruptedSessionTitle,
} from '../db.js';
import { logger } from '../logger.js';

const TITLE_POLL_MS = 750;

let running = false;
let timer: NodeJS.Timeout | undefined;
let activeController: AbortController | undefined;
let activeRun: Promise<boolean> | undefined;

/** Process at most one ready first-prompt title job. Exported for deterministic tests. */
export async function processNextSessionTitle(
  signal: AbortSignal = new AbortController().signal,
): Promise<boolean> {
  const job = claimPendingSessionTitle();
  if (!job) return false;

  try {
    const title = await generateSessionTitle(job.prompt, { signal });
    const applied = completeSessionTitle(job.channel_jid, title, job.channel_storage_token);
    logger.info({ jid: job.channel_jid, title, applied }, 'Extracted one-shot session title');
  } catch (error: any) {
    const message = error?.message || String(error);
    if (signal.aborted) {
      // Graceful shutdown is not an extraction failure. Keep the prompt and retry
      // budget intact so repeated deploys cannot permanently consume the job.
      requeueInterruptedSessionTitle(job.channel_jid, message, job.channel_storage_token);
      logger.info({ jid: job.channel_jid }, 'Deferred session title during worker shutdown');
    } else {
      const status = failSessionTitle(job.channel_jid, message, 3, job.channel_storage_token);
      logger.warn(
        { jid: job.channel_jid, status, error: error?.message },
        'One-shot session title extraction failed',
      );
    }
  }

  return true;
}

function schedule(delayMs = TITLE_POLL_MS): void {
  if (!running || timer || activeRun) return;
  timer = setTimeout(() => {
    timer = undefined;
    void tick();
  }, delayMs);
}

async function tick(): Promise<void> {
  if (!running || activeRun) return;
  activeController = new AbortController();
  activeRun = processNextSessionTitle(activeController.signal);

  try {
    await activeRun;
  } finally {
    activeRun = undefined;
    activeController = undefined;
    schedule();
  }
}

export function startSessionTitleLoop(): void {
  if (running) return;
  running = true;
  const recovered = recoverSessionTitleJobs();
  if (recovered > 0) logger.info({ count: recovered }, 'Recovered interrupted session titles');
  schedule(0);
}

export async function stopSessionTitleLoop(): Promise<void> {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  activeController?.abort();
  if (activeRun) await activeRun.catch(() => undefined);
}
