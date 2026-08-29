import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { computeEffectiveChannelSettingsMock, invokeAgentMock } = vi.hoisted(() => ({
  computeEffectiveChannelSettingsMock: vi.fn().mockResolvedValue({
    rawModelRef: '',
    displayModel: '',
    modelInfo: undefined,
    modelSource: 'pi runtime default',
    requestedThinking: 'off',
    effectiveThinking: 'off',
    hasManagedThinking: true,
    thinkingSource: 'pi runtime default',
    thinkingAdjusted: false,
    effectiveCwd: '/tmp',
    cwdSource: 'default',
  }),
  invokeAgentMock: vi.fn(),
}));

vi.mock('../src/agent/invoke.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/invoke.js')>()),
  invokeAgent: invokeAgentMock,
}));

vi.mock('../src/agent/channel-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/channel-settings.js')>()),
  computeEffectiveChannelSettings: computeEffectiveChannelSettingsMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'MAX_CONCURRENCY',
  'PIDG_CONFIG',
  'POLL_INTERVAL_MS',
  'RPC_STEER',
  'SESSIONS_DIR',
  'WEB_MEDIA_DIR',
  'WEB_UPLOAD_DIR',
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

describe('Life worker ownership', () => {
  it('blocks archive after the queue row is terminal until final stream and typing cleanup finishes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-worker-owner-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_MEDIA_DIR = resolve(tempDir, 'web-media');
    process.env.WEB_UPLOAD_DIR = resolve(tempDir, 'web-uploads');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.RPC_STEER = 'false';

    invokeAgentMock.mockResolvedValue({ ok: true, text: 'finished answer' });

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    const transport = await import('../src/transport/index.js');
    db.initDb();

    let releaseTypingCleanup!: () => void;
    const typingCleanupGate = new Promise<void>((resolveGate) => {
      releaseTypingCleanup = resolveGate;
    });
    const clearTyping = vi.fn(async (jid: string) => {
      await typingCleanupGate;
      db.clearLiveOutput(jid);
      db.setChannelBusy(jid, false);
    });

    transport.setTransport({
      sendResponse: vi.fn(async (jid, text) => {
        db.appendWebEvent({ channelJid: jid, kind: 'message', role: 'assistant', content: text });
        return true;
      }),
      sendFilesResponse: vi.fn().mockResolvedValue(true),
      setTyping: vi.fn(async (jid) => db.setChannelBusy(jid, true)),
      clearTyping,
      createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
    });

    const life = db.getOrCreateLifeChannel().channel;
    const rowid = db.enqueueMessage({
      channelJid: life.jid,
      sender: 'web',
      senderName: 'web',
      content: 'finish then clean up',
      timestamp: new Date().toISOString(),
    });

    const sqlite = new Database(dbPath, { readonly: true });
    try {
      queue.startProcessingLoop();
      await vi.waitFor(() => expect(clearTyping).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(
          sqlite.prepare('select status from message_queue where rowid = ?').get(rowid),
        ).toEqual({ status: 'done' }),
      );

      expect(() =>
        db.archiveLifeSessionAndStartNew({
          archivedJid: 'web:too-early',
          archivedName: 'Too early',
          expectedFolder: life.folder,
        }),
      ).toThrow('Life session still has active or queued work');

      releaseTypingCleanup();
      await vi.waitFor(() => expect(queue.isChannelProcessing(life.jid)).toBe(false));

      db.archiveLifeSessionAndStartNew({
        archivedJid: 'web:after-cleanup',
        archivedName: 'After cleanup',
        expectedFolder: life.folder,
      });
      expect(db.getChannel('web:after-cleanup')).toMatchObject({ kind: 'standard' });
      expect(db.getChannel('web:life')?.folder).not.toBe(life.folder);
    } finally {
      releaseTypingCleanup();
      await queue.stopProcessingLoop({ timeoutMs: 1_000 });
      sqlite.close();
      db.closeDb();
    }
  });

  it('fences a terminal worker that resumes after its Life lease expired and rotated', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-worker-fence-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_MEDIA_DIR = resolve(tempDir, 'web-media');
    process.env.WEB_UPLOAD_DIR = resolve(tempDir, 'web-uploads');
    process.env.POLL_INTERVAL_MS = '1';
    process.env.MAX_CONCURRENCY = '1';
    process.env.PIDG_CONFIG = resolve(tempDir, 'missing.env');
    process.env.RPC_STEER = 'false';

    invokeAgentMock.mockResolvedValue({ ok: true, text: 'old generation answer' });

    vi.resetModules();
    const db = await import('../src/db.js');
    const queue = await import('../src/agent/queue.js');
    const transport = await import('../src/transport/index.js');
    db.initDb();

    let releaseTypingCleanup!: () => void;
    const typingCleanupGate = new Promise<void>((resolveGate) => {
      releaseTypingCleanup = resolveGate;
    });
    const clearTyping = vi.fn(
      async (jid: string, fence?: { expectedFolder?: string }) => {
        await typingCleanupGate;
        try {
          db.clearLiveOutput(jid, fence);
          db.setChannelBusy(jid, false, fence);
        } catch {
          // A fenced stale worker is expected to lose this write.
        }
      },
    );

    const sendNotice = vi.fn().mockResolvedValue(undefined);
    transport.setTransport({
      sendResponse: vi.fn(async (jid, text) => {
        db.appendWebEvent({ channelJid: jid, kind: 'message', role: 'assistant', content: text });
        return true;
      }),
      sendFilesResponse: vi.fn().mockResolvedValue(true),
      sendNotice,
      setTyping: vi.fn(async (jid) => db.setChannelBusy(jid, true)),
      clearTyping,
      createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
    });

    const life = db.getOrCreateLifeChannel().channel;
    db.enqueueMessage({
      channelJid: life.jid,
      sender: 'web',
      senderName: 'web',
      content: 'pause after terminal status',
      timestamp: new Date().toISOString(),
    });

    const sqlite = new Database(dbPath);
    try {
      queue.startProcessingLoop();
      await vi.waitFor(() => expect(clearTyping).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(
          sqlite.prepare("select status from message_queue where channel_jid = 'web:life'").get(),
        ).toEqual({ status: 'done' }),
      );

      sqlite
        .prepare("update channel_operations set updated_at = datetime('now', '-2 hours')")
        .run();
      db.archiveLifeSessionAndStartNew({
        archivedJid: 'web:expired-worker',
        archivedName: 'Expired worker',
        expectedFolder: life.folder,
      });

      const fresh = db.getChannel('web:life')!;
      db.setLiveOutput('web:life', { content: 'fresh generation partial' });
      db.setChannelBusy('web:life', true);
      db.enqueueMessage({
        channelJid: 'web:life',
        sender: 'web',
        senderName: 'web',
        content: 'fresh generation pending turn',
        timestamp: new Date().toISOString(),
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(sendNotice).not.toHaveBeenCalled();
      expect(db.clearPendingMessages('web:life')).toBe(1);

      releaseTypingCleanup();
      await vi.waitFor(() => expect(queue.isChannelProcessing('web:life')).toBe(false));

      expect(fresh.folder).not.toBe(life.folder);
      expect(db.getLiveOutput('web:life')).toMatchObject({ content: 'fresh generation partial' });
      expect(db.isChannelBusy('web:life')).toBe(true);
    } finally {
      releaseTypingCleanup();
      await queue.stopProcessingLoop({ timeoutMs: 1_000 });
      sqlite.close();
      db.closeDb();
    }
  });
});
