import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import {
  createServer as createProbeServer,
  request as createHttpRequest,
  type ClientRequest,
  type Server,
} from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const servers: Server[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'HOME',
  'PIDG_CONFIG',
  'SESSIONS_DIR',
  'WEB_AUTH_TOKEN',
  'WEB_HOST',
  'WEB_PORT',
  'WEB_TRUST_TAILSCALE_IDENTITY',
  'WEB_MEDIA_DIR',
  'WEB_UPLOAD_DIR',
];

function chmodTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  chmodSync(path, 0o755);
  if (!statSync(path).isDirectory()) return;
  for (const entry of readdirSync(path)) chmodTreeWritable(resolve(path, entry));
}

async function unusedPort(): Promise<number> {
  const probe = createProbeServer();
  await new Promise<void>((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('probe did not bind');
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
  );
  const push = await import('../src/web/push.js').catch(() => null);
  push?.stopPush();
  const db = await import('../src/db.js').catch(() => null);
  db?.closeDb();
  vi.doUnmock('node:fs/promises');
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-trash-api-'));
  tempDirs.push(tempDir);
  const port = await unusedPort();
  const sessionsRoot = resolve(tempDir, 'sessions');
  const mediaRoot = resolve(tempDir, 'web-media');
  const uploadRoot = resolve(tempDir, 'web-uploads');
  process.env.DB_PATH = resolve(tempDir, 'gateway.db');
  process.env.SESSIONS_DIR = sessionsRoot;
  process.env.WEB_MEDIA_DIR = mediaRoot;
  process.env.WEB_UPLOAD_DIR = uploadRoot;
  process.env.WEB_AUTH_TOKEN = 'trash-test-token';
  process.env.WEB_HOST = '127.0.0.1';
  process.env.WEB_PORT = String(port);
  process.env.WEB_TRUST_TAILSCALE_IDENTITY = 'false';

  vi.resetModules();
  const db = await import('../src/db.js');
  const { startWebServer } = await import('../src/web/server.js');
  db.initDb();

  const addSession = (id: string, deleted: boolean) => {
    const jid = `web:${id}`;
    const folder = `folder-${id}`;
    db.registerChannel({
      jid,
      name: id,
      kind: 'standard',
      folder,
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    if (deleted) db.softDeleteChannel(jid);

    const ownedDirs = [
      resolve(sessionsRoot, folder),
      resolve(mediaRoot, `web_${id}`),
      resolve(uploadRoot, `web_${id}`),
    ];
    for (const dir of ownedDirs) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'owned.txt'), id);
    }
    return { jid, folder, ownedDirs };
  };

  const server = startWebServer();
  servers.push(server);
  if (!server.listening) {
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
  }

  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'trash-test-token' }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toBeTruthy();

  const request = (path: string, body: unknown) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { cookie: cookie!, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    addSession,
    cookie: cookie!,
    db,
    dbPath: process.env.DB_PATH!,
    origin,
    request,
  };
}

function exactPurgeBody(
  db: typeof import('../src/db.js'),
  jids: string[],
): {
  jids: string[];
  storageTokens: string[];
  deletionTokens: string[];
  deletedAts: string[];
} {
  const deleted = new Map(db.listDeletedWebSessions().map((session) => [session.jid, session]));
  return {
    jids,
    storageTokens: jids.map((jid) => db.getChannel(jid)?.storageToken || ''),
    deletionTokens: jids.map((jid) => deleted.get(jid)?.deletionToken || ''),
    deletedAts: jids.map((jid) => deleted.get(jid)?.deletedAt || ''),
  };
}

function delayedJsonRequest(
  origin: string,
  path: string,
  cookie: string,
  body: string,
): { request: ClientRequest; response: Promise<{ status: number; body: unknown }> } {
  let resolveResponse!: (response: { status: number; body: unknown }) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const url = new URL(path, origin);
  const request = createHttpRequest(
    url,
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
    },
    (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolveResponse({
          status: incoming.statusCode ?? 0,
          body: raw ? JSON.parse(raw) : undefined,
        });
      });
    },
  );
  request.on('error', rejectResponse);
  const split = Math.max(1, Math.floor(body.length / 2));
  request.write(body.slice(0, split));
  return { request, response };
}

async function waitForOperation(dbPath: string, jid: string, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sqlite = new Database(dbPath, { readonly: true });
    try {
      const row = sqlite
        .prepare('select count(*) as count from channel_operations where channel_jid = ?')
        .get(jid) as { count: number };
      if (row.count > 0) return true;
    } finally {
      sqlite.close();
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return false;
}

describe('Recently deleted purge API', () => {
  it('atomically removes every selected channel-owned row and its files', async () => {
    const { addSession, db, dbPath, request } = await startFixture();
    const selected = addSession('selected', false);
    const untouched = addSession('untouched', true);
    const live = addSession('live', false);

    db.appendWebEvent({ channelJid: selected.jid, kind: 'message', content: 'owned' });
    const message = db.enqueueMessage({
      channelJid: selected.jid,
      sender: 'test',
      senderName: 'Test',
      content: 'done',
      timestamp: new Date().toISOString(),
    });
    db.markMessageDone(message);
    const control = db.enqueueControl(selected.jid, 'pi status');
    expect(db.claimPendingControls()).toHaveLength(1);
    db.finishControl(control, true, 'done');
    db.logMessage(selected.jid, 'assistant', 'owned');
    db.setChannelBusy(selected.jid, false);
    db.setLiveOutput(selected.jid, { content: 'stale partial' });
    db.addScheduledTask({
      name: 'owned schedule',
      type: 'once',
      schedule: 'once',
      channelJid: selected.jid,
      prompt: 'owned',
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    });
    db.softDeleteChannel(selected.jid);

    const response = await request(
      '/api/sessions/deleted/purge',
      exactPurgeBody(db, [selected.jid]),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, purged: 1 });
    expect(db.getChannel(selected.jid)).toBeUndefined();
    expect(selected.ownedDirs.every((dir) => !existsSync(dir))).toBe(true);
    expect(db.getChannel(untouched.jid)).toBeDefined();
    expect(untouched.ownedDirs.every(existsSync)).toBe(true);
    expect(db.getChannel(live.jid)).toBeDefined();
    expect(live.ownedDirs.every(existsSync)).toBe(true);

    const inspect = new Database(dbPath, { readonly: true });
    try {
      for (const table of [
        'web_events',
        'message_queue',
        'message_log',
        'control_queue',
        'live_output',
        'channel_state',
        'session_title_jobs',
        'scheduled_tasks',
        'channel_operations',
      ]) {
        const row = inspect
          .prepare(`select count(*) as count from ${table} where channel_jid = ?`)
          .get(selected.jid) as { count: number };
        expect(row.count, table).toBe(0);
      }
    } finally {
      inspect.close();
    }
  });

  it('keeps a trashed transcript intact when clear is requested', async () => {
    const { addSession, db, request } = await startFixture();
    const session = addSession('deleted-clear', false);
    db.appendWebEvent({
      channelJid: session.jid,
      kind: 'message',
      role: 'user',
      content: 'must remain visible in trash',
    });
    db.setLiveOutput(session.jid, { content: 'stale partial must be cleared' });
    db.softDeleteChannel(session.jid);
    expect(db.getLiveOutput(session.jid)).toBeNull();

    const response = await request(`/api/sessions/${encodeURIComponent(session.jid)}/clear`, {});
    expect(response.status).toBe(409);
    expect(db.getRecentWebEvents(session.jid).map((event) => event.content)).toContain(
      'must remain visible in trash',
    );
    expect(db.claimPendingControls()).toEqual([]);
    expect(db.restoreChannel(session.jid)).toBe(true);
    expect(db.getLiveOutput(session.jid)).toBeNull();
  });

  it('journals the whole batch across filesystem failure, fences restore/writes, and recovers', async () => {
    const { addSession, db, request } = await startFixture();
    const first = addSession('first-deleted', true);
    const second = addSession('second-deleted', true);
    chmodSync(second.ownedDirs[0], 0o555);
    const purgeBody = exactPurgeBody(db, [first.jid, second.jid]);

    let failed: Response;
    try {
      failed = await request('/api/sessions/deleted/purge', purgeBody);
    } finally {
      for (const ownedDir of second.ownedDirs) {
        chmodTreeWritable(ownedDir);
        chmodTreeWritable(resolve(dirname(ownedDir), '.piweb-purge'));
      }
    }

    expect(failed!.status).toBe(503);
    expect(await failed.json()).toMatchObject({ pending: true, purged: 0 });
    expect(db.getChannel(first.jid)).toBeDefined();
    expect(db.getChannel(second.jid)).toBeDefined();
    expect(db.isChannelPurgePending(first.jid)).toBe(true);
    expect(db.isChannelPurgePending(second.jid)).toBe(true);
    expect(() => db.restoreChannel(first.jid)).toThrow(/purge/i);
    expect(() =>
      db.appendWebEvent({ channelJid: first.jid, kind: 'message', content: 'late write' }),
    ).toThrow(/purge/i);
    expect(() => db.setLiveOutput(first.jid, { content: 'late partial' })).toThrow(/purge/i);
    expect(db.beginChannelOperation(first.jid, first.folder)).toBeUndefined();

    const recovered = await request('/api/sessions/deleted/purge', purgeBody);

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ ok: true, purged: 2 });
    expect(db.getChannel(first.jid)).toBeUndefined();
    expect(db.getChannel(second.jid)).toBeUndefined();
    expect([...first.ownedDirs, ...second.ownedDirs].every((dir) => !existsSync(dir))).toBe(true);
  });

  it('unlinks a top-level owner symlink without traversing or deleting its target', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('symlink-owner', true);
    const external = mkdtempSync(join(tmpdir(), 'piweb-purge-external-'));
    tempDirs.push(external);
    const externalFile = resolve(external, 'must-survive.txt');
    writeFileSync(externalFile, 'outside managed roots');
    rmSync(deleted.ownedDirs[0], { recursive: true, force: true });
    symlinkSync(external, deleted.ownedDirs[0], 'dir');
    symlinkSync(externalFile, resolve(deleted.ownedDirs[1], '.piweb-purge-sealed'));

    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const { purgeSessionBatch } = await import('../src/session/purge.js');
    expect(await purgeSessionBatch(batch.batchId)).toBe(1);

    expect(existsSync(externalFile)).toBe(true);
    expect(readFileSync(externalFile, 'utf8')).toBe('outside managed roots');
    expect(existsSync(deleted.ownedDirs[0])).toBe(false);
    expect(db.getChannel(deleted.jid)).toBeUndefined();
  });

  it('rejects a symlinked managed parent instead of following it to operation data', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('symlink-parent', true);
    const external = mkdtempSync(join(tmpdir(), 'piweb-purge-parent-external-'));
    tempDirs.push(external);
    const { standardUploadOwnerDirName } = await import('../src/media-path.js');
    const operationOwner = standardUploadOwnerDirName(
      deleted.jid,
      deleted.folder,
      db.getChannel(deleted.jid)!.storageToken!,
    );
    const externalOwner = resolve(external, operationOwner);
    mkdirSync(externalOwner, { recursive: true });
    const externalFile = resolve(externalOwner, 'must-survive.txt');
    writeFileSync(externalFile, 'outside operation root');
    const operationsLink = resolve(process.env.WEB_MEDIA_DIR!, '.operations');
    symlinkSync(external, operationsLink, 'dir');

    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const { purgeSessionBatch, SessionPurgePendingError } = await import('../src/session/purge.js');
    await expect(purgeSessionBatch(batch.batchId)).rejects.toBeInstanceOf(SessionPurgePendingError);

    expect(readFileSync(externalFile, 'utf8')).toBe('outside operation root');
    expect(db.getChannel(deleted.jid)).toBeDefined();
    expect(db.getSessionPurgeBatch(batch.batchId)?.targets[0].filesDone).toBe(false);
  });

  it('never truncates a hard-linked source marker and records files_done only after terminal seals sync', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('hard-link-marker', true);
    const externalFile = resolve(dirname(dirname(deleted.ownedDirs[1])), 'external-hard-link.txt');
    writeFileSync(externalFile, 'external content must survive');
    linkSync(externalFile, resolve(deleted.ownedDirs[1], '.piweb-purge-sealed'));

    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const { purgeSessionBatch, SessionPurgePendingError } = await import('../src/session/purge.js');

    await expect(
      purgeSessionBatch(batch.batchId, {
        ...actualFs,
        syncPath: async (path: string) => {
          if (
            path.includes(join('.piweb-purge', batch.batchId)) &&
            dirname(path).endsWith(batch.batchId)
          ) {
            throw new Error('injected terminal seal fsync failure');
          }
        },
      } as any),
    ).rejects.toBeInstanceOf(SessionPurgePendingError);

    expect(readFileSync(externalFile, 'utf8')).toBe('external content must survive');
    expect(db.getSessionPurgeBatch(batch.batchId)?.targets[0].filesDone).toBe(false);
    expect(db.getChannel(deleted.jid)).toBeDefined();
    expect(() => db.restoreChannel(deleted.jid)).toThrow(/purge/i);

    expect(await purgeSessionBatch(batch.batchId)).toBe(1);
    expect(readFileSync(externalFile, 'utf8')).toBe('external content must survive');
    expect(db.getChannel(deleted.jid)).toBeUndefined();
    for (const root of [
      process.env.SESSIONS_DIR!,
      process.env.WEB_MEDIA_DIR!,
      process.env.WEB_UPLOAD_DIR!,
    ]) {
      const batchDir = resolve(root, '.piweb-purge', batch.batchId);
      expect(readdirSync(batchDir).length).toBeGreaterThan(0);
      for (const entry of readdirSync(batchDir)) {
        expect(statSync(resolve(batchDir, entry)).isFile(), `${root}/${entry}`).toBe(true);
      }
    }
  });

  it.each([
    { label: 'regular', hardLinked: false },
    { label: 'hard-linked', hardLinked: true },
  ])(
    'recovers after interrupting direct unlink of a $label top-level source',
    async ({ hardLinked }) => {
      const { addSession, db, dbPath } = await startFixture();
      const deleted = addSession(`interrupted-${hardLinked ? 'hard-link' : 'regular'}`, true);
      const sourcePath = deleted.ownedDirs[0];
      const externalPath = resolve(dirname(process.env.SESSIONS_DIR!), 'external-payload.txt');
      rmSync(sourcePath, { recursive: true, force: true });
      if (hardLinked) {
        writeFileSync(externalPath, 'external hard-link content');
        linkSync(externalPath, sourcePath);
      } else {
        writeFileSync(sourcePath, 'regular source content');
      }

      const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
      const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const syncActual = async (path: string) => {
        const handle = await actualFs.open(path, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      };
      let sourceUnlinked = false;
      let interrupted = false;
      const { purgeSessionBatch, SessionPurgePendingError } =
        await import('../src/session/purge.js');

      await expect(
        purgeSessionBatch(batch.batchId, {
          ...actualFs,
          rm: async (path: Parameters<typeof actualFs.rm>[0], options: any) => {
            await actualFs.rm(path, options);
            if (String(path) === sourcePath) sourceUnlinked = true;
          },
          syncPath: async (path: string) => {
            if (sourceUnlinked && !interrupted && path === dirname(sourcePath)) {
              interrupted = true;
              throw new Error('injected crash after direct source unlink');
            }
            await syncActual(path);
          },
        } as any),
      ).rejects.toBeInstanceOf(SessionPurgePendingError);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));

      expect(sourceUnlinked).toBe(true);
      expect(existsSync(sourcePath)).toBe(false);
      if (hardLinked) {
        expect(readFileSync(externalPath, 'utf8')).toBe('external hard-link content');
      }

      const inspect = new Database(dbPath, { readonly: true });
      let tombstonePath: string;
      try {
        tombstonePath = (
          inspect
            .prepare(
              'select tombstone_path from session_purge_paths where batch_id = ? and source_path = ?',
            )
            .get(batch.batchId, sourcePath) as { tombstone_path: string }
        ).tombstone_path;
      } finally {
        inspect.close();
      }
      expect(existsSync(tombstonePath)).toBe(false);

      const recoverySyncs: string[] = [];
      await expect(
        purgeSessionBatch(batch.batchId, {
          ...actualFs,
          syncPath: async (path: string) => {
            recoverySyncs.push(path);
            await syncActual(path);
          },
        }),
      ).resolves.toBe(1);
      expect(recoverySyncs).toContain(dirname(sourcePath));
      expect(readFileSync(tombstonePath, 'utf8')).toMatch(
        /^piweb-session-purge-seal-v1:[0-9a-f-]+\n$/u,
      );
      if (hardLinked) {
        expect(statSync(tombstonePath).ino).not.toBe(statSync(externalPath).ino);
        expect(readFileSync(externalPath, 'utf8')).toBe('external hard-link content');
      }
    },
  );

  it('fails closed when a verified directory source changes to a regular file', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('source-type-change', true);
    const sourcePath = deleted.ownedDirs[0];
    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let sourceStats = 0;
    let sourceRenamed = false;
    const { purgeSessionBatch, SessionPurgePendingError } = await import('../src/session/purge.js');

    await expect(
      purgeSessionBatch(batch.batchId, {
        ...actualFs,
        lstat: async (path: Parameters<typeof actualFs.lstat>[0], options?: any) => {
          if (String(path) === sourcePath && ++sourceStats === 2) {
            rmSync(sourcePath, { recursive: true, force: true });
            writeFileSync(sourcePath, 'replacement regular file');
          }
          return actualFs.lstat(path, options);
        },
        rename: async (oldPath: any, newPath: any) => {
          if (String(oldPath) === sourcePath) sourceRenamed = true;
          return actualFs.rename(oldPath, newPath);
        },
      } as any),
    ).rejects.toBeInstanceOf(SessionPurgePendingError);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));

    expect(sourceRenamed).toBe(false);
    expect(readFileSync(sourcePath, 'utf8')).toBe('replacement regular file');
    expect(db.getSessionPurgeBatch(batch.batchId)?.targets[0].filesDone).toBe(false);
    expect(db.getChannel(deleted.jid)).toBeDefined();
  });

  it('quarantines a directory swapped in after final source verification', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('directory-identity-swap', true);
    const sourcePath = deleted.ownedDirs[0];
    const originalPath = `${sourcePath}.original`;
    const replacementFile = 'replacement-must-survive.txt';
    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let tombstonePath = '';
    let swapped = false;
    const { purgeSessionBatch, SessionPurgePendingError } = await import('../src/session/purge.js');

    await expect(
      purgeSessionBatch(batch.batchId, {
        ...actualFs,
        rename: async (oldPath: any, newPath: any) => {
          if (!swapped && String(oldPath) === sourcePath) {
            swapped = true;
            tombstonePath = String(newPath);
            await actualFs.rename(sourcePath, originalPath);
            await actualFs.mkdir(sourcePath);
            await actualFs.writeFile(
              resolve(sourcePath, replacementFile),
              'unverified replacement',
            );
          }
          return actualFs.rename(oldPath, newPath);
        },
      } as any),
    ).rejects.toBeInstanceOf(SessionPurgePendingError);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));

    expect(swapped).toBe(true);
    expect(readFileSync(resolve(originalPath, 'owned.txt'), 'utf8')).toBe(
      'directory-identity-swap',
    );
    expect(readFileSync(resolve(tombstonePath, replacementFile), 'utf8')).toBe(
      'unverified replacement',
    );
    expect(db.getSessionPurgeBatch(batch.batchId)?.targets[0].filesDone).toBe(false);
    expect(db.getChannel(deleted.jid)).toBeDefined();
  });

  it('preserves a concurrent terminal seal through finalization and exact owner reuse', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('concurrent-seal-finalization', true);
    const sourcePath = deleted.ownedDirs[0];
    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const { purgeSessionBatch } = await import('../src/session/purge.js');
    let tombstonePath = '';
    let interleaved = false;
    const blockedOuterSources = new Set(deleted.ownedDirs.slice(1));

    const lateRunner = purgeSessionBatch(batch.batchId, {
      ...actualFs,
      lstat: async (path: Parameters<typeof actualFs.lstat>[0], options?: any) => {
        if (blockedOuterSources.has(String(path))) {
          const error = new Error(
            'outer runner path intentionally isolated',
          ) as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        return actualFs.lstat(path, options);
      },
      rename: async (oldPath: any, newPath: any) => {
        await actualFs.rename(oldPath, newPath);
        if (!interleaved && String(oldPath) === sourcePath) {
          interleaved = true;
          tombstonePath = String(newPath);
          expect(await purgeSessionBatch(batch.batchId)).toBe(1);
          db.registerChannel({
            jid: deleted.jid,
            name: 'exact reused owner',
            kind: 'standard',
            folder: deleted.folder,
            requiresTrigger: false,
            isMain: false,
            modelOverride: '',
            thinkingOverride: '',
            cwdOverride: '',
          });
          for (const dir of deleted.ownedDirs) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(resolve(dir, 'new-owner.txt'), 'must survive');
          }
        }
      },
    } as any);

    await expect(lateRunner).resolves.toBe(1);
    expect(interleaved).toBe(true);
    expect(statSync(tombstonePath).isFile()).toBe(true);
    expect(deleted.ownedDirs.every((dir) => existsSync(resolve(dir, 'new-owner.txt')))).toBe(true);
  });

  it('never removes a concurrent finalized stale-upload guard from stale directory metadata', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('concurrent-source-guard', false);
    const channel = db.getChannel(deleted.jid)!;
    const { standardUploadOwnerDirName } = await import('../src/media-path.js');
    const guardPath = resolve(
      process.env.WEB_UPLOAD_DIR!,
      '.operations',
      standardUploadOwnerDirName(deleted.jid, deleted.folder, channel.storageToken),
    );
    mkdirSync(guardPath, { recursive: true });
    writeFileSync(resolve(guardPath, 'stale-upload.txt'), 'stale');
    db.softDeleteChannel(deleted.jid);
    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const { purgeSessionBatch } = await import('../src/session/purge.js');

    let releaseStaleReader!: () => void;
    let staleReaderReached!: () => void;
    const readerGate = new Promise<void>((resolveGate) => {
      releaseStaleReader = resolveGate;
    });
    const readerReached = new Promise<void>((resolveReached) => {
      staleReaderReached = resolveReached;
    });
    let blocked = false;
    const staleRunner = purgeSessionBatch(batch.batchId, {
      ...actualFs,
      rename: async (oldPath: any, newPath: any) => {
        await actualFs.rename(oldPath, newPath);
        if (String(oldPath) === guardPath) {
          await actualFs.mkdir(guardPath, { recursive: true });
          await actualFs.writeFile(resolve(guardPath, 'late-stale-upload.txt'), 'late stale');
        }
      },
      readdir: async (path: Parameters<typeof actualFs.readdir>[0], options?: any) => {
        if (!blocked && String(path) === guardPath) {
          blocked = true;
          staleReaderReached();
          await readerGate;
        }
        return actualFs.readdir(path, options as any) as any;
      },
    } as any);

    const reached = await Promise.race([
      readerReached.then(() => true),
      new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1_000)),
    ]);
    expect(reached).toBe(true);
    const finishingRunner = purgeSessionBatch(batch.batchId);
    const finished = await Promise.race([
      finishingRunner.then((count) => ({ count })),
      new Promise<{ count: number | null }>((resolveTimeout) =>
        setTimeout(() => resolveTimeout({ count: null }), 1_000),
      ),
    ]);
    releaseStaleReader();
    expect(finished.count).toBe(1);
    expect(statSync(guardPath).isFile()).toBe(true);

    await expect(staleRunner).resolves.toBe(1);
    expect(statSync(guardPath).isFile()).toBe(true);
    await expect(actualFs.mkdir(guardPath, { recursive: true })).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('fsyncs an existing O_EXCL seal and its parent during crash recovery', async () => {
    const { addSession, db, dbPath } = await startFixture();
    const deleted = addSession('seal-fsync-recovery', true);
    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const createdSeals = new Set<string>();
    const syncActual = async (path: string) => {
      const handle = await actualFs.open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const { purgeSessionBatch, SessionPurgePendingError } = await import('../src/session/purge.js');

    await expect(
      purgeSessionBatch(batch.batchId, {
        ...actualFs,
        open: async (path: any, flags: any, mode?: any) => {
          const handle = await actualFs.open(path, flags, mode);
          if (typeof flags === 'number' && (flags & fsConstants.O_EXCL) !== 0) {
            createdSeals.add(String(path));
          }
          return handle;
        },
        syncPath: async (path: string) => {
          if (createdSeals.has(path)) {
            throw new Error('injected crash after O_EXCL seal creation');
          }
          await syncActual(path);
        },
      } as any),
    ).rejects.toBeInstanceOf(SessionPurgePendingError);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));

    const inspect = new Database(dbPath, { readonly: true });
    let sealPaths: string[];
    try {
      sealPaths = (
        inspect
          .prepare('select tombstone_path from session_purge_paths where batch_id = ?')
          .all(batch.batchId) as Array<{ tombstone_path: string }>
      ).map((row) => row.tombstone_path);
    } finally {
      inspect.close();
    }
    expect(createdSeals.size).toBeGreaterThan(0);
    expect(sealPaths.filter(existsSync).every((path) => statSync(path).isFile())).toBe(true);

    const synced = new Set<string>();
    await expect(
      purgeSessionBatch(batch.batchId, {
        ...actualFs,
        syncPath: async (path: string) => {
          synced.add(path);
          await syncActual(path);
        },
      }),
    ).resolves.toBe(1);

    for (const sealPath of sealPaths) {
      expect(synced.has(sealPath), sealPath).toBe(true);
      expect(synced.has(dirname(sealPath)), dirname(sealPath)).toBe(true);
    }
  });

  it('retries a managed-root component parent fsync after mkdir succeeded', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('managed-root-fsync-retry', true);
    const managedRoot = process.env.WEB_MEDIA_DIR!;
    rmSync(managedRoot, { recursive: true, force: true });
    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const syncActual = async (path: string) => {
      const handle = await actualFs.open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    let injected = false;
    const { purgeSessionBatch, SessionPurgePendingError } = await import('../src/session/purge.js');

    await expect(
      purgeSessionBatch(batch.batchId, {
        ...actualFs,
        syncPath: async (path: string) => {
          if (!injected && path === dirname(managedRoot)) {
            injected = true;
            throw new Error('injected managed-root parent fsync failure');
          }
          await syncActual(path);
        },
      }),
    ).rejects.toBeInstanceOf(SessionPurgePendingError);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(statSync(managedRoot).isDirectory()).toBe(true);

    const retrySyncs: string[] = [];
    await expect(
      purgeSessionBatch(batch.batchId, {
        ...actualFs,
        syncPath: async (path: string) => {
          retrySyncs.push(path);
          await syncActual(path);
        },
      }),
    ).resolves.toBe(1);
    expect(retrySyncs).toContain(dirname(managedRoot));
  });

  it('creates entirely missing managed roots durably before creating tombstone batches', async () => {
    const { db } = await startFixture();
    const jid = 'web:unused-roots';
    const folder = 'unused-roots-folder';
    for (const root of [
      process.env.SESSIONS_DIR!,
      process.env.WEB_MEDIA_DIR!,
      process.env.WEB_UPLOAD_DIR!,
    ]) {
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    }
    db.registerChannel({
      jid,
      name: 'Unused roots',
      folder,
      kind: 'standard',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.softDeleteChannel(jid);

    const batch = db.claimDeletedSessionsForPurge([jid]);
    const { purgeSessionBatch } = await import('../src/session/purge.js');
    await expect(purgeSessionBatch(batch.batchId)).resolves.toBe(1);

    for (const root of [
      process.env.SESSIONS_DIR!,
      process.env.WEB_MEDIA_DIR!,
      process.env.WEB_UPLOAD_DIR!,
    ]) {
      expect(statSync(root).isDirectory()).toBe(true);
      const seals = readdirSync(resolve(root, '.piweb-purge', batch.batchId));
      expect(seals.length).toBeGreaterThan(0);
      expect(
        seals.every((entry) =>
          statSync(resolve(root, '.piweb-purge', batch.batchId, entry)).isFile(),
        ),
      ).toBe(true);
    }
  });

  it('rejects symlink components in a configured managed root', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('symlink-root', true);
    const external = resolve(dirname(process.env.WEB_MEDIA_DIR!), 'external-media-root');
    rmSync(process.env.WEB_MEDIA_DIR!, { recursive: true, force: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(resolve(external, 'must-survive.txt'), 'outside configured root');
    symlinkSync(external, process.env.WEB_MEDIA_DIR!, 'dir');

    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const { purgeSessionBatch, SessionPurgePendingError } = await import('../src/session/purge.js');
    await expect(purgeSessionBatch(batch.batchId)).rejects.toBeInstanceOf(SessionPurgePendingError);

    expect(readFileSync(resolve(external, 'must-survive.txt'), 'utf8')).toBe(
      'outside configured root',
    );
    expect(existsSync(resolve(external, '.piweb-purge'))).toBe(false);
    expect(db.getSessionPurgeBatch(batch.batchId)?.targets[0].filesDone).toBe(false);
    expect(db.getChannel(deleted.jid)).toBeDefined();
  });

  it('purges a valid root-level dot-prefixed session folder', async () => {
    const { db } = await startFixture();
    const jid = 'web:root-dot-prefix';
    const folder = '..nested';
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
    const sourcePath = resolve(process.env.SESSIONS_DIR!, folder);
    mkdirSync(sourcePath, { recursive: true });
    writeFileSync(resolve(sourcePath, 'owned.txt'), 'owned');
    db.softDeleteChannel(jid);
    const batch = db.claimDeletedSessionsForPurge([jid]);
    const { purgeSessionBatch } = await import('../src/session/purge.js');

    await expect(purgeSessionBatch(batch.batchId)).resolves.toBe(1);
    expect(existsSync(sourcePath)).toBe(false);
    expect(db.getChannel(jid)).toBeUndefined();
  });

  it.each([
    { targetFolder: 'shared', otherFolder: 'shared/nested', label: 'nested session root' },
    {
      targetFolder: 'dot-prefix-owner',
      otherFolder: 'dot-prefix-owner/..nested',
      label: 'dot-prefixed nested session root',
    },
    {
      targetFolder: 'archive-owner',
      otherFolder: 'archive-owner__archived_live-channel',
      label: 'archive-prefix session root',
    },
    {
      targetFolder: 'archive-parent-owner',
      otherFolder: 'archive-parent-owner__archived_live-channel/nested',
      label: 'nested archive-prefix session root',
    },
  ])(
    'refuses a target whose $label belongs to another channel',
    async ({ targetFolder, otherFolder }) => {
      const { db } = await startFixture();
      const targetJid = `web:target-${targetFolder}`;
      const otherJid = `web:other-${otherFolder}`;
      for (const [jid, folder] of [
        [targetJid, targetFolder],
        [otherJid, otherFolder],
      ] as const) {
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
        mkdirSync(resolve(process.env.SESSIONS_DIR!, folder), { recursive: true });
        writeFileSync(resolve(process.env.SESSIONS_DIR!, folder, 'must-survive.txt'), jid);
      }
      db.softDeleteChannel(targetJid);

      expect(() => db.claimDeletedSessionsForPurge([targetJid])).toThrow(/deleted|idle|owned/i);
      expect(
        readFileSync(resolve(process.env.SESSIONS_DIR!, otherFolder, 'must-survive.txt'), 'utf8'),
      ).toBe(otherJid);
      expect(db.getChannel(targetJid)).toBeDefined();
      expect(db.getChannel(otherJid)).toBeDefined();
    },
  );

  it('fences post-claim channel registration across every filesystem alias', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('post-claim-alias-owner', true);
    db.claimDeletedSessionsForPurge([deleted.jid]);

    for (const [jid, folder] of [
      ['web:post-claim-nested', `${deleted.folder}/nested`],
      ['web:post-claim-dot-nested', `${deleted.folder}/..nested`],
      ['web:post-claim-archive', `${deleted.folder}__archived_new-owner/nested`],
      ['web?post-claim-alias-owner', 'post-claim-media-alias'],
    ] as const) {
      expect(() =>
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
        }),
      ).toThrow(/purge/i);
      expect(db.getChannel(jid)).toBeUndefined();
    }
  });

  it('refuses a target whose sanitized media owner aliases another channel', async () => {
    const { db } = await startFixture();
    const targetJid = 'web:media:alias';
    const otherJid = 'web:media?alias';
    for (const [jid, folder] of [
      [targetJid, 'media-alias-target'],
      [otherJid, 'media-alias-other'],
    ] as const) {
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
    }
    const sharedMedia = resolve(process.env.WEB_MEDIA_DIR!, 'web_media_alias');
    mkdirSync(sharedMedia, { recursive: true });
    writeFileSync(resolve(sharedMedia, 'must-survive.txt'), otherJid);
    db.softDeleteChannel(targetJid);

    expect(() => db.claimDeletedSessionsForPurge([targetJid])).toThrow(/deleted|idle|owned/i);
    expect(readFileSync(resolve(sharedMedia, 'must-survive.txt'), 'utf8')).toBe(otherJid);
    expect(db.getChannel(otherJid)).toBeDefined();
  });

  it('re-fsyncs a nested source parent when recovery starts after directory detach', async () => {
    const { db } = await startFixture();
    const jid = 'web:nested-parent-fsync';
    const folder = 'group/nested-parent-fsync';
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
    const sourcePath = resolve(process.env.SESSIONS_DIR!, folder);
    mkdirSync(sourcePath, { recursive: true });
    writeFileSync(resolve(sourcePath, 'owned.txt'), 'owned');
    db.softDeleteChannel(jid);
    const batch = db.claimDeletedSessionsForPurge([jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const sourceParent = dirname(sourcePath);
    let detached = false;
    let interrupted = false;
    const { purgeSessionBatch, SessionPurgePendingError } = await import('../src/session/purge.js');

    await expect(
      purgeSessionBatch(batch.batchId, {
        ...actualFs,
        rename: async (oldPath: any, newPath: any) => {
          await actualFs.rename(oldPath, newPath);
          if (String(oldPath) === sourcePath) detached = true;
        },
        syncPath: async (path: string) => {
          if (detached && !interrupted && path === sourceParent) {
            interrupted = true;
            throw new Error('injected source-parent fsync interruption');
          }
          const handle = await actualFs.open(path, 'r');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      } as any),
    ).rejects.toBeInstanceOf(SessionPurgePendingError);

    const recoverySyncs: string[] = [];
    await expect(
      purgeSessionBatch(batch.batchId, {
        ...actualFs,
        syncPath: async (path: string) => {
          recoverySyncs.push(path);
          const handle = await actualFs.open(path, 'r');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      }),
    ).resolves.toBe(1);
    expect(recoverySyncs).toContain(sourceParent);
  });

  it('waits for every detached child removal after one sibling fails', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('settled-child-removals', true);
    const sourcePath = deleted.ownedDirs[0];
    const blockedChild = resolve(sourcePath, 'blocked.txt');
    writeFileSync(blockedChild, 'blocked');
    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let releaseBlocked!: () => void;
    const blockedGate = new Promise<void>((resolveBlocked) => {
      releaseBlocked = resolveBlocked;
    });
    let reachedBlocked!: () => void;
    const blockedReached = new Promise<void>((resolveReached) => {
      reachedBlocked = resolveReached;
    });
    const { purgeSessionBatch, SessionPurgePendingError } = await import('../src/session/purge.js');

    let settled = false;
    let failed = false;
    let targetedTombstone = '';
    const pending = purgeSessionBatch(batch.batchId, {
      ...actualFs,
      rename: async (oldPath: any, newPath: any) => {
        await actualFs.rename(oldPath, newPath);
        if (String(oldPath) === sourcePath) targetedTombstone = String(newPath);
      },
      rm: async (path: Parameters<typeof actualFs.rm>[0], options: any) => {
        if (
          !failed &&
          dirname(String(path)) === targetedTombstone &&
          String(path).endsWith('/owned.txt')
        ) {
          failed = true;
          const error = new Error('injected sibling removal failure') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        if (dirname(String(path)) === targetedTombstone && String(path).endsWith('/blocked.txt')) {
          reachedBlocked();
          await blockedGate;
        }
        return actualFs.rm(path, options);
      },
    } as any).finally(() => {
      settled = true;
    });

    await blockedReached;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(settled).toBe(false);
    releaseBlocked();
    await expect(pending).rejects.toBeInstanceOf(SessionPurgePendingError);
  });

  it('atomically refuses a restore or active-worker race before claiming any target', async () => {
    const { addSession, db, request } = await startFixture();
    const idle = addSession('idle-deleted', true);
    const active = addSession('active-deleted', false);
    const rowid = db.enqueueMessage({
      channelJid: active.jid,
      sender: 'test',
      senderName: 'Test',
      content: 'processing',
      timestamp: new Date().toISOString(),
    });
    expect(db.claimNextMessage(active.jid)?.rowid).toBe(rowid);
    db.softDeleteChannel(active.jid);

    const response = await request(
      '/api/sessions/deleted/purge',
      exactPurgeBody(db, [idle.jid, active.jid]),
    );

    expect(response.status).toBe(409);
    expect(db.isChannelPurgePending(idle.jid)).toBe(false);
    expect(db.isChannelPurgePending(active.jid)).toBe(false);
    expect(db.restoreChannel(idle.jid)).toBe(true);
    expect(db.getChannel(active.jid)).toBeDefined();
    expect(idle.ownedDirs.every(existsSync)).toBe(true);
    expect(active.ownedDirs.every(existsSync)).toBe(true);
  });

  it('fences direct channel deletion from claim through atomic finalization', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('delete-fenced', true);
    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);

    expect(() => db.unregisterChannel(deleted.jid)).toThrow(/purge/i);
    expect(() =>
      db.registerChannel({
        jid: 'web:folder-reuse',
        name: 'must stay fenced',
        kind: 'standard',
        folder: deleted.folder,
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      }),
    ).toThrow(/purge/i);
    expect(db.getChannel(deleted.jid)).toBeDefined();

    const { purgeSessionBatch } = await import('../src/session/purge.js');
    expect(await purgeSessionBatch(batch.batchId)).toBe(1);
    expect(db.getChannel(deleted.jid)).toBeUndefined();
  });

  it('keeps late concurrent cleanup on sealed tombstones away from an exact reused owner', async () => {
    const { addSession, db } = await startFixture();
    const deleted = addSession('concurrent-cleanup', true);
    const batch = db.claimDeletedSessionsForPurge([deleted.jid]);
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const removedPaths: string[] = [];
    let releaseRemove!: () => void;
    const removeGate = new Promise<void>((resolveRemove) => {
      releaseRemove = resolveRemove;
    });
    let reachedRemove!: () => void;
    const removeReached = new Promise<void>((resolveReached) => {
      reachedRemove = resolveReached;
    });
    let blocked = false;

    const { purgeSessionBatch } = await import('../src/session/purge.js');
    const lateRunner = purgeSessionBatch(batch.batchId, {
      ...actualFs,
      rm: async (path: Parameters<typeof actualFs.rm>[0], options: any) => {
        removedPaths.push(String(path));
        if (!blocked) {
          blocked = true;
          reachedRemove();
          await removeGate;
        }
        return actualFs.rm(path, options);
      },
    });

    const reached = await Promise.race([
      removeReached.then(() => true),
      new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 250)),
    ]);
    expect(reached).toBe(true);

    // The other process may finish and release the DB identity while this
    // runner still has an old filesystem call in flight.
    expect(await purgeSessionBatch(batch.batchId)).toBe(1);
    db.registerChannel({
      jid: deleted.jid,
      name: 'reused owner',
      kind: 'standard',
      folder: deleted.folder,
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    for (const dir of deleted.ownedDirs) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'new-owner.txt'), 'must survive');
    }

    releaseRemove();
    expect(await lateRunner).toBe(1);
    expect(deleted.ownedDirs.every((dir) => existsSync(resolve(dir, 'new-owner.txt')))).toBe(true);
    expect(removedPaths.length).toBeGreaterThan(0);
    expect(removedPaths.every((path) => path.includes('.piweb-purge'))).toBe(true);
  });

  it('rejects a pre-purge request lease after exact JID and folder reuse', async () => {
    const { addSession, db } = await startFixture();
    const original = addSession('request-token-reuse', false);
    const originalToken = db.getChannel(original.jid)?.storageToken;
    expect(originalToken).toBeTruthy();

    db.softDeleteChannel(original.jid);
    const batch = db.claimDeletedSessionsForPurge([original.jid]);
    const { purgeSessionBatch } = await import('../src/session/purge.js');
    expect(await purgeSessionBatch(batch.batchId)).toBe(1);
    db.registerChannel({
      jid: original.jid,
      name: 'Replacement request owner',
      folder: original.folder,
      kind: 'standard',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const replacement = db.getChannel(original.jid)!;

    expect(db.beginChannelOperation(original.jid, original.folder, originalToken)).toBeUndefined();
    const replacementOperation = db.beginChannelOperation(
      replacement.jid,
      replacement.folder,
      replacement.storageToken,
    );
    expect(replacementOperation).toBeTruthy();
    db.finishChannelOperation(replacementOperation!);

    db.appendWebEvent({
      channelJid: replacement.jid,
      kind: 'message',
      role: 'user',
      content: 'replacement transcript',
    });
    expect(() =>
      db.renameChannel(original.jid, 'stale rename', original.folder, originalToken),
    ).toThrow(/generation/i);
    expect(() => db.clearChannelSession(original.jid, original.folder, originalToken)).toThrow(
      /generation/i,
    );
    expect(() => db.softDeleteChannel(original.jid, original.folder, originalToken)).toThrow(
      /generation/i,
    );
    expect(db.getChannel(original.jid)?.name).toBe('Replacement request owner');
    expect(db.getRecentWebEvents(original.jid).map((event) => event.content)).toContain(
      'replacement transcript',
    );

    db.softDeleteChannel(replacement.jid, replacement.folder, replacement.storageToken);
    expect(() => db.restoreChannel(original.jid, original.folder, originalToken)).toThrow(
      /generation/i,
    );
    expect(db.isChannelDeleted(replacement.jid)).toBe(true);
    expect(db.restoreChannel(replacement.jid, replacement.folder, replacement.storageToken)).toBe(
      true,
    );
  });

  it.each([
    ['standard message', 'messages', false],
    ['standard command', 'commands', false],
    ['Life message', 'messages', true],
    ['Life command', 'commands', true],
  ] as const)(
    'leases the captured channel generation before reading a delayed %s body',
    async (_label, sub, life) => {
      const { addSession, cookie, db, dbPath, origin } = await startFixture();
      const channel = life
        ? db.getOrCreateLifeChannel().channel
        : addSession(`delayed-${sub}`, false);
      const body = JSON.stringify(
        sub === 'messages'
          ? {
              text: 'delayed request body',
              ...(life ? { lifeGeneration: channel.folder } : {}),
            }
          : {
              command: 'pi status',
              ...(life ? { lifeGeneration: channel.folder } : {}),
            },
      );
      const pending = delayedJsonRequest(
        origin,
        `/api/sessions/${encodeURIComponent(channel.jid)}/${sub}`,
        cookie,
        body,
      );

      const leasedBeforeBodyEnd = await waitForOperation(dbPath, channel.jid);
      if (!leasedBeforeBodyEnd) {
        pending.request.destroy();
        await pending.response.catch(() => {});
      }
      expect(leasedBeforeBodyEnd).toBe(true);

      if (life) {
        expect(() =>
          db.archiveLifeSessionAndStartNew({
            archivedJid: `web:blocked-${sub}`,
            archivedName: 'Must remain blocked',
            expectedFolder: channel.folder,
          }),
        ).toThrow('Life session still has active or queued work');
      } else {
        db.softDeleteChannel(channel.jid);
        expect(() => db.claimDeletedSessionsForPurge([channel.jid])).toThrow();
      }

      pending.request.end(body.slice(Math.max(1, Math.floor(body.length / 2))));
      const response = await pending.response;
      expect(response.status).toBe(life ? 200 : 409);
      await vi.waitFor(() => {
        const sqlite = new Database(dbPath, { readonly: true });
        try {
          expect(
            (
              sqlite
                .prepare('select count(*) as count from channel_operations where channel_jid = ?')
                .get(channel.jid) as { count: number }
            ).count,
          ).toBe(0);
        } finally {
          sqlite.close();
        }
      });
    },
  );

  it('does not let an expired standard upload recreate durable owner roots after purge', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let releaseMkdir!: () => void;
    const mkdirGate = new Promise<void>((resolveMkdir) => {
      releaseMkdir = resolveMkdir;
    });
    let blockedPath = '';
    vi.doMock('node:fs/promises', () => ({
      ...actualFs,
      mkdir: async (path: Parameters<typeof actualFs.mkdir>[0], ...args: any[]) => {
        if (!blockedPath && String(path).includes('web-uploads')) {
          blockedPath = String(path);
          await mkdirGate;
        }
        return (actualFs.mkdir as any)(path, ...args);
      },
    }));

    const { addSession, db, dbPath, request } = await startFixture();
    const session = addSession('expired-upload', false);
    const pendingMessage = request(`/api/sessions/${encodeURIComponent(session.jid)}/messages`, {
      text: 'stale upload',
      attachments: [{ name: 'stale.png', dataBase64: Buffer.from('stale').toString('base64') }],
    });
    await vi.waitFor(() => expect(blockedPath).not.toBe(''));

    const sqlite = new Database(dbPath);
    try {
      sqlite
        .prepare("update channel_operations set updated_at = datetime('now', '-2 hours')")
        .run();
    } finally {
      sqlite.close();
    }
    db.softDeleteChannel(session.jid);
    const batch = db.claimDeletedSessionsForPurge([session.jid]);
    const { purgeSessionBatch } = await import('../src/session/purge.js');
    expect(await purgeSessionBatch(batch.batchId)).toBe(1);

    expect(session.ownedDirs.every((dir) => !existsSync(dir))).toBe(true);
    expect(blockedPath).toContain('.operations');
    expect(blockedPath).not.toContain(resolve(process.env.WEB_UPLOAD_DIR!, 'web_expired-upload'));
    const operationOwner = basename(dirname(blockedPath));
    const oldUploadOwner = resolve(process.env.WEB_UPLOAD_DIR!, '.operations', operationOwner);
    const oldMediaOwner = resolve(process.env.WEB_MEDIA_DIR!, '.operations', operationOwner);
    expect(dirname(blockedPath)).toBe(oldUploadOwner);
    expect(statSync(oldUploadOwner).isFile()).toBe(true);
    expect(statSync(oldMediaOwner).isFile()).toBe(true);

    releaseMkdir();
    const response = await pendingMessage;
    expect(response.status).toBe(409);
    expect(statSync(oldUploadOwner).isFile()).toBe(true);
    expect(statSync(oldMediaOwner).isFile()).toBe(true);

    db.registerChannel({
      jid: session.jid,
      name: 'exact reused upload owner',
      folder: session.folder,
      kind: 'standard',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    const reused = await request(`/api/sessions/${encodeURIComponent(session.jid)}/messages`, {
      text: 'new owner upload',
      attachments: [{ name: 'new.png', dataBase64: Buffer.from('new').toString('base64') }],
    });
    expect(reused.status).toBe(200);
    expect(statSync(oldUploadOwner).isFile()).toBe(true);
    expect(statSync(oldMediaOwner).isFile()).toBe(true);
  });

  it('does not purge a deleted replacement from a stale displayed generation', async () => {
    const { addSession, db, request } = await startFixture();
    const original = addSession('stale-purge-selection', true);
    const staleBody = exactPurgeBody(db, [original.jid]);
    const firstBatch = db.claimDeletedSessionsForPurge(
      staleBody.jids,
      staleBody.storageTokens,
      staleBody.deletionTokens,
      staleBody.deletedAts,
    );
    const { purgeSessionBatch } = await import('../src/session/purge.js');
    expect(await purgeSessionBatch(firstBatch.batchId)).toBe(1);

    db.registerChannel({
      jid: original.jid,
      name: 'Replacement deleted generation',
      folder: original.folder,
      kind: 'standard',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.softDeleteChannel(original.jid);

    const response = await request('/api/sessions/deleted/purge', staleBody);
    expect(response.status).toBe(409);
    expect(db.getChannel(original.jid)?.name).toBe('Replacement deleted generation');
    expect(db.isChannelDeleted(original.jid)).toBe(true);
  });

  it('does not purge a restored and newly re-deleted owner from a stale retention snapshot', async () => {
    const { addSession, db, request } = await startFixture();
    const session = addSession('renewed-retention', true);
    const staleBody = exactPurgeBody(db, [session.jid]);

    expect(db.restoreChannel(session.jid)).toBe(true);
    db.softDeleteChannel(session.jid);
    expect(db.getChannel(session.jid)?.storageToken).toBe(staleBody.storageTokens[0]);
    expect(db.getChannel(session.jid)?.deletionToken).not.toBe(staleBody.deletionTokens[0]);

    const response = await request('/api/sessions/deleted/purge', staleBody);
    expect(response.status).toBe(409);
    expect(db.isChannelDeleted(session.jid)).toBe(true);
  });

  it('accepts only exact aligned JID-generation arrays and has no 500-item cap', async () => {
    const { addSession, db, dbPath, request } = await startFixture();
    const deleted = addSession('valid-deleted', true);
    const live = addSession('invalid-live', false);

    for (const body of [
      null,
      'all',
      [],
      {},
      { jids: [] },
      { jids: [], storageTokens: [] },
      { jids: [deleted.jid], storageTokens: [] },
      {
        jids: [deleted.jid, deleted.jid],
        storageTokens: [
          db.getChannel(deleted.jid)?.storageToken,
          db.getChannel(deleted.jid)?.storageToken,
        ],
      },
      { all: true },
      { all: true, jids: [deleted.jid] },
      {
        jids: [deleted.jid],
        storageTokens: [db.getChannel(deleted.jid)?.storageToken],
        extra: true,
      },
    ]) {
      const response = await request('/api/sessions/deleted/purge', body);
      expect(response.status, JSON.stringify(body).slice(0, 200)).toBe(400);
      expect(db.getChannel(deleted.jid), JSON.stringify(body).slice(0, 200)).toBeDefined();
      expect(deleted.ownedDirs.every(existsSync)).toBe(true);
    }

    const deletedIdentity = exactPurgeBody(db, [deleted.jid]);
    const liveTarget = await request('/api/sessions/deleted/purge', {
      jids: [deleted.jid, live.jid],
      storageTokens: [deletedIdentity.storageTokens[0], db.getChannel(live.jid)?.storageToken],
      deletionTokens: [deletedIdentity.deletionTokens[0], 'not-deleted'],
      deletedAts: [deletedIdentity.deletedAts[0], new Date().toISOString()],
    });
    expect(liveTarget.status).toBe(409);
    expect(db.getChannel(deleted.jid)).toBeDefined();

    db.registerChannel({
      jid: 'hidden:deleted',
      name: 'hidden deleted standard',
      folder: 'hidden-deleted-folder',
      kind: 'standard',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.softDeleteChannel('hidden:deleted');
    const inspect = new Database(dbPath);
    try {
      inspect
        .prepare(
          `insert into channel_operations
            (id, channel_jid, channel_folder, created_at, updated_at)
           values ('hidden-expired-op', 'hidden:deleted', 'hidden-deleted-folder',
                   datetime('now', '-2 hours'), datetime('now', '-2 hours'))`,
        )
        .run();
    } finally {
      inspect.close();
    }

    const hiddenTarget = await request(
      '/api/sessions/deleted/purge',
      exactPurgeBody(db, ['hidden:deleted']),
    );
    expect(hiddenTarget.status).toBe(400);
    expect(db.getChannel('hidden:deleted')).toBeDefined();
    expect(() => db.claimDeletedSessionsForPurge(['hidden:deleted'])).toThrow(
      /deleted, idle, and owned/i,
    );
    const verify = new Database(dbPath, { readonly: true });
    try {
      expect(
        (
          verify
            .prepare(
              "select count(*) as count from channel_operations where id = 'hidden-expired-op'",
            )
            .get() as { count: number }
        ).count,
      ).toBe(1);
    } finally {
      verify.close();
    }

    const manyJids = Array.from({ length: 501 }, (_, index) => {
      const jid = `web:bulk-${index}`;
      db.registerChannel({
        jid,
        name: jid,
        folder: `bulk-folder-${index}`,
        kind: 'standard',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.softDeleteChannel(jid);
      return jid;
    });
    const many = await request('/api/sessions/deleted/purge', exactPurgeBody(db, manyJids));
    expect(many.status).toBe(200);
    expect(await many.json()).toEqual({ ok: true, purged: 501 });
  });
});
