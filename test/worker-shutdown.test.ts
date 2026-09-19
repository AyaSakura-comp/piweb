import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeDb: vi.fn(),
  stopControlLoop: vi.fn(),
  stopProcessingLoop: vi.fn().mockResolvedValue(undefined),
  stopSessionTitleLoop: vi.fn().mockResolvedValue(undefined),
  startSubscriptionLoop: vi.fn().mockResolvedValue(undefined),
  stopSubscriptionLoop: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../src/worker/subscriptions.js', () => ({
  startSubscriptionLoop: mocks.startSubscriptionLoop,
  stopSubscriptionLoop: mocks.stopSubscriptionLoop,
}));
vi.mock('../src/commands/extension-runner.js', () => ({
  discoverPiExtensionCommands: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/agent/scheduler.js', () => ({
  startScheduler: vi.fn(() => vi.fn()),
}));
vi.mock('../src/session/archive-cleanup.js', () => ({
  startArchiveCleanup: vi.fn(() => vi.fn()),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('worker subscription startup', () => {
  it('automatically retries a failed initialization and stops after recovery', async () => {
    vi.useFakeTimers();
    mocks.startSubscriptionLoop
      .mockRejectedValueOnce(new Error('initialization failed'))
      .mockResolvedValue(undefined);

    vi.resetModules();
    const { startWorker, stopWorker } = await import('../src/worker/index.js');
    await startWorker();
    expect(mocks.startSubscriptionLoop).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.startSubscriptionLoop).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mocks.startSubscriptionLoop).toHaveBeenCalledTimes(2);

    await stopWorker();
    vi.useRealTimers();
  });

  it('cancels a pending initialization retry during worker shutdown', async () => {
    vi.useFakeTimers();
    mocks.startSubscriptionLoop.mockRejectedValue(new Error('initialization failed'));

    vi.resetModules();
    const { startWorker, stopWorker } = await import('../src/worker/index.js');
    await startWorker();
    expect(mocks.startSubscriptionLoop).toHaveBeenCalledTimes(1);

    await stopWorker();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.startSubscriptionLoop).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

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
