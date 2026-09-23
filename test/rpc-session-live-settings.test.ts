import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const original = { ...process.env };
let dir = '';
afterEach(async () => {
  await (await import('../src/agent/rpc-session.js')).closeAllRpcSessions();
  vi.resetModules();
  for (const key of ['PI_BIN', 'PI_CWD', 'SESSIONS_DIR']) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('applies model and thinking changes to the same live parent while its child runs', async () => {
  dir = mkdtempSync(join(tmpdir(), 'piweb-live-settings-'));
  const script = join(dir, 'pi.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
 const cmd = JSON.parse(line);
 if (cmd.type === 'prompt') {
  send({type:'extension_ui_request',method:'setWidget',widgetKey:'subagent-async',widgetLines:['PI_SUBAGENT_ASYNC_JSON:'+JSON.stringify({kind:'pi-subagents.async-status-snapshot',version:1,runs:[{id:'run',state:'running'}],omitted:{runs:0,children:0,byteLimitExceeded:false}})]});
  send({type:'agent_settled'});
 } else if (cmd.type === 'set_model' || cmd.type === 'set_thinking_level') {
  appendFileSync(${JSON.stringify(join(dir, 'commands.jsonl'))}, JSON.stringify({pid: process.pid, ...cmd})+'\\n');
  send({type:'response',id:cmd.id,command:cmd.type,success:true});
 }
});`,
  );
  chmodSync(script, 0o755);
  Object.assign(process.env, { PI_BIN: script, PI_CWD: dir, SESSIONS_DIR: join(dir, 'sessions') });
  vi.resetModules();
  const rpc = await import('../src/agent/rpc-session.js');
  const old = { model: 'openai-codex/gpt-5.6-sol', thinking: 'low', cwd: dir };
  const parent = rpc.getRpcSession('parent', old);
  await parent.prompt('start child');
  expect(parent.hasLiveSubagents).toBe(true);
  const updated = { ...old, model: 'openai-codex/gpt-6-sol', thinking: 'medium' };
  const ready = await rpc.prepareRpcSession('parent', updated);
  expect(ready).toBe(parent);
  expect(ready.isAlive).toBe(true);
  await ready.prompt('next message');
  // Model changes must reassert an unchanged thinking preference too.
  await rpc.prepareRpcSession('parent', { ...updated, model: 'openai-codex/gpt-5.6-sol' });
  const commands = readFileSync(join(dir, 'commands.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  expect(
    commands.map((command) => [command.type, command.provider ?? command.level, command.modelId]),
  ).toEqual([
    ['set_model', 'openai-codex', 'gpt-6-sol'],
    ['set_thinking_level', 'medium', undefined],
    ['set_model', 'openai-codex', 'gpt-5.6-sol'],
    ['set_thinking_level', 'medium', undefined],
  ]);
  expect(new Set(commands.map((command) => command.pid)).size).toBe(1);
});

it('still refuses to replace a live parent when its working directory changes', async () => {
  dir = mkdtempSync(join(tmpdir(), 'piweb-live-cwd-'));
  const script = join(dir, 'pi.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import readline from 'node:readline';
const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 if(JSON.parse(line).type!=='prompt')return;
 send({type:'extension_ui_request',method:'setWidget',widgetKey:'subagent-async',widgetLines:['PI_SUBAGENT_ASYNC_JSON:'+JSON.stringify({kind:'pi-subagents.async-status-snapshot',version:1,runs:[{id:'run',state:'running'}],omitted:{runs:0,children:0,byteLimitExceeded:false}})]});
 send({type:'agent_settled'});
});`,
  );
  chmodSync(script, 0o755);
  Object.assign(process.env, { PI_BIN: script, PI_CWD: dir, SESSIONS_DIR: join(dir, 'sessions') });
  vi.resetModules();
  const rpc = await import('../src/agent/rpc-session.js');
  const parent = rpc.getRpcSession('parent', { model: 'openai-codex/gpt-5.6-sol', cwd: dir });
  await parent.prompt('start child');
  await expect(
    rpc.prepareRpcSession('parent', {
      model: 'openai-codex/gpt-6-sol',
      cwd: join(dir, 'elsewhere'),
    }),
  ).rejects.toThrow(/subagents/);
  expect(parent.isAlive).toBe(true);
});
