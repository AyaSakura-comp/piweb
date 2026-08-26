import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { closeRpcSessionMock, invokeAgentMock, invokeAgyMock, invokeClaudeMock, sendResponseMock } =
  vi.hoisted(() => ({
    closeRpcSessionMock: vi.fn(),
    invokeAgentMock: vi.fn(),
    invokeAgyMock: vi.fn(),
    invokeClaudeMock: vi.fn(),
    sendResponseMock: vi.fn(),
  }));

vi.mock('../src/agent/invoke.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/invoke.js')>()),
  invokeAgent: invokeAgentMock,
}));
vi.mock('../src/agent/agy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/agy.js')>()),
  invokeAgy: invokeAgyMock,
}));
vi.mock('../src/agent/claude-tmux.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/claude-tmux.js')>()),
  invokeClaudeTmux: invokeClaudeMock,
}));
vi.mock('../src/agent/rpc-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/rpc-session.js')>()),
  closeRpcSession: closeRpcSessionMock,
}));
vi.mock('../src/agent/model-catalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/model-catalog.js')>()),
  listAvailableModels: () => [
    {
      ref: 'claude-code/haiku',
      provider: 'claude-code',
      id: 'haiku',
      name: 'Claude Haiku (Claude Code)',
      reasoning: true,
      supportsXhigh: true,
    },
    {
      ref: 'local-llama/qwen',
      provider: 'local-llama',
      id: 'qwen',
      name: 'Qwen',
      reasoning: true,
      supportsXhigh: true,
    },
  ],
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const KEYS = [
  'CLAUDE_TMUX_ENABLED',
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
  for (const key of KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('queue Claude tmux routing', () => {
  it('delegates enabled claude-code models to the tmux bridge before the Pi RPC path', async () => {
    await runQueuedMessage('claude-code/haiku', true, true);

    expect(invokeClaudeMock).toHaveBeenCalledTimes(1);
    expect(closeRpcSessionMock).toHaveBeenCalledWith('web_claude1');
    expect(invokeAgentMock).not.toHaveBeenCalled();
    expect(invokeAgyMock).not.toHaveBeenCalled();
    expect(invokeClaudeMock.mock.calls[0]?.[2]).toMatchObject({
      channelJid: 'web:claude1',
      model: 'claude-code/haiku',
      cwd: '/global/project',
      turnId: expect.any(Number),
    });
  });

  it('fails closed when a persisted Claude override remains after the bridge is disabled', async () => {
    await runQueuedMessage('claude-code/haiku', true, false);

    expect(invokeClaudeMock).not.toHaveBeenCalled();
    expect(invokeAgentMock).not.toHaveBeenCalled();
    expect(invokeAgyMock).not.toHaveBeenCalled();
    expect(closeRpcSessionMock).not.toHaveBeenCalled();
    expect(sendResponseMock).toHaveBeenCalledWith(
      'web:claude1',
      expect.stringMatching(/Claude Code.*disabled.*CLAUDE_TMUX_ENABLED/i),
    );
  });

  it('leaves non-Claude models on their existing path', async () => {
    await runQueuedMessage('local-llama/qwen', false, false);

    expect(invokeAgentMock).toHaveBeenCalledTimes(1);
    expect(invokeClaudeMock).not.toHaveBeenCalled();
  });
});

async function runQueuedMessage(
  modelOverride: string,
  rpcSteer: boolean,
  claudeTmuxEnabled: boolean,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-claude-routing-'));
  tempDirs.push(tempDir);
  process.env.CLAUDE_TMUX_ENABLED = claudeTmuxEnabled ? 'true' : 'false';
  process.env.DB_PATH = ':memory:';
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
  process.env.POLL_INTERVAL_MS = '1';
  process.env.MAX_CONCURRENCY = '1';
  process.env.PI_CWD = '/global/project';
  process.env.RPC_STEER = rpcSteer ? 'true' : 'false';

  invokeAgentMock.mockResolvedValue({ ok: true, text: 'pi answered' });
  invokeAgyMock.mockResolvedValue({ ok: true, text: 'agy answered' });
  invokeClaudeMock.mockResolvedValue({ ok: true, text: 'claude answered' });
  sendResponseMock.mockResolvedValue(true);

  vi.resetModules();
  const db = await import('../src/db.js');
  const queue = await import('../src/agent/queue.js');
  const transport = await import('../src/transport/index.js');
  transport.setTransport({
    sendResponse: sendResponseMock,
    sendFilesResponse: vi.fn().mockResolvedValue(true),
    setTyping: vi.fn().mockResolvedValue(undefined),
    clearTyping: vi.fn().mockResolvedValue(undefined),
    createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
  });
  db.initDb();

  try {
    db.registerChannel({
      jid: 'web:claude1',
      name: 'Claude routing test',
      folder: 'web_claude1',
      requiresTrigger: false,
      isMain: false,
      modelOverride,
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'web:claude1',
      sender: 'u1',
      senderName: 'Alice',
      content: 'hello',
      timestamp: new Date().toISOString(),
    });
    queue.startProcessingLoop();
    await vi.waitFor(() => expect(sendResponseMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
      interval: 10,
    });
  } finally {
    await queue.stopProcessingLoop({ timeoutMs: 1000 });
    db.closeDb();
  }
}
