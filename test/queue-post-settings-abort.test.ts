import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  computeEffectiveSettingsMock,
  invokeAgentMock,
  invokeAgyMock,
  sendResponseMock,
  setTypingMock,
} = vi.hoisted(() => ({
  computeEffectiveSettingsMock: vi.fn(),
  invokeAgentMock: vi.fn(),
  invokeAgyMock: vi.fn(),
  sendResponseMock: vi.fn(),
  setTypingMock: vi.fn(),
}));

vi.mock('../src/agent/channel-settings.js', () => ({
  computeEffectiveChannelSettings: computeEffectiveSettingsMock,
}));

vi.mock('../src/agent/invoke.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/invoke.js')>()),
  invokeAgent: invokeAgentMock,
}));

vi.mock('../src/agent/agy.js', () => ({
  invokeAgy: invokeAgyMock,
  isAgyModelRef: () => false,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'MAX_CONCURRENCY',
  'PIDG_CONFIG',
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

describe('queue cancellation after settings resolution', () => {
  it('does not start any turn after settings resolution loses the abort race', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-queue-settings-abort-'));
    tempDirs.push(tempDir);

    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PIDG_CONFIG = join(tempDir, 'missing-config.env');
    process.env.PI_CWD = '/global/project';
    process.env.RPC_STEER = 'false';

    let resolveSettings!: (value: Record<string, unknown>) => void;
    let turnSignal: AbortSignal | undefined;
    computeEffectiveSettingsMock.mockImplementation(
      (_channel: unknown, options: { signal: AbortSignal }) =>
        new Promise((resolvePromise) => {
          turnSignal = options.signal;
          resolveSettings = resolvePromise;
        }),
    );
    invokeAgentMock.mockResolvedValue({ ok: true, text: 'stale pi answer' });
    invokeAgyMock.mockResolvedValue({ ok: true, text: 'stale agy answer' });
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
        jid: 'web:settings-abort',
        name: 'settings abort test',
        folder: 'web_settings_abort',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.enqueueMessage({
        channelJid: 'web:settings-abort',
        sender: 'u_1',
        senderName: 'Alice',
        content: 'do not start this turn',
        timestamp: new Date().toISOString(),
      });

      queue.startProcessingLoop();
      await vi.waitFor(() => expect(computeEffectiveSettingsMock).toHaveBeenCalledTimes(1));

      expect(queue.abortChannelTask('web:settings-abort')).toMatchObject({ aborted: true });
      expect(turnSignal?.aborted).toBe(true);
      resolveSettings({
        rawModelRef: 'local-llama/qwen3.6-35b-q4',
        displayModel: 'local-llama/qwen3.6-35b-q4',
        modelInfo: undefined,
        modelSource: 'default',
        requestedThinking: 'off',
        effectiveThinking: 'off',
        hasManagedThinking: false,
        thinkingSource: 'default',
        thinkingAdjusted: false,
        effectiveCwd: '/global/project',
        cwdSource: 'default',
      });

      await vi.waitFor(() => expect(queue.isChannelProcessing('web:settings-abort')).toBe(false));
      expect(invokeAgentMock).not.toHaveBeenCalled();
      expect(invokeAgyMock).not.toHaveBeenCalled();
      expect(sendResponseMock).not.toHaveBeenCalled();
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1_000 });
      db.closeDb();
    }
  });
});
