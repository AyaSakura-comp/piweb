import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const old = { ...process.env };
let dir = '';
afterEach(async () => {
  await (await import('../src/agent/rpc-session.js')).closeAllRpcSessions();
  (await import('../src/db.js')).closeDb();
  vi.resetModules();
  for (const k of ['DB_PATH', 'SESSIONS_DIR', 'PI_BIN', 'PI_CWD', 'RPC_IDLE_TIMEOUT_MS']) {
    if (old[k] === undefined) delete process.env[k];
    else process.env[k] = old[k];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it('publishes exact selected parent and delivers autonomous completion under its own RPC lease', async () => {
  dir = mkdtempSync(join(tmpdir(), 'piweb-autonomous-'));
  const script = join(dir, 'pi.mjs');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import readline from 'node:readline';import{join}from'node:path';
const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
readline.createInterface({input:process.stdin}).on('line',l=>{const c=JSON.parse(l);
 if(c.type==='get_state')send({type:'response',id:c.id,command:'get_state',success:true,data:{sessionFile:join(${JSON.stringify(dir)},'sessions','parent','selected.jsonl'),sessionId:'selected-id'}});
 if(c.type!=='prompt')return;
 send({type:'agent_start'});send({type:'message_start',message:{role:'assistant'}});send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'launch accepted'}]}});send({type:'agent_settled'});
 setTimeout(()=>{send({type:'agent_start'});send({type:'message_start',message:{role:'assistant'}});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Child finished'}});send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Child finished'}]}});send({type:'agent_settled'});},60);
});`,
  );
  chmodSync(script, 0o755);
  Object.assign(process.env, {
    DB_PATH: join(dir, 'db'),
    SESSIONS_DIR: join(dir, 'sessions'),
    PI_BIN: script,
    PI_CWD: dir,
    RPC_IDLE_TIMEOUT_MS: '60000',
  });
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:parent',
    name: 'Parent',
    folder: 'parent',
    kind: 'standard',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const channel = db.getChannel('web:parent')!;
  const delivered: string[] = [];
  const streamed: any[] = [];
  const typing: string[] = [];
  (await import('../src/transport/index.js')).setTransport({
    sendResponse: async (_j, text, fence) => {
      expect(fence?.expectedStorageToken).toBe(channel.storageToken);
      delivered.push(text);
      return true;
    },
    sendFilesResponse: async () => true,
    setTyping: async () => {
      typing.push('busy');
    },
    clearTyping: async () => {
      typing.push('idle');
    },
    createEventStreamer: () => async (e) => {
      streamed.push(e);
    },
  });
  const rpc = await import('../src/agent/rpc-session.js');
  const session = rpc.getRpcSession('parent', {
    channelJid: channel.jid,
    channelStorageToken: channel.storageToken,
    channelOwnershipEpoch: channel.ownershipEpoch,
  });
  await expect(session.prompt('start')).resolves.toMatchObject({ text: 'launch accepted' });
  await vi.waitFor(() => expect(delivered).toEqual(['Child finished']));
  expect(streamed.some((e) => e.type === 'message_update')).toBe(true);
  expect(typing).toEqual(['busy', 'idle']);
  const marker = JSON.parse(
    readFileSync(join(dir, 'sessions', 'parent', '.piweb-current-parent.json'), 'utf8'),
  );
  expect(marker.file).toBe('selected.jsonl');
  expect(marker.id).toBe('selected-id');
  await rpc.closeRpcSession('parent');
  expect(existsSync(join(dir, 'sessions', 'parent', '.piweb-current-parent.json'))).toBe(false);
});

it('one-shot invocation replaces a retired selection with its actual JSON header and removes publication on exit', async () => {
  dir = mkdtempSync(join(tmpdir(), 'piweb-print-parent-'));
  const root = join(dir, 'sessions', 'parent');
  mkdirSync(root, { recursive: true });
  const script = join(dir, 'pi.mjs');
  const header = { type: 'session', id: 'print-id', cwd: dir };
  writeFileSync(join(root, 'print.jsonl'), JSON.stringify(header) + '\n');
  writeFileSync(
    script,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(header) + '\n')});
setTimeout(()=>process.exit(0), 150);
`,
  );
  chmodSync(script, 0o755);
  Object.assign(process.env, {
    DB_PATH: join(dir, 'db'),
    SESSIONS_DIR: join(dir, 'sessions'),
    PI_BIN: script,
    PI_CWD: dir,
  });
  vi.resetModules();
  let witnessed = false;
  const { invokeAgent } = await import('../src/agent/invoke.js');
  await invokeAgent('parent', 'start', {
    parentOwner: 'print-owner',
    cwd: dir,
    onEvent: (event) => {
      if (event.type === 'session') {
        const marker = JSON.parse(readFileSync(join(root, '.piweb-current-parent.json'), 'utf8'));
        expect(marker.id).toBe('print-id');
        expect(marker.owner).toBe('print-owner');
        witnessed = true;
      }
    },
  });
  expect(witnessed).toBe(true);
  expect(existsSync(join(root, '.piweb-current-parent.json'))).toBe(false);
});
