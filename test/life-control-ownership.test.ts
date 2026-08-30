import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { runCommandMock } = vi.hoisted(() => ({ runCommandMock: vi.fn() }));

vi.mock('../src/commands/index.js', () => ({ runCommand: runCommandMock }));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'SESSIONS_DIR', 'WEB_MEDIA_DIR', 'WEB_UPLOAD_DIR'];

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

describe('Life control ownership', () => {
  it('keeps a suspended processing control authoritative regardless of heartbeat age', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-control-fence-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_MEDIA_DIR = resolve(tempDir, 'web-media');
    process.env.WEB_UPLOAD_DIR = resolve(tempDir, 'web-uploads');

    let resolveCommand!: (result: { ok: boolean; text: string }) => void;
    runCommandMock.mockImplementation(
      () =>
        new Promise<{ ok: boolean; text: string }>((resolveResult) => {
          resolveCommand = resolveResult;
        }),
    );

    vi.resetModules();
    const db = await import('../src/db.js');
    const control = await import('../src/worker/control.js');
    db.initDb();

    const life = db.getOrCreateLifeChannel().channel;
    const rowid = db.enqueueControl(life.jid, 'pi status');
    const sqlite = new Database(dbPath);

    try {
      control.startControlLoop();
      await vi.waitFor(() => expect(runCommandMock).toHaveBeenCalledTimes(1));
      sqlite
        .prepare(
          "update control_queue set processing_at = datetime('now', '-2 hours') where rowid = ?",
        )
        .run(rowid);

      expect(() =>
        db.archiveLifeSessionAndStartNew({
          archivedJid: 'web:must-wait-for-control',
          archivedName: 'Must wait',
          expectedFolder: life.folder,
        }),
      ).toThrow('Life session still has active or queued work');

      resolveCommand({ ok: true, text: 'completed control output' });
      await vi.waitFor(() => expect(db.getControl(rowid)).toMatchObject({ status: 'done' }));
      db.archiveLifeSessionAndStartNew({
        archivedJid: 'web:completed-control',
        archivedName: 'Completed control',
        expectedFolder: life.folder,
      });
      db.appendWebEvent({
        channelJid: 'web:life',
        kind: 'message',
        role: 'user',
        content: 'fresh generation sentinel',
      });

      expect(db.getRecentWebEvents('web:life').map((event) => event.content)).toEqual([
        'fresh generation sentinel',
      ]);
      expect(
        db.getRecentWebEvents('web:completed-control').map((event) => event.content),
      ).toContain('completed control output');
    } finally {
      resolveCommand?.({ ok: false, text: 'test cleanup' });
      await control.stopControlLoop();
      sqlite.close();
      db.closeDb();
    }
  });

  it('terminally fails pending and settled processing controls after soft deletion', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-deleted-control-fence-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = resolve(tempDir, 'gateway.db');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_MEDIA_DIR = resolve(tempDir, 'web-media');
    process.env.WEB_UPLOAD_DIR = resolve(tempDir, 'web-uploads');

    let resolveCommand!: (result: { ok: boolean; text: string }) => void;
    runCommandMock.mockImplementation(
      () =>
        new Promise<{ ok: boolean; text: string }>((resolveResult) => {
          resolveCommand = resolveResult;
        }),
    );

    vi.resetModules();
    const db = await import('../src/db.js');
    const control = await import('../src/worker/control.js');
    db.initDb();
    const register = (jid: string, folder: string) =>
      db.registerChannel({
        jid,
        name: jid,
        folder,
        kind: 'standard',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });

    register('web:pending-delete-control', 'pending-delete-control');
    const pendingRowid = db.enqueueControl('web:pending-delete-control', 'pi status');
    db.softDeleteChannel('web:pending-delete-control');
    expect(db.getControl(pendingRowid)).toMatchObject({ status: 'failed' });
    expect(() => db.claimDeletedSessionsForPurge(['web:pending-delete-control'])).not.toThrow();

    register('web:processing-delete-control', 'processing-delete-control');
    const processingRowid = db.enqueueControl('web:processing-delete-control', 'pi status');
    control.startControlLoop();
    await vi.waitFor(() => expect(runCommandMock).toHaveBeenCalledTimes(1));
    expect(db.getControl(processingRowid)).toMatchObject({ status: 'processing' });
    db.softDeleteChannel('web:processing-delete-control');
    resolveCommand({ ok: true, text: 'must be fenced' });

    await vi.waitFor(() =>
      expect(db.getControl(processingRowid)).toMatchObject({ status: 'failed' }),
    );
    expect(() => db.claimDeletedSessionsForPurge(['web:processing-delete-control'])).not.toThrow();
    await control.stopControlLoop();
    db.closeDb();
  });

  it('terminally fails a settled control when ownership reconciliation is uncertain', async () => {
    process.env.DB_PATH = ':memory:';
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();
    try {
      db.registerChannel({
        jid: 'web:uncertain-control',
        name: 'Uncertain control',
        folder: 'uncertain-control',
        kind: 'standard',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      const channel = db.getChannel('web:uncertain-control')!;
      const rowid = db.enqueueControl(channel.jid, 'pi status');
      expect(db.claimPendingControls()).toHaveLength(1);

      expect(db.failSettledControl(rowid, channel.jid)).toBe(true);
      expect(db.getControl(rowid)).toMatchObject({ status: 'failed' });
    } finally {
      db.closeDb();
    }
  });

  it('rolls back the complete control claim when any candidate update aborts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-control-claim-atomic-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    process.env.DB_PATH = dbPath;
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();
    try {
      for (const suffix of ['one', 'two']) {
        db.registerChannel({
          jid: `web:claim-${suffix}`,
          name: `Claim ${suffix}`,
          folder: `claim-${suffix}`,
          kind: 'standard',
          requiresTrigger: false,
          isMain: false,
          modelOverride: '',
          thinkingOverride: '',
          cwdOverride: '',
        });
        db.enqueueControl(`web:claim-${suffix}`, 'pi status');
      }
      const sqlite = new Database(dbPath);
      try {
        sqlite
          .prepare(
            `create trigger abort_second_control_claim
             before update of status on control_queue
             when new.rowid = 2 and new.status = 'processing'
             begin
               select raise(abort, 'injected claim failure');
             end`,
          )
          .run();
        expect(() => db.claimPendingControls()).toThrow(/injected claim failure/);
        expect(
          sqlite.prepare('select rowid, status from control_queue order by rowid').all(),
        ).toEqual([
          { rowid: 1, status: 'pending' },
          { rowid: 2, status: 'pending' },
        ]);
      } finally {
        sqlite.close();
      }
    } finally {
      db.closeDb();
    }
  });

  it('does not stop while an async pi new retirement is still active', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-control-stop-pi-new-'));
    tempDirs.push(tempDir);
    process.env.DB_PATH = resolve(tempDir, 'gateway.db');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_MEDIA_DIR = resolve(tempDir, 'web-media');
    process.env.WEB_UPLOAD_DIR = resolve(tempDir, 'web-uploads');

    let resolveRetirement!: (result: { ok: boolean; text: string }) => void;
    runCommandMock.mockImplementation(
      () =>
        new Promise<{ ok: boolean; text: string }>((resolveResult) => {
          resolveRetirement = resolveResult;
        }),
    );

    vi.resetModules();
    const db = await import('../src/db.js');
    const control = await import('../src/worker/control.js');
    db.initDb();
    const life = db.getOrCreateLifeChannel().channel;
    const rowid = db.enqueueControl(life.jid, 'pi new');

    control.startControlLoop();
    await vi.waitFor(() => expect(runCommandMock).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = control.stopControlLoop().then(() => {
      stopped = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(stopped).toBe(false);
    expect(db.getControl(rowid)).toMatchObject({ status: 'processing' });

    resolveRetirement({ ok: true, text: 'retirement confirmed' });
    await stopping;
    expect(stopped).toBe(true);
    expect(db.getControl(rowid)).toMatchObject({ status: 'done' });
    db.closeDb();
  });
});
