import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { mediaDirName } from './media-path.js';
import { resolveChannelSessionDir } from './session/path.js';
import {
  type ChannelKind,
  type RegisteredChannel,
  type QueuedMessage,
  type ThinkingLevel,
} from './types.js';

let db!: Database.Database;
let dbOpen = false;

export type ScheduledTaskType = 'once' | 'recurring';

export interface ScheduledTaskRow {
  id: number;
  name: string;
  type: ScheduledTaskType;
  schedule: string;
  channel_jid: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  created_by: string;
}

export function initDb(): void {
  if (dbOpen) return;

  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  dbOpen = true;
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    create table if not exists channels (
      jid              text primary key,
      name             text not null,
      folder           text not null unique,
      requires_trigger integer not null default 1,
      is_main          integer not null default 0,
      model_override   text not null default '',
      thinking_override text not null default '',
      cwd_override     text not null default '',
      kind             text not null default 'standard' check(kind in ('standard', 'life')),
      created_at       text not null default (datetime('now'))
    );

    create table if not exists message_queue (
      rowid         integer primary key autoincrement,
      channel_jid   text not null,
      sender        text not null,
      sender_name   text not null,
      content       text not null,
      timestamp     text not null,
      status        text not null default 'pending',
      interrupt_active integer not null default 1,
      created_at    text not null default (datetime('now')),
      processed_at  text
    );

    create index if not exists idx_queue_status on message_queue(status, channel_jid);

    create table if not exists message_log (
      rowid         integer primary key autoincrement,
      channel_jid   text not null,
      role          text not null,
      content       text not null,
      timestamp     text not null default (datetime('now'))
    );

    create table if not exists scheduled_tasks (
      id           integer primary key autoincrement,
      name         text not null,
      type         text not null check(type in ('once', 'recurring')),
      schedule     text not null,
      channel_jid  text not null,
      prompt       text not null,
      enabled      integer not null default 1,
      last_run_at  text,
      next_run_at  text,
      created_at   text not null default (datetime('now')),
      created_by   text not null default ''
    );

    create index if not exists idx_scheduled_tasks_due on scheduled_tasks(enabled, next_run_at);

    -- ── piweb: web transport tables ──
    --
    -- The web UI and the pi worker are SEPARATE PROCESSES sharing this database
    -- (worker on the host for full host access, web server in Docker). Anything
    -- that has to cross that boundary goes through a table with a monotonic
    -- rowid the reader can use as a cursor.

    -- Everything the user sees in a transcript: user turns, assistant replies,
    -- streamed thinking/tool events, and command output. Replaces Discord as
    -- the message store, so a phone that drops its connection can replay by
    -- rowid instead of losing the run.
    create table if not exists web_events (
      rowid       integer primary key autoincrement,
      channel_jid text not null,
      kind        text not null,
      role        text not null default '',
      content     text not null default '',
      files       text,
      created_at  text not null default (datetime('now'))
    );

    create index if not exists idx_web_events_channel on web_events(channel_jid, rowid);

    -- Commands the web server cannot run itself. /pi status spawns pi over RPC,
    -- /pi stop needs the worker's in-memory AbortController, /pi new must not
    -- race an in-flight run — all of that lives in the worker process, so the
    -- web server enqueues an intent here and the worker executes it.
    create table if not exists control_queue (
      rowid       integer primary key autoincrement,
      channel_jid text not null,
      command     text not null,
      args        text not null default '{}',
      status        text not null default 'pending',
      result        text,
      created_at    text not null default (datetime('now')),
      processing_at text,
      done_at       text
    );

    create index if not exists idx_control_pending on control_queue(status, rowid);

    -- Small key/value side-channel. Used for things the web server needs but
    -- cannot compute itself: the pi model list comes from spawning pi, which
    -- only the worker can do, so the worker publishes it here for the UI's
    -- model autocomplete to read.
    create table if not exists meta (
      key        text primary key,
      value      text not null,
      updated_at text not null default (datetime('now'))
    );

    -- Web Push subscriptions, one row per device that opted in. Keyed by
    -- endpoint because that is what the push service treats as the identity,
    -- and what it returns as 404/410 when the subscription dies.
    create table if not exists push_subscriptions (
      endpoint   text primary key,
      p256dh     text not null,
      auth       text not null,
      created_at text not null default (datetime('now'))
    );

    -- The assistant reply currently being generated, one row per channel,
    -- UPDATED in place rather than appended. Streaming deltas as web_events
    -- rows would add hundreds of rows per reply and wreck the rowid cursor
    -- that unread marks, paging and push all key off; this keeps the
    -- transcript clean and is dropped the moment the real message lands.
    create table if not exists live_output (
      channel_jid text primary key,
      content     text not null default '',
      thinking    text not null default '',
      seq         integer not null default 0,
      updated_at  text not null default (datetime('now'))
    );

    -- Per-channel transient runtime state the UI polls (typing indicator).
    create table if not exists channel_state (
      channel_jid text primary key,
      busy        integer not null default 0,
      updated_at  text not null default (datetime('now'))
    );

    -- Generation leases protect HTTP mutation requests and Life workers. A
    -- worker heartbeats through final stream/typing cleanup; stale rows expire
    -- after a crash so they cannot block archive forever.
    create table if not exists channel_operations (
      id             text primary key,
      channel_jid    text not null,
      channel_folder text not null,
      created_at     text not null default (datetime('now')),
      updated_at     text not null default (datetime('now'))
    );

    create index if not exists idx_channel_operations_channel
      on channel_operations(channel_jid, created_at);

    -- Filesystem renames cannot participate in a SQLite transaction. Life
    -- rotation commits this durable intent with the channel re-key, then moves
    -- media/uploads after commit. Startup can safely resume any interrupted
    -- move because each step is idempotent.
    create table if not exists life_archive_moves (
      id                text primary key,
      archived_jid      text not null unique,
      new_life_folder   text not null,
      media_required    integer not null,
      upload_required   integer not null,
      folder_done       integer not null default 0,
      media_done        integer not null default 0,
      upload_done       integer not null default 0,
      created_at        text not null default (datetime('now'))
    );

    -- One auxiliary, ephemeral title job per newly created web session. A row
    -- is prepared at creation, captures exactly the first normal prompt, and is
    -- erased after the in-process extraction. This table makes the job crash-safe.
    create table if not exists session_title_jobs (
      channel_jid   text primary key,
      prompt        text not null default '',
      message_rowid integer,
      status        text not null default 'waiting'
                    check(status in ('waiting', 'pending', 'processing', 'done', 'cancelled', 'failed')),
      attempts      integer not null default 0,
      last_error    text not null default '',
      created_at    text not null default (datetime('now')),
      updated_at    text not null default (datetime('now'))
    );

    create index if not exists idx_session_title_pending
      on session_title_jobs(status, updated_at);
  `);

  ensureTableColumn('channels', 'model_override', "text not null default ''");
  ensureTableColumn('channels', 'thinking_override', "text not null default ''");
  ensureTableColumn('channels', 'cwd_override', "text not null default ''");
  ensureTableColumn(
    'channels',
    'kind',
    "text not null default 'standard' check(kind in ('standard', 'life'))",
  );
  // Standard sessions remain unlimited, while even concurrent first-entry
  // requests can create at most one Life row.
  db.exec(
    "create unique index if not exists idx_channels_single_life on channels(kind) where kind = 'life'",
  );
  // Soft delete: deleting a session moves it to a trash it can be restored
  // from. Nothing is destroyed until it is purged, which also means a deleted
  // session no longer strands its pi session directory on disk.
  ensureTableColumn('channels', 'deleted_at', 'text');
  ensureTableColumn('message_queue', 'attachments', 'text');
  ensureTableColumn('control_queue', 'processing_at', 'text');
  ensureTableColumn('channel_operations', 'updated_at', 'text');
  db.prepare(
    'update channel_operations set updated_at = created_at where updated_at is null',
  ).run();
  db.exec(
    'create index if not exists idx_channel_operations_heartbeat on channel_operations(channel_jid, updated_at)',
  );
  // Reasoning streams on its own lane so the UI can show it while it happens
  // and still fold it into one thinking block when it ends.
  ensureTableColumn('live_output', 'thinking', "text not null default ''");
  // Scheduler/background events must wait behind an active user turn rather
  // than triggering INTERRUPT_ON_NEW_MESSAGE. User messages keep the default.
  ensureTableColumn('message_queue', 'interrupt_active', 'integer not null default 1');

  recoverLifeArchiveMoves();
  logger.info({ path: config.dbPath }, 'Database initialized');
}

function ensureTableColumn(table: string, column: string, ddl: string): void {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${ddl}`);
  logger.info({ table, column }, 'Database migrated: added column');
}

function normalizeTimestamp(timestamp: string | null): string | null {
  if (timestamp === null) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

// ── Channel registration ──

export function registerChannel(
  ch: RegisteredChannel,
  options: { prepareSessionTitle?: boolean } = {},
): void {
  db.transaction(() => {
    db.prepare(
      `
      insert into channels (jid, name, folder, requires_trigger, is_main, model_override, thinking_override, cwd_override, kind)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(jid) do update set
        name = excluded.name,
        folder = excluded.folder,
        requires_trigger = excluded.requires_trigger,
        is_main = excluded.is_main,
        cwd_override = case
          when excluded.cwd_override != '' then excluded.cwd_override
          else channels.cwd_override
        end
    `,
    ).run(
      ch.jid,
      ch.name,
      ch.folder,
      ch.requiresTrigger ? 1 : 0,
      ch.isMain ? 1 : 0,
      ch.modelOverride || '',
      ch.thinkingOverride || '',
      ch.cwdOverride.trim(),
      ch.kind ?? 'standard',
    );
    if (options.prepareSessionTitle) prepareSessionTitle(ch.jid);
  })();
  logger.info({ jid: ch.jid, name: ch.name }, 'Channel registered');
}

export function unregisterChannel(jid: string): boolean {
  const result = db.prepare('delete from channels where jid = ?').run(jid);
  return result.changes > 0;
}

export function getChannel(jid: string): RegisteredChannel | undefined {
  const row = db.prepare('select * from channels where jid = ?').get(jid) as any;
  return row ? rowToChannel(row) : undefined;
}

export function getAllChannels(): RegisteredChannel[] {
  const rows = db.prepare('select * from channels order by created_at').all() as any[];
  return rows.map(rowToChannel);
}

export function createDmChannel(
  jid: string,
  userId: string,
  displayName: string,
): RegisteredChannel {
  return {
    jid,
    name: `DM:${displayName}`,
    folder: `dm_${userId}`,
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  };
}

export function setChannelModelOverride(jid: string, modelOverride: string): boolean {
  const result = db
    .prepare('update channels set model_override = ? where jid = ?')
    .run(modelOverride.trim(), jid);
  return result.changes > 0;
}

export function clearChannelModelOverride(jid: string): boolean {
  const result = db.prepare("update channels set model_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

export function setChannelThinkingOverride(jid: string, thinkingOverride: ThinkingLevel): boolean {
  const result = db
    .prepare('update channels set thinking_override = ? where jid = ?')
    .run(thinkingOverride, jid);
  return result.changes > 0;
}

export function clearChannelThinkingOverride(jid: string): boolean {
  const result = db.prepare("update channels set thinking_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

export function setChannelCwdOverride(jid: string, cwdOverride: string): boolean {
  const result = db
    .prepare('update channels set cwd_override = ? where jid = ?')
    .run(cwdOverride.trim(), jid);
  return result.changes > 0;
}

export function clearChannelCwdOverride(jid: string): boolean {
  const result = db.prepare("update channels set cwd_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

function rowToChannel(row: any): RegisteredChannel {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    requiresTrigger: row.requires_trigger === 1,
    isMain: row.is_main === 1,
    modelOverride: row.model_override || '',
    thinkingOverride: (row.thinking_override || '') as ThinkingLevel | '',
    cwdOverride: row.cwd_override || '',
    kind: (row.kind || 'standard') as ChannelKind,
  };
}

export const LIFE_ARCHIVE_QUARANTINE_ERROR =
  'Life archive filesystem recovery is still pending';

/**
 * A pending filesystem move quarantines both owners created by the DB re-key:
 * the archived standard JID and the replacement Life folder. This table is the
 * authoritative barrier; filesystem observations cannot safely distinguish a
 * transient rename failure from another writer creating the destination.
 */
export function isChannelQuarantinedForLifeArchive(channelJid: string): boolean {
  return Boolean(
    db
      .prepare(
        `select 1
           from life_archive_moves m
          where m.archived_jid = ?
             or (? = 'web:life' and exists (
               select 1 from channels c
                where c.jid = 'web:life' and c.folder = m.new_life_folder
             ))
          limit 1`,
      )
      .get(channelJid, channelJid),
  );
}

/** Same quarantine barrier for direct `/media/<directory>/...` reads. */
export function isLifeArchiveMediaDirQuarantined(directory: string): boolean {
  const rows = db.prepare('select archived_jid from life_archive_moves').all() as Array<{
    archived_jid: string;
  }>;
  return rows.some(
    (row) =>
      directory === mediaDirName(row.archived_jid) || directory === mediaDirName('web:life'),
  );
}

function assertChannelNotQuarantined(channelJid: string): void {
  if (isChannelQuarantinedForLifeArchive(channelJid)) {
    throw new Error(LIFE_ARCHIVE_QUARANTINE_ERROR);
  }
}

export const CHANNEL_GENERATION_CHANGED_ERROR = 'Channel generation changed';

export interface ChannelGenerationFence {
  expectedFolder?: string;
}

export function isChannelGenerationCurrent(
  channelJid: string,
  expectedFolder: string,
): boolean {
  const current = db.prepare('select folder from channels where jid = ?').get(channelJid) as
    | { folder: string }
    | undefined;
  return (
    current?.folder === expectedFolder && !isChannelQuarantinedForLifeArchive(channelJid)
  );
}

function assertChannelWriteFence(
  channelJid: string,
  fence?: ChannelGenerationFence,
): void {
  assertChannelNotQuarantined(channelJid);
  if (fence?.expectedFolder && !isChannelGenerationCurrent(channelJid, fence.expectedFolder)) {
    throw new Error(CHANNEL_GENERATION_CHANGED_ERROR);
  }
}

function fencedChannelWrite<T>(
  channelJid: string,
  fence: ChannelGenerationFence | undefined,
  write: () => T,
): T {
  if (!fence?.expectedFolder) {
    assertChannelWriteFence(channelJid, fence);
    return write();
  }
  return db.transaction(() => {
    assertChannelWriteFence(channelJid, fence);
    return write();
  }).immediate();
}

// ── Message queue ──

export function enqueueMessage(msg: {
  channelJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  attachments?: string | null;
  interruptActive?: boolean;
  sessionTitlePrompt?: string;
  immediateSessionTitle?: string;
}): number {
  return db.transaction(() => {
    assertChannelNotQuarantined(msg.channelJid);
    const result = db
      .prepare(
        `
      insert into message_queue
        (channel_jid, sender, sender_name, content, timestamp, attachments, interrupt_active)
      values (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        msg.channelJid,
        msg.sender,
        msg.senderName,
        msg.content,
        msg.timestamp,
        msg.attachments ?? null,
        msg.interruptActive === false ? 0 : 1,
      );
    const rowid = Number(result.lastInsertRowid);
    if (msg.sessionTitlePrompt !== undefined) {
      const captured = queuePreparedSessionTitle(msg.channelJid, msg.sessionTitlePrompt, rowid);
      if (captured && msg.immediateSessionTitle) {
        completePendingSessionTitle(msg.channelJid, rowid, msg.immediateSessionTitle);
      }
    }
    return rowid;
  })();
}

export function claimNextMessage(channelJid: string): QueuedMessage | undefined {
  if (isChannelQuarantinedForLifeArchive(channelJid)) return undefined;
  const row = db
    .prepare(
      `
    with next_message as (
      select rowid
      from message_queue
      where status = 'pending' and channel_jid = ?
      order by rowid asc
      limit 1
    )
    update message_queue
    set status = 'processing'
    where rowid = (select rowid from next_message)
      and status = 'pending'
    returning rowid, channel_jid, sender, sender_name, content, timestamp, status, attachments,
              interrupt_active
  `,
    )
    .get(channelJid) as QueuedMessage | undefined;

  return row;
}

export function markMessageDone(rowid: number): void {
  db.prepare(
    "update message_queue set status = 'done', processed_at = datetime('now') where rowid = ?",
  ).run(rowid);
}

export function markMessageFailed(rowid: number): void {
  db.prepare(
    "update message_queue set status = 'failed', processed_at = datetime('now') where rowid = ?",
  ).run(rowid);
}

export function markMessageAborted(rowid: number): void {
  db.prepare(
    "update message_queue set status = 'aborted', processed_at = datetime('now') where rowid = ?",
  ).run(rowid);
}

/**
 * Put a claimed message back on the queue so it runs again.
 *
 * Used when pi was killed (SIGTERM/143) rather than finishing — a worker
 * restart or OOM. Setting it back to 'pending' means the next poll re-runs it
 * (or, if the worker is restarting, it is picked up after startup), so the
 * original request resumes instead of being lost.
 */
export function requeueMessage(rowid: number): void {
  db.prepare("update message_queue set status = 'pending' where rowid = ?").run(rowid);
}

export function clearPendingMessages(channelJid: string): number {
  return db.transaction(() => {
    // If an explicit reset discards the first unprocessed turn, release the
    // one-shot title slot so the next real turn can become the first prompt.
    db.prepare(
      `update session_title_jobs
          set prompt = '', message_rowid = null, status = 'waiting', last_error = '',
              updated_at = datetime('now')
        where channel_jid = ? and status = 'pending'
          and message_rowid in (
            select rowid from message_queue
             where channel_jid = ? and status = 'pending'
          )`,
    ).run(channelJid, channelJid);

    return db
      .prepare("delete from message_queue where channel_jid = ? and status = 'pending'")
      .run(channelJid).changes;
  })();
}

export function recoverStuckMessages(): number {
  const result = db
    .prepare("update message_queue set status = 'pending' where status = 'processing'")
    .run();
  return result.changes;
}

/** Get channels with pending messages that are allowed to pre-empt an active turn. */
export function channelsWithInterruptingPending(): string[] {
  const rows = db
    .prepare(
      `
    select channel_jid
    from message_queue
    where status = 'pending' and interrupt_active = 1
    group by channel_jid
    order by min(rowid) asc
  `,
    )
    .all() as any[];
  return rows
    .map((r) => r.channel_jid as string)
    .filter((channelJid) => !isChannelQuarantinedForLifeArchive(channelJid));
}

/** Get channels that have pending messages */
export function channelsWithPending(): string[] {
  const rows = db
    .prepare(
      `
    select channel_jid
    from message_queue
    where status = 'pending'
    group by channel_jid
    order by min(rowid) asc
  `,
    )
    .all() as any[];
  return rows
    .map((r) => r.channel_jid as string)
    .filter((channelJid) => !isChannelQuarantinedForLifeArchive(channelJid));
}

// ── Scheduled tasks ──

export function addScheduledTask(task: {
  name: string;
  type: ScheduledTaskType;
  schedule: string;
  channelJid: string;
  prompt: string;
  createdBy?: string;
  nextRunAt: string;
}): number {
  assertChannelNotQuarantined(task.channelJid);
  const result = db
    .prepare(
      `
    insert into scheduled_tasks (name, type, schedule, channel_jid, prompt, created_by, next_run_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      task.name,
      task.type,
      task.schedule,
      task.channelJid,
      task.prompt,
      task.createdBy ?? '',
      normalizeTimestamp(task.nextRunAt),
    );

  return Number(result.lastInsertRowid);
}

export function removeScheduledTask(id: number): boolean {
  const result = db.prepare('delete from scheduled_tasks where id = ?').run(id);
  return result.changes > 0;
}

export function enableScheduledTask(id: number): boolean {
  const result = db.prepare('update scheduled_tasks set enabled = 1 where id = ?').run(id);
  return result.changes > 0;
}

export function disableScheduledTask(id: number): boolean {
  const result = db.prepare('update scheduled_tasks set enabled = 0 where id = ?').run(id);
  return result.changes > 0;
}

export function listScheduledTasks(): ScheduledTaskRow[] {
  return db
    .prepare(
      `
    select id, name, type, schedule, channel_jid, prompt, enabled, last_run_at, next_run_at, created_at, created_by
    from scheduled_tasks
    order by id asc
  `,
    )
    .all() as ScheduledTaskRow[];
}

export function getDueScheduledTasks(): ScheduledTaskRow[] {
  return db
    .prepare(
      `
    select id, name, type, schedule, channel_jid, prompt, enabled, last_run_at, next_run_at, created_at, created_by
    from scheduled_tasks
    where enabled = 1
      and next_run_at is not null
      and next_run_at <= datetime('now')
    order by next_run_at asc, id asc
  `,
    )
    .all() as ScheduledTaskRow[];
}

export function updateTaskAfterRun(id: number, lastRunAt: string, nextRunAt: string | null): void {
  db.prepare(
    `
    update scheduled_tasks
    set last_run_at = ?,
        next_run_at = ?,
        enabled = case when ? is null then 0 else enabled end
    where id = ?
  `,
  ).run(normalizeTimestamp(lastRunAt), normalizeTimestamp(nextRunAt), nextRunAt, id);
}

export function enqueueScheduledTask(
  taskId: number,
  msg: {
    channelJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
  },
  lastRunAt: string,
  nextRunAt: string | null,
): boolean {
  return db.transaction(() => {
    // A Life archive may re-key a task after the scheduler fetched it. Resolve
    // its owner again inside this write transaction so stale scheduler memory
    // cannot inject the task into the brand-new web:life replacement.
    const task = db.prepare('select channel_jid from scheduled_tasks where id = ?').get(taskId) as
      | { channel_jid: string }
      | undefined;
    if (!task || isChannelQuarantinedForLifeArchive(task.channel_jid)) return false;
    enqueueMessage({
      ...msg,
      channelJid: task.channel_jid,
      interruptActive: false,
    });
    updateTaskAfterRun(taskId, lastRunAt, nextRunAt);
    return true;
  })();
}

// ── Message log ──

export function logMessage(
  channelJid: string,
  role: string,
  content: string,
  fence?: ChannelGenerationFence,
): void {
  fencedChannelWrite(channelJid, fence, () => {
    db.prepare('insert into message_log (channel_jid, role, content) values (?, ?, ?)').run(
      channelJid,
      role,
      content,
    );
  });
}

// ── piweb: web events (transcript + live stream) ──

export type WebEventKind = 'message' | 'thinking' | 'tool' | 'tool_result' | 'system' | 'error';

export interface WebEventRow {
  rowid: number;
  channel_jid: string;
  kind: WebEventKind;
  role: string;
  content: string;
  /** JSON array of served file URLs, or null */
  files: string | null;
  created_at: string;
}

export function getFirstUserMessageContent(channelJid: string): string | undefined {
  const row = db
    .prepare(
      `select content from web_events
        where channel_jid = ? and kind = 'message' and role = 'user'
        order by rowid asc limit 1`,
    )
    .get(channelJid) as { content: string } | undefined;
  return row?.content;
}

export function appendWebEvent(
  event: {
    channelJid: string;
    kind: WebEventKind;
    role?: string;
    content?: string;
    files?: string[];
  },
  fence?: ChannelGenerationFence,
): number {
  return fencedChannelWrite(event.channelJid, fence, () => {
    const result = db
      .prepare(
        'insert into web_events (channel_jid, kind, role, content, files) values (?, ?, ?, ?, ?)',
      )
      .run(
        event.channelJid,
        event.kind,
        event.role ?? '',
        event.content ?? '',
        event.files && event.files.length > 0 ? JSON.stringify(event.files) : null,
      );
    return Number(result.lastInsertRowid);
  });
}

/**
 * Events after `afterRowid`. The web server uses this both to render history on
 * load (afterRowid=0) and to tail for SSE, so a reconnecting phone resumes from
 * its last seen id with no gap and no duplicates.
 */
export function getWebEventsSince(
  channelJid: string,
  afterRowid: number,
  limit = 500,
): WebEventRow[] {
  return db
    .prepare('select * from web_events where channel_jid = ? and rowid > ? order by rowid limit ?')
    .all(channelJid, afterRowid, limit) as WebEventRow[];
}

/**
 * Newest events first, then reversed — the initial view wants the TAIL of a
 * long transcript, not the head.
 *
 * All three read paths (recent / older / since) are served by the single
 * (channel_jid, rowid) index: each is an index range scan with a LIMIT, so cost
 * is proportional to the page size rather than the transcript length. Keep it
 * that way — a filter on any other column would turn these into table scans.
 */
export function getRecentWebEvents(channelJid: string, limit = 200): WebEventRow[] {
  const rows = db
    .prepare('select * from web_events where channel_jid = ? order by rowid desc limit ?')
    .all(channelJid, limit) as WebEventRow[];
  return rows.reverse();
}

/** One page of history OLDER than `beforeRowid`, oldest-first for prepending. */
export function getWebEventsBefore(
  channelJid: string,
  beforeRowid: number,
  limit = 50,
): WebEventRow[] {
  const rows = db
    .prepare(
      'select * from web_events where channel_jid = ? and rowid < ? order by rowid desc limit ?',
    )
    .all(channelJid, beforeRowid, limit) as WebEventRow[];
  return rows.reverse();
}

/**
 * A window of history centred on `rowid` — what "jump to this search result"
 * needs: the hit plus context on both sides, in one round trip.
 */
export function getWebEventsAround(channelJid: string, rowid: number, limit = 50): WebEventRow[] {
  const half = Math.max(1, Math.floor(limit / 2));
  const before = db
    .prepare(
      'select * from web_events where channel_jid = ? and rowid <= ? order by rowid desc limit ?',
    )
    .all(channelJid, rowid, half) as WebEventRow[];
  const after = db
    .prepare('select * from web_events where channel_jid = ? and rowid > ? order by rowid limit ?')
    .all(channelJid, rowid, half) as WebEventRow[];
  return [...before.reverse(), ...after];
}

/** Whether anything NEWER than `rowid` exists — the downward twin of hasWebEventsBefore. */
export function hasWebEventsAfter(channelJid: string, rowid: number): boolean {
  const row = db
    .prepare('select 1 as x from web_events where channel_jid = ? and rowid > ? limit 1')
    .get(channelJid, rowid) as { x: number } | undefined;
  return Boolean(row);
}

export interface WebSearchHit {
  id: number;
  kind: string;
  role: string;
  snippet: string;
  createdAt: string;
}

/**
 * Substring search within a session.
 *
 * `like '%x%'` cannot use an index, so this scans the channel's rows — bounded
 * by the (channel_jid, rowid) index to that one session rather than the whole
 * table. That is fine at personal-transcript scale; if it ever isn't, the
 * upgrade is an FTS5 virtual table kept in sync by triggers, not a new index
 * (no b-tree index can serve a leading-wildcard match).
 *
 * Snippets are cut around the first match so the UI can show context without
 * shipping whole tool outputs to the client.
 */
export interface SessionMediaItem {
  url: string;
  name: string;
  eventId: number;
  createdAt: string;
  type: 'image' | 'video' | 'audio';
}

const MEDIA_TYPE_BY_EXT: Record<string, SessionMediaItem['type']> = {
  apng: 'image', avif: 'image', bmp: 'image', gif: 'image', heic: 'image', heif: 'image',
  jpeg: 'image', jpg: 'image', png: 'image', svg: 'image', webp: 'image',
  m4v: 'video', mkv: 'video', mov: 'video', mp4: 'video', webm: 'video',
  aac: 'audio', flac: 'audio', m4a: 'audio', mp3: 'audio', oga: 'audio', ogg: 'audio', opus: 'audio', wav: 'audio',
};

/**
 * Every image/video/audio attachment in a session, newest first.
 *
 * Scans this channel's events by the (channel_jid, rowid) index; non-media
 * attachments (source files, CSVs) are skipped so the gallery stays a gallery.
 * A URL is listed once even if the same file was attached to several events.
 */
export function listSessionMedia(channelJid: string, limit = 500): SessionMediaItem[] {
  const rows = db
    .prepare(
      `select rowid, files, created_at
         from web_events
        where channel_jid = ? and files is not null and files != '' and files != '[]'
        order by rowid desc`,
    )
    .all(channelJid) as Array<{ rowid: number; files: string; created_at: string }>;

  const items: SessionMediaItem[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    let urls: unknown;
    try {
      urls = JSON.parse(row.files);
    } catch {
      continue;
    }
    if (!Array.isArray(urls)) continue;

    for (const raw of urls) {
      if (typeof raw !== 'string' || !raw) continue;
      if (seen.has(raw)) continue;

      const name = decodeURIComponent(raw.split('/').pop() ?? raw);
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
      const type = MEDIA_TYPE_BY_EXT[ext];
      if (!type) continue;

      seen.add(raw);
      items.push({ url: raw, name, eventId: row.rowid, createdAt: row.created_at, type });
      if (items.length >= limit) return items;
    }
  }

  return items;
}

export interface LiveOutput {
  content: string;
  thinking: string;
  seq: number;
}

/**
 * Publish the in-flight turn: `content` is the answer, `thinking` the reasoning
 * being written before it. `seq` lets the UI ignore a stale poll.
 */
export function setLiveOutput(
  channelJid: string,
  value: { content?: string; thinking?: string },
  fence?: ChannelGenerationFence,
): number {
  return fencedChannelWrite(channelJid, fence, () => {
    const row = db
      .prepare('select seq from live_output where channel_jid = ?')
      .get(channelJid) as { seq: number } | undefined;
    const seq = (row?.seq ?? 0) + 1;
    db.prepare(
      `insert into live_output (channel_jid, content, thinking, seq, updated_at)
       values (?, ?, ?, ?, datetime('now'))
       on conflict(channel_jid) do update set
         content = excluded.content, thinking = excluded.thinking,
         seq = excluded.seq, updated_at = excluded.updated_at`,
    ).run(channelJid, value.content ?? '', value.thinking ?? '', seq);
    return seq;
  });
}

export function getLiveOutput(channelJid: string): LiveOutput | null {
  const row = db
    .prepare('select content, thinking, seq from live_output where channel_jid = ?')
    .get(channelJid) as LiveOutput | undefined;
  return row && (row.content || row.thinking) ? row : null;
}

/** Called when the finished message is appended, so the two never both show. */
export function clearLiveOutput(
  channelJid: string,
  fence?: ChannelGenerationFence,
): void {
  fencedChannelWrite(channelJid, fence, () => {
    db.prepare('delete from live_output where channel_jid = ?').run(channelJid);
  });
}

export function searchWebEvents(channelJid: string, query: string, limit = 50): WebSearchHit[] {
  const rows = db
    .prepare(
      `select rowid, kind, role, content, created_at
         from web_events
        where channel_jid = ? and content like ? escape '\\'
        order by rowid desc limit ?`,
    )
    .all(channelJid, `%${escapeLike(query)}%`, limit) as Array<{
    rowid: number;
    kind: string;
    role: string;
    content: string;
    created_at: string;
  }>;

  const needle = query.toLowerCase();
  return rows.map((r) => {
    const at = r.content.toLowerCase().indexOf(needle);
    const start = Math.max(0, at - 40);
    const snippet =
      (start > 0 ? '…' : '') +
      r.content
        .slice(start, start + 160)
        .replace(/\s+/g, ' ')
        .trim() +
      (start + 160 < r.content.length ? '…' : '');
    return { id: r.rowid, kind: r.kind, role: r.role, snippet, createdAt: r.created_at };
  });
}

/** `%`, `_` and the escape char itself are LIKE wildcards — a literal search must not match them. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Whether anything older than `rowid` exists — drives the client's "load more". */
export function hasWebEventsBefore(channelJid: string, rowid: number): boolean {
  const row = db
    .prepare('select 1 as x from web_events where channel_jid = ? and rowid < ? limit 1')
    .get(channelJid, rowid) as { x: number } | undefined;
  return Boolean(row);
}

export function deleteWebEvents(channelJid: string): number {
  return db.prepare('delete from web_events where channel_jid = ?').run(channelJid).changes;
}

export function getMaxWebEventRowid(): number {
  const row = db.prepare('select coalesce(max(rowid), 0) as m from web_events').get() as {
    m: number;
  };
  return row.m;
}

// ── piweb: control queue (web server → worker) ──

export interface ControlRow {
  rowid: number;
  channel_jid: string;
  command: string;
  args: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  result: string | null;
}

export function enqueueControl(channelJid: string, command: string, args: unknown = {}): number {
  assertChannelNotQuarantined(channelJid);
  const result = db
    .prepare('insert into control_queue (channel_jid, command, args) values (?, ?, ?)')
    .run(channelJid, command, JSON.stringify(args ?? {}));
  return Number(result.lastInsertRowid);
}

export function claimPendingControls(limit = 10): ControlRow[] {
  const rows = (
    db
      .prepare("select * from control_queue where status = 'pending' order by rowid")
      .all() as ControlRow[]
  )
    .filter((row) => !isChannelQuarantinedForLifeArchive(row.channel_jid))
    .slice(0, limit);
  const claim = db.prepare(
    "update control_queue set status = 'processing', processing_at = datetime('now') where rowid = ?",
  );
  for (const row of rows) claim.run(row.rowid);
  return rows;
}

export function touchControlProcessing(
  rowid: number,
  expectedChannelJid?: string,
  expectedFolder?: string,
): ControlRow | undefined {
  return db.transaction(() => {
    const current = db.prepare('select * from control_queue where rowid = ?').get(rowid) as
      | ControlRow
      | undefined;
    if (!current || isChannelQuarantinedForLifeArchive(current.channel_jid)) return undefined;
    if (expectedChannelJid && current.channel_jid !== expectedChannelJid) return undefined;
    if (
      expectedFolder &&
      !isChannelGenerationCurrent(current.channel_jid, expectedFolder)
    ) return undefined;
    return db
      .prepare(
        `update control_queue
            set processing_at = datetime('now')
          where rowid = ? and status = 'processing'
          returning *`,
      )
      .get(rowid) as ControlRow | undefined;
  }).immediate();
}

export function finishControl(rowid: number, ok: boolean, result: string): void {
  const current = getControl(rowid);
  if (!current || isChannelQuarantinedForLifeArchive(current.channel_jid)) return;
  db.prepare(
    "update control_queue set status = ?, result = ?, done_at = datetime('now') where rowid = ?",
  ).run(ok ? 'done' : 'failed', result, rowid);
}

/**
 * A processing control is authoritative until its worker exits. On worker
 * startup, unfinished rows are failed rather than replayed: commands such as
 * `pi new` are not safely repeatable after a crash.
 */
export function recoverStuckControls(): number {
  return db
    .prepare(
      `update control_queue
          set status = 'failed', result = 'Worker restarted before command completed',
              done_at = datetime('now')
        where status = 'processing'`,
    )
    .run().changes;
}

export function getControl(rowid: number): ControlRow | undefined {
  return db.prepare('select * from control_queue where rowid = ?').get(rowid) as
    | ControlRow
    | undefined;
}

// ── piweb: automatic session titles ──

export type SessionTitleJobStatus =
  | 'waiting'
  | 'pending'
  | 'processing'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface SessionTitleJobRow {
  channel_jid: string;
  prompt: string;
  message_rowid: number | null;
  status: SessionTitleJobStatus;
  attempts: number;
  last_error: string;
}

/** Mark only newly created web sessions as eligible for first-prompt naming. */
export function prepareSessionTitle(channelJid: string): void {
  db.prepare(
    `insert into session_title_jobs (channel_jid, status)
     values (?, 'waiting')
     on conflict(channel_jid) do nothing`,
  ).run(channelJid);
}

/** Capture exactly the first normal prompt; later calls cannot replace it. */
export function queuePreparedSessionTitle(
  channelJid: string,
  prompt: string,
  messageRowid: number,
): boolean {
  const firstPrompt = prompt.trim().slice(0, 8_000);
  if (!firstPrompt) return false;
  return (
    db
      .prepare(
        `update session_title_jobs
            set prompt = ?, message_rowid = ?, status = 'pending', updated_at = datetime('now')
          where channel_jid = ? and status = 'waiting'`,
      )
      .run(firstPrompt, messageRowid, channelJid).changes > 0
  );
}

/** Commit an already extracted first-prompt title with its enqueue transaction. */
export function completePendingSessionTitle(
  channelJid: string,
  messageRowid: number,
  title: string,
): boolean {
  const clean = title.trim().slice(0, 80);
  if (!clean) return false;

  return db.transaction(() => {
    const job = getSessionTitleJob(channelJid);
    if (job?.status !== 'pending' || job.message_rowid !== messageRowid) return false;

    const applied =
      db
        .prepare('update channels set name = ? where jid = ? and deleted_at is null')
        .run(clean, channelJid).changes > 0;
    if (!applied) return false;

    db.prepare(
      `update session_title_jobs
          set prompt = '', status = 'done', last_error = '', updated_at = datetime('now')
        where channel_jid = ? and status = 'pending' and message_rowid = ?`,
    ).run(channelJid, messageRowid);
    return true;
  })();
}

/**
 * Claim a fallback title only after the associated user message has left the
 * active queue. Normally the web tier completes the in-process title while
 * enqueueing; this worker path recovers interrupted or failed web requests.
 */
export function claimPendingSessionTitle(): SessionTitleJobRow | undefined {
  return db
    .prepare(
      `with next_job as (
         select j.channel_jid
           from session_title_jobs j
           join channels c on c.jid = j.channel_jid
           left join message_queue m on m.rowid = j.message_rowid
          where j.status = 'pending'
            and c.deleted_at is null
            and not exists (
              select 1 from life_archive_moves a where a.archived_jid = j.channel_jid
            )
            and (j.message_rowid is null or m.status in ('done', 'failed', 'aborted'))
          order by j.updated_at, j.created_at
          limit 1
       )
       update session_title_jobs
          set status = 'processing', updated_at = datetime('now')
        where channel_jid = (select channel_jid from next_job)
          and status = 'pending'
       returning channel_jid, prompt, message_rowid, status, attempts, last_error`,
    )
    .get() as SessionTitleJobRow | undefined;
}

/** Apply a title only if the job was not cancelled by a manual rename. */
export function completeSessionTitle(channelJid: string, title: string): boolean {
  const clean = title.trim().slice(0, 80);
  if (!clean) return false;

  return db.transaction(() => {
    const job = getSessionTitleJob(channelJid);
    if (job?.status !== 'processing') return false;

    const applied =
      db
        .prepare('update channels set name = ? where jid = ? and deleted_at is null')
        .run(clean, channelJid).changes > 0;
    db.prepare(
      `update session_title_jobs
          set prompt = '', status = ?, last_error = '', updated_at = datetime('now')
        where channel_jid = ? and status = 'processing'`,
    ).run(applied ? 'done' : 'cancelled', channelJid);
    return applied;
  })();
}

/** Retry transient failures, then forget the auxiliary prompt copy. */
export function failSessionTitle(
  channelJid: string,
  error: string,
  maxAttempts = 3,
): SessionTitleJobStatus | undefined {
  const job = getSessionTitleJob(channelJid);
  if (job?.status !== 'processing') return job?.status;
  const attempts = job.attempts + 1;
  const status: SessionTitleJobStatus = attempts >= maxAttempts ? 'failed' : 'pending';
  db.prepare(
    `update session_title_jobs
        set prompt = case when ? = 'failed' then '' else prompt end,
            status = ?, attempts = ?, last_error = ?, updated_at = datetime('now')
      where channel_jid = ? and status = 'processing'`,
  ).run(status, status, attempts, error.slice(0, 500), channelJid);
  return status;
}

export function cancelSessionTitle(channelJid: string): void {
  db.prepare(
    `update session_title_jobs
        set prompt = '', status = 'cancelled', updated_at = datetime('now')
      where channel_jid = ? and status in ('waiting', 'pending', 'processing')`,
  ).run(channelJid);
}

export function requeueInterruptedSessionTitle(channelJid: string, error = ''): boolean {
  return (
    db
      .prepare(
        `update session_title_jobs
            set status = 'pending', last_error = ?, updated_at = datetime('now')
          where channel_jid = ? and status = 'processing'`,
      )
      .run(error.slice(0, 500), channelJid).changes > 0
  );
}

export function recoverSessionTitleJobs(): number {
  return db
    .prepare(
      `update session_title_jobs
          set status = 'pending', updated_at = datetime('now')
        where status = 'processing'
          and not exists (
            select 1 from life_archive_moves a
             where a.archived_jid = session_title_jobs.channel_jid
          )`,
    )
    .run().changes;
}

export function getSessionTitleJob(channelJid: string): SessionTitleJobRow | undefined {
  return db
    .prepare(
      `select channel_jid, prompt, message_rowid, status, attempts, last_error
         from session_title_jobs where channel_jid = ?`,
    )
    .get(channelJid) as SessionTitleJobRow | undefined;
}

// ── piweb: per-channel busy flag and request leases ──

/**
 * Lease one exact channel generation while an HTTP request or worker owns it.
 * Heartbeats keep long worker turns alive past the one-hour crash cutoff; a
 * process that disappears leaves a row which eventually expires.
 */
export function beginChannelOperation(
  channelJid: string,
  expectedFolder: string,
): string | undefined {
  recoverLifeArchiveMoves();
  return db.transaction(() => {
    db.prepare(
      "delete from channel_operations where coalesce(updated_at, created_at) < datetime('now', '-1 hour')",
    ).run();
    const current = db.prepare('select folder from channels where jid = ?').get(channelJid) as
      | { folder: string }
      | undefined;
    if (!current || current.folder !== expectedFolder) return undefined;
    if (isChannelQuarantinedForLifeArchive(channelJid)) return undefined;

    const id = randomUUID();
    db.prepare(
      `insert into channel_operations
        (id, channel_jid, channel_folder, created_at, updated_at)
       values (?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(id, channelJid, expectedFolder);
    return id;
  }).immediate();
}

function isChannelOperationCurrent(
  id: string,
  channelJid: string,
  expectedFolder: string,
): boolean {
  const operation = db
    .prepare(
      `select 1 from channel_operations
        where id = ? and channel_jid = ? and channel_folder = ?`,
    )
    .get(id, channelJid, expectedFolder);
  return Boolean(operation) && isChannelGenerationCurrent(channelJid, expectedFolder);
}

export function touchChannelOperation(id: string): boolean {
  return db.transaction(() => {
    const operation = db
      .prepare('select channel_jid, channel_folder from channel_operations where id = ?')
      .get(id) as { channel_jid: string; channel_folder: string } | undefined;
    if (
      !operation ||
      !isChannelOperationCurrent(id, operation.channel_jid, operation.channel_folder)
    ) return false;
    return db
      .prepare("update channel_operations set updated_at = datetime('now') where id = ?")
      .run(id).changes > 0;
  }).immediate();
}

export function commitLifeMessageOperation(options: {
  operationId: string;
  channelJid: string;
  expectedFolder: string;
  event: {
    kind: WebEventKind;
    role?: string;
    content?: string;
    files?: string[];
  };
  message: Omit<Parameters<typeof enqueueMessage>[0], 'channelJid'>;
}): number {
  return db.transaction(() => {
    if (
      !isChannelOperationCurrent(
        options.operationId,
        options.channelJid,
        options.expectedFolder,
      )
    ) throw new Error(CHANNEL_GENERATION_CHANGED_ERROR);
    appendWebEvent(
      { channelJid: options.channelJid, ...options.event },
      { expectedFolder: options.expectedFolder },
    );
    return enqueueMessage({ channelJid: options.channelJid, ...options.message });
  }).immediate();
}

export function commitLifeControlOperation(options: {
  operationId: string;
  channelJid: string;
  expectedFolder: string;
  command: string;
  args: unknown;
}): number {
  return db.transaction(() => {
    if (
      !isChannelOperationCurrent(
        options.operationId,
        options.channelJid,
        options.expectedFolder,
      )
    ) throw new Error(CHANNEL_GENERATION_CHANGED_ERROR);
    appendWebEvent(
      {
        channelJid: options.channelJid,
        kind: 'message',
        role: 'user',
        content: `/${options.command}`,
      },
      { expectedFolder: options.expectedFolder },
    );
    return enqueueControl(options.channelJid, options.command, options.args);
  }).immediate();
}

export function finishChannelOperation(id: string): void {
  db.prepare('delete from channel_operations where id = ?').run(id);
}

export function setChannelBusy(
  channelJid: string,
  busy: boolean,
  fence?: ChannelGenerationFence,
): void {
  fencedChannelWrite(channelJid, fence, () => {
    db.prepare(
      `insert into channel_state (channel_jid, busy, updated_at)
       values (?, ?, datetime('now'))
       on conflict(channel_jid) do update set busy = excluded.busy, updated_at = excluded.updated_at`,
    ).run(channelJid, busy ? 1 : 0);
  });
}

/**
 * Sessions plus their busy flag and last-activity time in ONE query.
 *
 * The session list previously did a per-channel busy lookup (an N+1); this joins
 * instead so the drawer costs one statement regardless of session count.
 */
export function listWebSessions(): Array<{
  jid: string;
  name: string;
  folder: string;
  kind: ChannelKind;
  busy: boolean;
  modelOverride: string;
  thinkingOverride: string;
  cwdOverride: string;
  lastActivity: string | null;
  lastReplyId: number;
}> {
  const rows = db
    .prepare(
      `select c.jid, c.name, c.folder, c.kind, c.model_override, c.thinking_override, c.cwd_override,
              coalesce(s.busy, 0) as busy,
              (select max(created_at) from web_events e where e.channel_jid = c.jid) as last_activity,
              -- Newest event that is something to READ: an assistant reply or
              -- command output. The user's own turns and the streamed
              -- thinking/tool chatter must not mark a session unread.
              (select coalesce(max(rowid), 0) from web_events e
                where e.channel_jid = c.jid
                  and e.kind in ('message', 'system', 'error')
                  and e.role <> 'user') as last_reply_id
         from channels c
         left join channel_state s on s.channel_jid = c.jid
        where c.jid like 'web:%' and c.kind = 'standard' and c.deleted_at is null
          and not exists (
            select 1 from life_archive_moves m where m.archived_jid = c.jid
          )
        order by coalesce((select max(created_at) from web_events e where e.channel_jid = c.jid), c.created_at) desc, c.created_at desc`,
    )
    .all() as any[];

  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    folder: r.folder,
    kind: (r.kind || 'standard') as ChannelKind,
    busy: Boolean(r.busy),
    modelOverride: r.model_override,
    thinkingOverride: r.thinking_override,
    cwdOverride: r.cwd_override,
    lastActivity: r.last_activity,
    lastReplyId: Number(r.last_reply_id ?? 0),
  }));
}

/**
 * Restore or create the protected singleton Life conversation.
 *
 * Its first folder is random and therefore empty, so unlike standard session
 * creation this must not enqueue `pi new`: there is no inherited context to
 * rotate, and an asynchronous reset could race the first Life message.
 */
export function getOrCreateLifeChannel(): {
  channel: RegisteredChannel;
  created: boolean;
} {
  recoverLifeArchiveMoves();
  return db.transaction(() => {
    const existing = db.prepare("select * from channels where kind = 'life' limit 1").get() as
      | any
      | undefined;

    if (existing) {
      // A failed post-commit rename still leaves a valid fresh Life row. Return
      // that canonical generation, but let recovery remain its only writer.
      if (!isChannelQuarantinedForLifeArchive(existing.jid)) {
        db.prepare(
          `update channels
              set jid = 'web:life', name = 'Life', model_override = '',
                  thinking_override = '', cwd_override = '', deleted_at = null
            where jid = ?`,
        ).run(existing.jid);
      }
      return {
        channel: rowToChannel(db.prepare("select * from channels where jid = 'web:life'").get()),
        created: false,
      };
    }

    // Never reinterpret an ordinary conversation as Life: its folder may hold
    // unrelated Pi history. A reserved-JID collision must be resolved
    // explicitly instead of silently inheriting that context.
    const reserved = db.prepare("select kind from channels where jid = 'web:life'").get() as
      | { kind: ChannelKind }
      | undefined;
    if (reserved) {
      throw new Error('Cannot create Life: reserved web:life JID belongs to a standard session');
    }

    mkdirSync(config.sessionsDir, { recursive: true });
    let folder = '';
    let folderPath = '';
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = `web_life_${randomUUID().slice(0, 8)}`;
      const candidatePath = resolveChannelSessionDir(candidate);
      try {
        // mkdir without recursive is an atomic absent-path reservation. An
        // orphan from a prior run is never reused, even when it is non-empty.
        mkdirSync(candidatePath);
        folder = candidate;
        folderPath = candidatePath;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!folder) throw new Error('Could not reserve an empty Life session folder');

    try {
      db.prepare(
        `insert into channels
          (jid, name, folder, requires_trigger, is_main, model_override,
           thinking_override, cwd_override, kind)
         values ('web:life', 'Life', ?, 0, 0, '', '', '', 'life')`,
      ).run(folder);
    } catch (error) {
      try {
        rmdirSync(folderPath);
      } catch {
        // Preserve the original database error; a non-empty directory is never
        // safe to remove and will simply be skipped on the next attempt.
      }
      throw error;
    }
    return {
      channel: rowToChannel(db.prepare("select * from channels where jid = 'web:life'").get()),
      created: true,
    };
  })();
}

interface LifeArchiveMoveRow {
  id: string;
  archived_jid: string;
  new_life_folder: string;
  media_required: number;
  upload_required: number;
  folder_done: number;
  media_done: number;
  upload_done: number;
}

function finishLifeArchiveDirectoryMove(
  row: LifeArchiveMoveRow,
  column: 'media_done' | 'upload_done',
  root: string,
  required: boolean,
): void {
  if (!required) {
    db.prepare(`update life_archive_moves set ${column} = 1 where id = ?`).run(row.id);
    return;
  }

  const from = join(root, mediaDirName('web:life'));
  const to = join(root, mediaDirName(row.archived_jid));
  const fromExists = existsSync(from);
  const toExists = existsSync(to);

  // Destination-only is the expected recovery state when rename committed to
  // disk and the process died before recording that step in SQLite.
  if (toExists && !fromExists) {
    db.prepare(`update life_archive_moves set ${column} = 1 where id = ?`).run(row.id);
    return;
  }
  if (toExists && fromExists) {
    throw new Error(`Life archive destination already exists: ${to}`);
  }
  if (!fromExists) {
    throw new Error(`Life archive source disappeared before recovery: ${from}`);
  }

  mkdirSync(root, { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    // Two piweb processes may both recover the same journal row. If the other
    // one won the rename, this process can safely record the same completed step.
    if (!(existsSync(to) && !existsSync(from))) throw error;
  }
  db.prepare(`update life_archive_moves set ${column} = 1 where id = ?`).run(row.id);
}

function completeLifeArchiveMove(id: string): void {
  let row = db.prepare('select * from life_archive_moves where id = ?').get(id) as
    | LifeArchiveMoveRow
    | undefined;
  if (!row) return;

  if (!row.folder_done) {
    mkdirSync(config.sessionsDir, { recursive: true });
    // This path was checked absent before the DB commit. EEXIST on recovery is
    // also valid: the process may have died after mkdir and before this update.
    mkdirSync(resolveChannelSessionDir(row.new_life_folder), { recursive: true });
    db.prepare('update life_archive_moves set folder_done = 1 where id = ?').run(id);
  }

  row = db.prepare('select * from life_archive_moves where id = ?').get(id) as
    | LifeArchiveMoveRow
    | undefined;
  if (!row) return;
  if (!row.media_done) {
    finishLifeArchiveDirectoryMove(
      row,
      'media_done',
      config.webMediaDir,
      Boolean(row.media_required),
    );
  }
  row = db.prepare('select * from life_archive_moves where id = ?').get(id) as
    | LifeArchiveMoveRow
    | undefined;
  if (!row) return;
  if (!row.upload_done) {
    finishLifeArchiveDirectoryMove(
      row,
      'upload_done',
      config.webUploadDir,
      Boolean(row.upload_required),
    );
  }

  const finished = db
    .prepare('select folder_done, media_done, upload_done from life_archive_moves where id = ?')
    .get(id) as { folder_done: number; media_done: number; upload_done: number } | undefined;
  if (finished?.folder_done && finished.media_done && finished.upload_done) {
    db.prepare('delete from life_archive_moves where id = ?').run(id);
  }
}

/** Resume filesystem work committed by a Life re-key before a process crash. */
export function recoverLifeArchiveMoves(): number {
  const rows = db
    .prepare('select id from life_archive_moves order by created_at, id')
    .all() as Array<{
    id: string;
  }>;
  let recovered = 0;
  for (const row of rows) {
    try {
      completeLifeArchiveMove(row.id);
      if (!db.prepare('select 1 from life_archive_moves where id = ?').get(row.id)) recovered += 1;
    } catch (error) {
      logger.warn(
        { err: (error as Error).message, moveId: row.id },
        'Life archive filesystem recovery remains pending',
      );
    }
  }
  return recovered;
}

export function archiveLifeSessionAndStartNew(options: {
  archivedJid: string;
  archivedName: string;
  expectedFolder: string;
}): { archived: RegisteredChannel; life: RegisteredChannel } {
  const archivedJid = options.archivedJid.trim();
  const archivedName = options.archivedName.trim().slice(0, 80) || 'Life';
  if (!archivedJid.startsWith('web:') || archivedJid === 'web:life') {
    throw new Error('Archived Life session needs a distinct web JID');
  }

  recoverLifeArchiveMoves();
  if (db.prepare('select 1 from life_archive_moves limit 1').get()) {
    throw new Error('A previous Life filesystem archive is still incomplete');
  }

  const committed = db
    .transaction(() => {
      const current = db
        .prepare("select * from channels where jid = 'web:life' and kind = 'life'")
        .get() as { folder: string } | undefined;
      if (!current) throw new Error('Life session does not exist');
      if (current.folder !== options.expectedFolder) {
        throw new Error('Life session changed before it could be archived');
      }
      if (db.prepare('select 1 from channels where jid = ?').get(archivedJid)) {
        throw new Error(`Session already exists: ${archivedJid}`);
      }

      // A pre-existing destination is not recoverable: after commit there is
      // no safe way to distinguish it from data written by a stale owner. Fail
      // before changing any DB ownership or reserving the replacement folder.
      const archivedMediaDir = mediaDirName(archivedJid);
      const archivedMediaPath = join(config.webMediaDir, archivedMediaDir);
      const archivedUploadPath = join(config.webUploadDir, archivedMediaDir);
      for (const destination of [archivedMediaPath, archivedUploadPath]) {
        if (existsSync(destination)) {
          throw new Error(`Life archive destination already exists: ${destination}`);
        }
      }

      db.prepare(
        "delete from channel_operations where coalesce(updated_at, created_at) < datetime('now', '-1 hour')",
      ).run();
      const queuedWork = db
        .prepare(
          `select 1 from message_queue
          where channel_jid = 'web:life' and status in ('pending', 'processing')
         union all
         select 1 from control_queue
          where channel_jid = 'web:life' and status in ('pending', 'processing')
         union all
         select 1 from channel_operations
          where channel_jid = 'web:life'
         union all
         select 1 from session_title_jobs
          where channel_jid = 'web:life' and status = 'processing'
         limit 1`,
        )
        .get();
      if (queuedWork) throw new Error('Life session still has active or queued work');

      let newLifeFolder = '';
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = `web_life_${randomUUID().slice(0, 8)}`;
        if (existsSync(resolveChannelSessionDir(candidate))) continue;
        if (db.prepare('select 1 from channels where folder = ?').get(candidate)) continue;
        newLifeFolder = candidate;
        break;
      }
      if (!newLifeFolder) throw new Error('Could not reserve an empty Life session folder');

      const oldMediaDir = mediaDirName('web:life');
      const mediaRequired = existsSync(join(config.webMediaDir, oldMediaDir));
      const uploadRequired = existsSync(join(config.webUploadDir, oldMediaDir));

      db.prepare(
        `update web_events
          set files = replace(files, ?, ?)
        where channel_jid = 'web:life' and files is not null`,
      ).run(`/media/${oldMediaDir}/`, `/media/${archivedMediaDir}/`);
      db.prepare(
        `update message_queue
          set attachments = replace(attachments, ?, ?)
        where channel_jid = 'web:life' and attachments is not null`,
      ).run(join(config.webUploadDir, oldMediaDir), join(config.webUploadDir, archivedMediaDir));

      db.prepare(
        `update channels
          set jid = ?, name = ?, kind = 'standard', deleted_at = null
        where jid = 'web:life' and kind = 'life'`,
      ).run(archivedJid, archivedName);

      for (const table of [
        'web_events',
        'message_queue',
        'message_log',
        'control_queue',
        'live_output',
        'channel_state',
        'session_title_jobs',
        'scheduled_tasks',
      ]) {
        db.prepare(`update ${table} set channel_jid = ? where channel_jid = 'web:life'`).run(
          archivedJid,
        );
      }
      // A lease old enough to expire belongs to a crashed or suspended worker.
      // Its transient preview/busy mirror must not survive as permanent archive
      // chrome, and a fenced late cleanup is deliberately not allowed to write.
      db.prepare('delete from live_output where channel_jid = ?').run(archivedJid);
      db.prepare('update channel_state set busy = 0 where channel_jid = ?').run(archivedJid);

      db.prepare(
        `insert into channels
        (jid, name, folder, requires_trigger, is_main, model_override,
         thinking_override, cwd_override, kind)
       values ('web:life', 'Life', ?, 0, 0, '', '', '', 'life')`,
      ).run(newLifeFolder);

      const moveId = randomUUID();
      db.prepare(
        `insert into life_archive_moves
        (id, archived_jid, new_life_folder, media_required, upload_required,
         folder_done, media_done, upload_done)
       values (?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        moveId,
        archivedJid,
        newLifeFolder,
        mediaRequired ? 1 : 0,
        uploadRequired ? 1 : 0,
        mediaRequired ? 0 : 1,
        uploadRequired ? 0 : 1,
      );

      return {
        moveId,
        result: {
          archived: rowToChannel(
            db.prepare('select * from channels where jid = ?').get(archivedJid),
          ),
          life: rowToChannel(db.prepare("select * from channels where jid = 'web:life'").get()),
        },
      };
    })
    .immediate();

  // Deliberately post-commit: a crash here leaves the durable move journal and
  // the already-correct DB ownership for startup recovery. Never roll back or
  // delete the replacement Life folder after the re-key has committed.
  completeLifeArchiveMove(committed.moveId);
  return committed.result;
}

export function isChannelBusy(channelJid: string): boolean {
  const row = db.prepare('select busy from channel_state where channel_jid = ?').get(channelJid) as
    | { busy: number }
    | undefined;
  return Boolean(row?.busy);
}

// ── piweb: push subscriptions ──

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function savePushSubscription(sub: PushSubscriptionRow): void {
  db.prepare(
    `insert into push_subscriptions (endpoint, p256dh, auth) values (?, ?, ?)
     on conflict(endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(sub.endpoint, sub.p256dh, sub.auth);
}

export function deletePushSubscription(endpoint: string): void {
  db.prepare('delete from push_subscriptions where endpoint = ?').run(endpoint);
}

export function listPushSubscriptions(): PushSubscriptionRow[] {
  return db
    .prepare('select endpoint, p256dh, auth from push_subscriptions')
    .all() as PushSubscriptionRow[];
}

export function countPushSubscriptions(): number {
  return (db.prepare('select count(*) as c from push_subscriptions').get() as { c: number }).c;
}

/**
 * Events worth a notification: a finished assistant reply, or an agent error.
 *
 * Thinking and tool events are excluded because a single run emits dozens and
 * would turn one answer into a burst of buzzes. `system` is excluded too: that
 * is command output ("Model set to X"), which echoes something the user just
 * did on this device and does not need announcing back to them.
 */
export function getNotifiableEventsSince(
  afterRowid: number,
  limit = 20,
): Array<{
  rowid: number;
  channel_jid: string;
  kind: string;
  content: string;
  name: string;
}> {
  return db
    .prepare(
      `select e.rowid, e.channel_jid, e.kind, e.content, c.name
         from web_events e
         join channels c on c.jid = e.channel_jid
        where e.rowid > ?
          and c.deleted_at is null
          and e.role <> 'user'
          and e.kind in ('message', 'error')
        order by e.rowid limit ?`,
    )
    .all(afterRowid, limit) as any[];
}

// ── piweb: meta key/value ──

export function setMeta(key: string, value: string): void {
  db.prepare(
    `insert into meta (key, value, updated_at) values (?, ?, datetime('now'))
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function getMeta(key: string): string | undefined {
  const row = db.prepare('select value from meta where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/**
 * Move a session to the trash.
 *
 * Only the queue is cleared — anything in flight should stop — while the
 * transcript, settings and pi session directory are left untouched so a
 * restore brings the session back exactly as it was.
 */
export function softDeleteChannel(jid: string): void {
  db.transaction(() => {
    db.prepare("update channels set deleted_at = datetime('now') where jid = ?").run(jid);
    db.prepare("delete from message_queue where channel_jid = ? and status = 'pending'").run(jid);
    db.prepare('update channel_state set busy = 0 where channel_jid = ?').run(jid);
    // Keep queue deletion and title cancellation atomic: otherwise a crash
    // between them leaves a restored session with an orphaned prompt copy.
    cancelSessionTitle(jid);
  })();
}

export function renameChannel(jid: string, name: string): boolean {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return false;
  return db.transaction(() => {
    // An explicit user title always wins, even if the one-shot summary is
    // currently running in the worker.
    cancelSessionTitle(jid);
    return db.prepare('update channels set name = ? where jid = ?').run(trimmed, jid).changes > 0;
  })();
}

export function restoreChannel(jid: string): boolean {
  return db.prepare('update channels set deleted_at = null where jid = ?').run(jid).changes > 0;
}

/** Irreversible: drop every row for a session. The caller removes its files. */
export function purgeChannel(jid: string): void {
  db.prepare('delete from web_events where channel_jid = ?').run(jid);
  db.prepare('delete from message_queue where channel_jid = ?').run(jid);
  db.prepare('delete from message_log where channel_jid = ?').run(jid);
  db.prepare('delete from control_queue where channel_jid = ?').run(jid);
  db.prepare('delete from channel_state where channel_jid = ?').run(jid);
  db.prepare('delete from session_title_jobs where channel_jid = ?').run(jid);
  db.prepare('delete from channel_operations where channel_jid = ?').run(jid);
  db.prepare('delete from channels where jid = ?').run(jid);
}

export interface DeletedSession {
  jid: string;
  name: string;
  folder: string;
  deletedAt: string;
  events: number;
  lastActivity: string | null;
}

export function listDeletedWebSessions(): DeletedSession[] {
  const rows = db
    .prepare(
      `select c.jid, c.name, c.folder, c.deleted_at,
              (select count(*) from web_events e where e.channel_jid = c.jid) as events,
              (select max(created_at) from web_events e where e.channel_jid = c.jid) as last_activity,
              -- Newest event that is something to READ: an assistant reply or
              -- command output. The user's own turns and the streamed
              -- thinking/tool chatter must not mark a session unread.
              (select coalesce(max(rowid), 0) from web_events e
                where e.channel_jid = c.jid
                  and e.kind in ('message', 'system', 'error')
                  and e.role <> 'user') as last_reply_id
         from channels c
        where c.jid like 'web:%' and c.kind = 'standard' and c.deleted_at is not null
        order by c.deleted_at desc`,
    )
    .all() as any[];
  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    folder: r.folder,
    deletedAt: r.deleted_at,
    events: r.events,
    lastActivity: r.last_activity,
  }));
}

/** Sessions trashed longer ago than `days` — candidates for automatic purge. */
export function listExpiredDeletedSessions(days: number): DeletedSession[] {
  if (days <= 0) return [];
  return listDeletedWebSessions().filter((s) => {
    const at = new Date(s.deletedAt.replace(' ', 'T') + 'Z').getTime();
    return Number.isFinite(at) && Date.now() - at > days * 86_400_000;
  });
}

export function isChannelDeleted(jid: string): boolean {
  const row = db.prepare('select deleted_at from channels where jid = ?').get(jid) as
    | { deleted_at: string | null }
    | undefined;
  return Boolean(row?.deleted_at);
}

export function closeDb(): void {
  if (!dbOpen) return;
  db.close();
  dbOpen = false;
}
