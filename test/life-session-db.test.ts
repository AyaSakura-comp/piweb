import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'HOME', 'PIDG_CONFIG', 'SESSIONS_DIR'];

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
});
