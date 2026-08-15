import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { promptMock } = vi.hoisted(() => ({ promptMock: vi.fn() }));

vi.mock('../src/agent/rpc-session.js', () => ({
  abortRpcSession: vi.fn(),
  closeAllRpcSessions: vi.fn(),
  getRpcSession: vi.fn(() => ({ prompt: promptMock })),
}));

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
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('queue RPC abort handling', () => {
  it('records an aborted prompt without sending an agent response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piweb-queue-abort-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = join(dir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PI_CWD = dir;
    process.env.RPC_STEER = 'true';
    promptMock.mockResolvedValue({
      ok: false,
      text: '',
      error: 'Agent invocation aborted',
      aborted: true,
    });

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    const transport = await import('../src/transport/index.js');
    const sendResponse = vi.fn().mockResolvedValue(true);
    transport.setTransport({
      sendResponse,
      sendFilesResponse: vi.fn().mockResolvedValue(true),
      setTyping: vi.fn().mockResolvedValue(undefined),
      clearTyping: vi.fn().mockResolvedValue(undefined),
      createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
    });
    db.initDb();

    try {
      db.registerChannel({
        jid: 'web:abort',
        name: 'abort test',
        folder: 'web_abort',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.enqueueMessage({
        channelJid: 'web:abort',
        sender: 'web',
        senderName: 'web',
        content: 'keep this prompt',
        timestamp: new Date().toISOString(),
      });

      queue.startProcessingLoop();
      await vi.waitFor(
        () => {
          const inspect = new Database(dbPath, { readonly: true });
          const row = inspect.prepare('select status from message_queue limit 1').get() as {
            status: string;
          };
          inspect.close();
          expect(row.status).toBe('aborted');
        },
        { timeout: 2000, interval: 10 },
      );
      expect(sendResponse).not.toHaveBeenCalled();
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });
});
