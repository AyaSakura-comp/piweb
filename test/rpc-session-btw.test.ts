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
  writeFileSync(
    fake,
    `#!/usr/bin/env node
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
`,
  );
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

it.each([true, false])(
  'clears only through the installed native extension (clear loaded: %s)',
  async (clearLoaded) => {
    const dir = mkdtempSync(join(tmpdir(), 'piweb-btw-clear-'));
    dirs.push(dir);
    const fake = join(dir, 'pi.mjs');
    writeFileSync(
      fake,
      `#!/usr/bin/env node
import readline from 'node:readline';
const emit = x => process.stdout.write(JSON.stringify(x) + '\\n');
let cleared = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line);
  if (c.type === 'get_state') emit({ type: 'response', id: c.id, success: true, data: {} });
  if (c.type === 'get_commands') emit({ type: 'response', id: c.id, success: true, data: { commands: ${JSON.stringify(clearLoaded ? ['btw:web', 'btw:clear'] : ['btw:web'])}.map(name => ({ name, source: 'extension', sourceInfo: { path: '/tmp/pi-btw/extensions/btw.ts' } })) } });
  if (c.type === 'prompt') {
    if (c.message === '/btw:clear') cleared = true;
    else if (c.message.startsWith('/btw:web ')) {
      const input = JSON.parse(Buffer.from(c.message.slice(9), 'base64url').toString());
      emit({ type: 'extension_ui_request', method: 'notify', message: 'PIWEB_BTW_JSON:' + JSON.stringify({ id: input.id, ok: true, messages: cleared ? [] : [{ role: 'assistant', content: 'old side' }] }) });
    } else throw new Error('Unexpected model prompt');
    emit({ type: 'response', id: c.id, success: true });
  }
});
`,
    );
    chmodSync(fake, 0o755);
    process.env.PI_BIN = fake;
    process.env.PI_CWD = dir;
    process.env.SESSIONS_DIR = join(dir, 'sessions');
    vi.resetModules();
    const rpc = await import('../src/agent/rpc-session.js');
    const parent = rpc.getRpcSession('web_btw_clear', { cwd: dir });
    if (clearLoaded) await expect(parent.btw('clear')).resolves.toMatchObject({ messages: [] });
    else
      await expect(parent.btw('clear')).rejects.toThrow('Native BTW clear command is not loaded');
  },
);

it('answers a snapshot while a side send is still running and reports it as pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piweb-btw-pending-'));
  dirs.push(dir);
  const fake = join(dir, 'pi.mjs');
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import readline from 'node:readline';
const emit = x => process.stdout.write(JSON.stringify(x) + '\\n');
const done = [];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line);
  if (c.type === 'get_state') emit({ type: 'response', id: c.id, success: true, data: {} });
  if (c.type === 'get_commands') emit({ type: 'response', id: c.id, success: true, data: { commands: [
    { name: 'btw:web', source: 'extension', sourceInfo: { path: '/tmp/pi-btw/extensions/btw.ts' } }
  ] } });
  if (c.type === 'prompt' && c.message.startsWith('/btw:web ')) {
    const input = JSON.parse(Buffer.from(c.message.slice(9), 'base64url').toString());
    const reply = () => {
      emit({ type: 'extension_ui_request', method: 'notify', message: 'PIWEB_BTW_JSON:' + JSON.stringify({ id: input.id, ok: true, messages: done }) });
      emit({ type: 'response', id: c.id, success: true });
    };
    if (input.action === 'send') setTimeout(() => { done.push({ role: 'user', content: input.text }, { role: 'assistant', content: 'answer' }); reply(); }, 1500);
    else reply();
  }
});
`,
  );
  chmodSync(fake, 0o755);
  process.env.PI_BIN = fake;
  process.env.PI_CWD = dir;
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  vi.resetModules();
  const rpc = await import('../src/agent/rpc-session.js');
  const parent = rpc.getRpcSession('web_btw_pending', { cwd: dir });
  const send = parent.btw('send', 'slow question');
  const started = Date.now();
  await expect(parent.btw('snapshot')).resolves.toMatchObject({
    messages: [],
    pending: ['slow question'],
  });
  expect(Date.now() - started).toBeLessThan(1000);
  await expect(send).resolves.toMatchObject({
    messages: [{ content: 'slow question' }, { content: 'answer' }],
  });
  await expect(parent.btw('snapshot')).resolves.toMatchObject({ pending: [] });
}, 15_000);
