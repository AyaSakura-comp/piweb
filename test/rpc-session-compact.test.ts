import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(async () => {
  try {
    const rpc = await import('../src/agent/rpc-session.js');
    await rpc.closeAllRpcSessions();
  } catch {}
  vi.resetModules();
  for (const key of ['PI_BIN', 'PI_CWD', 'SESSIONS_DIR', 'RPC_IDLE_TIMEOUT_MS']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('persistent RPC compaction', () => {
  it('sends compact to the warm process and returns its correlated response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-rpc-compact-'));
    tempDirs.push(root);
    const fakePi = join(root, 'fake-pi.mjs');
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ type: 'response', command: 'get_state', id: command.id, success: true, data: {} });
  } else if (command.type === 'prompt') {
    send({ type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ready' }], stopReason: 'stop' };
    send({ type: 'message_start', message });
    send({ type: 'message_end', message });
    send({ type: 'agent_end', messages: [message], willRetry: false });
    send({ type: 'agent_settled' });
  } else if (command.type === 'compact') {
    send({ type: 'compaction_start', reason: 'manual' });
    const data = { summary: 'summary', tokensBefore: 427779, estimatedTokensAfter: 31234 };
    send({ type: 'compaction_end', reason: 'manual', result: data, aborted: false, willRetry: false });
    send({ type: 'response', command: 'compact', id: command.id, success: true, data });
  } else if (command.type === 'get_session_stats') {
    const data = {
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
      contextUsage: { tokens: 427779, contextWindow: 1050000, percent: 40.7 },
    };
    send({ type: 'response', command: 'get_session_stats', id: command.id, success: true, data });
  }
});
`,
    );
    chmodSync(fakePi, 0o755);
    process.env.PI_BIN = fakePi;
    process.env.PI_CWD = root;
    process.env.SESSIONS_DIR = join(root, 'sessions');
    process.env.RPC_IDLE_TIMEOUT_MS = '60000';
    vi.resetModules();

    const rpc = await import('../src/agent/rpc-session.js');
    const session = rpc.getRpcSession('web_compact_live', { cwd: root });
    await expect(session.prompt('start')).resolves.toMatchObject({ ok: true, text: 'ready' });

    await expect(rpc.getRpcSessionStats('web_compact_live')).resolves.toEqual({
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
      contextUsage: { tokens: 427779, contextWindow: 1050000, percent: 40.7 },
    });

    await expect(rpc.compactRpcSession('web_compact_live')).resolves.toEqual({
      summary: 'summary',
      tokensBefore: 427779,
      estimatedTokensAfter: 31234,
    });
  });
});
