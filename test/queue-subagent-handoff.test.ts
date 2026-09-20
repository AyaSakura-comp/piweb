import { chmodSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it.each([false, true])(
  'serializes queue file publication and typing cleanup before autonomous delivery (early settle=%s)',
  async (early) => {
    const old = { ...process.env };
    const dir = mkdtempSync(join(tmpdir(), 'piweb-handoff-'));
    const script = join(dir, 'pi.mjs');
    const releasePath = join(dir, 'finish');
    const startedPath = join(dir, 'started');
    const attachment = join(dir, 'result.txt');
    writeFileSync(attachment, 'original file');
    writeFileSync(
      script,
      `#!/usr/bin/env node
import readline from 'node:readline'; import {existsSync,writeFileSync} from 'node:fs';
const send=e=>process.stdout.write(JSON.stringify(e)+'\\n');
readline.createInterface({input:process.stdin}).on('line',l=>{const c=JSON.parse(l);if(c.type!=='prompt')return;
send({type:'agent_start'});send({type:'message_start',message:{role:'assistant'}});send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify('original [[file: ' + attachment + ']]')}}]}});send({type:'agent_settled'});
send({type:'agent_start'});send({type:'message_start',message:{role:'assistant'}});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'background partial'}});writeFileSync(${JSON.stringify(startedPath)},'yes');
const finish=()=>{send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'background final'}]}});send({type:'agent_settled'});};
${early ? 'finish();' : `const t=setInterval(()=>{if(existsSync(${JSON.stringify(releasePath)})){clearInterval(t);finish();}},10);`}
});`,
    );
    chmodSync(script, 0o755);
    Object.assign(process.env, {
      PIDG_CONFIG: '/dev/null',
      DB_PATH: join(dir, 'db'),
      SESSIONS_DIR: join(dir, 'sessions'),
      WEB_MEDIA_DIR: join(dir, 'media'),
      PI_BIN: script,
      PI_CWD: dir,
      RPC_STEER: 'true',
      POLL_INTERVAL_MS: '5',
      RPC_IDLE_TIMEOUT_MS: '60000',
    });
    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();
    const queue = await import('../src/agent/queue.js');
    const rpc = await import('../src/agent/rpc-session.js');
    const { webTransport } = await import('../src/transport/web.js');
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let sending = false;
    const order: string[] = [];
    (await import('../src/transport/index.js')).setTransport({
      ...webTransport,
      async sendFilesResponse(...args) {
        sending = true;
        await held;
        const result = await webTransport.sendFilesResponse(...args);
        order.push('original');
        return result;
      },
      async sendResponse(...args) {
        order.push(args[1]);
        return webTransport.sendResponse(...args);
      },
      async clearTyping(...args) {
        order.push('clear');
        return webTransport.clearTyping(...args);
      },
      async setTyping(...args) {
        order.push('busy');
        return webTransport.setTyping(...args);
      },
    });
    try {
      db.registerChannel({
        jid: 'web:handoff',
        name: 'Handoff',
        folder: 'parent',
        requiresTrigger: false,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      db.enqueueMessage({
        channelJid: 'web:handoff',
        sender: 'web',
        senderName: 'web',
        content: 'start',
        timestamp: new Date().toISOString(),
      });
      queue.startProcessingLoop();
      await vi.waitFor(() => {
        expect(sending).toBe(true);
        expect(existsSync(startedPath)).toBe(true);
      });
      // Let all immediate autonomous events reach the actual web transport.
      await new Promise((r) => setTimeout(r, 80));
      expect(order).toEqual(['busy']);
      release();
      await vi.waitFor(() => expect(order).toContain('original'));
      if (!early) {
        await vi.waitFor(() =>
          expect(db.getLiveOutput('web:handoff')?.content).toBe('background partial'),
        );
        expect(db.isChannelBusy('web:handoff')).toBe(true);
        writeFileSync(releasePath, 'yes');
      }
      await vi.waitFor(() => expect(order).toContain('background final'));
      expect(order).toEqual(['busy', 'original', 'clear', 'busy', 'background final', 'clear']);
      expect(db.isChannelBusy('web:handoff')).toBe(false);
      expect(
        db
          .getRecentWebEvents('web:handoff')
          .filter((e) => e.role === 'assistant')
          .map((e) => e.content),
      ).toEqual([expect.stringMatching(/^original \[\[file: \/media\//), 'background final']);
    } finally {
      release();
      await queue.stopProcessingLoop({ timeoutMs: 1000 });
      await rpc.closeAllRpcSessions();
      db.closeDb();
      for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
      Object.assign(process.env, old);
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
