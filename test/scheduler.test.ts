import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const originalDbPath = process.env.DB_PATH;

describe('computeNextRun', () => {
  it('returns a future date for a cron expression', async () => {
    vi.resetModules();
    const { computeNextRun } = await import('../src/agent/scheduler.js');

    const nextRun = computeNextRun('* * * * *', 'recurring');

    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun ?? '').getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for a past ISO one-time schedule', async () => {
    vi.resetModules();
    const { computeNextRun } = await import('../src/agent/scheduler.js');

    const nextRun = computeNextRun(new Date(Date.now() - 60_000).toISOString(), 'once');

    expect(nextRun).toBeNull();
  });

  it('returns the original future ISO one-time schedule', async () => {
    vi.resetModules();
    const { computeNextRun } = await import('../src/agent/scheduler.js');
    const futureIso = new Date(Date.now() + 60_000).toISOString();

    const nextRun = computeNextRun(futureIso, 'once');

    expect(nextRun).toBe(futureIso);
  });
});

describe('scheduled task db helpers', () => {
  it('does not enqueue a stale fetched task after its authoritative row was deleted', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();

    const db = await import('../src/db.js');
    db.initDb();

    try {
      const id = db.addScheduledTask({
        name: 'Deleted task',
        type: 'once',
        schedule: new Date().toISOString(),
        channelJid: 'web:old-owner',
        prompt: 'must not run',
        nextRunAt: new Date().toISOString(),
      });

      // Simulate the scheduler having fetched the row before another request
      // deleted it. The stale caller JID is not an ownership fallback.
      expect(db.removeScheduledTask(id)).toBe(true);
      db.enqueueScheduledTask(
        id,
        {
          channelJid: 'web:old-owner',
          sender: 'scheduler',
          senderName: 'Scheduler',
          content: 'must not run',
          timestamp: new Date().toISOString(),
        },
        new Date().toISOString(),
        null,
      );

      expect(db.channelsWithPending()).toEqual([]);
    } finally {
      db.closeDb();
      vi.resetModules();

      if (originalDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = originalDbPath;
    }
  });

  it('does not enqueue or expose due scheduled work while its session is trashed', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    try {
      db.registerChannel({
        jid: 'web:trashed-schedule',
        name: 'Trashed schedule',
        folder: 'trashed-schedule',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
        kind: 'standard',
      });
      const due = new Date(Date.now() - 60_000).toISOString();
      const taskId = db.addScheduledTask({
        name: 'Frozen task',
        type: 'recurring',
        schedule: '* * * * *',
        channelJid: 'web:trashed-schedule',
        prompt: 'must stay frozen',
        nextRunAt: due,
      });
      db.softDeleteChannel('web:trashed-schedule');

      expect(db.getDueScheduledTasks()).toEqual([]);
      expect(
        db.enqueueScheduledTask(
          taskId,
          {
            channelJid: 'web:trashed-schedule',
            sender: 'scheduler',
            senderName: 'Scheduler',
            content: 'must stay frozen',
            timestamp: new Date().toISOString(),
          },
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ).toBe(false);
      expect(db.channelsWithPending()).toEqual([]);
      expect(db.claimNextMessage('web:trashed-schedule')).toBeUndefined();
    } finally {
      db.closeDb();
      vi.resetModules();
      if (originalDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = originalDbPath;
    }
  });

  it('defers an archived Life task without advancing its schedule, then resumes after recovery', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-scheduler-life-quarantine-'));
    const previousEnv = {
      DB_PATH: process.env.DB_PATH,
      SESSIONS_DIR: process.env.SESSIONS_DIR,
      WEB_MEDIA_DIR: process.env.WEB_MEDIA_DIR,
      WEB_UPLOAD_DIR: process.env.WEB_UPLOAD_DIR,
    };
    const dbPath = resolve(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_MEDIA_DIR = resolve(tempDir, 'media');
    process.env.WEB_UPLOAD_DIR = resolve(tempDir, 'uploads');
    vi.resetModules();

    const db = await import('../src/db.js');
    db.initDb();

    try {
      db.registerChannel({
        jid: 'web:archived-task',
        name: 'Archived task owner',
        folder: 'web_life_original',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
        kind: 'standard',
      });
      const originalNextRun = new Date(Date.now() - 60_000).toISOString();
      const taskId = db.addScheduledTask({
        name: 'Deferred task',
        type: 'once',
        schedule: originalNextRun,
        channelJid: 'web:archived-task',
        prompt: 'run only after recovery',
        nextRunAt: originalNextRun,
      });

      const sqlite = new Database(dbPath);
      try {
        sqlite
          .prepare(
            `insert into life_archive_moves
              (id, archived_jid, new_life_folder, media_required, upload_required,
               folder_done, media_done, upload_done)
             values ('pending-task-move', 'web:archived-task', 'web_life_fresh000', 0, 0, 0, 1, 1)`,
          )
          .run();
      } finally {
        sqlite.close();
      }

      const lastRunAt = new Date().toISOString();
      expect(
        db.enqueueScheduledTask(
          taskId,
          {
            channelJid: 'web:life',
            sender: 'scheduler',
            senderName: 'Scheduler',
            content: 'run only after recovery',
            timestamp: lastRunAt,
          },
          lastRunAt,
          null,
        ),
      ).toBe(false);
      expect(db.channelsWithPending()).toEqual([]);
      expect(db.listScheduledTasks()[0]).toMatchObject({
        enabled: 1,
        last_run_at: null,
        next_run_at: originalNextRun.slice(0, 19).replace('T', ' '),
      });

      expect(db.recoverLifeArchiveMoves()).toBe(1);
      expect(
        db.enqueueScheduledTask(
          taskId,
          {
            channelJid: 'web:life',
            sender: 'scheduler',
            senderName: 'Scheduler',
            content: 'run only after recovery',
            timestamp: lastRunAt,
          },
          lastRunAt,
          null,
        ),
      ).toBe(true);
      expect(db.channelsWithPending()).toEqual(['web:archived-task']);
      expect(db.listScheduledTasks()[0]).toMatchObject({
        enabled: 0,
        last_run_at: lastRunAt.slice(0, 19).replace('T', ' '),
        next_run_at: null,
      });
    } finally {
      db.closeDb();
      vi.resetModules();
      rmSync(tempDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('does not let a quarantined due task starve an unrelated task at the concurrency limit', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-scheduler-quarantine-fairness-'));
    const previousEnv = {
      DB_PATH: process.env.DB_PATH,
      MAX_SCHEDULED_CONCURRENCY: process.env.MAX_SCHEDULED_CONCURRENCY,
      SESSIONS_DIR: process.env.SESSIONS_DIR,
      WEB_MEDIA_DIR: process.env.WEB_MEDIA_DIR,
      WEB_UPLOAD_DIR: process.env.WEB_UPLOAD_DIR,
    };
    const dbPath = resolve(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.MAX_SCHEDULED_CONCURRENCY = '1';
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_MEDIA_DIR = resolve(tempDir, 'media');
    process.env.WEB_UPLOAD_DIR = resolve(tempDir, 'uploads');
    vi.resetModules();

    const db = await import('../src/db.js');
    const scheduler = await import('../src/agent/scheduler.js');
    db.initDb();

    try {
      for (const [jid, folder] of [
        ['web:quarantined', 'web_quarantined'],
        ['web:ready', 'web_ready'],
      ]) {
        db.registerChannel({
          jid,
          name: jid,
          folder,
          requiresTrigger: false,
          isMain: false,
          modelOverride: '',
          thinkingOverride: '',
          cwdOverride: '',
          kind: 'standard',
        });
      }

      const due = new Date(Date.now() - 60_000).toISOString();
      db.addScheduledTask({
        name: 'blocked first',
        type: 'once',
        schedule: due,
        channelJid: 'web:quarantined',
        prompt: 'must defer',
        nextRunAt: due,
      });
      db.addScheduledTask({
        name: 'ready second',
        type: 'once',
        schedule: due,
        channelJid: 'web:ready',
        prompt: 'must run now',
        nextRunAt: due,
      });

      const sqlite = new Database(dbPath);
      try {
        sqlite
          .prepare(
            `insert into life_archive_moves
              (id, archived_jid, new_life_folder, media_required, upload_required,
               folder_done, media_done, upload_done)
             values ('fairness-move', 'web:quarantined', 'web_life_fair0000', 1, 0, 1, 0, 1)`,
          )
          .run();
      } finally {
        sqlite.close();
      }

      const stop = scheduler.startScheduler();
      stop();

      expect(db.channelsWithPending()).toEqual(['web:ready']);
      expect(db.listScheduledTasks()).toEqual([
        expect.objectContaining({ name: 'blocked first', enabled: 1, last_run_at: null }),
        expect.objectContaining({ name: 'ready second', enabled: 0 }),
      ]);
    } finally {
      db.closeDb();
      vi.resetModules();
      rmSync(tempDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('adds, lists, and removes scheduled tasks in an in-memory database', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();

    const db = await import('../src/db.js');
    db.initDb();

    try {
      const id = db.addScheduledTask({
        name: 'Daily summary',
        type: 'recurring',
        schedule: '* * * * *',
        channelJid: 'dc:123',
        prompt: 'post summary',
        createdBy: 'tester',
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      });

      expect(id).toBeGreaterThan(0);

      const tasks = db.listScheduledTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        id,
        name: 'Daily summary',
        type: 'recurring',
        schedule: '* * * * *',
        channel_jid: 'dc:123',
        prompt: 'post summary',
        enabled: 1,
        created_by: 'tester',
      });
      expect(tasks[0].next_run_at).toBeTruthy();

      expect(db.removeScheduledTask(id)).toBe(true);
      expect(db.listScheduledTasks()).toHaveLength(0);
    } finally {
      db.closeDb();
      vi.resetModules();

      if (originalDbPath === undefined) {
        delete process.env.DB_PATH;
      } else {
        process.env.DB_PATH = originalDbPath;
      }
    }
  });
});
