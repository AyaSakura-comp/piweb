import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgySubagentRecord } from './agy.js';

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stripUserEnvelope(value: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(value);
  return (match?.[1] || value).trim();
}

function toPiSession(record: AgySubagentRecord, source: string): string {
  const raw = readFileSync(source, 'utf8');
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const output: any[] = [
    {
      type: 'session',
      id: record.conversationId,
      source: 'agy',
      agyRole: record.role,
      agyType: record.type,
    },
    { type: 'session_info', name: record.role || 'AGY subagent' },
    { type: 'model_change', provider: 'agy', modelId: record.type || 'subagent' },
  ];
  let userWritten = false;
  let pendingTool = '';
  for (const row of rows) {
    const timestamp = text(row.created_at);
    if (row.type === 'USER_INPUT' && !userWritten) {
      output.push({
        type: 'message',
        id: `agy-${row.step_index}-user`,
        timestamp,
        message: { role: 'user', content: stripUserEnvelope(text(row.content)) || record.task },
      });
      userWritten = true;
      continue;
    }
    if (row.type === 'PLANNER_RESPONSE') {
      const content: any[] = [];
      if (text(row.thinking)) content.push({ type: 'thinking', thinking: row.thinking });
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        const name = text(call?.name) || 'tool';
        pendingTool = name;
        content.push({ type: 'toolCall', name, arguments: call?.args ?? {} });
      }
      if (text(row.content)) content.push({ type: 'text', text: row.content });
      if (content.length) {
        output.push({
          type: 'message',
          id: `agy-${row.step_index}-assistant`,
          timestamp,
          message: {
            role: 'assistant',
            provider: 'agy',
            model: record.type || 'subagent',
            stopReason: Array.isArray(row.tool_calls) && row.tool_calls.length ? 'toolUse' : 'stop',
            content,
          },
        });
      }
      continue;
    }
    if (row.type === 'GENERIC' && text(row.content)) {
      output.push({
        type: 'message',
        id: `agy-${row.step_index}-tool`,
        timestamp,
        message: {
          role: 'toolResult',
          toolName: pendingTool || 'agy',
          content: [{ type: 'text', text: row.content }],
          isError: row.status === 'ERROR',
        },
      });
      pendingTool = '';
      continue;
    }
    if (row.type === 'SYSTEM_MESSAGE' && text(row.content)) {
      output.push({
        type: 'message',
        id: `agy-${row.step_index}-system`,
        timestamp,
        message: { role: 'custom', display: true, content: row.content },
      });
    }
  }
  if (!userWritten && record.task) {
    output.splice(3, 0, {
      type: 'message',
      id: 'agy-task-user',
      message: { role: 'user', content: record.task },
    });
  }
  return output.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function validatedTranscript(record: AgySubagentRecord): string {
  if (!SAFE_ID.test(record.conversationId) || record.conversationId.includes('..')) {
    throw new Error('Invalid agy subagent conversation id');
  }
  let source: string;
  try {
    const url = new URL(record.logUri);
    if (url.protocol !== 'file:') throw new Error();
    source = resolve(fileURLToPath(url));
  } catch {
    throw new Error('Invalid agy subagent transcript path');
  }
  const expectedTail = join(record.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  if (basename(source) !== 'transcript.jsonl' || !source.endsWith(sep + expectedTail)) {
    throw new Error('Agy subagent transcript path does not match its conversation id');
  }
  const stat = lstatSync(source);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > MAX_TRANSCRIPT_BYTES
  ) {
    throw new Error('Agy subagent transcript path is not a safe regular file');
  }
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  closeSync(fd);
  return source;
}

/** Copy AGY-owned child logs into the channel generation while its queue lease is active. */
export function snapshotAgySubagents(
  channelDirectory: string,
  parentConversationId: string,
  records: AgySubagentRecord[],
): void {
  const root = join(channelDirectory, '.agy-subagents');
  mkdirSync(root, { recursive: true });
  const parentTmp = join(root, `.parent-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(parentTmp, `${JSON.stringify({ version: 1, parentConversationId })}\n`, {
    flag: 'wx',
  });
  renameSync(parentTmp, join(root, 'parent.json'));
  for (const record of records) {
    const source = validatedTranscript(record);
    const childDir = join(root, record.conversationId);
    mkdirSync(childDir, { recursive: true });
    const destination = join(childDir, 'session.jsonl');
    const tmp = join(childDir, `.session-${process.pid}-${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, toPiSession(record, source), { flag: 'wx' });
      renameSync(tmp, destination);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolveDelay();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

/**
 * AGY reports invoke_subagent as DONE when the child is launched, not when the
 * child has answered. Text-only acknowledgements are not terminal evidence.
 * Refresh only while the caller's turn/generation remains owned, within a bound.
 */
export async function watchAgySubagents(
  channelDirectory: string,
  parentConversationId: string,
  records: AgySubagentRecord[],
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  } = {},
): Promise<void> {
  const intervalMs = Math.max(1, options.intervalMs ?? 1000);
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60 * 1000);
  const original = lstatSync(channelDirectory);
  if (!original.isDirectory() || original.isSymbolicLink()) return;
  do {
    if (options.signal?.aborted) return;
    try {
      if (options.isCurrent && !options.isCurrent()) return;
      const current = lstatSync(channelDirectory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== original.dev ||
        current.ino !== original.ino
      )
        return;
    } catch {
      return;
    }
    try {
      snapshotAgySubagents(channelDirectory, parentConversationId, records);
    } catch {
      // AGY appends its JSONL asynchronously; retain the last atomic snapshot
      // and retry when a write is incomplete or temporarily unavailable.
    }
    if (Date.now() >= deadline) return;
    await delay(intervalMs, options.signal);
  } while (Date.now() <= deadline);
}
