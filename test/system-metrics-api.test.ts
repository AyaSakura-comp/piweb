import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('requires authentication, returns uncached telemetry, and exposes no client-selected filesystem path', async () => {
  const env = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), 'piweb-metrics-api-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('port unavailable');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  Object.assign(process.env, {
    DB_PATH: join(dir, 'db.sqlite'),
    PIDG_CONFIG: join(dir, 'missing.json'),
    SESSIONS_DIR: join(dir, 'sessions'),
    WEB_MEDIA_DIR: join(dir, 'media'),
    WEB_UPLOAD_DIR: join(dir, 'uploads'),
    WEB_AUTH_TOKEN: 'metrics-test-only',
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(port),
    WEB_TRUST_TAILSCALE_IDENTITY: 'false',
  });
  vi.resetModules();
  vi.doMock('../src/web/system-metrics.js', () => ({
    sampleSystemMetrics: async () => ({ gpuPercent: 0 }),
  }));
  const db = await import('../src/db.js');
  const { startWebServer } = await import('../src/web/server.js');
  db.initDb();
  const server = startWebServer();
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${port}`;
    expect((await fetch(`${origin}/api/system-metrics`)).status).toBe(401);
    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'metrics-test-only' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const response = await fetch(`${origin}/api/system-metrics?path=/etc/passwd`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ gpuPercent: 0 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (await import('../src/web/push.js')).stopPush();
    db.closeDb();
    vi.doUnmock('../src/web/system-metrics.js');
    vi.resetModules();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(dir, { recursive: true, force: true });
  }
});
