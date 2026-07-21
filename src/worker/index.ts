/**
 * Worker entrypoint — runs pi.
 *
 * In the default deployment this runs on the HOST (systemd user unit) rather
 * than in the container, so pi keeps the host access that makes it useful here:
 * systemctl, docker, the ROCm GPU, and the project checkouts under ~/src. The
 * web server in Docker talks to it purely through the shared SQLite database.
 */

import { initDb, closeDb, setMeta } from '../db.js';
import { listAvailableModels } from '../agent/model-catalog.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { setTransport } from '../transport/index.js';
import { webTransport } from '../transport/web.js';
import { startProcessingLoop, stopProcessingLoop } from '../agent/queue.js';
import { startControlLoop, stopControlLoop } from './control.js';
import { startScheduler } from '../agent/scheduler.js';
import { startArchiveCleanup } from '../session/archive-cleanup.js';

// Both of these return their own stop function rather than exporting one.
let stopScheduler: () => void = () => {};
let stopArchiveCleanup: () => void = () => {};
let modelRefreshTimer: NodeJS.Timeout | undefined;

const MODEL_REFRESH_MS = 10 * 60 * 1000;

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

export async function startWorker(): Promise<void> {
  initDb();
  setTransport(webTransport);

  startProcessingLoop();
  startControlLoop();
  stopScheduler = startScheduler();
  stopArchiveCleanup = startArchiveCleanup();
  publishModelCatalog();
  modelRefreshTimer = setInterval(publishModelCatalog, MODEL_REFRESH_MS);

  logger.info(
    { db: config.dbPath, sessions: config.sessionsDir, piBin: config.piBin },
    'piweb worker started',
  );
}

export async function stopWorker(): Promise<void> {
  if (modelRefreshTimer) clearInterval(modelRefreshTimer);
  stopControlLoop();
  stopScheduler();
  stopArchiveCleanup();
  await stopProcessingLoop();
  closeDb();
  logger.info('piweb worker stopped');
}
