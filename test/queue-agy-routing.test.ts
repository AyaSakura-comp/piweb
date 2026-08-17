import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeAgentMock, invokeAgyMock, sendResponseMock, setTypingMock } = vi.hoisted(() => ({
  invokeAgentMock: vi.fn(),
  invokeAgyMock: vi.fn(),
  sendResponseMock: vi.fn(),
  setTypingMock: vi.fn(),
}));

vi.mock('../src/agent/invoke.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/invoke.js')>()),
  invokeAgent: invokeAgentMock,
}));

// Only the spawn side is stubbed; isAgyModelRef stays real so the routing
// decision under test is the production one.
vi.mock('../src/agent/agy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/agy.js')>()),
  invokeAgy: invokeAgyMock,
}));

// The channel's model override is the routing input; stub the catalog so the
// test neither spawns agy nor depends on which models this host can reach.
vi.mock('../src/agent/model-catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/model-catalog.js')>();
  return {
    ...actual,
    listAvailableModels: () => [
      {
        ref: 'agy/gemini-3.1-pro-high',
        provider: 'agy',
        id: 'gemini-3.1-pro-high',
        name: 'Gemini 3.1 Pro (High)',
        reasoning: true,
        supportsXhigh: false,
      },
      {
        ref: 'local-llama/qwen3.6-35b-q4',
        provider: 'local-llama',
        id: 'qwen3.6-35b-q4',
        name: 'Qwen 3.6 35B',
        reasoning: true,
        supportsXhigh: true,
      },
    ],
  };
});

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'MAX_CONCURRENCY',
  'PI_CWD',
  'POLL_INTERVAL_MS',
  'RPC_STEER',
  'SESSIONS_DIR',
];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('queue agy routing', () => {
  it('sends a turn on an agy model to the agy bridge, not to pi', async () => {
    await runQueuedMessage('agy/gemini-3.1-pro-high');

    expect(invokeAgyMock).toHaveBeenCalledTimes(1);
    expect(invokeAgentMock).not.toHaveBeenCalled();

    const opts = invokeAgyMock.mock.calls[0]?.[2] as { model?: string; cwd?: string };
    expect(opts.model).toBe('agy/gemini-3.1-pro-high');
    expect(opts.cwd).toBe('/global/project');
  });

  it('leaves every other model on the pi path', async () => {
    await runQueuedMessage('local-llama/qwen3.6-35b-q4');

    expect(invokeAgentMock).toHaveBeenCalledTimes(1);
    expect(invokeAgyMock).not.toHaveBeenCalled();
  });

  it('routes to agy even when RPC steering is enabled, since agy has no RPC mode', async () => {
    await runQueuedMessage('agy/gemini-3.1-pro-high', { rpcSteer: true });

    expect(invokeAgyMock).toHaveBeenCalledTimes(1);
    expect(invokeAgentMock).not.toHaveBeenCalled();
  });
});

async function runQueuedMessage(
  modelOverride: string,
  options: { rpcSteer?: boolean } = {},
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-agy-routing-'));
  tempDirs.push(tempDir);

  process.env.DB_PATH = ':memory:';
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
  process.env.POLL_INTERVAL_MS = '1';
  process.env.MAX_CONCURRENCY = '1';
  process.env.PI_CWD = '/global/project';
  process.env.RPC_STEER = options.rpcSteer ? 'true' : 'false';

  invokeAgentMock.mockResolvedValue({ ok: true, text: 'pi answered' });
  invokeAgyMock.mockResolvedValue({ ok: true, text: 'agy answered' });
  sendResponseMock.mockResolvedValue(true);
  setTypingMock.mockResolvedValue(undefined);

  vi.resetModules();
  const db = await import('../src/db.js');
  const queue = await import('../src/agent/queue.js');
  const transport = await import('../src/transport/index.js');

  transport.setTransport({
    sendResponse: sendResponseMock,
    sendFilesResponse: vi.fn().mockResolvedValue(true),
    setTyping: setTypingMock,
    clearTyping: vi.fn().mockResolvedValue(undefined),
    createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
  });

  db.initDb();

  try {
    db.registerChannel({
      jid: 'web:agy1',
      name: 'agy routing test',
      folder: 'web_agy1',
      requiresTrigger: false,
      isMain: false,
      modelOverride,
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'web:agy1',
      sender: 'u_1',
      senderName: 'Alice',
      content: 'hello',
      timestamp: new Date().toISOString(),
    });

    queue.startProcessingLoop();
    await vi.waitFor(
      () => {
        expect(sendResponseMock).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000, interval: 10 },
    );
  } finally {
    await queue.stopProcessingLoop({ timeoutMs: 1000 });
    db.closeDb();
  }
}
