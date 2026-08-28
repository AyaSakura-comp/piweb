import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/model-catalog.js', () => ({
  isThinkingLevel: (value: string) =>
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value),
  listAvailableModels: () => [
    {
      ref: 'openai-codex/gpt-default',
      provider: 'openai-codex',
      id: 'gpt-default',
      name: 'GPT Default',
      reasoning: true,
      supportsXhigh: true,
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
  ],
  resolveModelReference: (ref: string) =>
    ref === 'openai-codex/gpt-default'
      ? {
          ref,
          provider: 'openai-codex',
          id: 'gpt-default',
          name: 'GPT Default',
          reasoning: true,
          supportsXhigh: true,
          supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        }
      : undefined,
  resolveThinkingForModel: (_model: unknown, requested: string) => ({
    requested,
    effective: requested,
    adjusted: false,
  }),
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const ENV_KEYS = [
  'PI_BIN',
  'PI_CWD',
  'PI_MODEL',
  'PI_THINKING',
  'PI_EXTRA_FLAGS',
  'PIDG_CONFIG',
  'LIFE_PROBE_ARGS_PATH',
  'LIFE_PROBE_PID_PATH',
  'LIFE_PROBE_TERM_PATH',
];

afterEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test process state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const lifeChannel = {
  jid: 'web:life',
  name: 'Life',
  folder: 'web_life',
  requiresTrigger: false,
  isMain: false,
  modelOverride: '',
  thinkingOverride: '' as const,
  cwdOverride: '/stale/project',
  kind: 'life' as const,
};

describe('Life runtime defaults', () => {
  it('uses one Pi-resolved model/thinking snapshot while ignoring stored overrides', async () => {
    const { computeEffectiveChannelSettings } = await import('../src/agent/channel-settings.js');
    await expect(
      computeEffectiveChannelSettings(lifeChannel, {
        lifeDefaults: { modelRef: 'openai-codex/gpt-default', thinking: 'max' },
      }),
    ).resolves.toMatchObject({
      rawModelRef: 'openai-codex/gpt-default',
      modelSource: 'default',
      requestedThinking: 'max',
      effectiveThinking: 'max',
      hasManagedThinking: true,
      thinkingSource: 'default',
      effectiveCwd: expect.any(String),
      cwdSource: 'default',
    });
  });

  it('keeps standard-session continue behavior unchanged', async () => {
    process.env.PI_MODEL = ' ';
    process.env.PI_THINKING = ' ';
    process.env.PIDG_CONFIG = join(tmpdir(), 'missing-piweb-config.env');
    vi.resetModules();
    const { computeEffectiveChannelSettings } = await import('../src/agent/channel-settings.js');

    await expect(
      computeEffectiveChannelSettings({ ...lifeChannel, kind: 'standard' }),
    ).resolves.toMatchObject({
      rawModelRef: '',
      modelSource: 'pi runtime default',
      hasManagedThinking: false,
      thinkingSource: 'pi runtime default',
      effectiveCwd: '/stale/project',
      cwdSource: 'override',
    });
  });

  it('waits for a SIGTERM-resistant probe to exit after abort and escalates without leaking it', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-resistant-probe-'));
    tempDirs.push(tempDir);
    const fakePi = join(tempDir, 'fake-resistant-pi.mjs');
    const pidPath = join(tempDir, 'pid');
    const termPath = join(tempDir, 'sigterm');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => writeFileSync(process.env.LIFE_PROBE_TERM_PATH, 'SIGTERM'));
writeFileSync(process.env.LIFE_PROBE_PID_PATH, String(process.pid));
process.stdin.resume();
setTimeout(() => process.exit(0), 1500);
`,
    );

    chmodSync(fakePi, 0o755);
    process.env.PI_BIN = fakePi;
    process.env.PI_CWD = tempDir;
    process.env.PI_MODEL = ' ';
    process.env.PI_THINKING = ' ';
    process.env.PIDG_CONFIG = join(tempDir, 'missing-config.env');
    process.env.LIFE_PROBE_PID_PATH = pidPath;
    process.env.LIFE_PROBE_TERM_PATH = termPath;
    vi.resetModules();
    const { probePiRuntimeDefaults } = await import('../src/agent/channel-settings.js');

    const controller = new AbortController();
    const pending = probePiRuntimeDefaults(lifeChannel, {
      signal: controller.signal,
      timeoutMs: 1_000,
      terminateGraceMs: 40,
    });
    await waitUntil(() => existsSync(pidPath));
    const abortStarted = Date.now();
    controller.abort();
    await expect(pending).rejects.toThrow('Life runtime-default probe aborted');
    const completionMs = Date.now() - abortStarted;

    const pid = Number(readFileSync(pidPath, 'utf8'));
    const aliveAtCompletion = isProcessAlive(pid);
    // Keep RED safe: the old implementation resolves immediately after SIGTERM,
    // so wait for the fake's own safety exit before making the failing assertion.
    if (aliveAtCompletion) await waitUntil(() => !isProcessAlive(pid));

    expect(readFileSync(termPath, 'utf8')).toBe('SIGTERM');
    expect(aliveAtCompletion).toBe(false);
    expect(completionMs).toBeLessThan(1_000);
  });

  it('lets abort override a valid response while the probe is closing without leaking the child', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-probe-teardown-abort-'));
    tempDirs.push(tempDir);
    const fakePi = join(tempDir, 'fake-teardown-resistant-pi.mjs');
    const pidPath = join(tempDir, 'pid');
    const termPath = join(tempDir, 'sigterm');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => writeFileSync(process.env.LIFE_PROBE_TERM_PATH, 'SIGTERM'));
writeFileSync(process.env.LIFE_PROBE_PID_PATH, String(process.pid));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.trim().split('\\n')) {
    const request = JSON.parse(line);
    if (request.type === 'get_state') {
      console.log(JSON.stringify({
        id: request.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: { provider: 'extension-provider', id: 'current-default' },
          thinkingLevel: 'max'
        }
      }));
    }
  }
});
setInterval(() => {}, 1000);
`,
    );

    chmodSync(fakePi, 0o755);
    process.env.PI_BIN = fakePi;
    process.env.PI_CWD = tempDir;
    process.env.PI_MODEL = ' ';
    process.env.PI_THINKING = ' ';
    process.env.PIDG_CONFIG = join(tempDir, 'missing-config.env');
    process.env.LIFE_PROBE_PID_PATH = pidPath;
    process.env.LIFE_PROBE_TERM_PATH = termPath;
    vi.resetModules();
    const { probePiRuntimeDefaults } = await import('../src/agent/channel-settings.js');

    const controller = new AbortController();
    const pending = probePiRuntimeDefaults(lifeChannel, {
      signal: controller.signal,
      timeoutMs: 1_000,
      terminateGraceMs: 100,
    });
    await waitUntil(() => existsSync(termPath));
    controller.abort();

    const completed = await pending.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: Error) => ({ status: 'rejected' as const, message: error.message }),
    );
    const pid = Number(readFileSync(pidPath, 'utf8'));
    const aliveAtCompletion = isProcessAlive(pid);
    if (aliveAtCompletion) {
      process.kill(pid, 'SIGKILL');
      await waitUntil(() => !isProcessAlive(pid));
    }

    expect(readFileSync(termPath, 'utf8')).toBe('SIGTERM');
    expect(aliveAtCompletion).toBe(false);
    expect(completed).toEqual({
      status: 'rejected',
      message: 'Life runtime-default probe aborted',
    });
  });

  it('asks the configured PI_BIN for its exact ephemeral RPC default', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'piweb-life-default-probe-'));
    tempDirs.push(tempDir);
    const fakePi = join(tempDir, 'fake-pi.mjs');
    const argsPath = join(tempDir, 'args.json');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LIFE_PROBE_ARGS_PATH, JSON.stringify({
  args: process.argv.slice(2),
  jid: process.env.PIWEB_CHANNEL_JID,
  folder: process.env.PIWEB_CHANNEL_FOLDER
}));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.trim().split('\\n')) {
    const request = JSON.parse(line);
    if (request.type === 'get_state') {
      console.log(JSON.stringify({
        id: request.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: { provider: 'extension-provider', id: 'current-default' },
          thinkingLevel: 'max'
        }
      }));
    }
  }
});
`,
    );

    chmodSync(fakePi, 0o755);
    process.env.PI_BIN = fakePi;
    process.env.PI_CWD = tempDir;
    process.env.PI_MODEL = ' ';
    process.env.PI_THINKING = ' ';
    process.env.PI_EXTRA_FLAGS = '--no-extensions --no-approve';
    process.env.PIDG_CONFIG = join(tempDir, 'missing-config.env');
    process.env.LIFE_PROBE_ARGS_PATH = argsPath;
    vi.resetModules();
    const { probePiRuntimeDefaults } = await import('../src/agent/channel-settings.js');

    await expect(probePiRuntimeDefaults(lifeChannel)).resolves.toEqual({
      modelRef: 'extension-provider/current-default',
      thinking: 'max',
    });
    expect(JSON.parse(readFileSync(argsPath, 'utf8'))).toEqual({
      args: expect.arrayContaining([
        '--mode',
        'rpc',
        '--no-session',
        '--no-extensions',
        '--no-approve',
      ]),
      jid: 'web:life',
      folder: 'web_life',
    });
  });
});
