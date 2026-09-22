/** Read-only native pi-subagents artifact projection. No Pi runtime imports in
 * Docker, global temp scans, caller paths, or active-fleet history truncation. */
import { constants } from 'node:fs';
import { open, opendir, type FileHandle } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';

export interface ChildEvent {
  id: string;
  rowid: number;
  kind: string;
  role: string;
  content: string;
  createdAt: string;
  files: never[];
}
export interface ChildSummary {
  id: string;
  name: string;
  task: string;
  model: string;
  state: string;
  eventCount?: number;
  updatedAt?: number;
  running?: boolean;
}
export interface ChildProjection {
  scope: string;
  children: ChildSummary[];
  events?: ChildEvent[];
  hasMore?: boolean;
  hasMoreNewer?: boolean;
  reset?: boolean;
  total?: number;
}
export class SubagentReadError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fdPath = (fd: FileHandle, name = '') => `/proc/self/fd/${fd.fd}${name ? '/' + name : ''}`;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const missing = (e: unknown) =>
  ['ENOENT', 'ELOOP', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || '');
async function openDirectory(path: string): Promise<FileHandle> {
  let fd = await open('/', directoryFlags);
  try {
    for (const part of resolve(path).split('/').filter(Boolean)) {
      const next = await open(fdPath(fd, part), directoryFlags);
      await fd.close();
      fd = next;
    }
    return fd;
  } catch (e) {
    await fd.close();
    throw e;
  }
}
async function openFile(fd: FileHandle, name: string): Promise<FileHandle | undefined> {
  let file: FileHandle;
  try {
    file = await open(
      fdPath(fd, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    if (missing(e)) return;
    throw e;
  }
  const st = await file.stat();
  if (!st.isFile() || st.nlink !== 1) {
    await file.close();
    return;
  }
  return file;
}
const inspection = new AsyncLocalStorage<{ remaining: number; entries: number }>();
let inspections = 0;
async function admitted<T>(work: () => Promise<T>): Promise<T> {
  if (inspections >= 2) throw new SubagentReadError('Child inspection busy; retry shortly', 429);
  inspections++;
  try {
    return await inspection.run({ remaining: 2 * 1024 * 1024, entries: 0 }, work);
  } finally {
    inspections--;
  }
}
async function* directoryEntries(fd: FileHandle) {
  const dir = await opendir(fdPath(fd));
  for await (const entry of dir) {
    const budget = inspection.getStore();
    if (budget && ++budget.entries > 10000)
      throw new SubagentReadError('Child tree exceeds inspection entry limit', 413);
    yield entry;
  }
}
async function readBytes(
  file: FileHandle,
  start: number,
  length: number,
  history = false,
): Promise<Buffer> {
  length = Math.min(length, Math.max(0, (await file.stat()).size - start));
  const budget = inspection.getStore();
  if (budget && !history) {
    if (length > budget.remaining)
      throw new SubagentReadError('Child inventory exceeds 2 MiB inspection budget', 413);
    budget.remaining -= length;
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(buffer, offset, length - offset, start + offset);
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}
async function bytes(
  file: FileHandle,
  start: number,
  length: number,
  history = false,
): Promise<string> {
  return (await readBytes(file, start, length, history)).toString('utf8');
}
/** Pi discovery skips malformed/blank physical lines, accepts EOF without a
 * newline and stops at the first parsed entry. Same 1 MiB scan ceiling, plus
 * the aggregate request budget. */
async function discoveryHeader(file: FileHandle): Promise<any> {
  const size = (await file.stat()).size;
  const limit = Math.min(size, 1024 * 1024);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for (let offset = 0; offset < limit; offset += 16384) {
    pending += decoder.write(await readBytes(file, offset, Math.min(16384, limit - offset)));
    if (offset + 16384 >= size) pending += decoder.end() + '\n';
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line.trim()) continue;
      try {
        return JSON.parse(line);
      } catch {
        /* Pi skips malformed lines. */
      }
    }
  }
}
async function header(file: FileHandle): Promise<any> {
  const text = await bytes(file, 0, 16384);
  const end = text.indexOf('\n');
  if (end < 0) return;
  return JSON.parse(text.slice(0, end));
}
async function rows(text: string, tail = false): Promise<any[]> {
  if (tail) text = text.slice(text.indexOf('\n') + 1);
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
  const result: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) result.push(JSON.parse(lines[i]));
    if (result.length > 20000)
      throw new SubagentReadError('Child history exceeds 20000-entry inspection limit', 413);
    if (i % 128 === 0) await yieldLoop();
  }
  return result;
}
const textContent = (content: any): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((x) => x?.type === 'text')
          .map((x) => x.text)
          .join('\n')
      : '';
function activeBranch(entries: any[]): any[] {
  if (!entries.some((e) => Object.hasOwn(e, 'parentId'))) return entries;
  const map = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const branch: any[] = [];
  const seen = new Set();
  let cursor = [...entries].reverse().find((e) => e.id && e.type !== 'session');
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    branch.push(cursor);
    cursor = map.get(cursor.parentId);
  }
  return [entries[0], ...branch.reverse()];
}
function project(raw: any[]): {
  events: ChildEvent[];
  name: string;
  model: string;
  state: string;
  task: string;
} {
  const entries = activeBranch(raw);
  const events: ChildEvent[] = [];
  let name = 'Subagent',
    model = '',
    state = 'Activity unconfirmed',
    task = '';
  const blocks = new Map<string, number>();
  const add = (entry: any, kind: string, role: string, content: string) => {
    if (!content) return;
    const key = entry.id || 'row-' + entries.indexOf(entry);
    const block = blocks.get(key) || 0;
    blocks.set(key, block + 1);
    events.push({
      id: `${key}:${block}`,
      rowid: events.length + 1,
      kind,
      role,
      content,
      createdAt: typeof entry.timestamp === 'string' ? entry.timestamp : '',
      files: [],
    });
  };
  if (raw[0]?.parentSession)
    add(
      { id: 'fork-context' },
      'system',
      '',
      'Forked child — transcript includes inherited parent context.',
    );
  for (const entry of entries) {
    if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name;
    if (entry.type === 'model_change') model = `${entry.provider}/${entry.modelId}`;
    if (entry.type === 'compaction' || entry.type === 'branch_summary')
      add(entry, 'system', '', entry.summary || 'Context summary');
    if (entry.type !== 'message' || !entry.message) continue;
    const m = entry.message;
    if (m.role === 'user') {
      const text = textContent(m.content);
      add(entry, 'message', 'user', text);
      if (!task && !raw[0]?.parentSession) task = text.slice(0, 240);
      state = 'Activity unconfirmed';
    }
    if (m.role === 'assistant') {
      if (m.model) model = `${m.provider}/${m.model}`;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text') add(entry, 'message', 'assistant', b.text);
        if (b.type === 'thinking') add(entry, 'thinking', '', b.thinking);
        if (b.type === 'toolCall') add(entry, 'tool', b.name, JSON.stringify(b.arguments, null, 2));
      }
      // A persisted model response is not proof of process exit or gate success.
      state = ['stop', 'length'].includes(m.stopReason)
        ? 'Response complete'
        : ['error', 'aborted'].includes(m.stopReason)
          ? 'Response interrupted'
          : 'Activity unconfirmed';
      if (m.errorMessage) add(entry, 'error', '', m.errorMessage);
    }
    if (m.role === 'toolResult')
      add(entry, m.isError ? 'error' : 'tool_result', m.toolName || '', textContent(m.content));
    if (m.role === 'custom' && m.display) add(entry, 'system', '', textContent(m.content));
  }
  return { events, name, model, state, task };
}
interface Parent {
  file?: string;
  id?: string;
  scope: string;
  activeFiles?: string[];
}
async function parentIdentity(root: FileHandle, owner: string, cwd?: string): Promise<Parent> {
  let published: { id?: string; file?: string } | undefined;
  const marker = await openFile(root, '.piweb-current-parent.json');
  if (marker) {
    try {
      const m = await header(marker);
      if (
        m?.owner === owner &&
        typeof m.runtime === 'string' &&
        m.expires > Date.now() &&
        (!cwd || m.cwd === cwd)
      ) {
        published = m;
        if (
          typeof m.file === 'string' &&
          /^[^/\\]+\.jsonl$/.test(m.file) &&
          typeof m.id === 'string'
        )
          return {
            file: m.file,
            id: m.id,
            scope: digest(owner + ':' + m.file + ':' + m.id),
            activeFiles:
              m.activity?.expires > Date.now() && Array.isArray(m.activity.files)
                ? m.activity.files.slice(0, 128).filter((f: unknown) => typeof f === 'string')
                : [],
          };
        if (!m.id) return { scope: digest(owner + ':starting:' + m.runtime) };
      }
    } finally {
      await marker.close();
    }
  }
  // Cold fallback matches Pi's --continue preference: valid session header,
  // newest mtime, not lexicographic timestamp names. A warm owner publishes its
  // exact selected identity above, including before the first persisted reply.
  const candidates: { file: string; id: string; mtime: number }[] = [];
  for await (const e of directoryEntries(root)) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const file = await openFile(root, e.name);
    if (!file) continue;
    try {
      const h = await discoveryHeader(file);
      if (
        h?.type === 'session' &&
        typeof h.id === 'string' &&
        (published
          ? h.id === published.id
          : !cwd || (typeof h.cwd === 'string' && !!h.cwd && resolve(h.cwd) === resolve(cwd)))
      )
        candidates.push({ file: e.name, id: h.id, mtime: (await file.stat()).mtimeMs });
    } catch (e) {
      if (e instanceof SubagentReadError) throw e;
      /* Invalid files are not Pi sessions. */
    } finally {
      await file.close();
    }
  }
  const p = candidates.sort(
    (a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  )[0];
  return {
    file: p?.file,
    id: p?.id,
    scope: digest(owner + ':' + (p?.file || 'empty') + ':' + (p?.id || '')),
  };
}
/** Cheap identity-only revalidation; never re-scans child transcripts. */
export async function subagentParentScope(
  directory: string,
  owner: string,
  cwd?: string,
): Promise<string> {
  return admitted(() => parentScope(directory, owner, cwd));
}
async function parentScope(directory: string, owner: string, cwd?: string): Promise<string> {
  let root: FileHandle;
  try {
    root = await openDirectory(directory);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return digest(owner + ':empty:');
    throw e;
  }
  try {
    return (await parentIdentity(root, owner, cwd)).scope;
  } finally {
    await root.close();
  }
}
const summaries = new Map<string, Omit<ChildSummary, 'id'>>();
/** Descriptor-relative reads cannot follow swapped/symlink ancestors. Limits
 * bound depth, inventory, per-read allocation and selected history; all disk
 * I/O is asynchronous, list previews are cached and only details parse history. */
type Query = { scope?: string; child?: string; before?: number; after?: string; cwd?: string };
export async function readSubagents(
  directory: string,
  owner: string,
  query: Query = {},
): Promise<ChildProjection> {
  return admitted(() => readProjection(directory, owner, query));
}
interface Inventory {
  expires: number;
  children: ChildSummary[];
  paths: Map<string, { relative: string; sessionId: string }>;
}
const inventories = new Map<string, Inventory>();
const histories = new Map<
  string,
  { size: number; mtime: number; ctime: number; offset: number; rows: any[]; events: ChildEvent[] }
>();
async function selectedHistory(file: FileHandle, key: string): Promise<ChildEvent[]> {
  const st = await file.stat();
  if (st.size > 16 * 1024 * 1024)
    throw new SubagentReadError('Child history exceeds 16 MiB inspection limit', 413);
  const previous = histories.get(key);
  if (
    previous &&
    previous.size === st.size &&
    previous.mtime === st.mtimeMs &&
    previous.ctime === st.ctimeMs
  )
    return previous.events;
  const append = previous && st.size > previous.size;
  const offset = append ? previous.offset : 0;
  const text = await bytes(file, offset, st.size - offset, true);
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  const parsed = [...(append ? previous.rows : []), ...(await rows(complete))];
  if (parsed.length > 20000)
    throw new SubagentReadError('Child history exceeds 20000-entry inspection limit', 413);
  const events = project(parsed).events;
  // Two selected histories, each at most 16 MiB of source. No per-page reparse.
  if (!histories.has(key) && histories.size >= 2) histories.delete(histories.keys().next().value!);
  histories.set(key, {
    size: st.size,
    mtime: st.mtimeMs,
    ctime: st.ctimeMs,
    offset: offset + Buffer.byteLength(complete),
    rows: parsed,
    events,
  });
  return events;
}
async function readProjection(
  directory: string,
  owner: string,
  query: Query,
): Promise<ChildProjection> {
  let root: FileHandle;
  try {
    root = await openDirectory(directory);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const scope = digest(owner + ':empty:');
    if (query.scope && query.scope !== scope) throw new SubagentReadError('Parent session changed');
    if (query.child) throw new SubagentReadError('Child not found', 404);
    return { scope, children: [] };
  }
  try {
    const parent = await parentIdentity(root, owner, query.cwd);
    const { scope } = parent;
    if (query.scope && query.scope !== scope) throw new SubagentReadError('Parent session changed');
    const rootStat = await root.stat();
    const inventoryKey = `${directory}:${scope}:${rootStat.dev}:${rootStat.ino}`;
    const cached = inventories.get(inventoryKey);
    const inventory = cached && cached.expires > Date.now() ? cached : undefined;
    const children: ChildSummary[] = inventory ? [...inventory.children] : [];
    const paths = inventory
      ? inventory.paths
      : new Map<string, { relative: string; sessionId: string }>();
    let selected: ChildEvent[] | undefined;
    async function scan(fd: FileHandle, prefix: string, depth: number) {
      if (depth > 16) throw new SubagentReadError('Child tree exceeds inspection depth limit', 413);
      for await (const entry of directoryEntries(fd)) {
        const relative = prefix + '/' + entry.name;
        if (entry.isDirectory()) {
          let child: FileHandle;
          try {
            child = await open(fdPath(fd, entry.name), directoryFlags);
          } catch (e) {
            if (missing(e)) continue;
            throw e;
          }
          try {
            await scan(child, relative, depth + 1);
          } finally {
            await child.close();
          }
        } else if (
          entry.isFile() &&
          (entry.name === 'session.jsonl' ||
            (prefix.endsWith('/forks') && entry.name.endsWith('.jsonl')))
        ) {
          const file = await openFile(fd, entry.name);
          if (!file) continue;
          try {
            const h = await header(file);
            if (h?.type !== 'session' || typeof h.id !== 'string' || h.id === parent.id) continue;
            // Fork ownership is explicit; never follow parentSession as a path.
            if (
              prefix.endsWith('/forks') &&
              h.parentSession !== join(directory, parent.file!) &&
              !(
                typeof h.parentSession === 'string' &&
                h.parentSession.startsWith(join(directory, parent.file!.slice(0, -6)) + '/')
              )
            )
              continue;
            const id = digest(scope + ':' + relative + ':' + h.id);
            const st = await file.stat();
            const cacheKey = `${scope}:${relative}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
            let summary = summaries.get(cacheKey);
            if (!summary) {
              const head = await rows(await bytes(file, 0, Math.min(st.size, 32768)));
              const tail =
                st.size > 32768
                  ? await rows(await bytes(file, Math.max(0, st.size - 32768), 32768), true)
                  : [];
              // This is metadata only, not a rendered conversation: keep head
              // metadata when the bounded tail starts mid-ancestry.
              const preview = [...head, ...tail].map((e) => {
                const { parentId, ...rest } = e;
                return rest;
              });
              const p = project(preview);
              summary = {
                name: p.name,
                task: p.task,
                model: p.model,
                state: p.state,
                updatedAt: st.mtimeMs,
              };
              if (summaries.size >= 10000) summaries.delete(summaries.keys().next().value!);
              summaries.set(cacheKey, summary);
            }
            children.push({ id, ...summary });
            paths.set(id, { relative, sessionId: h.id });
          } catch (e) {
            // A malformed sibling never prevents access to other children.
            if (e instanceof SubagentReadError) throw e;
            const id = digest(scope + ':' + relative + ':unavailable');
            children.push({
              id,
              name: 'Unavailable child history',
              task: '',
              model: '',
              state: 'Unreadable artifact',
            });
          } finally {
            await file.close();
          }
        }
      }
    }
    if (parent.file && !inventory) {
      let fd: FileHandle | undefined;
      try {
        fd = await open(fdPath(root, parent.file.slice(0, -6)), directoryFlags);
      } catch (e) {
        if (!missing(e)) throw e;
      }
      if (fd) {
        try {
          await scan(fd, '', 0);
        } finally {
          await fd.close();
        }
      }
    }
    if (!inventory) {
      if (inventories.size >= 32) inventories.delete(inventories.keys().next().value!);
      inventories.set(inventoryKey, { expires: Date.now() + 1000, children: [...children], paths });
    }
    // Apply fresh owner activity AFTER inventory caching, never cache a spinner.
    const activeFiles = new Set(parent.activeFiles || []);
    for (let i = 0; i < children.length; i++)
      children[i] = {
        ...children[i],
        running: activeFiles.has(paths.get(children[i].id)?.relative.slice(1) || ''),
      };
    children.sort(
      (a, b) =>
        Number(!!b.running) - Number(!!a.running) ||
        (b.updatedAt || 0) - (a.updatedAt || 0) ||
        a.id.localeCompare(b.id),
    );
    if (query.child && parent.file) {
      const entry = paths.get(query.child);
      if (entry) {
        // Reopen every ancestor descriptor-relative, including on a cache hit.
        const parts = [parent.file.slice(0, -6), ...entry.relative.split('/').filter(Boolean)];
        let fd = await open(fdPath(root, parts.shift()!), directoryFlags);
        try {
          for (const part of parts.slice(0, -1)) {
            const next = await open(fdPath(fd, part), directoryFlags);
            await fd.close();
            fd = next;
          }
          const file = await openFile(fd, parts.at(-1)!);
          if (file) {
            try {
              const h = await header(file);
              if (h?.id === entry.sessionId) {
                const st = await file.stat();
                selected = await selectedHistory(
                  file,
                  `${scope}:${entry.relative}:${st.dev}:${st.ino}`,
                );
              }
            } finally {
              await file.close();
            }
          }
        } finally {
          await fd.close();
        }
      }
    }
    if (query.child && !selected) throw new SubagentReadError('Child not found', 404);
    if (!selected) return { scope, children };
    const cursor = query.after ? selected.findIndex((e) => e.id === query.after) : -1;
    const reset = !!query.after && cursor < 0;
    const end = query.before ? Math.min(selected.length, query.before - 1) : selected.length;
    const start = cursor >= 0 ? cursor + 1 : Math.max(0, end - 200);
    const pageEnd = cursor >= 0 ? Math.min(selected.length, start + 200) : end;
    return {
      scope,
      children,
      events: selected.slice(start, pageEnd),
      hasMore: start > 0,
      hasMoreNewer: pageEnd < selected.length,
      reset,
      total: selected.length,
    };
  } finally {
    await root.close();
  }
}
