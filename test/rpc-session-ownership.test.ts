import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'PI_BIN', 'PI_CWD', 'RPC_IDLE_TIMEOUT_MS', 'SESSIONS_DIR'];

afterEach(async () => {
  const rpc = await import('../src/agent/rpc-session.js').catch(() => null);
  await rpc?.closeAllRpcSessions();
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

describe('persistent RPC filesystem ownership', () => {
  it('holds a durable channel lease while idle and retires the process when deletion revokes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-rpc-ownership-'));
    tempDirs.push(root);
    const dbPath = resolve(root, 'gateway.db');
    const sessionsDir = resolve(root, 'sessions');
    const fakePi = resolve(root, 'fake-pi.mjs');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type !== 'prompt') return;
  send({ type: 'agent_start' });
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } });
  send({ type: 'agent_end', messages: [] });
  send({ type: 'agent_settled' });
});
`,
    );
    chmodSync(fakePi, 0o755);
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = sessionsDir;
    process.env.PI_BIN = fakePi;
    process.env.PI_CWD = root;
    process.env.RPC_IDLE_TIMEOUT_MS = '600000';

    vi.resetModules();
    const db = await import('../src/db.js');
    const rpc = await import('../src/agent/rpc-session.js');
    db.initDb();
    db.registerChannel({
      jid: 'web:rpc-owner',
      name: 'RPC owner',
      folder: 'rpc-owner-folder',
      kind: 'standard',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    const session = rpc.getRpcSession('rpc-owner-folder', { channelJid: 'web:rpc-owner' });
    await expect(session.prompt('hello')).resolves.toMatchObject({ ok: true, text: 'ok' });

    const inspect = new Database(dbPath);
    try {
      expect(
        (
          inspect
            .prepare(
              "select count(*) as count from channel_operations where channel_jid = 'web:rpc-owner'",
            )
            .get() as { count: number }
        ).count,
      ).toBe(1);
    } finally {
      inspect.close();
    }

    db.softDeleteChannel('web:rpc-owner');
    expect(() => db.claimDeletedSessionsForPurge(['web:rpc-owner'])).toThrow();

    expect(await (rpc as any).sweepRpcSessionOwnership()).toBe(1);
    const batch = db.claimDeletedSessionsForPurge(['web:rpc-owner']);
    expect(batch.targets).toHaveLength(1);
    expect(rpc.rpcSessionIsStreaming('rpc-owner-folder')).toBe(false);
  });

  it('holds ownership until exit and SIGKILLs a child that ignores SIGTERM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-rpc-retirement-'));
    tempDirs.push(root);
    const dbPath = resolve(root, 'gateway.db');
    const sessionsDir = resolve(root, 'sessions');
    const fakePi = resolve(root, 'stubborn-pi.mjs');
    const pidFile = resolve(root, 'child.pid');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 60_000);
const rl = readline.createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type !== 'prompt') return;
  send({ type: 'agent_start' });
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } });
  send({ type: 'agent_settled' });
});
`,
    );
    chmodSync(fakePi, 0o755);
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = sessionsDir;
    process.env.PI_BIN = fakePi;
    process.env.PI_CWD = root;
    process.env.RPC_IDLE_TIMEOUT_MS = '600000';

    vi.resetModules();
    const db = await import('../src/db.js');
    const rpc = await import('../src/agent/rpc-session.js');
    db.initDb();
    db.registerChannel({
      jid: 'web:stubborn-rpc',
      name: 'Stubborn RPC',
      folder: 'stubborn-rpc-folder',
      kind: 'standard',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    const session = rpc.getRpcSession('stubborn-rpc-folder', {
      channelJid: 'web:stubborn-rpc',
    });
    await expect(session.prompt('hello')).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const pid = Number(readFileSync(pidFile, 'utf8'));

    const retirement = rpc.closeRpcSession('stubborn-rpc-folder');
    const leaseWhileTerminating = (() => {
      const inspect = new Database(dbPath, { readonly: true });
      try {
        return (
          inspect
            .prepare(
              "select count(*) as count from channel_operations where channel_jid = 'web:stubborn-rpc'",
            )
            .get() as { count: number }
        ).count;
      } finally {
        inspect.close();
      }
    })();

    if (retirement instanceof Promise) await retirement;
    else await new Promise((resolveWait) => setTimeout(resolveWait, 3_200));

    let childAlive = true;
    try {
      process.kill(pid, 0);
    } catch {
      childAlive = false;
    }
    if (childAlive) process.kill(pid, 'SIGKILL');

    expect(retirement).toBeInstanceOf(Promise);
    expect(leaseWhileTerminating).toBe(1);
    expect(childAlive).toBe(false);
    const inspect = new Database(dbPath, { readonly: true });
    try {
      expect(
        (
          inspect
            .prepare(
              "select count(*) as count from channel_operations where channel_jid = 'web:stubborn-rpc'",
            )
            .get() as { count: number }
        ).count,
      ).toBe(0);
    } finally {
      inspect.close();
    }
  }, 10_000);

  it('retains the durable lease after a post-spawn ChildProcess error until exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-rpc-post-spawn-error-'));
    tempDirs.push(root);
    const dbPath = resolve(root, 'gateway.db');
    const fakePi = resolve(root, 'post-spawn-error-pi.mjs');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import readline from 'node:readline';
setInterval(() => {}, 60_000);
const rl = readline.createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type !== 'prompt') return;
  send({ type: 'agent_start' });
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } });
  send({ type: 'agent_settled' });
});
`,
    );
    chmodSync(fakePi, 0o755);
    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(root, 'sessions');
    process.env.PI_BIN = fakePi;
    process.env.PI_CWD = root;
    process.env.RPC_IDLE_TIMEOUT_MS = '600000';

    vi.resetModules();
    const db = await import('../src/db.js');
    const rpc = await import('../src/agent/rpc-session.js');
    db.initDb();
    db.registerChannel({
      jid: 'web:post-spawn-error',
      name: 'Post-spawn error',
      folder: 'post-spawn-error-folder',
      kind: 'standard',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });

    const session = rpc.getRpcSession('post-spawn-error-folder', {
      channelJid: 'web:post-spawn-error',
    });
    let proc: any;
    try {
      await expect(session.prompt('hello')).resolves.toMatchObject({ ok: true });
      proc = (session as any).proc;
      expect(proc?.pid).toEqual(expect.any(Number));

      proc.emit('error', new Error('injected post-spawn stream error'));

      const inspect = new Database(dbPath, { readonly: true });
      try {
        expect(
          (
            inspect
              .prepare(
                "select count(*) as count from channel_operations where channel_jid = 'web:post-spawn-error'",
              )
              .get() as { count: number }
          ).count,
        ).toBe(1);
      } finally {
        inspect.close();
      }
    } finally {
      if (proc?.exitCode === null && proc?.signalCode === null) proc.kill('SIGKILL');
      if (proc?.exitCode === null && proc?.signalCode === null) {
        await new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit()));
      }
      await rpc.closeAllRpcSessions();
    }
  });

  it('makes closeAll wait for a retirement already removed from the session map', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-rpc-retirement-registry-'));
    tempDirs.push(root);
    const fakePi = resolve(root, 'delayed-retirement-pi.mjs');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import readline from 'node:readline';
const keepAlive = setInterval(() => {}, 60_000);
process.on('SIGTERM', () => {
  setTimeout(() => {
    clearInterval(keepAlive);
    process.exit(0);
  }, 150);
});
const rl = readline.createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type !== 'prompt') return;
  send({ type: 'agent_start' });
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } });
  send({ type: 'agent_settled' });
});
`,
    );
    chmodSync(fakePi, 0o755);
    process.env.DB_PATH = ':memory:';
    process.env.SESSIONS_DIR = resolve(root, 'sessions');
    process.env.PI_BIN = fakePi;
    process.env.PI_CWD = root;
    process.env.RPC_IDLE_TIMEOUT_MS = '600000';

    vi.resetModules();
    const db = await import('../src/db.js');
    const rpc = await import('../src/agent/rpc-session.js');
    db.initDb();
    const session = rpc.getRpcSession('retirement-registry-folder', {});
    await expect(session.prompt('hello')).resolves.toMatchObject({ ok: true });

    const retirement = rpc.closeRpcSession('retirement-registry-folder');
    let closeAllResolved = false;
    const closeAll = rpc.closeAllRpcSessions().then(() => {
      closeAllResolved = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));

    expect(closeAllResolved).toBe(false);
    await Promise.all([retirement, closeAll]);
    expect(closeAllResolved).toBe(true);
  });
});
