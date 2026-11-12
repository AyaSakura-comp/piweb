import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer as createProbeServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 🔑 login details, 2026-11-12: 「現在不是會把資料放在 session 裡面不是嗎？然後我想
// 要放在 disk 的時候至少是被加密過的，丟到 agent 的時候才解開，至少不要 read session
// data 的時候就有帳號密碼 leak」. The web tier seals, SQLite and the transcript
// hold no plain text, and the worker opens them only for the agent's turn.
// Made-up details only.

const USERNAME = 'octo-user-7731';
const PASSWORD = `pa$$ w0rd"q'x-9182`;

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const servers: Server[] = [];
const ENV_KEYS = [
  'DB_PATH',
  'PIDG_CONFIG',
  'SESSIONS_DIR',
  'WEB_AUTH_TOKEN',
  'WEB_HOST',
  'WEB_PORT',
  'WEB_TRUST_TAILSCALE_IDENTITY',
  'WEB_MEDIA_DIR',
  'WEB_UPLOAD_DIR',
  'SECRET_KEY_PATH',
  'SECRETS_RUNTIME_DIR',
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

async function startWeb() {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-login-secrets-'));
  tempDirs.push(tempDir);
  const probe = createProbeServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  Object.assign(process.env, {
    DB_PATH: resolve(tempDir, 'gateway.db'),
    PIDG_CONFIG: resolve(tempDir, 'missing.env'),
    SESSIONS_DIR: resolve(tempDir, 'sessions'),
    WEB_MEDIA_DIR: resolve(tempDir, 'media'),
    WEB_UPLOAD_DIR: resolve(tempDir, 'uploads'),
    SECRET_KEY_PATH: resolve(tempDir, 'config', 'secret-key.pem'),
    SECRETS_RUNTIME_DIR: resolve(tempDir, 'runtime'),
    WEB_AUTH_TOKEN: 'login-secrets-token',
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
  if (!server.listening) await new Promise<void>((done) => server.once('listening', done));
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'login-secrets-token' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const get = async (path: string) => (await fetch(`${origin}${path}`, { headers: { cookie } })).json();
  const post = (path: string, body: unknown) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const handoff = await import('../src/agent/secret-handoff.js');
  return { tempDir, db, get, post, handoff };
}

/** Every byte SQLite keeps for this database: the file, its WAL and shared memory. */
function databaseBytes(tempDir: string): Buffer {
  return Buffer.concat(
    ['gateway.db', 'gateway.db-wal', 'gateway.db-shm']
      .map((name) => join(tempDir, name))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path)),
  );
}

async function newSession(post: (path: string, body: unknown) => Promise<Response>) {
  const created = await (await post('/api/sessions', { name: 'Login test' })).json();
  return created.session?.jid ?? created.jid;
}

describe('login details sent with a message', () => {
  it('are refused until the worker has published its key, and offered after', async () => {
    const { get, post, handoff } = await startWeb();
    expect((await get('/api/me')).secrets).toBe(false);
    const jid = await newSession(post);
    const refused = await post(`/api/sessions/${encodeURIComponent(jid)}/messages`, {
      text: 'log in',
      secrets: [{ name: 'GitHub', username: USERNAME, password: PASSWORD }],
    });
    expect(refused.status).toBe(503);

    handoff.initSecretKey();
    expect((await get('/api/me')).secrets).toBe(true);
    expect(statSync(process.env.SECRET_KEY_PATH!).mode & 0o777).toBe(0o600);
  });

  it('leave no plain text in SQLite or the transcript, only the name', async () => {
    const { tempDir, db, get, post, handoff } = await startWeb();
    handoff.initSecretKey();
    const jid = await newSession(post);
    const sent = await post(`/api/sessions/${encodeURIComponent(jid)}/messages`, {
      text: '幫我登入 GitHub',
      secrets: [{ name: 'GitHub', username: USERNAME, password: PASSWORD }],
    });
    expect(sent.status).toBe(200);

    db.closeDb(); // flush the WAL into the file being scanned
    const bytes = databaseBytes(tempDir);
    expect(bytes.length).toBeGreaterThan(0);
    for (const value of [USERNAME, PASSWORD, 'w0rd']) {
      expect(bytes.includes(Buffer.from(value)), value).toBe(false);
      expect(bytes.includes(Buffer.from(JSON.stringify(value).slice(1, -1))), value).toBe(false);
    }
    db.initDb();

    const { events } = await get(`/api/sessions/${encodeURIComponent(jid)}/events`);
    const user = events.find((event: any) => event.role === 'user');
    expect(user.content).toBe('幫我登入 GitHub\n🔑 GitHub');
    expect(db.getChannelSecrets(jid)).toEqual([
      expect.objectContaining({ name: 'GitHub', base: 'PIWEB_SECRET_GITHUB' }),
    ]);
  });

  it('are opened for the agent as variable names, in files only the user can read', async () => {
    const { db, post, handoff } = await startWeb();
    handoff.initSecretKey();
    const jid = await newSession(post);
    await post(`/api/sessions/${encodeURIComponent(jid)}/messages`, {
      text: '',
      secrets: [{ name: 'GitHub', username: USERNAME, password: PASSWORD }],
    });
    // The pending `pi new` control row is the worker's; the message is ours.
    const message = db.claimNextMessage(jid)!;
    expect(JSON.parse(message.secrets!)).toEqual([{ name: 'GitHub', base: 'PIWEB_SECRET_GITHUB' }]);
    const channel = db.getChannel(jid)!;

    const pi = handoff.prepareSecretHandoff(channel, message.secrets, 'pi');
    expect(pi.prompt).toContain('- GitHub: account $PIWEB_SECRET_GITHUB_USER, password $PIWEB_SECRET_GITHUB_PASS');
    expect(pi.prompt).not.toContain(USERNAME);
    expect(pi.prompt).not.toContain(PASSWORD);
    expect(pi.redact(`echo ${PASSWORD}`)).toBe('echo $PIWEB_SECRET_GITHUB_PASS');

    const files = handoff.secretFilesFor(channel.folder);
    expect(files.json.startsWith(process.env.SECRETS_RUNTIME_DIR!)).toBe(true);
    expect(statSync(files.json).mode & 0o777).toBe(0o600);
    expect(statSync(files.env).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(files.json, 'utf8')).secrets[0]).toMatchObject({
      base: 'PIWEB_SECRET_GITHUB',
      username: USERNAME,
      password: PASSWORD,
    });
    // The shell file survives quotes and dollar signs in a password.
    const shell = execFileSync('bash', ['-c', `. "$1" && printf '%s\\n%s' "$PIWEB_SECRET_GITHUB_USER" "$PIWEB_SECRET_GITHUB_PASS"`, 'x', files.env], {
      encoding: 'utf8',
    });
    expect(shell).toBe(`${USERNAME}\n${PASSWORD}`);

    // Claude Code and agy have no Pi extension: they are told to source the file.
    const claude = handoff.prepareSecretHandoff(channel, message.secrets, 'claude');
    expect(claude.prompt).toContain(`. '${files.env}' && `);
    expect(claude.prompt).not.toContain(PASSWORD);

    // The turn's end takes the opened values out of the runtime dir.
    claude.release();
    expect(existsSync(files.json)).toBe(false);
    expect(existsSync(files.env)).toBe(false);

    // A later message without details does not re-announce them...
    expect(handoff.prepareSecretHandoff(channel, null, 'pi').prompt).toBe('');
    // ...unless another agent takes over the session.
    expect(handoff.prepareSecretHandoff(channel, null, 'agy', true).prompt).toContain('$PIWEB_SECRET_GITHUB_PASS');
  });

  it('go with the session: sending the name again replaces them, clearing forgets them', async () => {
    const { db, post, handoff } = await startWeb();
    handoff.initSecretKey();
    const jid = await newSession(post);
    const send = (password: string) =>
      post(`/api/sessions/${encodeURIComponent(jid)}/messages`, {
        text: 'x',
        secrets: [{ name: 'github', username: USERNAME, password }],
      });
    await send(PASSWORD);
    await send('second-password-55');
    const channel = db.getChannel(jid)!;
    expect(db.getChannelSecrets(jid)).toHaveLength(1);
    handoff.prepareSecretHandoff(channel, null, 'pi', true);
    const files = handoff.secretFilesFor(channel.folder);
    expect(JSON.parse(readFileSync(files.json, 'utf8')).secrets[0].password).toBe('second-password-55');

    const cleared = await post(`/api/sessions/${encodeURIComponent(jid)}/clear`, {});
    expect(cleared.status).toBe(200);
    expect(db.getChannelSecrets(jid)).toEqual([]);
    handoff.sweepSecretFiles();
    expect(existsSync(files.json)).toBe(false);
    expect(existsSync(files.env)).toBe(false);
  });

  it('reject malformed details without storing anything', async () => {
    const { db, post, handoff } = await startWeb();
    handoff.initSecretKey();
    const jid = await newSession(post);
    const bad = await post(`/api/sessions/${encodeURIComponent(jid)}/messages`, {
      text: 'x',
      secrets: [{ name: '', password: PASSWORD }],
    });
    expect(bad.status).toBe(400);
    expect(db.getChannelSecrets(jid)).toEqual([]);
  });
});
