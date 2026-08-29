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
        .prepare("update control_queue set processing_at = datetime('now', '-2 hours') where rowid = ?")
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
      control.stopControlLoop();
      resolveCommand?.({ ok: false, text: 'test cleanup' });
      sqlite.close();
      db.closeDb();
    }
  });
});
