import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createProbeServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'SESSIONS_DIR',
  'WEB_AUTH_TOKEN',
  'WEB_HOST',
  'WEB_PORT',
  'WEB_TRUST_TAILSCALE_IDENTITY',
];
const servers: Server[] = [];
let tempDir = '';

async function unusedPort(): Promise<number> {
  const probe = createProbeServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('probe did not bind');
  await new Promise<void>((done) => probe.close(() => done()));
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  (await import('../src/web/push.js').catch(() => null))?.stopPush();
  (await import('../src/db.js').catch(() => null))?.closeDb();
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

it('BTW clear is authenticated, generation-fenced and uses a private control', async () => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'piweb-btw-api-'));
  const port = await unusedPort();
  Object.assign(process.env, {
    DB_PATH: resolve(tempDir, 'db.sqlite'),
    SESSIONS_DIR: resolve(tempDir, 'sessions'),
    WEB_AUTH_TOKEN: 'btw-test-only',
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(port),
    WEB_TRUST_TAILSCALE_IDENTITY: 'false',
  });
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  const { startWebServer } = await import('../src/web/server.js');
  const server = startWebServer();
  servers.push(server);
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'btw-test-only' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const created = await fetch(origin + '/api/sessions', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'BTW clear test' }),
  });
  const { jid } = await created.json();
  const folder = db.getChannel(jid)!.folder;
  for (const row of db.claimPendingControls())
    db.finishControl(row.rowid, true, 'fixture initialized');
  const post = (body: unknown, authed = true) =>
    fetch(origin + '/api/sessions/' + encodeURIComponent(jid) + '/btw', {
      method: 'POST',
      headers: { ...(authed ? { cookie } : {}), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
  expect((await post({ action: 'clear', generation: folder }, false)).status).toBe(401);
  expect((await post({ action: 'clear', generation: 'old' })).status).toBe(409);
  expect((await post({ action: 'unknown', generation: folder })).status).toBe(400);
  const response = post({ action: 'clear', generation: folder }).catch((error) => error);
  let rows: ReturnType<typeof db.claimPendingControls> = [];
  await expect
    .poll(() => {
      rows = db.claimPendingControls();
      return rows.length;
    })
    .toBe(1);
  expect(rows[0].command).toBe('btw:web');
  expect(JSON.parse(rows[0].args)).toEqual({ action: 'clear', generation: folder });
  db.finishControl(rows[0].rowid, true, JSON.stringify({ messages: [] }));
  expect(await (await response).json()).toMatchObject({
    available: true,
    generation: folder,
    thread: { messages: [] },
  });
});
