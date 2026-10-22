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

describe('subscription API', () => {
  it('queues OpenAI device login and returns pollable status without credentials', async () => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'piweb-subscription-api-'));
    const port = await unusedPort();
    process.env.DB_PATH = resolve(tempDir, 'gateway.db');
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');
    process.env.WEB_AUTH_TOKEN = 'subscription-test-token';
    process.env.WEB_HOST = '127.0.0.1';
    process.env.WEB_PORT = String(port);
    process.env.WEB_TRUST_TAILSCALE_IDENTITY = 'false';

    vi.resetModules();
    const db = await import('../src/db.js');
    const { startWebServer } = await import('../src/web/server.js');
    db.initDb();
    const server = startWebServer();
    servers.push(server);
    if (!server.listening) await new Promise<void>((done) => server.once('listening', done));

    const origin = `http://127.0.0.1:${port}`;
    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'subscription-test-token' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const request = (method = 'GET') =>
      fetch(`${origin}/api/subscriptions/openai-codex`, { method, headers: { cookie } });

    const queued = await request('POST');
    expect(queued.status).toBe(202);
    const queuedBody = await queued.json();
    expect(queuedBody).toMatchObject({
      job: { provider: 'openai-codex', action: 'login', status: 'pending' },
    });

    const status = await request();
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body).toMatchObject({
      provider: 'openai-codex',
      connected: false,
      job: { id: queuedBody.job.id },
    });
    expect(JSON.stringify(body)).not.toContain('access');
    expect(JSON.stringify(body)).not.toContain('refresh');

    // Claude: the pasted code is relayed to the waiting login but never echoed.
    const claude = (suffix = '', method = 'GET', payload?: unknown) =>
      fetch(`${origin}/api/subscriptions/anthropic${suffix}`, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
    expect((await claude('/code', 'POST', { code: 'early' })).status).toBe(409);
    const claudeLogin = await (await claude('', 'POST')).json();
    const claimed = db.claimPendingSubscriptionJob();
    expect(claimed?.id).not.toBe(claudeLogin.job.id); // OpenAI's job is first in line
    const claudeJob = db.claimPendingSubscriptionJob()!;
    expect(claudeJob.id).toBe(claudeLogin.job.id);
    db.updateSubscriptionJobAuthUrl(
      claudeJob.id,
      'https://claude.ai/oauth/authorize',
      new Date(Date.now() + 60_000),
    );
    expect((await claude('/code', 'POST', { code: '  ' })).status).toBe(400);
    const submitted = await claude('/code', 'POST', { code: 'SECRET-CODE#state' });
    expect(submitted.status).toBe(202);
    const claudeStatus = await (await claude()).json();
    expect(claudeStatus).toMatchObject({
      provider: 'anthropic',
      connected: false,
      job: { status: 'waiting', authUrl: 'https://claude.ai/oauth/authorize', codeSubmitted: true },
    });
    expect(JSON.stringify(claudeStatus)).not.toContain('SECRET-CODE');
    expect(db.takeSubscriptionJobCode(claudeJob.id)).toBe('SECRET-CODE#state');

    const cancelled = await claude('/cancel', 'POST');
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ job: { status: 'failed', error: 'Cancelled' } });
    // Antigravity (agy) is offered next to the pi providers.
    const agy = await fetch(`${origin}/api/subscriptions/agy`, { headers: { cookie } });
    expect(agy.status).toBe(200);
    expect(await agy.json()).toMatchObject({ provider: 'agy', connected: false, job: null });
    expect(
      (await fetch(`${origin}/api/subscriptions/unknown`, { headers: { cookie } })).status,
    ).toBe(404);
  });
});
