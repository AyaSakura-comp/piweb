import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const saved = { ...process.env };
const dirs: string[] = [];
afterEach(async () => {
  const rpc = await import('../src/agent/rpc-session.js');
  await rpc.closeAllRpcSessions();
  vi.resetModules();
  for (const key of ['PI_BIN', 'PI_CWD', 'SESSIONS_DIR']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('routes BTW to the warm parent even when side completion takes longer than 15 seconds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piweb-btw-rpc-'));
  dirs.push(dir);
  const fake = join(dir, 'pi.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let busy = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const cmd = JSON.parse(line);
  if (cmd.type === 'get_state') send({ type: 'response', id: cmd.id, success: true, data: {} });
  if (cmd.type === 'get_commands') send({ type: 'response', id: cmd.id, success: true, data: { commands: [
    { name: 'btw:web', source: 'extension', sourceInfo: { path: '/tmp/pi-btw/extensions/btw.ts' } }
  ] } });
  if (cmd.type === 'prompt' && cmd.message === 'main') {
    busy = true;
    send({ type: 'response', id: cmd.id, success: true });
    send({ type: 'agent_start' });
  } else if (cmd.type === 'prompt' && cmd.message.startsWith('/btw:web ')) {
    const input = JSON.parse(Buffer.from(cmd.message.slice(9), 'base64url').toString());
    setTimeout(() => {
      send({ type: 'extension_ui_request', method: 'notify', message: 'PIWEB_BTW_JSON:' + JSON.stringify({
        id: input.id, ok: busy, messages: [{ role: 'assistant', content: input.text || 'snapshot' }]
      }) });
      send({ type: 'response', id: cmd.id, success: true });
    }, 16_000);
  }
});
`);
  chmodSync(fake, 0o755);
  process.env.PI_BIN = fake;
  process.env.PI_CWD = dir;
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  vi.resetModules();
  const rpc = await import('../src/agent/rpc-session.js');
  const parent = rpc.getRpcSession('web_btw_rpc', { cwd: dir });
  void parent.prompt('main');
  await expect.poll(() => parent.isStreaming).toBe(true);
  await expect(parent.btw('send', 'side only')).resolves.toMatchObject({
    messages: [{ role: 'assistant', content: 'side only' }],
  });
}, 25_000);
