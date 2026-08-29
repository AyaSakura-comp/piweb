import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'HOME',
  'PIDG_CONFIG',
  'SESSIONS_DIR',
  'WEB_MEDIA_DIR',
  'WEB_UPLOAD_DIR',
];

afterEach(() => {
  vi.doUnmock('node:crypto');
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function openTestDb(prefix = 'piweb-life-') {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(tempDir);
  const dbPath = resolve(tempDir, 'gateway.db');
  process.env.DB_PATH = dbPath;
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
  process.env.WEB_MEDIA_DIR = resolve(tempDir, 'web-media');
  process.env.WEB_UPLOAD_DIR = resolve(tempDir, 'web-uploads');
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  return { db, dbPath };
}

describe('Life channel persistence', () => {
  it('migrates legacy channels and keeps one default-model Life channel outside session management', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-legacy-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      create table channels (
        jid               text primary key,
        name              text not null,
        folder            text not null unique,
        requires_trigger  integer not null default 1,
        is_main           integer not null default 0,
        model_override    text not null default '',
        thinking_override text not null default '',
        cwd_override      text not null default '',
        created_at        text not null default (datetime('now'))
      );
    `);
    legacy.close();

    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    try {
      db.registerChannel({
        jid: 'web:ordinary',
        name: 'Ordinary',
        folder: 'web_ordinary',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });

      const first = db.getOrCreateLifeChannel();
      expect(first).toMatchObject({
        created: true,
        channel: {
          jid: 'web:life',
          name: 'Life',
          kind: 'life',
          modelOverride: '',
          thinkingOverride: '',
        },
      });

      expect(first.channel.folder).toMatch(/^web_life_[0-9a-f]{8}$/);

      db.setChannelModelOverride(first.channel.jid, 'openai-codex/gpt-5.6-sol');
      db.setChannelThinkingOverride(first.channel.jid, 'xhigh');
      db.setChannelCwdOverride(first.channel.jid, '/stale/project');
      db.softDeleteChannel(first.channel.jid);

      const second = db.getOrCreateLifeChannel();
      expect(second.created).toBe(false);
      expect(second.channel).toMatchObject({
        jid: first.channel.jid,
        folder: first.channel.folder,
        kind: 'life',
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      expect(db.isChannelDeleted(first.channel.jid)).toBe(false);
      expect(db.listWebSessions().map((session) => session.jid)).toEqual(['web:ordinary']);
      expect(db.listDeletedWebSessions()).toEqual([]);

      const sqlite = new Database(dbPath, { readonly: true });
      try {
        const columns = sqlite.prepare('pragma table_info(channels)').all() as Array<{
          name: string;
        }>;
        expect(columns.some((column) => column.name === 'kind')).toBe(true);
        expect(
          sqlite.prepare("select count(*) as count from channels where kind = 'life'").get(),
        ).toEqual({ count: 1 });
      } finally {
        sqlite.close();
      }
    } finally {
      db.closeDb();
    }
  });

  it('fails closed when an unrelated standard session already owns the reserved Life JID', async () => {
    const { db } = await openTestDb('piweb-life-reserved-collision-');
    try {
      db.registerChannel({
        jid: 'web:life',
        name: 'Unrelated legacy chat',
        folder: 'web_unrelated_legacy',
        requiresTrigger: false,
        isMain: false,
        modelOverride: 'openai-codex/gpt-5.6-sol',
        thinkingOverride: 'xhigh',
        cwdOverride: '/legacy/project',
        kind: 'standard',
      });

      expect(() => db.getOrCreateLifeChannel()).toThrow(
        'reserved web:life JID belongs to a standard session',
      );
      expect(db.getChannel('web:life')).toMatchObject({
        name: 'Unrelated legacy chat',
        folder: 'web_unrelated_legacy',
        kind: 'standard',
        modelOverride: 'openai-codex/gpt-5.6-sol',
        thinkingOverride: 'xhigh',
        cwdOverride: '/legacy/project',
      });
    } finally {
      db.closeDb();
    }
  });

  it('atomically skips an orphaned candidate folder instead of inheriting its Pi history', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-orphan-folder-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    const sessionsDir = resolve(tempDir, 'sessions');
    const orphanDir = resolve(sessionsDir, 'web_life_deadbeef');
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(resolve(orphanDir, 'unrelated-history.jsonl'), '{"legacy":true}\n');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = sessionsDir;

    const actualCrypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce('deadbeef-0000-4000-8000-000000000000')
      .mockReturnValueOnce('cafebabe-0000-4000-8000-000000000000');
    vi.doMock('node:crypto', () => ({ ...actualCrypto, randomUUID }));
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    try {
      const life = db.getOrCreateLifeChannel();
      expect(randomUUID).toHaveBeenCalledTimes(2);
      expect(life.channel.folder).toBe('web_life_cafebabe');
      expect(readdirSync(orphanDir)).toEqual(['unrelated-history.jsonl']);
      expect(readdirSync(resolve(sessionsDir, life.channel.folder))).toEqual([]);
    } finally {
      db.closeDb();
    }
  });

  it('returns the same singleton on every ordinary entry', async () => {
    const { db } = await openTestDb();
    try {
      const first = db.getOrCreateLifeChannel();
      const second = db.getOrCreateLifeChannel();
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.channel.jid).toBe(first.channel.jid);
    } finally {
      db.closeDb();
    }
  });

  it('archives the current Life conversation as a standard session and starts empty', async () => {
    const { db } = await openTestDb('piweb-life-archive-');
    try {
      const original = db.getOrCreateLifeChannel().channel;
      db.appendWebEvent({
        channelJid: original.jid,
        kind: 'message',
        role: 'user',
        content: 'Plan a weekend trip to Tainan',
        files: ['/media/web_life/photo.png'],
      });
      db.appendWebEvent({
        channelJid: original.jid,
        kind: 'message',
        role: 'assistant',
        content: 'Here is the plan.',
      });
      const scheduledTaskId = db.addScheduledTask({
        name: 'Continue planning',
        type: 'once',
        schedule: '2099-01-01T00:00:00.000Z',
        channelJid: original.jid,
        prompt: 'Continue the plan',
        nextRunAt: '2099-01-01T00:00:00.000Z',
      });

      const mediaSource = resolve(process.env.WEB_MEDIA_DIR!, 'web_life');
      const uploadSource = resolve(process.env.WEB_UPLOAD_DIR!, 'web_life');
      mkdirSync(mediaSource, { recursive: true });
      mkdirSync(uploadSource, { recursive: true });
      writeFileSync(resolve(mediaSource, 'photo.png'), 'photo');
      writeFileSync(resolve(uploadSource, 'source.png'), 'upload');

      const result = db.archiveLifeSessionAndStartNew({
        archivedJid: 'web:archive1',
        archivedName: 'Tainan',
        expectedFolder: original.folder,
      });

      expect(result.archived).toMatchObject({
        jid: 'web:archive1',
        name: 'Tainan',
        folder: original.folder,
        kind: 'standard',
      });
      expect(result.life).toMatchObject({
        jid: 'web:life',
        name: 'Life',
        kind: 'life',
      });
      expect(result.life.folder).not.toBe(original.folder);
      expect(db.listWebSessions().map((session) => session.jid)).toEqual(['web:archive1']);
      expect(db.getRecentWebEvents('web:life')).toEqual([]);
      expect(db.getRecentWebEvents('web:archive1')).toHaveLength(2);
      expect(JSON.parse(db.getRecentWebEvents('web:archive1')[0].files!)).toEqual([
        '/media/web_archive1/photo.png',
      ]);
      expect(readdirSync(resolve(process.env.WEB_MEDIA_DIR!, 'web_archive1'))).toEqual([
        'photo.png',
      ]);
      expect(readdirSync(resolve(process.env.WEB_UPLOAD_DIR!, 'web_archive1'))).toEqual([
        'source.png',
      ]);
      expect(() => readdirSync(mediaSource)).toThrow();
      expect(() => readdirSync(uploadSource)).toThrow();
      expect(db.listScheduledTasks()).toEqual([
        expect.objectContaining({ id: scheduledTaskId, channel_jid: 'web:archive1' }),
      ]);

      // The scheduler may have fetched the task before the archive committed.
      // Enqueue must resolve its current DB owner instead of trusting that stale JID.
      db.enqueueScheduledTask(
        scheduledTaskId,
        {
          channelJid: 'web:life',
          sender: 'scheduler',
          senderName: 'Scheduler',
          content: 'Continue the plan',
          timestamp: new Date().toISOString(),
        },
        new Date().toISOString(),
        null,
      );
      expect(db.channelsWithPending()).toEqual(['web:archive1']);
      expect(() =>
        db.archiveLifeSessionAndStartNew({
          archivedJid: 'web:duplicate-new',
          archivedName: 'Must not archive fresh Life',
          expectedFolder: original.folder,
        }),
      ).toThrow('Life session changed before it could be archived');
    } finally {
      db.closeDb();
    }
  });

  it('refuses to archive Life while a request owns its current generation', async () => {
    const { db } = await openTestDb('piweb-life-archive-request-');
    try {
      const life = db.getOrCreateLifeChannel().channel;
      const operationId = db.beginChannelOperation(life.jid, life.folder);
      expect(operationId).toBeTruthy();

      expect(() =>
        db.archiveLifeSessionAndStartNew({
          archivedJid: 'web:must-wait',
          archivedName: 'Life request',
          expectedFolder: life.folder,
        }),
      ).toThrow('Life session still has active or queued work');

      db.finishChannelOperation(operationId!);
      db.archiveLifeSessionAndStartNew({
        archivedJid: 'web:after-request',
        archivedName: 'Life request',
        expectedFolder: life.folder,
      });
      expect(db.beginChannelOperation('web:life', life.folder)).toBeUndefined();
    } finally {
      db.closeDb();
    }
  });

  it('atomically rejects transcript and queue commit after an HTTP operation generation expired', async () => {
    const { db, dbPath } = await openTestDb('piweb-life-http-operation-fence-');
    try {
      const life = db.getOrCreateLifeChannel().channel;
      const operationId = db.beginChannelOperation(life.jid, life.folder)!;
      const sqlite = new Database(dbPath);
      try {
        sqlite
          .prepare("update channel_operations set updated_at = datetime('now', '-2 hours')")
          .run();
      } finally {
        sqlite.close();
      }

      db.archiveLifeSessionAndStartNew({
        archivedJid: 'web:expired-http-request',
        archivedName: 'Expired request',
        expectedFolder: life.folder,
      });
      expect(() =>
        db.commitLifeMessageOperation({
          operationId,
          channelJid: 'web:life',
          expectedFolder: life.folder,
          event: { kind: 'message', role: 'user', content: 'must not cross generations' },
          message: {
            sender: 'web',
            senderName: 'web',
            content: 'must not cross generations',
            timestamp: new Date().toISOString(),
          },
        }),
      ).toThrow('Channel generation changed');
      expect(db.getRecentWebEvents('web:life')).toEqual([]);
      expect(db.channelsWithPending()).toEqual([]);
    } finally {
      db.closeDb();
    }
  });

  it('keeps a heartbeating worker lease alive past the stale cutoff and expires a crashed one', async () => {
    const { db, dbPath } = await openTestDb('piweb-life-worker-lease-');
    try {
      const life = db.getOrCreateLifeChannel().channel;
      const operationId = db.beginChannelOperation(life.jid, life.folder);
      expect(operationId).toBeTruthy();

      const sqlite = new Database(dbPath);
      try {
        sqlite
          .prepare("update channel_operations set updated_at = datetime('now', '-2 hours') where id = ?")
          .run(operationId);
      } finally {
        sqlite.close();
      }

      expect(db.touchChannelOperation(operationId!)).toBe(true);
      expect(() =>
        db.archiveLifeSessionAndStartNew({
          archivedJid: 'web:live-worker',
          archivedName: 'Live worker',
          expectedFolder: life.folder,
        }),
      ).toThrow('Life session still has active or queued work');

      const staleSqlite = new Database(dbPath);
      try {
        staleSqlite
          .prepare("update channel_operations set updated_at = datetime('now', '-2 hours') where id = ?")
          .run(operationId);
      } finally {
        staleSqlite.close();
      }

      db.archiveLifeSessionAndStartNew({
        archivedJid: 'web:crashed-worker',
        archivedName: 'Crashed worker',
        expectedFolder: life.folder,
      });
      expect(db.getChannel('web:crashed-worker')).toMatchObject({ kind: 'standard' });
    } finally {
      db.closeDb();
    }
  });

  it.each([
    ['media', 'WEB_MEDIA_DIR'],
    ['upload', 'WEB_UPLOAD_DIR'],
  ] as const)(
    'rejects a pre-existing archived %s destination before committing DB ownership',
    async (_label, rootEnv) => {
      const { db, dbPath } = await openTestDb(`piweb-life-${rootEnv.toLowerCase()}-collision-`);
      try {
        const life = db.getOrCreateLifeChannel().channel;
        const source = resolve(process.env[rootEnv]!, 'web_life');
        const destination = resolve(process.env[rootEnv]!, 'web_collision');
        mkdirSync(source, { recursive: true });
        mkdirSync(destination, { recursive: true });
        writeFileSync(resolve(source, 'source.txt'), 'source');
        writeFileSync(resolve(destination, 'existing.txt'), 'existing');

        expect(() =>
          db.archiveLifeSessionAndStartNew({
            archivedJid: 'web:collision',
            archivedName: 'Collision',
            expectedFolder: life.folder,
          }),
        ).toThrow('Life archive destination already exists');

        expect(db.getChannel('web:life')).toMatchObject({ folder: life.folder, kind: 'life' });
        expect(db.getChannel('web:collision')).toBeUndefined();
        expect(readdirSync(source)).toEqual(['source.txt']);
        expect(readdirSync(destination)).toEqual(['existing.txt']);
        expect(readdirSync(process.env.SESSIONS_DIR!)).toEqual([life.folder]);

        const sqlite = new Database(dbPath, { readonly: true });
        try {
          expect(sqlite.prepare('select count(*) as count from life_archive_moves').get()).toEqual({
            count: 0,
          });
        } finally {
          sqlite.close();
        }
      } finally {
        db.closeDb();
      }
    },
  );

  it('recovers a committed Life re-key after an injected post-commit rename failure', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    let failUploadRename = true;
    vi.doMock('node:fs', () => ({
      ...actualFs,
      renameSync: (from: string, to: string) => {
        if (failUploadRename && from.endsWith('/web-uploads/web_life')) {
          failUploadRename = false;
          throw Object.assign(new Error('Injected post-commit upload rename failure'), {
            code: 'EIO',
          });
        }
        return actualFs.renameSync(from, to);
      },
    }));

    const { db, dbPath } = await openTestDb('piweb-life-move-recovery-');
    const life = db.getOrCreateLifeChannel().channel;
    const mediaSource = resolve(process.env.WEB_MEDIA_DIR!, 'web_life');
    const mediaDestination = resolve(process.env.WEB_MEDIA_DIR!, 'web_recovery');
    const uploadSource = resolve(process.env.WEB_UPLOAD_DIR!, 'web_life');
    const uploadDestination = resolve(process.env.WEB_UPLOAD_DIR!, 'web_recovery');
    mkdirSync(mediaSource, { recursive: true });
    mkdirSync(uploadSource, { recursive: true });
    writeFileSync(resolve(mediaSource, 'old-photo.png'), 'old media');
    writeFileSync(resolve(uploadSource, 'old-upload.png'), 'old upload');

    expect(() =>
      db.archiveLifeSessionAndStartNew({
        archivedJid: 'web:recovery',
        archivedName: 'Recovery',
        expectedFolder: life.folder,
      }),
    ).toThrow('Injected post-commit upload rename failure');

    const replacement = db.getChannel('web:life');
    expect(replacement?.folder).not.toBe(life.folder);
    expect(db.getChannel('web:recovery')).toMatchObject({
      folder: life.folder,
      kind: 'standard',
    });
    expect(existsSync(resolve(process.env.SESSIONS_DIR!, replacement!.folder))).toBe(true);
    expect(existsSync(mediaSource)).toBe(false);
    expect(readdirSync(mediaDestination)).toEqual(['old-photo.png']);
    expect(existsSync(uploadSource)).toBe(true);
    expect(existsSync(uploadDestination)).toBe(false);

    expect(db.isChannelQuarantinedForLifeArchive('web:recovery')).toBe(true);
    expect(db.isChannelQuarantinedForLifeArchive('web:life')).toBe(true);
    expect(() =>
      db.enqueueMessage({
        channelJid: 'web:recovery',
        sender: 'web',
        senderName: 'web',
        content: 'must wait',
        timestamp: new Date().toISOString(),
      }),
    ).toThrow('Life archive filesystem recovery is still pending');
    expect(() => db.enqueueControl('web:recovery', 'pi status')).toThrow(
      'Life archive filesystem recovery is still pending',
    );
    expect(() =>
      db.appendWebEvent({
        channelJid: 'web:recovery',
        kind: 'message',
        role: 'assistant',
        content: 'must wait',
      }),
    ).toThrow('Life archive filesystem recovery is still pending');
    expect(() => db.setLiveOutput('web:recovery', { content: 'must wait' })).toThrow(
      'Life archive filesystem recovery is still pending',
    );
    expect(() => db.setChannelBusy('web:recovery', true)).toThrow(
      'Life archive filesystem recovery is still pending',
    );

    let sqlite = new Database(dbPath);
    try {
      expect(sqlite.prepare('select count(*) as count from life_archive_moves').get()).toEqual({
        count: 1,
      });
      // Simulate the narrower crash boundary: rename reached disk, but its
      // completion bit did not. Destination-only must still recover as done.
      sqlite.prepare('update life_archive_moves set media_done = 0').run();
    } finally {
      sqlite.close();
    }

    // Simulate process restart after the DB commit. Startup must finish both
    // pending steps idempotently without relying on a destination collision.
    db.closeDb();
    vi.doUnmock('node:fs');
    vi.resetModules();
    const recoveredDb = await import('../src/db.js');
    recoveredDb.initDb();
    try {
      expect(readdirSync(mediaDestination)).toEqual(['old-photo.png']);
      expect(readdirSync(uploadDestination)).toEqual(['old-upload.png']);
      expect(existsSync(mediaSource)).toBe(false);
      expect(existsSync(uploadSource)).toBe(false);
      expect(recoveredDb.getChannel('web:life')).toMatchObject({
        folder: replacement!.folder,
        kind: 'life',
      });
      sqlite = new Database(dbPath, { readonly: true });
      try {
        expect(sqlite.prepare('select count(*) as count from life_archive_moves').get()).toEqual({
          count: 0,
        });
      } finally {
        sqlite.close();
      }
    } finally {
      recoveredDb.closeDb();
    }
  });

  it('blocks every processing control and fails crashed rows during worker recovery', async () => {
    const { db, dbPath } = await openTestDb('piweb-life-stale-control-');
    try {
      const life = db.getOrCreateLifeChannel().channel;
      db.enqueueControl(life.jid, 'pi status');
      expect(db.claimPendingControls()).toHaveLength(1);
      expect(() =>
        db.archiveLifeSessionAndStartNew({
          archivedJid: 'web:recent-control',
          archivedName: 'Recent control',
          expectedFolder: life.folder,
        }),
      ).toThrow('Life session still has active or queued work');

      const sqlite = new Database(dbPath);
      try {
        sqlite
          .prepare("update control_queue set processing_at = datetime('now', '-2 hours')")
          .run();
      } finally {
        sqlite.close();
      }

      // Wall-clock age cannot prove that a worker is dead: it may have been
      // suspended and could resume with stale web:life ownership. Only worker
      // startup recovery may terminalize an unfinished control.
      expect(() =>
        db.archiveLifeSessionAndStartNew({
          archivedJid: 'web:still-processing',
          archivedName: 'Still processing',
          expectedFolder: life.folder,
        }),
      ).toThrow('Life session still has active or queued work');
      expect(db.recoverStuckControls()).toBe(1);
      expect(db.getControl(1)).toMatchObject({ status: 'failed' });

      // Busy is a non-authoritative UI mirror and is cleared on archive.
      db.setChannelBusy(life.jid, true);
      db.archiveLifeSessionAndStartNew({
        archivedJid: 'web:after-control-recovery',
        archivedName: 'Recovered control',
        expectedFolder: life.folder,
      });
      expect(db.getChannel('web:after-control-recovery')).toMatchObject({ kind: 'standard' });
      expect(db.touchControlProcessing(1)).toBeUndefined();
    } finally {
      db.closeDb();
    }
  });

  it('refuses to archive Life while it has queued work', async () => {
    const { db } = await openTestDb('piweb-life-archive-busy-');
    try {
      const life = db.getOrCreateLifeChannel().channel;
      const mediaSource = resolve(process.env.WEB_MEDIA_DIR!, 'web_life');
      mkdirSync(mediaSource, { recursive: true });
      writeFileSync(resolve(mediaSource, 'still-owned.png'), 'old Life');
      db.enqueueMessage({
        channelJid: life.jid,
        sender: 'web',
        senderName: 'web',
        content: 'Still waiting',
        timestamp: new Date().toISOString(),
      });

      expect(() =>
        db.archiveLifeSessionAndStartNew({
          archivedJid: 'web:must-not-exist',
          archivedName: 'Busy Life',
          expectedFolder: life.folder,
        }),
      ).toThrow('Life session still has active or queued work');
      expect(db.getChannel('web:life')).toMatchObject({ folder: life.folder, kind: 'life' });
      expect(db.getChannel('web:must-not-exist')).toBeUndefined();
      expect(readdirSync(mediaSource)).toEqual(['still-owned.png']);
      expect(existsSync(resolve(process.env.WEB_MEDIA_DIR!, 'web_must-not-exist'))).toBe(false);
    } finally {
      db.closeDb();
    }
  });
});
