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

describe('dashboard-layout cloud persistence API', () => {
  it('reads and writes multi-session dashboard layout across devices via /api/dashboard-layout', async () => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'piweb-dash-layout-'));
    const port = await unusedPort();
    Object.assign(process.env, {
      DB_PATH: resolve(tempDir, 'db.sqlite'),
      SESSIONS_DIR: resolve(tempDir, 'sessions'),
      WEB_AUTH_TOKEN: 'dash-test-token',
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

    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'dash-test-token' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const headers = {
      cookie,
      'content-type': 'application/json',
    };

    // 1. Initial GET returns layout: null when nothing has been saved yet
    const initRes = await fetch(`${baseUrl}/api/dashboard-layout`, { headers });
    expect(initRes.status).toBe(200);
    const initData = await initRes.json();
    expect(initData.layout).toBeNull();

    // 2. POST saves a 2D layout topology to backend SQLite
    const testLayout = {
      direction: 'row',
      groups: [
        { weight: 1, items: [{ jid: 'web:s01', weight: 1 }] },
        { weight: 1.2, items: [{ jid: 'web:s02', weight: 1 }, { jid: 'web:s03', weight: 1 }] },
      ],
      updatedAt: 1792345000000,
    };
    const postRes = await fetch(`${baseUrl}/api/dashboard-layout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ layout: testLayout }),
    });
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ ok: true });

    // 3. Second GET (e.g. from another device) retrieves the exact layout
    const getRes = await fetch(`${baseUrl}/api/dashboard-layout`, { headers });
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.layout).toEqual(testLayout);

    // 4. Also verify database meta table directly
    const stored = db.getMeta('dashboard.layout');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!)).toEqual(testLayout);
  });
});
