import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeDb: vi.fn(),
  stopControlLoop: vi.fn(),
  stopProcessingLoop: vi.fn().mockResolvedValue(undefined),
  stopSessionTitleLoop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/db.js', () => ({
  claimDeletedSessionsForPurge: vi.fn(),
  closeDb: mocks.closeDb,
  initDb: vi.fn(),
  listExpiredDeletedSessions: vi.fn(() => []),
  setMeta: vi.fn(),
}));
vi.mock('../src/session/purge.js', () => ({
  purgeSessionBatch: vi.fn(),
  recoverPendingSessionPurges: vi.fn().mockResolvedValue(0),
}));
vi.mock('../src/agent/model-catalog.js', () => ({
  listAvailableModels: vi.fn(() => []),
  primeModelRegistry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/agent/agy.js', () => ({
  listAgyModels: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../src/config.js', () => ({
  config: {
    dbPath: ':memory:',
    piBin: 'pi',
    sessionsDir: '/tmp/piweb-worker-shutdown',
    webTrashRetentionDays: 30,
  },
}));
vi.mock('../src/transport/index.js', () => ({ setTransport: vi.fn() }));
vi.mock('../src/transport/web.js', () => ({ webTransport: {} }));
vi.mock('../src/agent/queue.js', () => ({
  startProcessingLoop: vi.fn(),
  stopProcessingLoop: mocks.stopProcessingLoop,
}));
vi.mock('../src/worker/control.js', () => ({
  startControlLoop: vi.fn(),
  stopControlLoop: mocks.stopControlLoop,
}));
vi.mock('../src/worker/session-title.js', () => ({
  startSessionTitleLoop: vi.fn(),
  stopSessionTitleLoop: mocks.stopSessionTitleLoop,
}));
vi.mock('../src/agent/scheduler.js', () => ({
  startScheduler: vi.fn(() => vi.fn()),
}));
vi.mock('../src/session/archive-cleanup.js', () => ({
  startArchiveCleanup: vi.fn(() => vi.fn()),
}));

describe('worker shutdown', () => {
  it('does not close the database before the active control tick retires pi new', async () => {
    let finishControl!: () => void;
    mocks.stopControlLoop.mockReturnValue(
      new Promise<void>((resolveControl) => {
        finishControl = resolveControl;
      }),
    );

    vi.resetModules();
    const { stopWorker } = await import('../src/worker/index.js');
    let stopped = false;
    const stopping = stopWorker().then(() => {
      stopped = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));

    expect(stopped).toBe(false);
    expect(mocks.closeDb).not.toHaveBeenCalled();

    finishControl();
    await stopping;
    expect(mocks.closeDb).toHaveBeenCalledTimes(1);
  });
});
