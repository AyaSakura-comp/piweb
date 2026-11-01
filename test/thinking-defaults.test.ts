import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createProbeServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Settings' default thinking per mode (Life / ordinary sessions): stored in
// meta by the web tier, applied by the worker to sessions with no level of
// their own (channel-settings.ts).

vi.mock('../src/agent/model-catalog.js', () => ({
  isThinkingLevel: (value: string) =>
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value),
  listAvailableModels: () => [],
  resolveModelReference: () => undefined,
  resolveThinkingForModel: (_model: unknown, requested: string) => ({
    requested,
    effective: requested,
    adjusted: false,
  }),
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const servers: Server[] = [];
const ENV_KEYS = [
  'DB_PATH',
  'PI_MODEL',
  'PI_THINKING',
  'PIDG_CONFIG',
  'SESSIONS_DIR',
  'WEB_AUTH_TOKEN',
  'WEB_HOST',
  'WEB_PORT',
  'WEB_TRUST_TAILSCALE_IDENTITY',
  'WEB_MEDIA_DIR',
  'WEB_UPLOAD_DIR',
];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  const push = await import('../src/web/push.js').catch(() => null);
  push?.stopPush();
  const db = await import('../src/db.js').catch(() => null);
  db?.closeDb();
  vi.resetModules();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh database in a temp dir; PI_THINKING as given ('' = unset). */
async function freshModules(piThinking: string) {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-thinking-defaults-'));
  tempDirs.push(tempDir);
  Object.assign(process.env, {
    DB_PATH: resolve(tempDir, 'gateway.db'),
    PIDG_CONFIG: resolve(tempDir, 'missing.env'),
    SESSIONS_DIR: resolve(tempDir, 'sessions'),
    WEB_MEDIA_DIR: resolve(tempDir, 'media'),
    WEB_UPLOAD_DIR: resolve(tempDir, 'uploads'),
    PI_MODEL: ' ',
    PI_THINKING: piThinking || ' ',
  });
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  const settings = await import('../src/agent/channel-settings.js');
  return { db, settings };
}

function channel(kind: 'life' | 'standard', thinkingOverride = '') {
  return {
    jid: kind === 'life' ? 'web:life' : 'web:dev',
    name: kind,
    folder: `web_${kind}`,
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: thinkingOverride as '',
    cwdOverride: '',
    kind,
  };
}

const lifeDefaults = { modelRef: '', thinking: 'max' as const };

describe('default thinking per mode', () => {
  it('runs each mode at its Settings default unless the session picked a level', async () => {
    const { db, settings } = await freshModules('');
    const effective = (kind: 'life' | 'standard', override = '') =>
      settings.computeEffectiveChannelSettings(channel(kind, override), { lifeDefaults });

    // Nothing chosen: Life low, ordinary sessions Pi's own default.
    await expect(effective('life')).resolves.toMatchObject({
      requestedThinking: 'low',
      thinkingSource: 'default',
    });
    await expect(effective('standard')).resolves.toMatchObject({
      hasManagedThinking: false,
      thinkingSource: 'pi runtime default',
    });

    expect(db.setModeThinkingDefault('standard', 'high')).toBe(true);
    expect(db.setModeThinkingDefault('life', 'minimal')).toBe(true);
    await expect(effective('standard')).resolves.toMatchObject({
      requestedThinking: 'high',
      effectiveThinking: 'high',
      hasManagedThinking: true,
      thinkingSource: 'default',
    });
    await expect(effective('life')).resolves.toMatchObject({
      requestedThinking: 'minimal',
      thinkingSource: 'default',
    });
    // A level the session picked itself still wins over its mode's default.
    await expect(effective('standard', 'medium')).resolves.toMatchObject({
      requestedThinking: 'medium',
      thinkingSource: 'override',
    });
    await expect(effective('life', 'xhigh')).resolves.toMatchObject({
      requestedThinking: 'xhigh',
      thinkingSource: 'override',
    });
    expect(settings.getDesiredThinkingLevel(channel('standard'))).toBe('high');
    expect(settings.getDesiredThinkingLevel(channel('life'))).toBe('minimal');
  });

  it('rejects unknown modes and levels without storing them', async () => {
    const { db } = await freshModules('');
    expect(db.setModeThinkingDefault('discord', 'low')).toBe(false);
    expect(db.setModeThinkingDefault('life', 'huge')).toBe(false);
    expect(db.setModeThinkingDefault('standard', '')).toBe(false);
    expect(db.getThinkingDefaults()).toEqual({ life: '', standard: '' });
  });

  it('serves and saves the defaults over the API, built-in ones from the worker', async () => {
    const { db, settings } = await freshModules('medium');
    const probe = createProbeServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    Object.assign(process.env, {
      WEB_AUTH_TOKEN: 'thinking-defaults-token',
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      WEB_TRUST_TAILSCALE_IDENTITY: 'false',
    });
    vi.resetModules();
    const webDb = await import('../src/db.js');
    webDb.initDb();
    const { startWebServer } = await import('../src/web/server.js');
    const server = startWebServer();
    servers.push(server);
    if (!server.listening) await new Promise<void>((done) => server.once('listening', done));
    const origin = `http://127.0.0.1:${port}`;
    const login = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'thinking-defaults-token' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const get = async (path: string) =>
      (await fetch(`${origin}${path}`, { headers: { cookie } })).json();
    const post = (body: unknown) =>
      fetch(`${origin}/api/thinking-defaults`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // The worker publishes PI_THINKING, which the web tier's env does not have.
    expect(settings.builtinModeThinking('standard')).toBe('medium');
    expect(settings.builtinModeThinking('life')).toBe('low');
    webDb.setMeta(
      'thinking.builtin',
      JSON.stringify({
        life: settings.builtinModeThinking('life'),
        standard: settings.builtinModeThinking('standard'),
      }),
    );
    expect(await get('/api/thinking-defaults')).toEqual({
      defaults: { life: 'low', standard: 'medium' },
    });

    const saved = await post({ mode: 'standard', level: 'xhigh' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ defaults: { life: 'low', standard: 'xhigh' } });
    expect((await post({ mode: 'life', level: 'nope' })).status).toBe(400);
    expect((await post({ mode: 'other', level: 'low' })).status).toBe(400);
    expect((await get('/api/sessions')).thinkingDefaults).toEqual({
      life: 'low',
      standard: 'xhigh',
    });
    // The worker, on its own connection, runs ordinary sessions at it.
    expect(settings.getDesiredThinkingLevel(channel('standard'))).toBe('xhigh');
    expect(settings.getDesiredThinkingLevel(channel('standard', 'low'))).toBe('low');
    db.closeDb();
  });
});
