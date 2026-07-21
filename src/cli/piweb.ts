#!/usr/bin/env node
/**
 * piweb entrypoint.
 *
 *   piweb worker   → run the pi worker (host; full host access)
 *   piweb web      → run the web UI/API (container)
 *   piweb all      → both in one process (dev / all-in-one container)
 *
 * The split exists so pi keeps host privileges while the UI ships in Docker;
 * the two halves only ever meet in SQLite.
 */

import { initDb, closeDb } from '../db.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { startWebServer } from '../web/server.js';

const mode = (process.argv[2] ?? 'all').trim();

async function main(): Promise<void> {
  let stopping = false;
  let server: ReturnType<typeof startWebServer> | undefined;
  let stopWorker: (() => Promise<void>) | undefined;
  const runWorker = mode === 'worker' || mode === 'all' || (mode === 'web' && config.webEmbeddedWorker);

  if (mode === 'web' && !config.webEmbeddedWorker) {
    // The worker owns schema creation in the split deployment, but the web
    // server may well start first, so both initialise (CREATE TABLE IF NOT
    // EXISTS makes it idempotent).
    initDb();
  }

  if (runWorker) {
    // Imported lazily on purpose: the worker module pulls in the pi agent
    // packages (peer deps), which do not exist in the web container. A static
    // import would be evaluated in `web` mode too and crash the container with
    // ERR_MODULE_NOT_FOUND for '@earendil-works/pi-coding-agent'.
    const worker = await import('../worker/index.js');
    await worker.startWorker();
    stopWorker = worker.stopWorker;
  }
  if (mode === 'web' || mode === 'all') server = startWebServer();

  if (!runWorker && mode !== 'web') {
    logger.error({ mode }, 'Unknown mode — use: worker | web | all');
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');

    server?.close();
    if (stopWorker) await stopWorker();
    else closeDb();

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: err.message }, 'piweb failed to start');
  process.exit(1);
});
