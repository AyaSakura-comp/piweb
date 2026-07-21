/**
 * Media handling — download Discord attachments to disk for pi @file processing.
 *
 * The gateway acts as a pure relay: download to disk, pass path to pi via @file,
 * let pi decide how to handle each file type natively.
 * Periodic cleanup removes stale media files.
 */

import { execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import { copyFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { type AttachmentMeta } from '../discord/attachments.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { resolveChannelMediaMessageDir } from './path.js';

/** A successfully downloaded file */
export interface DownloadedFile {
  filePath: string;
  originalName: string;
  size: number;
}

/** Download timeout per file (30s) */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Media TTL before cleanup (1 hour) */
const MEDIA_TTL_MS = 60 * 60 * 1000;

/**
 * Persistent archive of every received attachment. Lives under /tmp and is
 * NEVER touched by cleanupExpiredMedia (that only scans the session dirs), so
 * files received via Discord are kept here until /tmp is cleared (e.g. reboot).
 */
const ARCHIVE_DIR = '/tmp/pi-discord-files';

/**
 * Download all attachments to a per-message directory under the channel session.
 * Returns the list of successfully downloaded files.
 */
export async function downloadAttachments(
  attachments: AttachmentMeta[],
  channelFolder: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<DownloadedFile[]> {
  if (attachments.length === 0) return [];

  const mediaDir = resolveChannelMediaMessageDir(channelFolder, messageId);
  mkdirSync(mediaDir, { recursive: true });

  const results: DownloadedFile[] = [];

  for (const [index, att] of attachments.entries()) {
    const safeName = sanitizeFilename(att.name || 'file');
    const fileName = index > 0 ? `${index}_${safeName}` : safeName;
    const filePath = join(mediaDir, fileName);

    try {
      // piweb uploads are already on local disk (the web server staged them),
      // so there is nothing to fetch — copy them into the per-message media dir
      // instead. Everything downstream (PNG transcode, voice ASR, @file args)
      // then treats them exactly like a Discord attachment.
      if (att.filePath) {
        await copyFile(att.filePath, filePath);
      } else {
        await streamAttachmentToFile(att, filePath, signal);
      }

      // llama.cpp's image decoder (stb_image) only handles JPG/PNG/BMP/GIF, so
      // Discord-delivered WEBP/HEIC/AVIF images fail to decode on local vision
      // models. Transcode those to PNG so any image format works downstream.
      const finalPath = await maybeConvertImageToPng(filePath);
      const fileStats = await stat(finalPath);

      // Keep a permanent copy of every received file under /tmp (not cleaned up).
      await archiveToTmp(finalPath, messageId);

      results.push({ filePath: finalPath, originalName: att.name || 'file', size: fileStats.size });
      logger.debug(
        { name: att.name, size: fileStats.size, path: finalPath },
        'Attachment downloaded',
      );
    } catch (err: any) {
      await rm(filePath, { force: true }).catch(() => undefined);
      logger.warn({ name: att.name, err: err.message }, 'Attachment download error');
    }
  }

  return results;
}

/**
 * Copy a downloaded file into the persistent /tmp archive. Best-effort: any
 * failure is logged and ignored so it never disrupts the message flow. Files
 * are grouped per day, prefixed with the message id to avoid name collisions.
 */
async function archiveToTmp(srcPath: string, messageId: string): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dir = join(ARCHIVE_DIR, day);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${messageId}_${basename(srcPath)}`);
    await copyFile(srcPath, dest);
    logger.info({ dest }, 'Archived received attachment to /tmp');
  } catch (err: any) {
    logger.warn({ src: srcPath, err: err.message }, 'Failed to archive attachment to /tmp');
  }
}

const execFileAsync = promisify(execFile);

/** Image formats stb_image (llama.cpp vision) cannot decode; transcode these to PNG. */
const NEEDS_PNG_CONVERSION = new Set(['webp', 'heic', 'heif', 'avif', 'tiff', 'tif', 'jxl']);

/**
 * If `filePath` is an image in a format local vision models can't decode
 * (WEBP/HEIC/AVIF/...), transcode it to PNG via ImageMagick and return the new
 * path. On any failure (or unsupported/non-image type) the original path is
 * returned unchanged so this is a no-op for already-supported formats.
 */
async function maybeConvertImageToPng(filePath: string): Promise<string> {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (!NEEDS_PNG_CONVERSION.has(ext)) return filePath;

  const pngPath = `${filePath.slice(0, -(ext.length + 1))}.png`;
  try {
    // `[0]` flattens multi-frame/animated sources to the first frame.
    await execFileAsync('magick', [`${filePath}[0]`, pngPath]);
    await rm(filePath, { force: true }).catch(() => undefined);
    logger.info({ from: filePath, to: pngPath }, 'Transcoded image to PNG for vision');
    return pngPath;
  } catch (err: any) {
    logger.warn({ path: filePath, err: err.message }, 'Image PNG transcode failed; passing original');
    return filePath;
  }
}

/** Make filenames safe for the filesystem */
function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return sanitized || 'file';
}

async function streamAttachmentToFile(
  attachment: AttachmentMeta,
  filePath: string,
  parentSignal?: AbortSignal,
): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(attachment.url, { signal });

  if (!res.ok) {
    throw new Error(`Attachment download failed with status ${res.status}`);
  }

  if (!res.body) {
    throw new Error('Attachment download returned an empty body');
  }

  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(filePath), { signal });
}

/** Start the periodic media cleanup timer */
export function startMediaCleanup(): () => void {
  // Run every 30 minutes
  const timer = setInterval(
    () => {
      try {
        cleanupExpiredMedia();
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Media cleanup error');
      }
    },
    30 * 60 * 1000,
  );

  return () => clearInterval(timer);
}

/** Remove media directories older than MEDIA_TTL_MS */
function cleanupExpiredMedia(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const mediaRoot of findMediaRoots(config.sessionsDir)) {
    try {
      const msgDirs = readdirSync(mediaRoot, { withFileTypes: true });
      for (const msgDir of msgDirs) {
        if (!msgDir.isDirectory() || !msgDir.name.startsWith('msg-')) continue;

        const dirPath = join(mediaRoot, msgDir.name);
        try {
          const st = statSync(dirPath);
          if (now - st.mtimeMs > MEDIA_TTL_MS) {
            rmSync(dirPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch {
          // Skip entries that disappear mid-scan.
        }
      }
    } catch {
      // Media root vanished mid-scan.
    }
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up expired media directories');
  }
}

function findMediaRoots(dirPath: string): string[] {
  let entries: Dirent[];

  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const mediaRoots: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const entryPath = join(dirPath, entry.name);
    if (entry.name === 'media') {
      mediaRoots.push(entryPath);
      continue;
    }

    mediaRoots.push(...findMediaRoots(entryPath));
  }

  return mediaRoots;
}
