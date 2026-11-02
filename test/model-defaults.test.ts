import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createProbeServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Settings' default model per mode (Life / ordinary sessions): stored in meta
// by the web tier, run by the worker for Life and for every session with no
// model of its own (channel-settings.ts).

const catalog = vi.hoisted(() => ({
  models: [] as Array<{ ref: string; provider: string; id: string; name: string }>,
}));

vi.mock('../src/agent/model-catalog.js', () => ({
  isThinkingLevel: (value: string) =>
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value),
  listAvailableModels: () => catalog.models,
  resolveModelReference: (ref: string, models = catalog.models) =>
    models.find((model) => model.ref === ref),
  resolveThinkingForModel: (_model: unknown, requested: string) => ({
    requested,
    effective: requested,
    adjusted: false,
  }),
}));

const MODELS = [
  'agy/gemini-4-argon-high',
  'claude-code/opus',
  'local-strata/qwen3.8-flash',
  'openai-codex/gpt-5.6-sol',
].map((ref) => {
  const [provider, id] = ref.split('/');
  return { ref, provider, id, name: id };
});

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const servers: Server[] = [];
const ENV_KEYS = [
  'DB_PATH',
  'PI_BIN',
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
  catalog.models = [];
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh database in a temp dir with the worker's catalog published; PI_MODEL unset. */
async function freshModules() {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-model-defaults-'));
  tempDirs.push(tempDir);
  Object.assign(process.env, {
    DB_PATH: resolve(tempDir, 'gateway.db'),
    PIDG_CONFIG: resolve(tempDir, 'missing.env'),
    SESSIONS_DIR: resolve(tempDir, 'sessions'),
    WEB_MEDIA_DIR: resolve(tempDir, 'media'),
    WEB_UPLOAD_DIR: resolve(tempDir, 'uploads'),
    // A Life probe would have to spawn this, and fail.
    PI_BIN: resolve(tempDir, 'no-such-pi'),
    PI_MODEL: ' ',
    PI_THINKING: ' ',
  });
  catalog.models = MODELS;
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  db.setMeta('models', JSON.stringify(MODELS));
  const settings = await import('../src/agent/channel-settings.js');
  return { db, settings };
}

function channel(kind: 'life' | 'standard', modelOverride = '') {
  return {
    jid: kind === 'life' ? 'web:life' : 'web:dev',
    name: kind,
    folder: `web_${kind}`,
    requiresTrigger: false,
    isMain: false,
    modelOverride,
    thinkingOverride: '' as const,
    cwdOverride: '',
    kind,
  };
}

const lifeDefaults = { modelRef: 'local-strata/qwen3.8-flash', thinking: 'low' as const };

describe('default model per mode', () => {
  it('runs each mode on its Settings model unless the session picked one', async () => {
    const { db, settings } = await freshModules();
    const effective = (kind: 'life' | 'standard', override = '', options = { lifeDefaults }) =>
      settings.computeEffectiveChannelSettings(channel(kind, override), options);

    // Nothing chosen: ordinary sessions leave the model to Pi, Life asks Pi.
    await expect(effective('standard')).resolves.toMatchObject({
      rawModelRef: '',
      modelSource: 'pi runtime default',
    });
    await expect(effective('life')).resolves.toMatchObject({
      rawModelRef: 'local-strata/qwen3.8-flash',
    });

    expect(db.setModeModelDefault('standard', 'openai-codex/gpt-5.6-sol')).toBe(true);
    expect(db.setModeModelDefault('life', 'openai-codex/gpt-5.6-sol')).toBe(true);
    await expect(effective('standard')).resolves.toMatchObject({
      rawModelRef: 'openai-codex/gpt-5.6-sol',
      modelSource: 'default',
    });
    // A model the session picked itself still wins over its mode's default.
    await expect(effective('standard', 'claude-code/opus')).resolves.toMatchObject({
      rawModelRef: 'claude-code/opus',
      modelSource: 'override',
    });
    // Life's Settings model needs no probe: PI_BIN does not exist.
    await expect(effective('life', '', {} as never)).resolves.toMatchObject({
      rawModelRef: 'openai-codex/gpt-5.6-sol',
      modelSource: 'default',
    });
    expect(settings.configuredModelRef(channel('standard'))).toBe('openai-codex/gpt-5.6-sol');

    // A model the catalog dropped (a signed-out subscription) falls back to
    // Pi's default rather than failing every turn...
    catalog.models = MODELS.filter((model) => model.provider !== 'openai-codex');
    await expect(effective('standard')).resolves.toMatchObject({ rawModelRef: '' });
    await expect(effective('life')).resolves.toMatchObject({
      rawModelRef: 'local-strata/qwen3.8-flash',
    });
    // ...but an empty catalog (worker still starting) cannot tell, so it stands.
    catalog.models = [];
    expect(settings.configuredModelRef(channel('standard'))).toBe('openai-codex/gpt-5.6-sol');

    // '' follows Pi's default again.
    expect(db.setModeModelDefault('standard', '')).toBe(true);
    catalog.models = MODELS;
    expect(settings.configuredModelRef(channel('standard'))).toBe('');
  });

  it('stores only published models, and only Pi models for Life', async () => {
    const { db } = await freshModules();
    expect(db.setModeModelDefault('discord', 'local-strata/qwen3.8-flash')).toBe(false);
    expect(db.setModeModelDefault('standard', 'local-strata/no-such-model')).toBe(false);
    expect(db.setModeModelDefault('standard', 42)).toBe(false);
    expect(db.setModeModelDefault('life', 'agy/gemini-4-argon-high')).toBe(false);
    expect(db.setModeModelDefault('life', 'claude-code/opus')).toBe(false);
    expect(db.getModelDefaults()).toEqual({ life: '', standard: '', piDefault: '' });
    // Ordinary sessions can run on agy or Claude Code.
    expect(db.setModeModelDefault('standard', 'agy/gemini-4-argon-high')).toBe(true);
    expect(db.setModeModelDefault('life', 'local-strata/qwen3.8-flash')).toBe(true);
    expect(db.getModelDefaults()).toMatchObject({
      life: 'local-strata/qwen3.8-flash',
      standard: 'agy/gemini-4-argon-high',
    });
  });

  it('serves and saves the defaults over the API and badges sessions that follow them', async () => {
    await freshModules();
    const probe = createProbeServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((done) => probe.close(() => done()));
    Object.assign(process.env, {
      WEB_AUTH_TOKEN: 'model-defaults-token',
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
      body: JSON.stringify({ token: 'model-defaults-token' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const get = async (path: string) =>
      (await fetch(`${origin}${path}`, { headers: { cookie } })).json();
    const post = (body: unknown) =>
      fetch(`${origin}/api/model-defaults`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // The worker publishes what "Pi 預設" means; the web tier cannot read it.
    webDb.setMeta('model.pi_default', 'local-strata/qwen3.8-flash');
    expect(await get('/api/model-defaults')).toEqual({
      defaults: { life: '', standard: '', piDefault: 'local-strata/qwen3.8-flash' },
    });

    const saved = await post({ mode: 'standard', model: 'openai-codex/gpt-5.6-sol' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      defaults: {
        life: '',
        standard: 'openai-codex/gpt-5.6-sol',
        piDefault: 'local-strata/qwen3.8-flash',
      },
    });
    expect((await post({ mode: 'life', model: 'claude-code/opus' })).status).toBe(400);
    expect((await post({ mode: 'standard', model: 'gone/model' })).status).toBe(400);
    expect((await post({ mode: 'other', model: '' })).status).toBe(400);

    // A session with no model of its own wears the default's badge; one with
    // its own keeps it.
    webDb.registerChannel({ ...channel('standard'), jid: 'web:follows', folder: 'web_follows' });
    webDb.registerChannel({
      ...channel('standard', 'local-strata/qwen3.8-flash'),
      jid: 'web:own',
      folder: 'web_own',
    });
    const listing = await get('/api/sessions');
    expect(listing.modelDefaults).toMatchObject({ standard: 'openai-codex/gpt-5.6-sol' });
    const byJid = Object.fromEntries(
      listing.sessions.map((session: { jid: string }) => [session.jid, session]),
    );
    expect(byJid['web:follows']).toMatchObject({
      model: '',
      provider: 'openai-codex',
      runningModel: 'openai-codex/gpt-5.6-sol',
      pending: true,
      badge: { label: 'SOL' },
    });
    expect(byJid['web:own']).toMatchObject({
      model: 'local-strata/qwen3.8-flash',
      provider: 'local-strata',
    });

    // A default the worker's catalog no longer offers (a signed-out
    // subscription) runs on Pi's default, so the badge stops claiming it,
    // while Settings still shows the choice.
    webDb.setMeta(
      'models',
      JSON.stringify(MODELS.filter((model) => model.provider !== 'openai-codex')),
    );
    const fallen = (await get('/api/sessions')).sessions.find(
      (session: { jid: string }) => session.jid === 'web:follows',
    );
    expect(fallen).toMatchObject({ provider: '', runningModel: '', pending: true, badge: null });
    expect((await get('/api/model-defaults')).defaults.standard).toBe('openai-codex/gpt-5.6-sol');
  });
});
