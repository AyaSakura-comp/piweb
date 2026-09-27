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

describe('upload metrics API', () => {
  it('requires authentication, rejects cross-origin posts and logs only safe metrics', async () => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'piweb-metrics-api-'));
    const port = await unusedPort();
    Object.assign(process.env, {
      DB_PATH: resolve(tempDir, 'gateway.db'),
      SESSIONS_DIR: resolve(tempDir, 'sessions'),
      WEB_AUTH_TOKEN: 'metrics-test-token',
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      WEB_TRUST_TAILSCALE_IDENTITY: 'false',
    });
    vi.resetModules();
    const db = await import('../src/db.js');
    const { logger } = await import('../src/logger.js');
    const spy = vi.spyOn(logger, 'info');
    const { startWebServer } = await import('../src/web/server.js');
    db.initDb();
    const server = startWebServer();
    servers.push(server);
    if (!server.listening) await new Promise<void>((done) => server.once('listening', done));
    const origin = `http://127.0.0.1:${port}`;
    const metrics = {
      fileBytes: 2000000,
      fileCount: 1,
      bodyBytes: 2666700,
      uploadMs: 1000,
      totalMs: 1200,
      status: 200,
      outcome: 'response',
      filename: 'secret',
    };
    const post = (headers: Record<string, string> = {}, body: unknown = metrics) =>
      fetch(`${origin}/api/upload-metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect((await post()).status).toBe(401);
    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'metrics-test-token' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await post({ cookie, origin: 'https://untrusted.invalid' })).status).toBe(403);
    expect((await post({ cookie }, {})).status).toBe(400);
    expect((await post({ cookie })).status).toBe(200);
    const records = spy.mock.calls.filter((call) => call[1] === 'Upload metrics');
    expect(records).toHaveLength(1);
    expect(records[0][0]).toMatchObject({
      fileBytes: 2000000,
      route: 'unknown',
      source: 'browser',
    });
    expect(JSON.stringify(records)).not.toContain('secret');
    spy.mockRestore();
  });
});
