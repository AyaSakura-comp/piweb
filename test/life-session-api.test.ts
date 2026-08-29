import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createProbeServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  vi.doUnmock('node:fs');
  vi.doUnmock('node:fs/promises');
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Life session API', () => {
  it('creates one default Life session and rejects session management', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-api-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    const port = await unusedPort();
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_AUTH_TOKEN = 'life-test-token';
    process.env.WEB_HOST = '127.0.0.1';
    process.env.WEB_PORT = String(port);
    process.env.WEB_TRUST_TAILSCALE_IDENTITY = 'false';

    vi.resetModules();
    const db = await import('../src/db.js');
    const { startWebServer } = await import('../src/web/server.js');
    db.initDb();
    const server = startWebServer();
    servers.push(server);
    if (!server.listening) {
      await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    }

    const origin = `http://127.0.0.1:${port}`;
    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'life-test-token' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();

    const request = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          cookie: cookie!,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const firstResponse = await request('/api/life-session', 'POST');
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first).toMatchObject({
      jid: 'web:life',
      name: 'Life',
      kind: 'life',
      model: '',
      thinking: '',
      generation: expect.any(String),
      created: true,
    });

    db.setChannelModelOverride(first.jid, 'openai-codex/gpt-5.6-sol');
    db.setChannelThinkingOverride(first.jid, 'xhigh');
    const secondResponse = await request('/api/life-session', 'POST');
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect(second).toMatchObject({
      jid: first.jid,
      kind: 'life',
      model: '',
      thinking: '',
      created: false,
    });

    const sessions = await (await request('/api/sessions')).json();
    expect(sessions.sessions).toEqual([]);

    for (const body of [
      {},
      { generation: '' },
      { generation: 'not-a-life-generation' },
      { generation: 42 },
      { generation: { folder: first.generation } },
    ]) {
      const malformedNew = await request('/api/life-session/new', 'POST', body);
      expect(malformedNew.status, JSON.stringify(body)).toBe(400);
    }

    for (const [sub, body] of [
      ['messages', { text: 'must not enqueue' }],
      ['messages', { text: 'must not enqueue', lifeGeneration: 42 }],
      ['messages', { text: 'must not enqueue', lifeGeneration: 'bad' }],
      ['commands', { command: 'pi stop' }],
      ['commands', { command: 'pi stop', lifeGeneration: {} }],
      ['commands', { command: 'pi stop', lifeGeneration: ' ' }],
    ] as const) {
      const malformedMutation = await request(
        `/api/sessions/${encodeURIComponent(first.jid)}/${sub}`,
        'POST',
        body,
      );
      expect(malformedMutation.status, `${sub}: ${JSON.stringify(body)}`).toBe(400);
    }

    db.appendWebEvent({
      channelJid: first.jid,
      kind: 'message',
      role: 'user',
      content: 'Plan a weekend trip to Tainan',
    });
    db.appendWebEvent({
      channelJid: first.jid,
      kind: 'message',
      role: 'assistant',
      content: 'Here is the plan.',
    });

    const newLifeResponse = await request('/api/life-session/new', 'POST', {
      generation: first.generation,
    });
    expect(newLifeResponse.status).toBe(200);
    const rotated = await newLifeResponse.json();
    expect(rotated).toMatchObject({
      archived: { name: 'Tainan', kind: 'standard' },
      life: {
        jid: 'web:life',
        name: 'Life',
        kind: 'life',
        model: '',
        thinking: '',
        generation: expect.any(String),
      },
    });
    expect(rotated.archived.jid).toMatch(/^web:[0-9a-f]{8}$/);
    expect(rotated.archived.jid).not.toBe(first.jid);
    expect(rotated.life.generation).not.toBe(first.generation);

    const duplicateNew = await request('/api/life-session/new', 'POST', {
      generation: first.generation,
    });
    expect(duplicateNew.status).toBe(409);
    expect(await duplicateNew.json()).toEqual({
      error: 'Life session changed before it could be archived',
    });

    const sessionsAfterNew = await (await request('/api/sessions')).json();
    expect(sessionsAfterNew.sessions).toHaveLength(1);
    expect(sessionsAfterNew.sessions[0]).toMatchObject(rotated.archived);

    const archivedEvents = await (
      await request(`/api/sessions/${encodeURIComponent(rotated.archived.jid)}/events`)
    ).json();
    expect(archivedEvents.events.map((event: { content: string }) => event.content)).toEqual([
      'Plan a weekend trip to Tainan',
      'Here is the plan.',
    ]);
    expect(archivedEvents.session).toMatchObject({
      jid: rotated.archived.jid,
      name: 'Tainan',
      kind: 'standard',
      deleted: false,
    });

    const lifeReadPaths = [
      `/api/sessions/${encodeURIComponent(first.jid)}/events`,
      `/api/sessions/${encodeURIComponent(first.jid)}/events?around=1`,
      `/api/sessions/${encodeURIComponent(first.jid)}/search?q=Li`,
      `/api/sessions/${encodeURIComponent(first.jid)}/media`,
      `/api/sessions/${encodeURIComponent(first.jid)}/stream?after=0`,
    ];
    for (const lifeReadPath of lifeReadPaths) {
      const separator = lifeReadPath.includes('?') ? '&' : '?';
      const missingGeneration = await request(lifeReadPath);
      expect(missingGeneration.status, `missing: ${lifeReadPath}`).toBe(400);

      const malformedGeneration = await request(
        `${lifeReadPath}${separator}generation=${encodeURIComponent('bad')}`,
      );
      expect(malformedGeneration.status, `malformed: ${lifeReadPath}`).toBe(400);

      const staleGeneration = await request(
        `${lifeReadPath}${separator}generation=${encodeURIComponent(first.generation)}`,
      );
      expect(staleGeneration.status, `stale: ${lifeReadPath}`).toBe(409);
    }

    const freshLifeEvents = await (
      await request(
        `/api/sessions/${encodeURIComponent(first.jid)}/events?generation=${encodeURIComponent(rotated.life.generation)}`,
      )
    ).json();
    expect(freshLifeEvents.events).toEqual([]);
    expect(freshLifeEvents.session).toMatchObject({
      jid: first.jid,
      name: 'Life',
      kind: 'life',
      generation: rotated.life.generation,
      deleted: false,
    });

    db.registerChannel({
      jid: 'web:metadata',
      name: 'Metadata session',
      folder: 'web_metadata',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
      kind: 'standard',
    });
    const liveEvents = await (await request('/api/sessions/web%3Ametadata/events')).json();
    expect(liveEvents.session).toEqual({
      jid: 'web:metadata',
      name: 'Metadata session',
      kind: 'standard',
      deleted: false,
    });
    expect((await request('/api/sessions/web%3Ametadata', 'DELETE')).status).toBe(200);
    const deletedEvents = await (await request('/api/sessions/web%3Ametadata/events')).json();
    expect(deletedEvents.session).toEqual({
      jid: 'web:metadata',
      name: 'Metadata session',
      kind: 'standard',
      deleted: true,
    });

    // First creation gets a unique empty session folder, so there is no async
    // pi-new bootstrap that could race the first user message.
    let sqlite = new Database(dbPath, { readonly: true });
    try {
      expect(
        sqlite
          .prepare(
            "select count(*) as count from control_queue where channel_jid = ? and command = 'pi new'",
          )
          .get(first.jid),
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }

    for (const [path, method, body] of [
      [`/api/sessions/${encodeURIComponent(first.jid)}`, 'PATCH', { name: 'Renamed' }],
      [`/api/sessions/${encodeURIComponent(first.jid)}`, 'DELETE', undefined],
      [
        `/api/sessions/${encodeURIComponent(first.jid)}/commands`,
        'POST',
        { command: 'pi model', lifeGeneration: rotated.life.generation },
      ],
      [
        `/api/sessions/${encodeURIComponent(first.jid)}/commands`,
        'POST',
        { command: 'pi reset-model', lifeGeneration: rotated.life.generation },
      ],
      [
        `/api/sessions/${encodeURIComponent(first.jid)}/commands`,
        'POST',
        { command: 'pi thinking', lifeGeneration: rotated.life.generation },
      ],
      [
        `/api/sessions/${encodeURIComponent(first.jid)}/commands`,
        'POST',
        { command: 'pi cwd', lifeGeneration: rotated.life.generation },
      ],
      [
        `/api/sessions/${encodeURIComponent(first.jid)}/commands`,
        'POST',
        { command: 'pi reset-cwd', lifeGeneration: rotated.life.generation },
      ],
      [`/api/sessions/${encodeURIComponent(first.jid)}/clear`, 'POST', undefined],
    ] as const) {
      const response = await request(path, method, body);
      expect(response.status, `${method} ${path}`).toBe(409);
    }

    // Starting a fresh Pi context is available without making Life itself
    // renameable, deletable, clearable, or configurable.
    const fresh = await request(
      `/api/sessions/${encodeURIComponent(first.jid)}/commands`,
      'POST',
      { command: 'pi new', lifeGeneration: rotated.life.generation },
    );
    expect(fresh.status).toBe(200);
    sqlite = new Database(dbPath, { readonly: true });
    try {
      expect(
        sqlite
          .prepare(
            "select count(*) as count from control_queue where channel_jid = ? and command = 'pi new'",
          )
          .get(first.jid),
      ).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }

    // Emergency task control remains available even though model/session
    // management is hidden and blocked.
    const stop = await request(`/api/sessions/${encodeURIComponent(first.jid)}/commands`, 'POST', {
      command: 'pi stop',
      lifeGeneration: rotated.life.generation,
    });
    expect(stop.status).toBe(200);

    const busyNewLife = await request('/api/life-session/new', 'POST', {
      generation: rotated.life.generation,
    });
    expect(busyNewLife.status).toBe(409);
    expect(await busyNewLife.json()).toEqual({
      error: 'Life session still has active or queued work',
    });
  });

  it('fences a Life upload request that resumes after its operation generation expired', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-api-upload-fence-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    const mediaRoot = resolve(tempDir, 'web-media');
    const uploadRoot = resolve(tempDir, 'web-uploads');
    const port = await unusedPort();
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_MEDIA_DIR = mediaRoot;
    process.env.WEB_UPLOAD_DIR = uploadRoot;
    process.env.WEB_AUTH_TOKEN = 'life-upload-fence-token';
    process.env.WEB_HOST = '127.0.0.1';
    process.env.WEB_PORT = String(port);
    process.env.WEB_TRUST_TAILSCALE_IDENTITY = 'false';

    const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolveWrite) => {
      releaseWrite = resolveWrite;
    });
    let blockedPath = '';
    let blocked = false;
    vi.doMock('node:fs/promises', () => ({
      ...actualFsPromises,
      writeFile: async (path: Parameters<typeof actualFsPromises.writeFile>[0], ...args: any[]) => {
        if (!blocked && String(path).includes(`${join('.operations', '')}`)) {
          blocked = true;
          blockedPath = String(path);
          await writeGate;
        }
        return (actualFsPromises.writeFile as any)(path, ...args);
      },
    }));

    vi.resetModules();
    const db = await import('../src/db.js');
    const { startWebServer } = await import('../src/web/server.js');
    db.initDb();
    const server = startWebServer();
    servers.push(server);
    if (!server.listening) {
      await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    }

    const origin = `http://127.0.0.1:${port}`;
    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'life-upload-fence-token' }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    const first = await (
      await fetch(`${origin}/api/life-session`, {
        method: 'POST',
        headers: { cookie: cookie! },
      })
    ).json();

    const pendingMessage = fetch(
      `${origin}/api/sessions/${encodeURIComponent(first.jid)}/messages`,
      {
        method: 'POST',
        headers: { cookie: cookie!, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'must stay with the old generation',
          lifeGeneration: first.generation,
          attachments: [
            { name: 'old.png', dataBase64: Buffer.from('old upload').toString('base64') },
          ],
        }),
      },
    );
    await vi.waitFor(() => expect(blockedPath).not.toBe(''));

    const sqlite = new Database(dbPath);
    let operationId = '';
    try {
      const operation = sqlite
        .prepare("select id from channel_operations where channel_jid = 'web:life'")
        .get() as { id: string };
      operationId = operation.id;
      sqlite
        .prepare("update channel_operations set updated_at = datetime('now', '-2 hours')")
        .run();
    } finally {
      sqlite.close();
    }

    db.archiveLifeSessionAndStartNew({
      archivedJid: 'web:upload-request-archive',
      archivedName: 'Upload request archive',
      expectedFolder: first.generation,
    });
    const freshUploadOperation = resolve(uploadRoot, 'web_life', '.operations', operationId);
    const freshMediaOperation = resolve(mediaRoot, 'web_life', '.operations', operationId);
    mkdirSync(freshUploadOperation, { recursive: true });
    mkdirSync(freshMediaOperation, { recursive: true });
    expect(dirname(blockedPath)).toBe(freshUploadOperation);

    releaseWrite();
    const response = await pendingMessage;
    expect(response.status).toBe(409);
    expect(db.getRecentWebEvents('web:life')).toEqual([]);
    expect(db.channelsWithPending()).toEqual([]);
    expect(existsSync(freshUploadOperation)).toBe(false);
    expect(existsSync(freshMediaOperation)).toBe(false);
  });

  it('returns 503 for every archived-owner operation while its filesystem move is pending', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-api-quarantine-'));
    tempDirs.push(tempDir);
    const dbPath = resolve(tempDir, 'gateway.db');
    const mediaRoot = resolve(tempDir, 'web-media');
    const uploadRoot = resolve(tempDir, 'web-uploads');
    const port = await unusedPort();
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_MEDIA_DIR = mediaRoot;
    process.env.WEB_UPLOAD_DIR = uploadRoot;
    process.env.WEB_AUTH_TOKEN = 'life-quarantine-token';
    process.env.WEB_HOST = '127.0.0.1';
    process.env.WEB_PORT = String(port);
    process.env.WEB_TRUST_TAILSCALE_IDENTITY = 'false';

    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    let failMediaRename = true;
    vi.doMock('node:fs', () => ({
      ...actualFs,
      renameSync: (from: string, to: string) => {
        if (failMediaRename && from.endsWith('/web-media/web_life')) {
          failMediaRename = false;
          throw Object.assign(new Error('Injected API archive rename failure'), { code: 'EIO' });
        }
        return actualFs.renameSync(from, to);
      },
    }));

    vi.resetModules();
    const db = await import('../src/db.js');
    const { startWebServer } = await import('../src/web/server.js');
    db.initDb();
    const server = startWebServer();
    servers.push(server);
    if (!server.listening) {
      await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
    }

    const origin = `http://127.0.0.1:${port}`;
    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'life-quarantine-token' }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();
    const request = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${origin}${path}`, {
        method,
        headers: {
          cookie: cookie!,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const first = await (await request('/api/life-session', 'POST')).json();
    const mediaSource = resolve(mediaRoot, 'web_life');
    mkdirSync(mediaSource, { recursive: true });
    writeFileSync(resolve(mediaSource, 'old-photo.png'), 'old media');
    db.appendWebEvent({
      channelJid: first.jid,
      kind: 'message',
      role: 'user',
      content: 'Archive me safely',
      files: ['/media/web_life/old-photo.png'],
    });

    const archiveResponse = await request('/api/life-session/new', 'POST', {
      generation: first.generation,
    });
    expect(archiveResponse.status).toBe(500);
    expect(await archiveResponse.json()).toEqual({ error: 'Injected API archive rename failure' });

    const archived = db.getAllChannels().find((channel) => channel.kind === 'standard');
    expect(archived).toBeTruthy();
    const encodedJid = encodeURIComponent(archived!.jid);
    const archivedDir = archived!.jid.replace(/[^\w.-]/g, '_');
    const mediaDestination = resolve(mediaRoot, archivedDir);
    const uploadDestination = resolve(uploadRoot, archivedDir);
    expect(existsSync(mediaSource)).toBe(true);
    expect(existsSync(mediaDestination)).toBe(false);
    expect(await (await request('/api/sessions')).json()).toEqual({ sessions: [] });

    const blocked = [
      ['events read', `/api/sessions/${encodedJid}/events`, 'GET', undefined],
      ['media index read', `/api/sessions/${encodedJid}/media`, 'GET', undefined],
      ['search read', `/api/sessions/${encodedJid}/search?q=Archive`, 'GET', undefined],
      ['stream read', `/api/sessions/${encodedJid}/stream?after=0`, 'GET', undefined],
      ['direct media read', `/media/${archivedDir}/old-photo.png`, 'GET', undefined],
      ['normalized direct media read', '/media/..%2Fweb_life/old-photo.png', 'GET', undefined],
      ['rename', `/api/sessions/${encodedJid}`, 'PATCH', { name: 'Must wait' }],
      ['restore', `/api/sessions/${encodedJid}/restore`, 'POST', {}],
      ['clear', `/api/sessions/${encodedJid}/clear`, 'POST', {}],
      [
        'message with media',
        `/api/sessions/${encodedJid}/messages`,
        'POST',
        {
          text: 'must not stage',
          attachments: [{ name: 'new.png', dataBase64: Buffer.from('new').toString('base64') }],
        },
      ],
      [
        'command',
        `/api/sessions/${encodedJid}/commands`,
        'POST',
        { command: 'pi status' },
      ],
      ['soft delete', `/api/sessions/${encodedJid}`, 'DELETE', undefined],
      ['permanent delete', `/api/sessions/${encodedJid}?permanent=1`, 'DELETE', undefined],
    ] as const;

    for (const [label, path, method, body] of blocked) {
      const response = await request(path, method, body);
      expect(response.status, label).toBe(503);
      expect(await response.json(), label).toEqual({
        error: 'Life archive filesystem recovery is still pending',
      });
    }

    expect(db.getChannel(archived!.jid)).toMatchObject({
      name: archived!.name,
      folder: first.generation,
      kind: 'standard',
    });
    expect(db.getRecentWebEvents(archived!.jid)).toHaveLength(1);
    expect(db.channelsWithPending()).toEqual([]);
    expect(existsSync(mediaDestination)).toBe(false);
    expect(existsSync(uploadDestination)).toBe(false);
    expect(readdirSync(mediaSource)).toEqual(['old-photo.png']);

    expect(db.recoverLifeArchiveMoves()).toBe(1);
    const resumedSessions = await (await request('/api/sessions')).json();
    expect(resumedSessions.sessions).toEqual([
      expect.objectContaining({ jid: archived!.jid, kind: 'standard' }),
    ]);
    const resumedEvents = await request(`/api/sessions/${encodedJid}/events`);
    expect(resumedEvents.status).toBe(200);
    const resumedMessage = await request(`/api/sessions/${encodedJid}/messages`, 'POST', {
      text: 'work resumes',
      attachments: [{ name: 'new.png', dataBase64: Buffer.from('new').toString('base64') }],
    });
    expect(resumedMessage.status).toBe(200);
    expect(readdirSync(mediaDestination)).toEqual(
      expect.arrayContaining(['old-photo.png', expect.stringMatching(/-new\.png$/)]),
    );
    expect(readdirSync(uploadDestination)).toEqual([
      expect.stringMatching(/-new\.png$/),
    ]);
  });
});
