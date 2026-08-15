import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['PI_BIN', 'PI_CWD', 'RPC_IDLE_TIMEOUT_MS', 'SESSIONS_DIR'];

afterEach(async () => {
  try {
    const rpc = await import('../src/agent/rpc-session.js');
    rpc.closeAllRpcSessions();
  } catch {
    // The module may fail to load while the requested API is still RED.
  }
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('persistent RPC abort', () => {
  it('waits for agent_settled instead of resolving at an intermediate agent_end', async () => {
    prepareFakeRpc();
    const rpc = await import('../src/agent/rpc-session.js');
    const session = rpc.getRpcSession('web_settled', {});
    let resolved = false;

    const resultPromise = session.prompt('settled-test').then((result) => {
      resolved = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolved).toBe(false);
    await expect(resultPromise).resolves.toMatchObject({ ok: true, text: 'final answer' });
  });

  it('sends abort only after Pi has persisted the active user prompt', async () => {
    prepareFakeRpc();
    const rpc = await import('../src/agent/rpc-session.js');
    const session = rpc.getRpcSession('web_abort', {});

    const resultPromise = session.prompt('abort-test');

    expect(rpc.abortRpcSession('web_abort')).toBe(true);
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      aborted: true,
      text: '',
    });
  });
});

function prepareFakeRpc(): void {
  const dir = mkdtempSync(join(tmpdir(), 'piweb-rpc-abort-'));
  tempDirs.push(dir);
  const script = join(dir, 'fake-pi.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
let userPersisted = false;
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'prompt' && command.message === 'settled-test') {
    send({ type: 'agent_start' });
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'intermediate answer' }], stopReason: 'stop' } });
    send({ type: 'agent_end', messages: [] });
    setTimeout(() => {
      send({ type: 'agent_start' });
      send({ type: 'message_start', message: { role: 'assistant', content: [] } });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], stopReason: 'stop' } });
      send({ type: 'agent_end', messages: [] });
      send({ type: 'agent_settled' });
    }, 60);
  } else if (command.type === 'prompt' && command.message === 'abort-test') {
    send({ type: 'agent_start' });
    setTimeout(() => {
      send({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'abort-test' }] } });
      send({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'abort-test' }] } });
      userPersisted = true;
    }, 40);
  } else if (command.type === 'abort') {
    if (!userPersisted) {
      send({ type: 'response', command: 'abort', success: false, error: 'prompt not persisted' });
      return;
    }
    send({ type: 'response', command: 'abort', success: true });
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    send({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } });
    send({ type: 'agent_end', messages: [] });
    send({ type: 'agent_settled' });
  }
});
`,
  );
  chmodSync(script, 0o755);
  process.env.PI_BIN = script;
  process.env.PI_CWD = dir;
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  process.env.RPC_IDLE_TIMEOUT_MS = '60000';
  vi.resetModules();
}
