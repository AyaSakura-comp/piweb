import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root: string;
let db: typeof import('../src/db.js');
let transport: typeof import('../src/transport/web.js').webTransport | undefined;
const jid = 'web:reply-handoff';
const keys = ['DB_PATH', 'WEB_MEDIA_DIR', 'PIDG_CONFIG', 'STREAM_PARTIAL_TEXT'] as const;
let original: Record<string, string | undefined>;

beforeEach(async () => {
  transport = undefined;
  original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), 'piweb-reply-handoff-'));
  Object.assign(process.env, {
    DB_PATH: join(root, 'db.sqlite'),
    WEB_MEDIA_DIR: join(root, 'media'),
    PIDG_CONFIG: '/dev/null',
    STREAM_PARTIAL_TEXT: 'true',
  });
  vi.resetModules();
  db = await import('../src/db.js');
  db.initDb();
  db.registerChannel({
    jid,
    name: 'Reply handoff',
    folder: 'handoff',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
});

afterEach(async () => {
  if (transport) await transport.clearTyping(jid);
  vi.restoreAllMocks();
  vi.doUnmock('node:fs/promises');
  db.closeDb();
  vi.resetModules();
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  rmSync(root, { recursive: true, force: true });
});

it('retains the preview throughout held file publication and consumes it only with the saved reply', async () => {
  let release!: () => void;
  let requested = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.doMock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
      ...actual,
      copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
        requested = true;
        await held;
        return actual.copyFile(...args);
      },
    };
  });
  transport = (await import('../src/transport/web.js')).webTransport;
  const stream = transport.createEventStreamer(jid);
  const file = join(root, 'report.txt');
  writeFileSync(file, 'saved file');
  const content = '## Visible answer\n\nKeep the same body.\n\n';
  await stream({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: content },
  });
  await stream({ type: 'turn_end' });
  await stream({ type: 'agent_end' });
  const sent = transport.sendFilesResponse(jid, content, [file]);
  try {
    await vi.waitFor(() => expect(requested).toBe(true));
    expect(db.getLiveOutput(jid)?.content).toBe(content);
    expect(db.getRecentWebEvents(jid)).toHaveLength(0);
  } finally {
    release();
    await sent;
  }
  expect(db.getLiveOutput(jid)).toBeNull();
  expect(JSON.parse(db.getRecentWebEvents(jid)[0].files!)).toHaveLength(1);
});

it('reads one WAL snapshot when another connection publishes between the event and live queries', () => {
  db.setChannelBusy(jid, true);
  db.setLiveOutput(jid, { content: 'still visible' });
  const writer = new Database(join(root, 'db.sqlite'));
  let published = false;
  const prepare = Database.prototype.prepare;
  const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    source: string,
  ) {
    const statement = prepare.call(this, source);
    if (source.startsWith('select * from web_events where channel_jid = ? and rowid >')) {
      const all = statement.all.bind(statement);
      statement.all = (...params: any[]) => {
        const result = all(...params);
        if (!published) {
          published = true;
          writer
            .transaction(() => {
              writer
                .prepare(
                  'insert into web_events (channel_jid, kind, role, content) values (?, ?, ?, ?)',
                )
                .run(jid, 'message', 'assistant', 'durable final');
              writer.prepare('delete from live_output where channel_jid = ?').run(jid);
              writer.prepare('update channel_state set busy = 0 where channel_jid = ?').run(jid);
            })
            .immediate();
        }
        return result;
      };
    }
    return statement;
  });
  try {
    const snapshot = db.getWebStreamSnapshot(jid, 0);
    expect(published).toBe(true);
    expect(snapshot.rows).toHaveLength(0);
    expect(snapshot.busy).toBe(true);
    expect(snapshot.live?.content).toBe('still visible');
    spy.mockRestore();
    const next = db.getWebStreamSnapshot(jid, 0);
    expect(next.rows.map((row) => row.content)).toEqual(['durable final']);
    expect(next.busy).toBe(false);
    expect(next.live).toBeNull();
  } finally {
    spy.mockRestore();
    writer.close();
  }
});

it('rolls back the final row if preview cleanup fails', () => {
  db.setLiveOutput(jid, { content: 'still visible' });
  const writer = new Database(join(root, 'db.sqlite'));
  writer.exec(
    "create trigger fail_clear before delete on live_output begin select raise(abort, 'cleanup denied'); end",
  );
  try {
    expect(() =>
      db.commitWebReply({ channelJid: jid, kind: 'message', role: 'assistant', content: 'final' }),
    ).toThrow('cleanup denied');
    expect(db.getRecentWebEvents(jid)).toHaveLength(0);
    expect(db.getLiveOutput(jid)?.content).toBe('still visible');
  } finally {
    writer.exec('drop trigger fail_clear');
    writer.close();
  }
});

it('a revoked generation cannot publish a reply or clear the current preview', () => {
  const channel = db.getChannel(jid)!;
  db.setLiveOutput(jid, { content: 'current owner' });
  expect(() =>
    db.commitWebReply(
      { channelJid: jid, kind: 'message', role: 'assistant', content: 'stale' },
      {
        expectedFolder: channel.folder,
        expectedStorageToken: channel.storageToken,
        expectedOwnershipEpoch: (channel.ownershipEpoch ?? 0) + 1,
      },
    ),
  ).toThrow(db.CHANNEL_GENERATION_CHANGED_ERROR);
  expect(db.getRecentWebEvents(jid)).toHaveLength(0);
  expect(db.getLiveOutput(jid)?.content).toBe('current owner');
});
