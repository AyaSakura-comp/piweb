import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const old = { ...process.env };
let dir = '';
afterEach(async () => {
  await (await import('../src/agent/rpc-session.js')).closeAllRpcSessions();
  vi.resetModules();
  for (const k of ['PI_BIN', 'PI_CWD', 'SESSIONS_DIR', 'RPC_IDLE_TIMEOUT_MS']) {
    if (old[k] === undefined) delete process.env[k];
    else process.env[k] = old[k];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it('keeps a settled parent alive for async work and consumes terminal widgets outside a turn', async () => {
  dir = mkdtempSync(join(tmpdir(), 'piweb-live-child-'));
  const script = join(dir, 'pi.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 if(JSON.parse(line).type!=='prompt')return;
 const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
 const widget=state=>send({type:'extension_ui_request',method:'setWidget',widgetKey:'subagent-async',widgetLines:['PI_SUBAGENT_ASYNC_JSON:'+JSON.stringify({kind:'pi-subagents.async-status-snapshot',version:1,runs:[{id:'run',state}],omitted:{runs:0,children:0,byteLimitExceeded:false}})]});
 widget('running'); send({type:'agent_settled'});
 setTimeout(()=>widget('complete'), 350);
});`,
  );
  chmodSync(script, 0o755);
  Object.assign(process.env, {
    PI_BIN: script,
    PI_CWD: dir,
    SESSIONS_DIR: join(dir, 'sessions'),
    RPC_IDLE_TIMEOUT_MS: '40',
  });
  vi.resetModules();
  const rpc = await import('../src/agent/rpc-session.js');
  const session = rpc.getRpcSession('channel', {});
  await session.prompt('test');
  await new Promise((r) => setTimeout(r, 140));
  expect(session.isAlive).toBe(true);
  await vi.waitFor(() => expect(session.isAlive).toBe(false), { timeout: 1500 });
});
