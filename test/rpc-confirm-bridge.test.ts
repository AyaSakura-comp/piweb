import Database from 'better-sqlite3';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'PI_BIN', 'PI_CWD', 'RPC_IDLE_TIMEOUT_MS', 'SESSIONS_DIR'];

afterEach(async () => {
  try {
    const rpc = await import('../src/agent/rpc-session.js');
    await rpc.closeAllRpcSessions();
  } catch {
    /* module may not have loaded */
  }
  vi.resetModules();
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The fake extension asks one confirm() per prompt and reports the answer as
// the assistant's final text, so the test sees exactly what Pi received.
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'piweb-rpc-confirm-'));
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
  if (command.type === 'prompt') {
    send({ type: 'agent_start' });
    send({ type: 'extension_ui_request', id: 'dlg-1', method: 'confirm', title: 'LINE GUI click approval', message: 'Click detector ID 20?', timeout: Number(command.message) || undefined });
  } else if (command.type === 'extension_ui_response') {
    const text = 'cancelled' in command ? 'cancelled' : 'confirmed=' + command.confirmed;
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
    send({ type: 'agent_end', messages: [] });
    send({ type: 'agent_settled' });
  }
});
`,
  );
  chmodSync(script, 0o755);
  const dbPath = join(dir, 'gateway.db');
  process.env.DB_PATH = dbPath;
  process.env.PI_BIN = script;
  process.env.PI_CWD = dir;
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  process.env.RPC_IDLE_TIMEOUT_MS = '60000';
  vi.resetModules();
  const db = await import('../src/db.js');
  const transport = await import('../src/transport/index.js');
  const notices: string[] = [];
  transport.setTransport({
    sendResponse: vi.fn().mockResolvedValue(true),
    sendFilesResponse: vi.fn().mockResolvedValue(true),
    sendNotice: vi.fn(async (_jid: string, text: string) => {
      notices.push(text);
    }),
    setTyping: vi.fn().mockResolvedValue(undefined),
    clearTyping: vi.fn().mockResolvedValue(undefined),
    createEventStreamer: () => vi.fn().mockResolvedValue(undefined),
  });
  db.initDb();
  db.registerChannel({
    jid: 'web:confirm',
    name: 'confirm test',
    folder: 'web_confirm',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const channel = db.getChannel('web:confirm')!;
  const rpc = await import('../src/agent/rpc-session.js');
  const queue = await import('../src/agent/queue.js');
  const session = rpc.getRpcSession('web_confirm', {
    channelJid: 'web:confirm',
    channelStorageToken: channel.storageToken,
    channelOwnershipEpoch: channel.ownershipEpoch,
  });
  const enqueue = (content: string) =>
    db.enqueueMessage({
      channelJid: 'web:confirm',
      sender: 'web',
      senderName: 'web',
      content,
      timestamp: new Date().toISOString(),
    });
  const statuses = () => {
    const inspect = new Database(dbPath, { readonly: true });
    const rows = inspect.prepare('select status from message_queue order by rowid').all() as Array<{
      status: string;
    }>;
    inspect.close();
    return rows.map((row) => row.status);
  };
  return { rpc, queue, session, notices, enqueue, statuses };
}

describe('web-answered extension confirm dialogs', () => {
  it('posts the dialog and approves it with a yes reply, consuming the reply', async () => {
    const { rpc, queue, session, notices, enqueue, statuses } = await setup();
    const result = session.prompt('0');
    await vi.waitFor(() => expect(rpc.rpcSessionHasPendingConfirm('web_confirm')).toBe(true));
    expect(notices[0]).toContain('LINE GUI click approval');
    expect(notices[0]).toContain('Click detector ID 20?');

    enqueue('好的！');
    queue.answerPendingConfirms();

    await expect(result).resolves.toMatchObject({ ok: true, text: 'confirmed=true' });
    expect(statuses()).toEqual(['done']);
    expect(rpc.rpcSessionHasPendingConfirm('web_confirm')).toBe(false);
    expect(notices.at(-1)).toContain('已批准');
  });

  it('denies with a no reply', async () => {
    const { rpc, queue, session, enqueue, statuses } = await setup();
    const result = session.prompt('0');
    await vi.waitFor(() => expect(rpc.rpcSessionHasPendingConfirm('web_confirm')).toBe(true));
    enqueue('no');
    queue.answerPendingConfirms();
    await expect(result).resolves.toMatchObject({ text: 'confirmed=false' });
    expect(statuses()).toEqual(['done']);
  });

  it('fails closed on any other message and leaves it queued for normal dispatch', async () => {
    const { rpc, queue, session, notices, enqueue, statuses } = await setup();
    const result = session.prompt('0');
    await vi.waitFor(() => expect(rpc.rpcSessionHasPendingConfirm('web_confirm')).toBe(true));
    enqueue('yes and also type my password');
    queue.answerPendingConfirms();
    await expect(result).resolves.toMatchObject({ text: 'confirmed=false' });
    expect(statuses()).toEqual(['pending']);
    expect(notices.at(-1)).toContain('收到其他訊息');
  });

  it('stops accepting answers once the dialog times out', async () => {
    const { rpc, session, notices } = await setup();
    void session.prompt('50');
    await vi.waitFor(() => expect(rpc.rpcSessionHasPendingConfirm('web_confirm')).toBe(true));
    await vi.waitFor(() => expect(rpc.rpcSessionHasPendingConfirm('web_confirm')).toBe(false), {
      timeout: 1000,
    });
    expect(notices.at(-1)).toContain('逾時');
    expect(rpc.answerRpcConfirm('web_confirm', true)).toBe(false);
  });
});
