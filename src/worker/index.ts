/**
 * Worker entrypoint — runs pi.
 *
 * In the default deployment this runs on the HOST (systemd user unit) rather
 * than in the container, so pi keeps the host access that makes it useful here:
 * systemctl, docker, the ROCm GPU, and the project checkouts under ~/src. The
 * web server in Docker talks to it purely through the shared SQLite database.
 */

import {
  claimDeletedSessionsForPurge,
  initDb,
  closeDb,
  setMeta,
  listExpiredDeletedSessions,
} from '../db.js';
import { purgeSessionBatch, recoverPendingSessionPurges } from '../session/purge.js';
import { listAvailableModels, primeModelRegistry } from '../agent/model-catalog.js';
import { listAgyModels } from '../agent/agy.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { setTransport } from '../transport/index.js';
import { webTransport } from '../transport/web.js';
import { startProcessingLoop, stopProcessingLoop } from '../agent/queue.js';
import { startControlLoop, stopControlLoop } from './control.js';
import { startSessionTitleLoop, stopSessionTitleLoop } from './session-title.js';
import { startScheduler } from '../agent/scheduler.js';
import { startArchiveCleanup } from '../session/archive-cleanup.js';
import { discoverPiExtensionCommands } from '../commands/extension-runner.js';

// Both of these return their own stop function rather than exporting one.
let stopScheduler: () => void = () => {};
let stopArchiveCleanup: () => void = () => {};
let modelRefreshTimer: NodeJS.Timeout | undefined;
let extCommandRefreshTimer: NodeJS.Timeout | undefined;
let trashSweepTimer: NodeJS.Timeout | undefined;

const EXT_COMMAND_REFRESH_MS = 60 * 60 * 1000;

const MODEL_REFRESH_MS = 10 * 60 * 1000;
const TRASH_SWEEP_MS = 60 * 60 * 1000;

/**
 * Purge sessions that have sat in the trash past the retention window.
 *
 * Runs in the worker rather than the web tier because it deletes pi's session
 * directories, and the worker is the process that owns them.
 */
async function sweepTrash(): Promise<void> {
  try {
    await recoverPendingSessionPurges();
    const expired = listExpiredDeletedSessions(config.webTrashRetentionDays);
    for (const session of expired) {
      try {
        const batch = claimDeletedSessionsForPurge(
          [session.jid],
          [session.storageToken],
          [session.deletionToken],
          [session.deletedAt],
        );
        const purged = await purgeSessionBatch(batch.batchId);
        logger.info({ jid: session.jid, purged }, 'Purged expired trashed session');
      } catch (err: any) {
        // One active or temporarily unremovable owner must not starve every
        // unrelated expired session behind it until the next hourly sweep.
        logger.warn({ err: err.message, jid: session.jid }, 'Trash session purge deferred');
      }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Trash sweep failed');
  }
}

/**
 * Publish pi's model list for the web UI's autocomplete. Listing models means
 * spawning pi, which only the worker can do — the web server may be in a
 * container with no pi binary — so it goes through the meta table.
 */
function publishModelCatalog(): void {
  try {
    const models = listAvailableModels({ forceRefresh: true });
    setMeta('models', JSON.stringify(models));
    logger.debug({ count: models.length }, 'Published model catalog');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to publish model catalog');
  }
}

/**
 * Discover and publish pi's extension slash commands for the web UI's autocomplete.
 */
async function publishExtensionCommands(): Promise<void> {
  try {
    const commands = await discoverPiExtensionCommands();
    setMeta('extension_commands', JSON.stringify(commands));
    logger.info({ count: commands.length }, 'Published extension commands');
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to publish extension commands');
  }
}

export async function startWorker(): Promise<void> {
  initDb();
  setTransport(webTransport);
  await recoverPendingSessionPurges();

  startProcessingLoop();
  startControlLoop();
  startSessionTitleLoop();
  stopScheduler = startScheduler();
  stopArchiveCleanup = startArchiveCleanup();
  // agy's catalog comes from a separate CLI and merges in from cache, so wait
  // for the first fetch before publishing or the picker's first render after a
  // worker restart would be missing every Gemini model.
  await listAgyModels({ forceRefresh: true });
  // pi's model runtime is created asynchronously; without this the first
  // catalog publish (and any message handled before it settles) sees no models.
  await primeModelRegistry().catch((err: any) => {
    logger.warn({ err: err.message }, 'Failed to initialize pi model runtime');
  });
  publishModelCatalog();
  modelRefreshTimer = setInterval(publishModelCatalog, MODEL_REFRESH_MS);
  void publishExtensionCommands();
  extCommandRefreshTimer = setInterval(() => void publishExtensionCommands(), EXT_COMMAND_REFRESH_MS);
  void sweepTrash();
  trashSweepTimer = setInterval(() => void sweepTrash(), TRASH_SWEEP_MS);

  logger.info(
    { db: config.dbPath, sessions: config.sessionsDir, piBin: config.piBin },
    'piweb worker started',
  );
}

export async function stopWorker(): Promise<void> {
  if (modelRefreshTimer) clearInterval(modelRefreshTimer);
  if (extCommandRefreshTimer) clearInterval(extCommandRefreshTimer);
  if (trashSweepTimer) clearInterval(trashSweepTimer);
  const controlStopped = stopControlLoop();
  stopScheduler();
  stopArchiveCleanup();
  const titleStopped = stopSessionTitleLoop();
  const processingStopped = stopProcessingLoop();
  await controlStopped;
  await titleStopped;
  await processingStopped;
  closeDb();
  logger.info('piweb worker stopped');
}
