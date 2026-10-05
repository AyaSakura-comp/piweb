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
    await rpc.closeAllRpcSessions();
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

describe('extension-owned RPC turns', () => {
  it('finishes a prompt consumed by an extension and returns its displayed receipt', async () => {
    prepareFakeRpc();
    const rpc = await import('../src/agent/rpc-session.js');
    const session = rpc.getRpcSession('web_handled', {});
    await expect(session.prompt('handled')).resolves.toMatchObject({ ok: true, text: 'done: written' });
  });

  it('uses displayed custom messages when a run ends without assistant text, never hidden ones', async () => {
    prepareFakeRpc();
    const rpc = await import('../src/agent/rpc-session.js');
    const session = rpc.getRpcSession('web_toolonly', {});
    await expect(session.prompt('tool-only')).resolves.toMatchObject({ ok: true, text: 'preview: confirm abc' });
  });

  it('keeps the assistant answer authoritative when one exists', async () => {
    prepareFakeRpc();
    const rpc = await import('../src/agent/rpc-session.js');
    const session = rpc.getRpcSession('web_normal', {});
    await expect(session.prompt('normal')).resolves.toMatchObject({ ok: true, text: 'answer' });
  });
});

function prepareFakeRpc(): void {
  const dir = mkdtempSync(join(tmpdir(), 'piweb-rpc-handled-'));
  tempDirs.push(dir);
  const script = join(dir, 'fake-pi.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
rl.on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type !== 'prompt') return;
  if (command.message === 'handled') {
    send({ type: 'message_end', message: { role: 'custom', customType: 'receipt', display: true, content: 'done: written' } });
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'input_handled', via: 'input' });
  } else if (command.message === 'tool-only') {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'x', arguments: {} }], stopReason: 'toolUse' } });
    send({ type: 'message_end', message: { role: 'custom', customType: 'receipt', display: true, content: 'preview: confirm abc' } });
    send({ type: 'message_end', message: { role: 'custom', customType: 'hidden', display: false, content: 'secret context' } });
    send({ type: 'agent_end', messages: [] });
    send({ type: 'agent_settled' });
  } else if (command.message === 'normal') {
    send({ type: 'agent_start' });
    send({ type: 'message_end', message: { role: 'custom', customType: 'note', display: true, content: 'side note' } });
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], stopReason: 'stop' } });
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
