import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative } from 'node:path';
import { config } from '../config.js';
import {
  ensureSessionPurgeTargetPaths,
  finalizeSessionPurgeBatch,
  getCompletedSessionPurgeCount,
  getSessionPurgeBatch,
  listPendingSessionPurgeBatchIds,
  markSessionPurgeFilesDone,
  recordSessionPurgeFileError,
  recordSessionPurgeSourceIdentity,
  type SessionPurgePath,
} from '../db.js';
import { logger } from '../logger.js';
import { mediaDirName, standardUploadOwnerDirName } from '../media-path.js';
import {
  listSessionFamilyDirs,
  relativePathEscapesRoot,
  resolveChannelSessionDir,
} from './path.js';

export class SessionPurgePendingError extends Error {
  constructor(message = 'Permanent deletion cleanup is pending and will be retried') {
    super(message);
    this.name = 'SessionPurgePendingError';
  }
}

export interface SessionPurgeFileOps {
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  open: typeof open;
  readdir: typeof readdir;
  rename: typeof rename;
  rm: typeof rm;
  rmdir: typeof rmdir;
  /** Test seam for injected durability failures; production opens and fsyncs. */
  syncPath?: (path: string) => Promise<void>;
}

const defaultFileOps: SessionPurgeFileOps = {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
};

interface PurgeSource {
  sourcePath: string;
  rootPath: string;
  sourceGuard: boolean;
}

function targetSources(folder: string, jid: string, storageToken: string): PurgeSource[] {
  const operationOwner = standardUploadOwnerDirName(jid, folder, storageToken);
  return [
    ...listSessionFamilyDirs(resolveChannelSessionDir(folder)).map((sourcePath) => ({
      sourcePath,
      rootPath: config.sessionsDir,
      sourceGuard: false,
    })),
    {
      sourcePath: join(config.webMediaDir, mediaDirName(jid)),
      rootPath: config.webMediaDir,
      sourceGuard: false,
    },
    {
      sourcePath: join(config.webUploadDir, mediaDirName(jid)),
      rootPath: config.webUploadDir,
      sourceGuard: false,
    },
    {
      sourcePath: join(config.webMediaDir, '.operations', operationOwner),
      rootPath: config.webMediaDir,
      sourceGuard: true,
    },
    {
      sourcePath: join(config.webUploadDir, '.operations', operationOwner),
      rootPath: config.webUploadDir,
      sourceGuard: true,
    },
  ];
}

function tombstonePath(rootPath: string, batchId: string, sourcePath: string): string {
  const sourceId = createHash('sha256').update(sourcePath).digest('hex').slice(0, 24);
  return join(rootPath, '.piweb-purge', batchId, sourceId);
}

async function pathExists(path: string, fileOps: SessionPurgeFileOps): Promise<boolean> {
  try {
    await fileOps.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function durableSyncPath(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncPath(path: string, fileOps: SessionPurgeFileOps): Promise<void> {
  await (fileOps.syncPath ?? durableSyncPath)(path);
}

/** Create one directory level without ever following an existing symlink. */
async function ensureRealDirectory(
  path: string,
  fileOps: SessionPurgeFileOps,
  syncExisting = false,
): Promise<void> {
  let info;
  let created = false;
  try {
    info = await fileOps.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await fileOps.mkdir(path);
      created = true;
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
    }
    info = await fileOps.lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Unsafe session purge tombstone directory: ${path}`);
  }
  // Callers request recovery fsyncs for tombstone levels and managed-root
  // components that may have been created before a prior parent-sync failure.
  if (created || syncExisting) await syncPath(dirname(path), fileOps);
}

/**
 * Materialize a configured absolute root without `mkdir({recursive:true})`.
 * Every component is lstat-checked before use, so a missing-root repair cannot
 * be redirected through a symlink planted at an intermediate component.
 */
async function ensureManagedRoot(path: string, fileOps: SessionPurgeFileOps): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`Session purge managed root is not absolute: ${path}`);
  const root = parse(path).root;
  let current = root;
  const rootInfo = await fileOps.lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Unsafe session purge managed root: ${root}`);
  }
  for (const segment of relative(root, path)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    current = join(current, segment);
    // Retry the parent fsync even when this component already exists. A prior
    // attempt may have completed mkdir and then failed before that namespace
    // entry became durable.
    await ensureRealDirectory(current, fileOps, true);
  }
}

async function assertManagedSourceParents(
  sourcePath: string,
  detachedPath: string,
  fileOps: SessionPurgeFileOps,
): Promise<void> {
  const managedRoot = dirname(dirname(dirname(detachedPath)));
  const parentPath = dirname(sourcePath);
  const rel = relative(managedRoot, parentPath);
  if (relativePathEscapesRoot(rel)) {
    throw new Error(`Session purge source escapes managed root: ${sourcePath}`);
  }
  let current = managedRoot;
  for (const segment of rel.split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    let info;
    try {
      info = await fileOps.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe session purge source parent: ${current}`);
    }
  }
}

async function ensureTombstoneParent(
  detachedPath: string,
  fileOps: SessionPurgeFileOps,
): Promise<void> {
  const batchDir = dirname(detachedPath);
  const purgeRoot = dirname(batchDir);
  const managedRoot = dirname(purgeRoot);
  await ensureManagedRoot(managedRoot, fileOps);
  // One-level mkdir calls plus lstat checks prevent a pre-created
  // `.piweb-purge` symlink from redirecting cleanup outside a configured root.
  await ensureRealDirectory(purgeRoot, fileOps, true);
  await ensureRealDirectory(batchDir, fileOps, true);
}

async function removeDetachedEntry(path: string, fileOps: SessionPurgeFileOps): Promise<void> {
  try {
    const info = await fileOps.lstat(path);
    await fileOps.rm(path, {
      recursive: info.isDirectory() && !info.isSymbolicLink(),
      force: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function cleanDetachedDirectory(
  detachedPath: string,
  fileOps: SessionPurgeFileOps,
): Promise<void> {
  let info;
  try {
    info = await fileOps.lstat(detachedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Unsafe session purge detached payload type: ${detachedPath}`);
  }

  const entries = (await fileOps.readdir(detachedPath)) as string[];
  const removals = await Promise.allSettled(
    entries.map((entry) => removeDetachedEntry(join(detachedPath, entry), fileOps)),
  );
  const failedRemoval = removals.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failedRemoval) throw failedRemoval.reason;
  await syncPath(detachedPath, fileOps);
  try {
    // rmdir is intentional: unlike recursive rm, a paused cleanup cannot
    // remove the regular terminal seal another runner creates at this path.
    await fileOps.rmdir(detachedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  await syncPath(dirname(detachedPath), fileOps);
}

function inodeIdentity(info: { dev: number | bigint; ino: number | bigint }): string {
  return `${String(info.dev)}:${String(info.ino)}`;
}

function terminalSealPayload(sealToken: string): string {
  return `piweb-session-purge-seal-v1:${sealToken}\n`;
}

async function validateTerminalSeal(
  detachedPath: string,
  sealToken: string,
  fileOps: SessionPurgeFileOps,
): Promise<void> {
  const expected = Buffer.from(terminalSealPayload(sealToken));
  const handle = await fileOps.open(detachedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let identity = '';
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expected.length) {
      throw new Error(`Unsafe session purge terminal seal: ${detachedPath}`);
    }
    identity = inodeIdentity(info);
    const actual = Buffer.alloc(expected.length);
    const { bytesRead } = await handle.read(actual, 0, actual.length, 0);
    if (bytesRead !== expected.length || !actual.equals(expected)) {
      throw new Error(`Unsafe session purge terminal seal: ${detachedPath}`);
    }
    await handle.sync();
    // Test-only durability seam. Production uses this already-open O_NOFOLLOW
    // handle and never opens an unverified path for writing.
    if (fileOps.syncPath) await fileOps.syncPath(detachedPath);
  } finally {
    await handle.close();
  }
  const current = await fileOps.lstat(detachedPath);
  if (current.isSymbolicLink() || !current.isFile() || inodeIdentity(current) !== identity) {
    throw new Error(`Unsafe session purge terminal seal changed identity: ${detachedPath}`);
  }
  await syncPath(dirname(detachedPath), fileOps);
}

async function ensureTerminalSeal(
  detachedPath: string,
  sealToken: string,
  fileOps: SessionPurgeFileOps,
): Promise<void> {
  let handle;
  try {
    handle = await fileOps.open(
      detachedPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await validateTerminalSeal(detachedPath, sealToken, fileOps);
    return;
  }

  let identity = '';
  try {
    await handle.writeFile(terminalSealPayload(sealToken));
    await handle.sync();
    const info = await handle.stat();
    identity = inodeIdentity(info);
    // Test-only durability seam. A failure here simulates interruption after
    // O_EXCL creation; recovery authenticates and fsyncs this same seal.
    if (fileOps.syncPath) await fileOps.syncPath(detachedPath);
  } finally {
    await handle.close();
  }
  const current = await fileOps.lstat(detachedPath);
  if (current.isSymbolicLink() || !current.isFile() || inodeIdentity(current) !== identity) {
    throw new Error(`Session purge terminal seal changed before publication: ${detachedPath}`);
  }
  await syncPath(dirname(detachedPath), fileOps);
}

/**
 * Atomically detach an owner root, clean that payload without writing through
 * any of its inodes, then replace the tombstone endpoint with an app-created
 * regular seal. Every namespace mutation is fsynced before SQLite can record
 * files_done; the terminal file makes a paused late directory rename fail.
 */
async function ensureSourceGuard(
  sourcePath: string,
  sealToken: string,
  fileOps: SessionPurgeFileOps,
): Promise<void> {
  // This namespace includes an immutable channel storage token, so no future
  // owner can legitimately reuse it. A regular guard at the old operation
  // owner root makes every suspended mkdir/write fail without blocking the new
  // generation's distinct root.
  const operationsRoot = dirname(sourcePath);
  const managedRoot = dirname(operationsRoot);
  await ensureManagedRoot(managedRoot, fileOps);
  await ensureRealDirectory(operationsRoot, fileOps, true);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let info;
    try {
      info = await fileOps.lstat(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await ensureTerminalSeal(sourcePath, sealToken, fileOps);
        return;
      } catch (sealError) {
        if ((sealError as NodeJS.ErrnoException).code === 'EEXIST') continue;
        // ensureTerminalSeal converts an EEXIST type/content mismatch to an
        // ordinary Error. Reinspect on the next iteration only when a path now
        // exists; never remove a regular file whose validation merely hit EIO.
        if (await pathExists(sourcePath, fileOps)) continue;
        throw sealError;
      }
    }
    if (info.isFile() && !info.isSymbolicLink()) {
      await validateTerminalSeal(sourcePath, sealToken, fileOps);
      return;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe stale upload guard type: ${sourcePath}`);
    }
    // Clean children and use rmdir for the endpoint. Unlike recursive rm,
    // rmdir cannot remove a regular authenticated guard published by another
    // runner after this lstat, so this transition is monotonic across processes.
    await cleanDetachedDirectory(sourcePath, fileOps);
  }
  throw new Error(`Could not establish stale upload guard: ${sourcePath}`);
}

async function detachAndCleanSource(
  path: SessionPurgePath,
  fileOps: SessionPurgeFileOps,
): Promise<void> {
  const { batchId, jid, sourcePath, tombstonePath: detachedPath, sealToken } = path;
  let expectedSourceIdentity = path.sourceIdentity;
  await ensureTombstoneParent(detachedPath, fileOps);
  await assertManagedSourceParents(sourcePath, detachedPath, fileOps);

  let detachedInfo;
  try {
    detachedInfo = await fileOps.lstat(detachedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (detachedInfo && (await pathExists(dirname(sourcePath), fileOps))) {
    // The previous process may have crashed after the cross-directory rename
    // but before persisting source-side disappearance. Recovery must repeat
    // this fsync even though only the detached endpoint is visible now.
    await syncPath(dirname(sourcePath), fileOps);
  }

  if (!detachedInfo) {
    let sourceInfo;
    try {
      sourceInfo = await fileOps.lstat(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (sourceInfo && (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory())) {
      if (expectedSourceIdentity) {
        throw new Error(`Session purge source changed after directory detach: ${sourcePath}`);
      }
      // Never detach a non-directory to the tombstone endpoint. Direct unlink
      // does not traverse a symlink or alter hard-linked inode content.
      await fileOps.rm(sourcePath, { force: true });
      await syncPath(dirname(sourcePath), fileOps);
    } else if (!sourceInfo) {
      // A prior direct unlink may have crashed during this fsync. Repeat it
      // before publishing a seal even when recovery now finds no source.
      if (await pathExists(dirname(sourcePath), fileOps)) {
        await syncPath(dirname(sourcePath), fileOps);
      }
    } else {
      const observedIdentity = inodeIdentity(sourceInfo);
      expectedSourceIdentity = recordSessionPurgeSourceIdentity(
        batchId,
        jid,
        sourcePath,
        observedIdentity,
      );
      // Revalidate immediately before detach. Recovery may recursively clean
      // only the exact inode identity durably recorded above.
      const verified = await fileOps.lstat(sourcePath);
      if (
        verified.isSymbolicLink() ||
        !verified.isDirectory() ||
        inodeIdentity(verified) !== expectedSourceIdentity
      ) {
        throw new Error(`Session purge source changed identity before detach: ${sourcePath}`);
      }
      try {
        await fileOps.rename(sourcePath, detachedPath);
      } catch (error) {
        if (!(await pathExists(detachedPath, fileOps))) throw error;
        // Another runner won the deterministic detach. Never choose a second
        // endpoint or touch a source that may now belong to a reused owner.
      }
      detachedInfo = await fileOps.lstat(detachedPath);
      // Persist both sides before cleanup. If another runner already replaced
      // the directory with an authenticated seal, validation below accepts it;
      // no runner ever unlinks a regular tombstone endpoint.
      await syncPath(dirname(sourcePath), fileOps);
      await syncPath(dirname(detachedPath), fileOps);
    }
  }

  if (detachedInfo) {
    if (detachedInfo.isSymbolicLink()) {
      throw new Error(`Unsafe session purge tombstone type: ${detachedPath}`);
    }
    if (detachedInfo.isDirectory()) {
      if (!expectedSourceIdentity || inodeIdentity(detachedInfo) !== expectedSourceIdentity) {
        throw new Error(`Unsafe session purge detached directory identity: ${detachedPath}`);
      }
      await cleanDetachedDirectory(detachedPath, fileOps);
    } else if (!detachedInfo.isFile()) {
      throw new Error(`Unsafe session purge tombstone type: ${detachedPath}`);
    }
    // Regular endpoints are never removed. Only the path-specific authenticated
    // seal created below can permit files_done and DB finalization.
  }
  await ensureTerminalSeal(detachedPath, sealToken, fileOps);

  if (path.sourceGuard) {
    await ensureSourceGuard(sourcePath, sealToken, fileOps);
  } else if (await pathExists(sourcePath, fileOps)) {
    // An existing deterministic tombstone means a normal owner path must never
    // be touched again. A remaining source is a late writer and keeps the DB
    // fence in place rather than being mistaken for successful I/O.
    throw new Error(`Session purge source was recreated after detach: ${sourcePath}`);
  }
}

async function cleanTarget(
  batchId: string,
  target: { jid: string; folder: string; storageToken: string },
  fileOps: SessionPurgeFileOps,
): Promise<void> {
  const manifest = targetSources(target.folder, target.jid, target.storageToken).map((source) => ({
    sourcePath: source.sourcePath,
    tombstonePath: tombstonePath(source.rootPath, batchId, source.sourcePath),
    sourceGuard: source.sourceGuard,
  }));
  const persisted = ensureSessionPurgeTargetPaths(batchId, target.jid, manifest);
  if (persisted.length === 0) return;
  const results = await Promise.allSettled(
    persisted.map((path) => detachAndCleanSource(path, fileOps)),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed) throw failed.reason;
}

/**
 * Finish one durable purge claim.
 *
 * Source roots are first atomically detached to sealed, batch-unique
 * tombstones. All recursive deletion then remains inside those tombstones, so
 * concurrent web/worker recovery and late syscalls cannot affect a later owner
 * that reuses the exact JID/folder. DB ownership is still removed for the whole
 * batch in one transaction only after every target is clean.
 */
export async function purgeSessionBatch(
  batchId: string,
  fileOps: SessionPurgeFileOps = defaultFileOps,
): Promise<number> {
  const batch = getSessionPurgeBatch(batchId);
  if (!batch) {
    const completed = getCompletedSessionPurgeCount(batchId);
    if (completed === undefined) {
      throw new Error(`Session purge completion receipt is missing: ${batchId}`);
    }
    return completed;
  }

  const settledTargets = await Promise.allSettled(
    batch.targets.map(async (target) => {
      if (target.filesDone) return null;
      try {
        await cleanTarget(batchId, target, fileOps);
        markSessionPurgeFilesDone(batchId, target.jid);
        return null;
      } catch (error) {
        const message = (error as Error).message;
        recordSessionPurgeFileError(batchId, target.jid, message);
        logger.warn({ err: message, jid: target.jid, batchId }, 'Session purge cleanup pending');
        return message;
      }
    }),
  );
  const targetErrors = settledTargets.map((result) =>
    result.status === 'fulfilled' ? result.value : (result.reason as Error).message,
  );

  if (targetErrors.some(Boolean)) {
    const completed = getCompletedSessionPurgeCount(batchId);
    if (completed !== undefined) return completed;
    throw new SessionPurgePendingError();
  }

  const finalized = finalizeSessionPurgeBatch(batchId);
  if (finalized.status === 'missing') {
    throw new Error(`Session purge completion receipt is missing: ${batchId}`);
  }
  return finalized.count;
}

/** Retry every crash-safe cleanup intent during web/worker startup and sweeps. */
export async function recoverPendingSessionPurges(): Promise<number> {
  let recovered = 0;
  for (const batchId of listPendingSessionPurgeBatchIds()) {
    try {
      recovered += await purgeSessionBatch(batchId);
    } catch (error) {
      logger.warn(
        { err: (error as Error).message, batchId },
        'Session purge recovery remains pending',
      );
    }
  }
  return recovered;
}
