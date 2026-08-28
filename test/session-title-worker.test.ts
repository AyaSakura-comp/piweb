import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { generateSessionTitleMock } = vi.hoisted(() => ({
  generateSessionTitleMock: vi.fn(),
}));

vi.mock('../src/agent/session-title.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/session-title.js')>()),
  generateSessionTitle: generateSessionTitleMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'PIDG_CONFIG', 'SESSIONS_DIR'];

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

describe('session title worker', () => {
  it('extracts the first completed prompt once and renames the session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piweb-title-worker-'));
    tempDirs.push(dir);
    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(dir, 'sessions');
    generateSessionTitleMock.mockResolvedValue('台南兩日遊');

    vi.resetModules();
    const db = await import('../src/db.js');
    const worker = await import('../src/worker/session-title.js');
    db.initDb();

    try {
      db.registerChannel({
        jid: 'web:title1',
        name: 'New session',
        folder: 'web_title1',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.prepareSessionTitle('web:title1');
      const messageRowid = db.enqueueMessage({
        channelJid: 'web:title1',
        sender: 'web',
        senderName: 'web',
        content: '幫我規劃台南旅行',
        timestamp: new Date().toISOString(),
      });
      db.queuePreparedSessionTitle('web:title1', '幫我規劃台南旅行', messageRowid);
      db.markMessageDone(messageRowid);

      expect(await worker.processNextSessionTitle()).toBe(true);
      expect(generateSessionTitleMock).toHaveBeenCalledTimes(1);
      expect(generateSessionTitleMock).toHaveBeenCalledWith('幫我規劃台南旅行', {
        signal: expect.any(AbortSignal),
      });
      expect(db.getChannel('web:title1')?.name).toBe('台南兩日遊');
      expect(await worker.processNextSessionTitle()).toBe(false);
    } finally {
      db.closeDb();
    }
  });

  it('returns a failed job to pending so a transient summary failure can retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piweb-title-worker-retry-'));
    tempDirs.push(dir);
    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(dir, 'sessions');
    generateSessionTitleMock.mockRejectedValueOnce(new Error('temporary extraction failure'));

    vi.resetModules();
    const db = await import('../src/db.js');
    const worker = await import('../src/worker/session-title.js');
    db.initDb();

    try {
      db.registerChannel({
        jid: 'web:title2',
        name: 'New session',
        folder: 'web_title2',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.prepareSessionTitle('web:title2');
      const messageRowid = db.enqueueMessage({
        channelJid: 'web:title2',
        sender: 'web',
        senderName: 'web',
        content: '修正登入錯誤',
        timestamp: new Date().toISOString(),
      });
      db.queuePreparedSessionTitle('web:title2', '修正登入錯誤', messageRowid);
      db.markMessageDone(messageRowid);

      expect(await worker.processNextSessionTitle()).toBe(true);
      expect(db.getSessionTitleJob('web:title2')).toMatchObject({
        attempts: 1,
        prompt: '修正登入錯誤',
        status: 'pending',
      });
      expect(db.getChannel('web:title2')?.name).toBe('New session');
    } finally {
      db.closeDb();
    }
  });
});
