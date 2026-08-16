import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Validate a channel session folder name.
 *
 * We allow nested relative paths (e.g. "guild/general") but reject empty,
 * absolute, and traversing paths so channel state always stays under
 * config.sessionsDir.
 */
export function validateSessionFolder(folder: string): string {
  const trimmed = folder.trim();
  if (!trimmed) {
    throw new Error('Session folder cannot be empty');
  }

  if (isAbsolute(trimmed)) {
    throw new Error(`Session folder must be relative: ${folder}`);
  }

  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Session folder contains an invalid path segment: ${folder}`);
  }

  return trimmed;
}

/** Resolve a channel session folder to an absolute directory under sessionsDir. */
export function resolveChannelSessionDir(folder: string): string {
  const safeFolder = validateSessionFolder(folder);
  const baseDir = resolve(config.sessionsDir);
  const sessionDir = resolve(baseDir, safeFolder);
  const rel = relative(baseDir, sessionDir);

  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Session folder escapes sessions directory: ${folder}`);
  }

  return sessionDir;
}

/** Resolve a media directory for a message under a validated channel session directory. */
export function resolveChannelMediaMessageDir(folder: string, messageId: string): string {
  const trimmedMessageId = messageId.trim();
  if (
    !trimmedMessageId ||
    /[\\/]/u.test(trimmedMessageId) ||
    trimmedMessageId === '.' ||
    trimmedMessageId === '..'
  ) {
    throw new Error(`Invalid media message id: ${messageId}`);
  }

  return resolve(resolveChannelSessionDir(folder), 'media', `msg-${trimmedMessageId}`);
}

/**
 * List the active session directory plus every archived sibling created from it.
 * Permanent deletion must remove this complete family rather than orphaning
 * transcripts (and any session-scoped knowledge databases) in rotated folders.
 */
export function listSessionFamilyDirs(sessionDir: string): string[] {
  const activeDir = resolve(sessionDir);
  const parentDir = dirname(activeDir);
  const sessionName = basename(activeDir);
  const archivePrefix = `${sessionName}__archived_`;

  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [activeDir];
  }

  const archives = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(archivePrefix))
    .map((entry) => resolve(parentDir, entry.name));

  return [activeDir, ...archives];
}

/** Rotate a channel session directory out of the active path without deleting it. */
export function rotateChannelSessionDir(folder: string): string | undefined {
  const sessionDir = resolveChannelSessionDir(folder);
  if (!existsSync(sessionDir)) {
    return undefined;
  }

  const parentDir = dirname(sessionDir);
  const sessionName = basename(sessionDir);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

  let archiveDir = resolve(parentDir, `${sessionName}__archived_${stamp}`);
  let suffix = 1;

  while (existsSync(archiveDir)) {
    archiveDir = resolve(parentDir, `${sessionName}__archived_${stamp}_${suffix}`);
    suffix += 1;
  }

  renameSync(sessionDir, archiveDir);
  return archiveDir;
}

/** Resolve the most recent active session file for a channel, if one exists. */
export function resolveLatestChannelSessionFile(folder: string): string | undefined {
  const sessionDir = resolveChannelSessionDir(folder);
  if (!existsSync(sessionDir)) {
    return undefined;
  }

  const sessionFile = readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))[0];

  if (!sessionFile) {
    return undefined;
  }

  return resolve(sessionDir, sessionFile);
}

/**
 * Make the newest session file safe for `pi --continue`.
 *
 * A run interrupted mid-tool-loop — INTERRUPT_ON_NEW_MESSAGE aborting an
 * in-flight run, an OOM SIGKILL, a crash — leaves the session ending inside an
 * unfinished turn: an assistant `toolCall` (and maybe its `toolResult`) with no
 * closing text reply. pi then refuses the *next* `--continue` with
 *   "Cannot continue from message role: assistant"
 * and the session is stuck there until it happens to complete a clean turn.
 *
 * This truncates the file back to the last COMPLETE turn — the last assistant
 * message that produced text and has no pending toolCall — discarding only the
 * aborted turn's partial work. A single rolling backup (`<file>.prerepair.bak`)
 * is kept. Returns true if it changed anything.
 *
 * Safe to call right before spawning pi: the queue's per-channel serial lock
 * guarantees no pi process is writing this session's file at the same time.
 */
export function repairSessionForContinue(folder: string): boolean {
  const file = resolveLatestChannelSessionFile(folder);
  if (!file) return false;

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  const rawLines = text.split('\n');
  interface Row {
    raw: string;
    isMessage: boolean;
    complete: boolean; // assistant final reply: has text, no pending toolCall
  }
  const rows: Row[] = [];
  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(raw);
    } catch {
      rows.push({ raw, isMessage: false, complete: false });
      continue;
    }
    if (ev?.type === 'message') {
      const content = ev.message?.content;
      const parts = Array.isArray(content)
        ? content.map((p: any) => p?.type)
        : [];
      const complete =
        ev.message?.role === 'assistant' &&
        parts.includes('text') &&
        !parts.includes('toolCall');
      rows.push({ raw, isMessage: true, complete });
    } else {
      rows.push({ raw, isMessage: false, complete: false });
    }
  }

  const lastMessageIdx = (() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].isMessage) return i;
    return -1;
  })();
  if (lastMessageIdx === -1) return false; // no conversation yet — nothing to fix

  // Already ends on a completed assistant reply → continuable, leave it alone.
  if (rows[lastMessageIdx].complete) return false;

  const lastComplete = (() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].complete) return i;
    return -1;
  })();

  // Keep everything up to and including the last complete reply. If there is no
  // complete reply at all, keep only the leading non-message preamble (session
  // header, model_change) so the session is valid but empty.
  let keepUpto: number;
  if (lastComplete >= 0) {
    keepUpto = lastComplete;
  } else {
    keepUpto = -1;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].isMessage) break;
      keepUpto = i;
    }
  }

  try {
    copyFileSync(file, `${file}.prerepair.bak`);
    const kept = rows.slice(0, keepUpto + 1).map((r) => r.raw);
    writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '');
    logger.warn(
      { folder, file: basename(file), droppedMessages: lastMessageIdx - keepUpto },
      'Repaired interrupted session so pi can continue',
    );
    return true;
  } catch (err: any) {
    logger.error({ folder, err: err.message }, 'Session repair failed');
    return false;
  }
}

/** Read the session creation timestamp from the metadata record at the start of a session file. */
export function readSessionCreatedAt(sessionFile: string): string | undefined {
  let fd: number | undefined;

  try {
    fd = openSync(sessionFile, 'r');
    const buffer = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return undefined;
    }

    const firstLine = buffer.toString('utf-8', 0, bytesRead).split(/\r?\n/u, 1)[0]?.trim();
    if (!firstLine) {
      return undefined;
    }

    const record = JSON.parse(firstLine) as { timestamp?: string };
    return typeof record.timestamp === 'string' ? record.timestamp : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
