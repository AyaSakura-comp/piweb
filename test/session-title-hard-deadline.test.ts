import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSessionTitle } from '../src/agent/session-title.js';

const tempDirs: string[] = [];

function makeSigtermIgnoringChild(): { bin: string; modelPath: string; pidFile: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'piweb-title-deadline-'));
  tempDirs.push(cwd);
  const bin = join(cwd, 'fake-llama-simple.mjs');
  const modelPath = join(cwd, 'tiny.gguf');
  const pidFile = join(cwd, 'pid');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 1500);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, modelPath, pidFile };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session title hard deadline', () => {
  it('rejects only after the timed-out child has exited despite ignoring SIGTERM', async () => {
    const { pidFile, ...child } = makeSigtermIgnoringChild();
    const startedAt = Date.now();

    await expect(generateSessionTitle('title this', { ...child, timeoutMs: 250 })).rejects.toThrow(
      'timed out after 250ms',
    );

    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(processIsAlive(pid)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('rejects only after the aborted child has exited despite ignoring SIGTERM', async () => {
    const { pidFile, ...child } = makeSigtermIgnoringChild();
    const controller = new AbortController();
    const title = generateSessionTitle('title this', {
      ...child,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const abortedAt = Date.now();
    controller.abort();

    await expect(title).rejects.toThrow('Session title generation aborted');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(processIsAlive(pid)).toBe(false);
    expect(Date.now() - abortedAt).toBeLessThan(750);
  });
});
