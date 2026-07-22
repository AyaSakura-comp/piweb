import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { type RegisteredChannel, type QueuedMessage, type ThinkingLevel } from './types.js';

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
      status      text not null default 'pending',
      result      text,
      created_at  text not null default (datetime('now')),
      done_at     text
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

    -- Per-channel transient runtime state the UI polls (typing indicator).
    create table if not exists channel_state (
      channel_jid text primary key,
      busy        integer not null default 0,
      updated_at  text not null default (datetime('now'))
    );
  `);

  ensureTableColumn('channels', 'model_override', "text not null default ''");
  ensureTableColumn('channels', 'thinking_override', "text not null default ''");
  ensureTableColumn('channels', 'cwd_override', "text not null default ''");
  // Soft delete: deleting a session moves it to a trash it can be restored
  // from. Nothing is destroyed until it is purged, which also means a deleted
  // session no longer strands its pi session directory on disk.
  ensureTableColumn('channels', 'deleted_at', 'text');
  ensureTableColumn('message_queue', 'attachments', 'text');

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

export function registerChannel(ch: RegisteredChannel): void {
  db.prepare(
    `
    insert into channels (jid, name, folder, requires_trigger, is_main, model_override, thinking_override, cwd_override)
    values (?, ?, ?, ?, ?, ?, ?, ?)
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
  );
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
  };
}

// ── Message queue ──

export function enqueueMessage(msg: {
  channelJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  attachments?: string | null;
}): void {
  db.prepare(
    `
    insert into message_queue (channel_jid, sender, sender_name, content, timestamp, attachments)
    values (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    msg.channelJid,
    msg.sender,
    msg.senderName,
    msg.content,
    msg.timestamp,
    msg.attachments ?? null,
  );
}

export function claimNextMessage(channelJid: string): QueuedMessage | undefined {
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
    returning rowid, channel_jid, sender, sender_name, content, timestamp, status, attachments
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

export function clearPendingMessages(channelJid: string): number {
  const result = db
    .prepare("delete from message_queue where channel_jid = ? and status = 'pending'")
    .run(channelJid);
  return result.changes;
}

export function recoverStuckMessages(): number {
  const result = db
    .prepare("update message_queue set status = 'pending' where status = 'processing'")
    .run();
  return result.changes;
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
  return rows.map((r) => r.channel_jid);
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
): void {
  db.transaction(() => {
    enqueueMessage(msg);
    updateTaskAfterRun(taskId, lastRunAt, nextRunAt);
  })();
}

// ── Message log ──

export function logMessage(channelJid: string, role: string, content: string): void {
  db.prepare('insert into message_log (channel_jid, role, content) values (?, ?, ?)').run(
    channelJid,
    role,
    content,
  );
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

export function appendWebEvent(event: {
  channelJid: string;
  kind: WebEventKind;
  role?: string;
  content?: string;
  files?: string[];
}): number {
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
    .prepare(
      'select * from web_events where channel_jid = ? and rowid > ? order by rowid limit ?',
    )
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
export function getWebEventsAround(
  channelJid: string,
  rowid: number,
  limit = 50,
): WebEventRow[] {
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
export function searchWebEvents(
  channelJid: string,
  query: string,
  limit = 50,
): WebSearchHit[] {
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
      r.content.slice(start, start + 160).replace(/\s+/g, ' ').trim() +
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
  status: 'pending' | 'done' | 'failed';
  result: string | null;
}

export function enqueueControl(channelJid: string, command: string, args: unknown = {}): number {
  const result = db
    .prepare('insert into control_queue (channel_jid, command, args) values (?, ?, ?)')
    .run(channelJid, command, JSON.stringify(args ?? {}));
  return Number(result.lastInsertRowid);
}

export function claimPendingControls(limit = 10): ControlRow[] {
  const rows = db
    .prepare("select * from control_queue where status = 'pending' order by rowid limit ?")
    .all(limit) as ControlRow[];
  const claim = db.prepare("update control_queue set status = 'processing' where rowid = ?");
  for (const row of rows) claim.run(row.rowid);
  return rows;
}

export function finishControl(rowid: number, ok: boolean, result: string): void {
  db.prepare(
    "update control_queue set status = ?, result = ?, done_at = datetime('now') where rowid = ?",
  ).run(ok ? 'done' : 'failed', result, rowid);
}

export function getControl(rowid: number): ControlRow | undefined {
  return db.prepare('select * from control_queue where rowid = ?').get(rowid) as
    | ControlRow
    | undefined;
}

// ── piweb: per-channel busy flag (typing indicator) ──

export function setChannelBusy(channelJid: string, busy: boolean): void {
  db.prepare(
    `insert into channel_state (channel_jid, busy, updated_at)
     values (?, ?, datetime('now'))
     on conflict(channel_jid) do update set busy = excluded.busy, updated_at = excluded.updated_at`,
  ).run(channelJid, busy ? 1 : 0);
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
  busy: boolean;
  modelOverride: string;
  thinkingOverride: string;
  cwdOverride: string;
  lastActivity: string | null;
  lastReplyId: number;
}> {
  const rows = db
    .prepare(
      `select c.jid, c.name, c.folder, c.model_override, c.thinking_override, c.cwd_override,
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
        where c.jid like 'web:%' and c.deleted_at is null
        order by c.created_at`,
    )
    .all() as any[];

  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    folder: r.folder,
    busy: Boolean(r.busy),
    modelOverride: r.model_override,
    thinkingOverride: r.thinking_override,
    cwdOverride: r.cwd_override,
    lastActivity: r.last_activity,
    lastReplyId: Number(r.last_reply_id ?? 0),
  }));
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
  return db.prepare('select endpoint, p256dh, auth from push_subscriptions').all() as
    PushSubscriptionRow[];
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
export function getNotifiableEventsSince(afterRowid: number, limit = 20): Array<{
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
  db.prepare("update channels set deleted_at = datetime('now') where jid = ?").run(jid);
  db.prepare("delete from message_queue where channel_jid = ? and status = 'pending'").run(jid);
  db.prepare('update channel_state set busy = 0 where channel_jid = ?').run(jid);
}

export function renameChannel(jid: string, name: string): boolean {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return false;
  return db.prepare('update channels set name = ? where jid = ?').run(trimmed, jid).changes > 0;
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
        where c.jid like 'web:%' and c.deleted_at is not null
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
