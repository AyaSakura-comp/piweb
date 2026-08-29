import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A message sent while a run is in flight must interrupt it (piweb's web tier
 * only enqueues, so the trigger has to run in the worker's poll loop, not the
 * old Discord handler).
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

describe('interrupt on new message', () => {
  it('aborts an in-flight run when a newer message arrives for the same channel', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-interrupt-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.INTERRUPT_ON_NEW_MESSAGE = 'true';
    process.env.RPC_STEER = 'false';

    // First run blocks until its abort signal fires, so a second message has
    // time to arrive mid-run. It records whether it was aborted.
    let firstAborted = false;
    invokeAgentMock.mockImplementationOnce(
      (_folder: string, _prompt: string, opts: any) =>
        new Promise((resolveRun) => {
          opts.signal.addEventListener('abort', () => {
            firstAborted = true;
            resolveRun({ ok: false, text: '', error: 'aborted' });
          });
        }),
    );
    invokeAgentMock.mockResolvedValue({ ok: true, text: 'second reply' });

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    const transport = await import('../src/transport/index.js');
    transport.setTransport({
      sendResponse: vi.fn().mockResolvedValue(true),
      sendFilesResponse: vi.fn().mockResolvedValue(true),
      setTyping: vi.fn().mockResolvedValue(undefined),
      clearTyping: vi.fn().mockResolvedValue(undefined),
      createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
    });
    db.initDb();

    try {
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
      const msg = (content: string) =>
        db.enqueueMessage({
          channelJid: 'web:abc',
          sender: 'web',
          senderName: 'web',
          content,
          timestamp: new Date().toISOString(),
        });

      msg('first — long running');
      queue.startProcessingLoop();

      // wait until the first run is actually in flight
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(1), {
        timeout: 2000,
        interval: 5,
      });

      // second message arrives mid-run → must interrupt the first
      msg('second — interrupts');

      await vi.waitFor(() => expect(firstAborted).toBe(true), { timeout: 2000, interval: 5 });

      // and the second message then runs
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(2), {
        timeout: 2000,
        interval: 5,
      });
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });

  it('queues a scheduled prompt without interrupting an in-flight user turn', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-scheduler-interrupt-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.INTERRUPT_ON_NEW_MESSAGE = 'true';
    process.env.RPC_STEER = 'false';

    let firstAborted = false;
    let releaseFirst: () => void = () => {};
    invokeAgentMock.mockImplementationOnce(
      (_folder: string, _prompt: string, opts: any) =>
        new Promise((resolveRun) => {
          opts.signal.addEventListener('abort', () => {
            firstAborted = true;
          });
          releaseFirst = () => resolveRun({ ok: true, text: 'first reply' });
        }),
    );
    invokeAgentMock.mockResolvedValue({ ok: true, text: 'scheduled reply' });

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    const transport = await import('../src/transport/index.js');
    transport.setTransport({
      sendResponse: vi.fn().mockResolvedValue(true),
      sendFilesResponse: vi.fn().mockResolvedValue(true),
      setTyping: vi.fn().mockResolvedValue(undefined),
      clearTyping: vi.fn().mockResolvedValue(undefined),
      createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
    });
    db.initDb();

    try {
      db.registerChannel({
        jid: 'web:cron',
        name: 'cron test',
        folder: 'web_cron',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.enqueueMessage({
        channelJid: 'web:cron',
        sender: 'web',
        senderName: 'web',
        content: 'long user turn',
        timestamp: new Date().toISOString(),
      });
      queue.startProcessingLoop();
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(1), {
        timeout: 2000,
        interval: 5,
      });

      const scheduledTaskId = db.addScheduledTask({
        name: 'queued cron test',
        type: 'once',
        schedule: new Date().toISOString(),
        channelJid: 'web:cron',
        prompt: 'scheduled prompt',
        nextRunAt: new Date().toISOString(),
      });
      db.enqueueScheduledTask(
        scheduledTaskId,
        {
          channelJid: 'web:cron',
          sender: 'scheduler',
          senderName: 'Scheduler',
          content: 'scheduled prompt',
          timestamp: new Date().toISOString(),
        },
        new Date().toISOString(),
        null,
      );

      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      expect(firstAborted).toBe(false);
      expect(invokeAgentMock).toHaveBeenCalledTimes(1);

      releaseFirst();
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(2), {
        timeout: 2000,
        interval: 5,
      });
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });

  it('does not interrupt when INTERRUPT_ON_NEW_MESSAGE is off (message queues)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-interrupt-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.INTERRUPT_ON_NEW_MESSAGE = 'false';
    process.env.RPC_STEER = 'false';

    let firstAborted = false;
    let releaseFirst: () => void = () => {};
    invokeAgentMock.mockImplementationOnce(
      (_folder: string, _prompt: string, opts: any) =>
        new Promise((resolveRun) => {
          opts.signal.addEventListener('abort', () => {
            firstAborted = true;
          });
          releaseFirst = () => resolveRun({ ok: true, text: 'first reply' });
        }),
    );
    invokeAgentMock.mockResolvedValue({ ok: true, text: 'second reply' });

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    const transport = await import('../src/transport/index.js');
    transport.setTransport({
      sendResponse: vi.fn().mockResolvedValue(true),
      sendFilesResponse: vi.fn().mockResolvedValue(true),
      setTyping: vi.fn().mockResolvedValue(undefined),
      clearTyping: vi.fn().mockResolvedValue(undefined),
      createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
    });
    db.initDb();

    try {
      db.registerChannel({
        jid: 'web:def',
        name: 't',
        folder: 'web_def',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      const msg = (content: string) =>
        db.enqueueMessage({
          channelJid: 'web:def',
          sender: 'web',
          senderName: 'web',
          content,
          timestamp: new Date().toISOString(),
        });

      msg('first');
      queue.startProcessingLoop();
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(1), {
        timeout: 2000,
        interval: 5,
      });

      msg('second');
      // give the poll loop a few cycles; the first must NOT be aborted
      await new Promise((r) => setTimeout(r, 100));
      expect(firstAborted).toBe(false);
      expect(invokeAgentMock).toHaveBeenCalledTimes(1); // second still queued

      releaseFirst();
      await vi.waitFor(() => expect(invokeAgentMock).toHaveBeenCalledTimes(2), {
        timeout: 2000,
        interval: 5,
      });
    } finally {
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      db.closeDb();
    }
  });
});
