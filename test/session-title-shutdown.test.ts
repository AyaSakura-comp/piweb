import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'DB_PATH',
  'PIDG_CONFIG',
  'SESSIONS_DIR',
  'SESSION_TITLE_BIN',
  'SESSION_TITLE_MODEL_PATH',
  'SESSION_TITLE_TIMEOUT_MS',
];

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return Number(readFileSync(pidFile, 'utf8'));
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error('title child did not record its PID');
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

afterEach(() => {
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session title worker shutdown', () => {
  it('does not resolve stop until the active title child has exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piweb-title-shutdown-'));
    tempDirs.push(dir);
    const bin = join(dir, 'fake-llama-simple.mjs');
    const pidFile = join(dir, 'pid');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 10000);
`,
    );
    chmodSync(bin, 0o755);

    process.env.DB_PATH = ':memory:';
    process.env.PIDG_CONFIG = join(dir, 'missing.env');
    process.env.SESSIONS_DIR = resolve(dir, 'sessions');
    process.env.SESSION_TITLE_BIN = bin;
    process.env.SESSION_TITLE_MODEL_PATH = join(dir, 'tiny.gguf');
    process.env.SESSION_TITLE_TIMEOUT_MS = '5000';

    vi.resetModules();
    const db = await import('../src/db.js');
    const worker = await import('../src/worker/session-title.js');
    db.initDb();

    let pid: number | undefined;
    let aliveWhenStopResolved = true;
    let jobAfterStop: { status: string; attempts: number; prompt: string } | undefined;
    try {
      db.registerChannel({
        jid: 'web:shutdown',
        name: 'New session',
        folder: 'web_shutdown',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.prepareSessionTitle('web:shutdown');
      const rowid = db.enqueueMessage({
        channelJid: 'web:shutdown',
        sender: 'web',
        senderName: 'web',
        content: 'title this session',
        timestamp: new Date().toISOString(),
      });
      db.queuePreparedSessionTitle('web:shutdown', 'title this session', rowid);
      db.markMessageDone(rowid);

      worker.startSessionTitleLoop();
      pid = await waitForPid(pidFile);
      await worker.stopSessionTitleLoop();
      aliveWhenStopResolved = processIsAlive(pid);
      jobAfterStop = db.getSessionTitleJob('web:shutdown');
    } finally {
      await worker.stopSessionTitleLoop();
      if (pid !== undefined && processIsAlive(pid)) {
        process.kill(pid, 'SIGKILL');
        await waitForExit(pid);
      }
      db.closeDb();
    }

    expect(aliveWhenStopResolved).toBe(false);
    expect(jobAfterStop).toMatchObject({
      status: 'pending',
      attempts: 0,
      prompt: 'title this session',
    });
  });
});
