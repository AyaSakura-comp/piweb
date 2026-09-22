import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LIMIT = 16 * 1024 * 1024;
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const text = (value: unknown) => (typeof value === 'string' ? value : '');

function directory(path: string): number {
  let fd = openSync('/', dirFlags);
  try {
    for (const part of resolve(path).split('/').filter(Boolean)) {
      const next = openSync(fdPath(fd, part), dirFlags);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function childDirectory(fd: number, name: string): number {
  try {
    mkdirSync(fdPath(fd, name), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return openSync(fdPath(fd, name), dirFlags);
}
function readRows(fd: number, name: string): { rows: any[]; signature: string; size: number } {
  const file = openSync(
    fdPath(fd, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT)
      throw new Error('Unsafe Claude transcript');
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(file, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const complete = buffer.subarray(0, length);
    const lines = complete
      .subarray(0, complete.lastIndexOf(0x0a) + 1)
      .toString('utf8')
      .split('\n')
      .filter(Boolean);
    if (lines.length > 20000) throw new Error('Claude transcript entry limit');
    return {
      rows: lines.map((line) => JSON.parse(line)),
      signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      size: stat.size,
    };
  } finally {
    closeSync(file);
  }
}
function atomic(fd: number, name: string, content: string): void {
  const tmp = `.snapshot-${randomUUID()}`;
  try {
    writeFileSync(fdPath(fd, tmp), content, { flag: 'wx', mode: 0o600 });
    renameSync(fdPath(fd, tmp), fdPath(fd, name));
  } finally {
    try {
      unlinkSync(fdPath(fd, tmp));
    } catch {
      // Best-effort removal must not mask a failed atomic write. Hidden temp
      // names are never discovered by the read-only projection API.
    }
  }
}
interface Child {
  name: string;
  model: string;
}
function project(rows: any[], parent: string, id: string, child?: Child): string {
  const messages = rows.filter((row) => row.type === 'user' || row.type === 'assistant');
  if (
    !messages.length ||
    messages.some(
      (row) => row.sessionId !== parent || row.agentId !== id || row.isSidechain !== true,
    )
  )
    throw new Error('Foreign Claude child identity');
  const output: any[] = [
    { type: 'session', id, source: 'claude-code', parentSessionId: parent },
    { type: 'session_info', name: child?.name || 'Claude subagent' },
  ];
  const tools = new Map<string, string>();
  for (const [index, row] of messages.entries()) {
    const m = row.message;
    if (!m || !['user', 'assistant'].includes(m.role)) continue;
    const base = {
      type: 'message',
      id: text(row.uuid) || `row-${index}`,
      timestamp: text(row.timestamp),
    };
    if (m.role === 'assistant') {
      const content: any[] = [];
      for (const part of Array.isArray(m.content) ? m.content : []) {
        if (part.type === 'thinking' && text(part.thinking))
          content.push({ type: 'thinking', thinking: part.thinking });
        if (part.type === 'text' && text(part.text))
          content.push({ type: 'text', text: part.text });
        if (part.type === 'tool_use') {
          tools.set(text(part.id), text(part.name));
          content.push({
            type: 'toolCall',
            id: text(part.id),
            name: text(part.name) || 'tool',
            arguments: part.input ?? {},
          });
        }
      }
      if (content.length)
        output.push({
          ...base,
          message: {
            role: 'assistant',
            provider: 'claude-code',
            model: text(m.model) || child?.model || 'subagent',
            content,
            stopReason:
              m.stop_reason === 'end_turn' && content.some((c) => c.type === 'text')
                ? 'stop'
                : m.stop_reason === 'max_tokens'
                  ? 'length'
                  : 'toolUse',
          },
        });
    } else if (typeof m.content === 'string') {
      output.push({ ...base, message: { role: 'user', content: m.content } });
    } else if (Array.isArray(m.content)) {
      for (const [block, part] of m.content.entries()) {
        if (part.type === 'tool_result') {
          const value =
            typeof part.content === 'string'
              ? part.content
              : Array.isArray(part.content)
                ? part.content
                    .filter((p: any) => p.type === 'text')
                    .map((p: any) => text(p.text))
                    .join('\n')
                : '';
          output.push({
            ...base,
            id: `${base.id}:${block}`,
            message: {
              role: 'toolResult',
              toolName: tools.get(text(part.tool_use_id)) || 'tool',
              isError: part.is_error === true,
              content: [{ type: 'text', text: value }],
            },
          });
        } else if (part.type === 'text')
          output.push({
            ...base,
            id: `${base.id}:${block}`,
            message: { role: 'user', content: text(part.text) },
          });
      }
    }
  }
  return output.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** Worker-only, scoped snapshots. Never follows outputFile paths from model text.
 * Short-lived activity is observational, not a process-exit or success claim. */
export function createClaudeSubagentTracker(
  channelDirectory: string,
  parentSessionId: string,
  options: { isCurrent?: () => boolean; now?: () => number } = {},
) {
  if (!ID.test(parentSessionId)) throw new Error('Invalid Claude parent id');
  const original = lstatSync(channelDirectory);
  const now = options.now || Date.now;
  const calls = new Map<string, any>();
  const children = new Map<string, Child>();
  const active = new Set<string>();
  const versions = new Map<string, string>();
  let bootstrapped = false;
  const owned = () => {
    try {
      if (options.isCurrent && !options.isCurrent()) return false;
      const st = lstatSync(channelDirectory);
      return (
        original.isDirectory() &&
        !original.isSymbolicLink() &&
        st.isDirectory() &&
        !st.isSymbolicLink() &&
        st.ino === original.ino &&
        st.dev === original.dev
      );
    } catch {
      return false;
    }
  };
  function notification(content: string) {
    // Only metadata supplied by Claude's notification channel reaches here.
    // Never interpret child result text as additional completion metadata.
    const envelope = content.split('<result>')[0];
    const id = /<task-id>([^<]+)<\/task-id>/.exec(envelope)?.[1];
    const status = /<status>([^<]+)<\/status>/.exec(envelope)?.[1];
    if (id && ['completed', 'failed', 'stopped'].includes(status || '')) active.delete(id);
  }
  function observe(row: any) {
    if (row?.sessionId !== parentSessionId || row.isSidechain) return;
    const parts = Array.isArray(row.message?.content) ? row.message.content : [];
    if (row.type === 'assistant') {
      for (const part of parts) {
        if (part?.type !== 'tool_use') continue;
        if (['Agent', 'Task'].includes(part.name)) calls.set(text(part.id), part.input || {});
        if (part.name === 'SendMessage' && children.has(part.input?.to)) active.add(part.input.to);
      }
    }
    if (row.type === 'user') {
      const result = row.toolUseResult;
      const call = parts.find(
        (part: any) => part.type === 'tool_result' && calls.has(part.tool_use_id),
      );
      if (result && call && ID.test(text(result.agentId))) {
        const input = calls.get(call.tool_use_id);
        const id = result.agentId;
        children.set(id, {
          name: text(input.description) || text(result.description) || 'Claude subagent',
          model: text(result.resolvedModel),
        });
        if (result.isAsync === true || result.status === 'async_launched') active.add(id);
        else active.delete(id);
      }
      if (row.origin?.kind === 'task-notification' || row.turnOrigin === 'task_notification') {
        notification(text(row.message?.content));
      }
    }
    if (
      row.type === 'attachment' &&
      row.attachment?.type === 'queued_command' &&
      row.attachment.commandMode === 'task-notification'
    ) {
      notification(text(row.attachment.prompt));
    }
    if (
      row.type === 'system' &&
      row.subtype === 'turn_duration' &&
      row.pendingBackgroundAgentCount === 0
    )
      active.clear();
  }
  function manifest(fd: number, stopped = false) {
    if (!owned()) return;
    atomic(
      fd,
      'parent.json',
      JSON.stringify({
        version: 1,
        parentSessionId,
        activeIds: stopped ? [] : [...active],
        expires: stopped ? 0 : now() + 5000,
      }) + '\n',
    );
  }
  return {
    observe,
    get hasPending() {
      return active.size > 0;
    },
    refresh(parentTranscript: string) {
      if (!owned() || basename(parentTranscript) !== `${parentSessionId}.jsonl`) return;
      let source: number | undefined,
        input: number | undefined,
        root: number | undefined,
        output: number | undefined;
      try {
        source = directory(dirname(parentTranscript));
        if (!bootstrapped) {
          try {
            for (const row of readRows(source, basename(parentTranscript)).rows) observe(row);
          } catch {
            // Recovery metadata is optional. A large parent transcript must not
            // prevent safely reading its bounded, independently owned children.
          }
          bootstrapped = true;
        }
        const parentDir = openSync(fdPath(source, parentSessionId), dirFlags);
        try {
          input = openSync(fdPath(parentDir, 'subagents'), dirFlags);
        } finally {
          closeSync(parentDir);
        }
        root = directory(channelDirectory);
        const stat = fstatSync(root);
        if (!owned() || stat.ino !== original.ino || stat.dev !== original.dev) return;
        output = childDirectory(root, '.claude-subagents');
        let remaining = 32 * 1024 * 1024;
        const files = readdirSync(fdPath(input, '.')).filter((name) =>
          /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(name),
        );
        if (files.length > 128) throw new Error('Claude child inventory limit');
        for (const name of files) {
          if (!owned()) return;
          const id = name.slice(6, -6);
          if (!ID.test(id)) continue;
          let childDir: number | undefined;
          try {
            const data = readRows(input, name);
            remaining -= data.size;
            if (remaining < 0) break;
            const child = children.get(id);
            const signature = data.signature + JSON.stringify(child);
            if (versions.get(id) === signature) continue;
            const content = project(data.rows, parentSessionId, id, child);
            if (!owned()) return;
            childDir = childDirectory(output, id);
            atomic(childDir, 'session.jsonl', content);
            versions.set(id, signature);
          } catch {
            /* Incomplete/unsafe children never replace a good snapshot. */
          } finally {
            if (childDir !== undefined) closeSync(childDir);
          }
        }
        manifest(output);
      } catch {
        /* Missing files while Claude starts/writes are normal. Fail closed. */
      } finally {
        for (const fd of [output, root, input, source]) if (fd !== undefined) closeSync(fd);
      }
    },
    stop() {
      if (!owned()) return;
      let root: number | undefined, output: number | undefined;
      try {
        root = directory(channelDirectory);
        output = openSync(fdPath(root, '.claude-subagents'), dirFlags);
        manifest(output, true);
      } catch {
        /* No snapshot yet, or its generation disappeared. */
      } finally {
        if (output !== undefined) closeSync(output);
        if (root !== undefined) closeSync(root);
      }
    },
  };
}
