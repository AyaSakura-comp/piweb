import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createProbeServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

    for (const [path, method, body] of [
      [`/api/sessions/${encodeURIComponent(first.jid)}`, 'PATCH', { name: 'Renamed' }],
      [`/api/sessions/${encodeURIComponent(first.jid)}`, 'DELETE', undefined],
      [`/api/sessions/${encodeURIComponent(first.jid)}/commands`, 'POST', { command: 'pi model' }],
      [
        `/api/sessions/${encodeURIComponent(first.jid)}/commands`,
        'POST',
        { command: 'pi reset-model' },
      ],
      [
        `/api/sessions/${encodeURIComponent(first.jid)}/commands`,
        'POST',
        { command: 'pi thinking' },
      ],
      [`/api/sessions/${encodeURIComponent(first.jid)}/commands`, 'POST', { command: 'pi cwd' }],
      [
        `/api/sessions/${encodeURIComponent(first.jid)}/commands`,
        'POST',
        { command: 'pi reset-cwd' },
      ],
      [`/api/sessions/${encodeURIComponent(first.jid)}/commands`, 'POST', { command: 'pi new' }],
      [`/api/sessions/${encodeURIComponent(first.jid)}/clear`, 'POST', undefined],
    ] as const) {
      const response = await request(path, method, body);
      expect(response.status, `${method} ${path}`).toBe(409);
    }

    // Emergency task control remains available even though model/session
    // management is hidden and blocked.
    const stop = await request(`/api/sessions/${encodeURIComponent(first.jid)}/commands`, 'POST', {
      command: 'pi stop',
    });
    expect(stop.status).toBe(200);

    // First creation gets a unique empty session folder, so there is no async
    // pi-new bootstrap that could race the first user message.
    const sqlite = new Database(dbPath, { readonly: true });
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
  });
});
