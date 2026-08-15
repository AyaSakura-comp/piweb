import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { abortRpcSessionMock, promptMock } = vi.hoisted(() => ({
  abortRpcSessionMock: vi.fn(),
  promptMock: vi.fn(),
}));

vi.mock('../src/agent/rpc-session.js', () => ({
  abortRpcSession: abortRpcSessionMock,
  closeAllRpcSessions: vi.fn(),
  getRpcSession: vi.fn(() => ({ prompt: promptMock })),
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'INTERRUPT_ON_NEW_MESSAGE',
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

describe('new message interruption in RPC mode', () => {
  it('RPC-aborts the active turn and makes the next prompt supersede the old task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piweb-rpc-interrupt-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = join(dir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PI_CWD = dir;
    process.env.RPC_STEER = 'true';
    process.env.INTERRUPT_ON_NEW_MESSAGE = 'true';

    let finishFirst!: (result: {
      ok: boolean;
      text: string;
      error: string;
      aborted: boolean;
    }) => void;
    promptMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, text: 'latest instruction completed' });
    abortRpcSessionMock.mockImplementation(() => {
      finishFirst({
        ok: false,
        text: '',
        error: 'Agent invocation aborted',
        aborted: true,
      });
      return true;
    });

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    const transport = await import('../src/transport/index.js');
    transport.setTransport({
      sendResponse: vi.fn().mockResolvedValue(true),
      sendFilesResponse: vi.fn().mockResolvedValue(true),
      sendNotice: vi.fn().mockResolvedValue(undefined),
      setTyping: vi.fn().mockResolvedValue(undefined),
      clearTyping: vi.fn().mockResolvedValue(undefined),
      createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
    });
    db.initDb();

    try {
      db.registerChannel({
        jid: 'web:interrupt',
        name: 'interrupt test',
        folder: 'web_interrupt',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.enqueueMessage({
        channelJid: 'web:interrupt',
        sender: 'web',
        senderName: 'web',
        content: 'continue the old shopping task',
        timestamp: new Date().toISOString(),
      });

      queue.startProcessingLoop();
      await vi.waitFor(() => expect(promptMock).toHaveBeenCalledTimes(1), {
        timeout: 2000,
        interval: 10,
      });

      db.enqueueMessage({
        channelJid: 'web:interrupt',
        sender: 'web',
        senderName: 'web',
        content: 'send me the screenshot now',
        timestamp: new Date().toISOString(),
      });

      await vi.waitFor(() => expect(abortRpcSessionMock).toHaveBeenCalledWith('web_interrupt'), {
        timeout: 2000,
        interval: 10,
      });
      await vi.waitFor(() => expect(promptMock).toHaveBeenCalledTimes(2), {
        timeout: 2000,
        interval: 10,
      });

      const nextPrompt = String(promptMock.mock.calls[1]?.[0]);
      expect(nextPrompt).toContain('Do not resume or continue the previous task');
      expect(nextPrompt).toContain('send me the screenshot now');

      await vi.waitFor(
        () => {
          const inspect = new Database(dbPath, { readonly: true });
          const rows = inspect
            .prepare('select status from message_queue order by rowid')
            .all() as Array<{ status: string }>;
          inspect.close();
          expect(rows.map((row) => row.status)).toEqual(['aborted', 'done']);
        },
        { timeout: 2000, interval: 10 },
      );
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });
});
