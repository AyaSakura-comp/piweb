import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A run killed by SIGTERM (exit 143) — worker restart or OOM, NOT a user
 * interrupt — must be re-queued and auto-resumed against the same session,
 * not dropped with "send it again". Capped so a message that reliably kills
 * pi can't loop forever.
 */

const { invokeAgentMock } = vi.hoisted(() => ({ invokeAgentMock: vi.fn() }));

vi.mock('../src/agent/invoke.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/invoke.js')>()),
  invokeAgent: invokeAgentMock,
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-sigterm-'));
  tempDirs.push(tempDir);
  process.env.DB_PATH = ':memory:';
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
  process.env.POLL_INTERVAL_MS = '1';
  process.env.MAX_CONCURRENCY = '1';
  process.env.INTERRUPT_ON_NEW_MESSAGE = 'false';
  process.env.RPC_STEER = 'false';

  vi.resetModules();
  const db = await import('../src/db.js');
  const queue = await import('../src/agent/queue.js');
  const transport = await import('../src/transport/index.js');
  const sendNotice = vi.fn().mockResolvedValue(undefined);
  transport.setTransport({
    sendResponse: vi.fn().mockResolvedValue(true),
    sendFilesResponse: vi.fn().mockResolvedValue(true),
    sendNotice,
    setTyping: vi.fn().mockResolvedValue(undefined),
    clearTyping: vi.fn().mockResolvedValue(undefined),
    createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
  });
  db.initDb();
  db.registerChannel({
    jid: 'web:abc',
    name: 't',
    folder: 'web_abc',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  db.enqueueMessage({
    channelJid: 'web:abc',
    sender: 'web',
    senderName: 'web',
    content: 'do the thing',
    timestamp: new Date().toISOString(),
  });
  return { db, queue, sendNotice };
}

describe('SIGTERM requeue', () => {
  it('re-queues a SIGTERM-killed message and auto-resumes, then completes', async () => {
    const { db, queue, sendNotice } = await setup();

    // First attempt is killed (143); the retry succeeds.
    invokeAgentMock.mockResolvedValueOnce({ ok: false, text: '', error: 'pi exited with code 143' });
    invokeAgentMock.mockResolvedValue({ ok: true, text: 'done' });

    try {
      queue.startProcessingLoop();
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(2), {
        timeout: 2000,
        interval: 5,
      });
      // The killed attempt was NOT surfaced as a failure notice; it just resumed.
      expect(sendNotice).not.toHaveBeenCalled();
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });

  it('re-queues when rpc session exits with code 143', async () => {
    const { db, queue, sendNotice } = await setup();

    // RPC session format: "pi rpc session exited (code 143)"
    invokeAgentMock.mockResolvedValueOnce({ ok: false, text: '', error: 'pi rpc session exited (code 143)' });
    invokeAgentMock.mockResolvedValue({ ok: true, text: 'done' });

    try {
      queue.startProcessingLoop();
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(2), {
        timeout: 2000,
        interval: 5,
      });
      expect(sendNotice).not.toHaveBeenCalled();
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });

  it('gives up after the retry cap and notifies', async () => {
    const { db, queue, sendNotice } = await setup();

    // Always killed → should stop after MAX_SIGTERM_RETRIES (2) retries = 3 calls.
    invokeAgentMock.mockResolvedValue({ ok: false, text: '', error: 'pi exited with code 143' });

    try {
      queue.startProcessingLoop();
      await vi.waitFor(() => expect(sendNotice).toHaveBeenCalledTimes(1), {
        timeout: 3000,
        interval: 5,
      });
      // 1 initial + 2 retries = 3 invocations before giving up.
      expect(invokeAgentMock).toHaveBeenCalledTimes(3);
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });
});
