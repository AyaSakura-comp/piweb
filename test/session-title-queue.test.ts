import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'PIDG_CONFIG', 'SESSIONS_DIR'];

beforeEach(() => {
  process.env.DB_PATH = ':memory:';
  const dir = mkdtempSync(join(tmpdir(), 'piweb-title-queue-'));
  tempDirs.push(dir);
  process.env.SESSIONS_DIR = resolve(dir, 'sessions');
});

afterEach(() => {
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setupSession() {
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
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
  return db;
}

describe('atomic session title DB APIs', () => {
  it('registers a new channel and prepares its title job in one public operation', async () => {
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();
    try {
      db.registerChannel(
        {
          jid: 'web:atomic-register',
          name: 'New session',
          folder: 'web_atomic_register',
          requiresTrigger: false,
          isMain: false,
          modelOverride: '',
          thinkingOverride: '',
          cwdOverride: '',
        },
        { prepareSessionTitle: true },
      );

      expect(db.getChannel('web:atomic-register')).toBeDefined();
      expect(db.getSessionTitleJob('web:atomic-register')).toMatchObject({
        prompt: '',
        message_rowid: null,
        status: 'waiting',
      });
    } finally {
      db.closeDb();
    }
  });

  it('applies the first extracted title in the same transaction as message enqueue', async () => {
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();
    try {
      db.registerChannel(
        {
          jid: 'web:immediate-title',
          name: 'New session',
          folder: 'web_immediate_title',
          requiresTrigger: false,
          isMain: false,
          modelOverride: '',
          thinkingOverride: '',
          cwdOverride: '',
        },
        { prepareSessionTitle: true },
      );

      db.enqueueMessage({
        channelJid: 'web:immediate-title',
        sender: 'web',
        senderName: 'web',
        content: '幫我規劃台南兩日旅行',
        timestamp: new Date().toISOString(),
        sessionTitlePrompt: '幫我規劃台南兩日旅行',
        immediateSessionTitle: '台南兩日旅行',
      });

      expect(db.getChannel('web:immediate-title')?.name).toBe('台南兩日旅行');
      expect(db.getSessionTitleJob('web:immediate-title')).toMatchObject({
        prompt: '',
        status: 'done',
      });
    } finally {
      db.closeDb();
    }
  });

  it('enqueues a message and captures only its title source in one public operation', async () => {
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();
    try {
      db.registerChannel(
        {
          jid: 'web:atomic-enqueue',
          name: 'New session',
          folder: 'web_atomic_enqueue',
          requiresTrigger: false,
          isMain: false,
          modelOverride: '',
          thinkingOverride: '',
          cwdOverride: '',
        },
        { prepareSessionTitle: true },
      );
      const firstRowid = db.enqueueMessage({
        channelJid: 'web:atomic-enqueue',
        sender: 'web',
        senderName: 'web',
        content: 'agent prompt with quote and attachments',
        timestamp: new Date().toISOString(),
        sessionTitlePrompt: 'typed text\n\nQuoted context:\nquoted text\n\nAttachments:\ntrace.log',
      });
      db.enqueueMessage({
        channelJid: 'web:atomic-enqueue',
        sender: 'web',
        senderName: 'web',
        content: 'later prompt',
        timestamp: new Date().toISOString(),
        sessionTitlePrompt: 'must not replace the first source',
      });

      expect(db.getSessionTitleJob('web:atomic-enqueue')).toMatchObject({
        prompt: 'typed text\n\nQuoted context:\nquoted text\n\nAttachments:\ntrace.log',
        message_rowid: firstRowid,
        status: 'pending',
      });
    } finally {
      db.closeDb();
    }
  });
});

describe('session title job queue', () => {
  it('captures only the first prompt and waits for that message to finish', async () => {
    const db = await setupSession();
    try {
      db.enqueueMessage({
        channelJid: 'web:title1',
        sender: 'web',
        senderName: 'web',
        content: '第一組 prompt',
        timestamp: new Date().toISOString(),
      });
      const firstMessage = db.claimNextMessage('web:title1');
      expect(firstMessage).toBeDefined();

      expect(db.queuePreparedSessionTitle('web:title1', '第一組 prompt', firstMessage!.rowid)).toBe(
        true,
      );
      expect(db.queuePreparedSessionTitle('web:title1', '第二組 prompt', firstMessage!.rowid)).toBe(
        false,
      );
      expect(db.claimPendingSessionTitle()).toBeUndefined();

      db.markMessageDone(firstMessage!.rowid);
      expect(db.claimPendingSessionTitle()).toMatchObject({
        channel_jid: 'web:title1',
        prompt: '第一組 prompt',
        status: 'processing',
      });
    } finally {
      db.closeDb();
    }
  });

  it('uses the literal first submitted prompt after an aborted turn becomes terminal', async () => {
    const db = await setupSession();
    try {
      const messageRowid = db.enqueueMessage({
        channelJid: 'web:title1',
        sender: 'web',
        senderName: 'web',
        content: 'first submitted prompt',
        timestamp: new Date().toISOString(),
        sessionTitlePrompt: 'first submitted prompt',
      });
      db.markMessageAborted(messageRowid);

      expect(db.claimPendingSessionTitle()).toMatchObject({
        prompt: 'first submitted prompt',
        status: 'processing',
      });
    } finally {
      db.closeDb();
    }
  });

  it('releases the title slot when an explicit reset drops the unprocessed first message', async () => {
    const db = await setupSession();
    try {
      const discardedRowid = db.enqueueMessage({
        channelJid: 'web:title1',
        sender: 'web',
        senderName: 'web',
        content: 'discard this before processing',
        timestamp: new Date().toISOString(),
        sessionTitlePrompt: 'discard this before processing',
      });

      expect(db.clearPendingMessages('web:title1')).toBe(1);
      expect(db.getSessionTitleJob('web:title1')).toMatchObject({
        prompt: '',
        message_rowid: null,
        status: 'waiting',
        attempts: 0,
      });

      const replacementRowid = db.enqueueMessage({
        channelJid: 'web:title1',
        sender: 'web',
        senderName: 'web',
        content: 'actual first completed prompt',
        timestamp: new Date().toISOString(),
        sessionTitlePrompt: 'actual first completed prompt',
      });
      expect(replacementRowid).toBeGreaterThan(discardedRowid);
      expect(db.getSessionTitleJob('web:title1')).toMatchObject({
        prompt: 'actual first completed prompt',
        message_rowid: replacementRowid,
        status: 'pending',
      });
    } finally {
      db.closeDb();
    }
  });

  it('cancels the pending title and clears its prompt when the session is soft-deleted', async () => {
    const db = await setupSession();
    try {
      db.enqueueMessage({
        channelJid: 'web:title1',
        sender: 'web',
        senderName: 'web',
        content: 'never process this prompt',
        timestamp: new Date().toISOString(),
        sessionTitlePrompt: 'never process this prompt',
      });

      db.softDeleteChannel('web:title1');

      expect(db.isChannelDeleted('web:title1')).toBe(true);
      expect(db.claimNextMessage('web:title1')).toBeUndefined();
      expect(db.getSessionTitleJob('web:title1')).toMatchObject({
        prompt: '',
        status: 'cancelled',
      });
    } finally {
      db.closeDb();
    }
  });

  it('preserves the retry budget across repeated interrupted title runs', async () => {
    const db = await setupSession();
    try {
      const messageRowid = db.enqueueMessage({
        channelJid: 'web:title1',
        sender: 'web',
        senderName: 'web',
        content: 'keep this title source',
        timestamp: new Date().toISOString(),
        sessionTitlePrompt: 'keep this title source',
      });
      db.markMessageDone(messageRowid);

      for (let restart = 0; restart < 3; restart += 1) {
        expect(db.claimPendingSessionTitle()).toMatchObject({ status: 'processing' });
        expect(db.requeueInterruptedSessionTitle('web:title1', 'worker stopping')).toBe(true);
      }

      expect(db.getSessionTitleJob('web:title1')).toMatchObject({
        prompt: 'keep this title source',
        status: 'pending',
        attempts: 0,
      });
    } finally {
      db.closeDb();
    }
  });

  it('applies the generated title and erases the title worker copy of the prompt', async () => {
    const db = await setupSession();
    try {
      const messageRowid = db.enqueueMessage({
        channelJid: 'web:title1',
        sender: 'web',
        senderName: 'web',
        content: '幫我規劃台南旅行',
        timestamp: new Date().toISOString(),
      });
      db.queuePreparedSessionTitle('web:title1', '幫我規劃台南旅行', messageRowid);
      db.markMessageDone(messageRowid);
      db.claimPendingSessionTitle();

      expect(db.completeSessionTitle('web:title1', '台南兩日遊')).toBe(true);
      expect(db.getChannel('web:title1')?.name).toBe('台南兩日遊');
      expect(db.getSessionTitleJob('web:title1')).toMatchObject({
        prompt: '',
        status: 'done',
      });
    } finally {
      db.closeDb();
    }
  });

  it('does not overwrite a manual rename made while the summary is running', async () => {
    const db = await setupSession();
    try {
      const messageRowid = db.enqueueMessage({
        channelJid: 'web:title1',
        sender: 'web',
        senderName: 'web',
        content: '幫我規劃台南旅行',
        timestamp: new Date().toISOString(),
      });
      db.queuePreparedSessionTitle('web:title1', '幫我規劃台南旅行', messageRowid);
      db.markMessageDone(messageRowid);
      db.claimPendingSessionTitle();

      db.renameChannel('web:title1', '我的旅遊計畫');
      expect(db.completeSessionTitle('web:title1', '台南兩日遊')).toBe(false);
      expect(db.getChannel('web:title1')?.name).toBe('我的旅遊計畫');
      expect(db.getSessionTitleJob('web:title1')).toMatchObject({
        prompt: '',
        status: 'cancelled',
      });
    } finally {
      db.closeDb();
    }
  });
});
