import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
const old = { ...process.env };
let dir = '';
let server: Server | undefined;
const keys = [
  'DB_PATH',
  'SESSIONS_DIR',
  'PIDG_CONFIG',
  'WEB_AUTH_TOKEN',
  'WEB_HOST',
  'WEB_PORT',
  'WEB_TRUST_TAILSCALE_IDENTITY',
  'WEB_PUBLIC_ORIGIN',
  'WEB_MEDIA_DIR',
  'WEB_UPLOAD_DIR',
];
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  (await import('../src/web/push.js')).stopPush();
  (await import('../src/db.js')).closeDb();
  vi.resetModules();
  for (const k of keys) {
    if (old[k] === undefined) delete process.env[k];
    else process.env[k] = old[k];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it('authenticates all child reads, binds exact parent, and requires Life generation', async () => {
  dir = mkdtempSync(join(tmpdir(), 'piweb-subagent-api-'));
  const token = randomBytes(32).toString('hex');
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  Object.assign(process.env, {
    PIDG_CONFIG: '/dev/null',
    DB_PATH: join(dir, 'gateway.db'),
    SESSIONS_DIR: join(dir, 'sessions'),
    WEB_MEDIA_DIR: join(dir, 'media'),
    WEB_UPLOAD_DIR: join(dir, 'uploads'),
    WEB_AUTH_TOKEN: token,
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(port),
    WEB_TRUST_TAILSCALE_IDENTITY: 'false',
    WEB_PUBLIC_ORIGIN: '',
  });
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  server = (await import('../src/web/server.js')).startWebServer();
  if (!server.listening) await new Promise<void>((r) => server!.once('listening', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw Error('No address');
  const origin = 'http://127.0.0.1:' + addr.port;
  const login = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(origin + path, {
      method,
      headers: { cookie, Origin: origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const parent = (await (await request('/api/sessions', 'POST', { name: 'Parent' })).json()) as any;
  const other = (await (await request('/api/sessions', 'POST', { name: 'Other' })).json()) as any;
  const folder = db.getChannel(parent.jid)!.folder;
  const root = join(dir, 'sessions', folder);
  mkdirSync(join(root, 'parent', 'run', 'run-0'), { recursive: true });
  writeFileSync(
    join(root, 'parent.jsonl'),
    JSON.stringify({
      type: 'session',
      id: 'parent-id',
      cwd: (await import('../src/config.js')).config.piCwd,
    }) + '\n',
  );
  writeFileSync(
    join(root, 'parent', 'run', 'run-0', 'session.jsonl'),
    JSON.stringify({ type: 'session', id: 'child-id' }) + '\n',
  );
  // The sidebar tracks child activity separately from the parent's turn state.
  const channel = db.getChannel(parent.jid)!;
  const marker = {
    owner: `${channel.storageToken}:${channel.folder}:${channel.ownershipEpoch}`,
    cwd: (await import('../src/config.js')).config.piCwd,
    runtime: 'test-runtime', id: 'parent-id', file: 'parent.jsonl',
    expires: Date.now() + 60000,
    activity: { files: ['parent/run/run-0/session.jsonl'], expires: Date.now() + 60000 },
  };
  const publish = () => writeFileSync(join(root, '.piweb-current-parent.json'), JSON.stringify(marker) + '\n');
  const sidebar = async () => (await (await request('/api/sessions')).json()).sessions;
  publish();
  const sessions = await sidebar();
  expect(sessions.find((s: any) => s.jid === parent.jid)).toMatchObject({ busy: false, subagentsBusy: true });
  expect(sessions.find((s: any) => s.jid === other.jid).subagentsBusy).toBe(false);
  marker.activity.files = [];
  publish();
  expect((await sidebar()).find((s: any) => s.jid === parent.jid).subagentsBusy).toBe(false);
  marker.activity.files = ['parent/run/run-0/session.jsonl'];
  marker.activity.expires = 0;
  publish();
  expect((await sidebar()).find((s: any) => s.jid === parent.jid).subagentsBusy).toBe(false);
  marker.activity.expires = Date.now() + 60000;
  marker.owner = 'previous-owner';
  publish();
  expect((await sidebar()).find((s: any) => s.jid === parent.jid).subagentsBusy).toBe(false);

  const endpoint = '/api/sessions/' + encodeURIComponent(parent.jid) + '/subagents';
  expect((await fetch(origin + endpoint)).status).toBe(401);
  const list = (await (await request(endpoint)).json()) as any;
  expect(list.children).toHaveLength(1);
  expect((await request(endpoint + '?child=' + list.children[0].id)).status).toBe(400);
  expect(
    (await request(endpoint + '?scope=' + list.scope + '&child=' + list.children[0].id)).status,
  ).toBe(200);
  expect(
    (
      await request(
        '/api/sessions/' +
          encodeURIComponent(other.jid) +
          '/subagents?scope=' +
          list.scope +
          '&child=' +
          list.children[0].id,
      )
    ).status,
  ).toBe(409);
  expect((await request(endpoint + '?scope=' + list.scope + '&child=../../private')).status).toBe(
    404,
  );
  const commandEndpoint = '/api/sessions/' + encodeURIComponent(parent.jid) + '/commands-running';
  expect((await fetch(origin + commandEndpoint)).status).toBe(401);
  db.appendWebEvent({
    channelJid: parent.jid,
    kind: 'system',
    role: 'agy-command',
    content: JSON.stringify({
      id: 'turn:1',
      command: 'npm test',
      state: 'running',
      updatedAt: Date.now(),
    }),
  });
  expect((await (await request(commandEndpoint)).json()).commands[0].state).toBe('unknown');
  db.appendWebEvent({
    channelJid: parent.jid,
    kind: 'system',
    role: 'agy-command',
    content: JSON.stringify({
      id: 'turn:1',
      command: 'npm test',
      state: 'cancelled',
      updatedAt: Date.now(),
    }),
  });
  const commandList = await (await request(commandEndpoint)).json();
  expect(commandList.commands).toHaveLength(1);
  expect(commandList.commands[0].state).toBe('cancelled');
  expect(
    (
      await (
        await request('/api/sessions/' + encodeURIComponent(other.jid) + '/commands-running')
      ).json()
    ).commands,
  ).toEqual([]);
  const life = (await (await request('/api/life-session', 'POST', {})).json()) as any;
  expect((await request('/api/sessions/web%3Alife/commands-running')).status).toBe(400);
  expect((await request('/api/sessions/web%3Alife/commands-running?generation=stale')).status).toBe(
    400,
  );
  expect(
    (await request('/api/sessions/web%3Alife/commands-running?generation=' + life.generation))
      .status,
  ).toBe(200);
  expect((await request('/api/sessions/web%3Alife/subagents')).status).toBe(400);
  expect(
    (await request('/api/sessions/web%3Alife/subagents?generation=' + life.generation)).status,
  ).toBe(200);
  db.setChannelModelOverride(parent.jid, 'claude-code/opus');
  for (const [source, expected] of [
    [undefined, 'claude-usage'],
    ['toolbar', 'claude-usage'],
    ['composer', 'gpt-usage'],
  ]) {
    const response = await request(
      '/api/sessions/' + encodeURIComponent(parent.jid) + '/commands',
      'POST',
      { command: 'gpt-usage', args: {}, ...(source ? { source } : {}) },
    );
    expect(response.status).toBe(200);
    expect(db.getControl((await response.json()).rowid)?.command).toBe(expected);
  }
});
