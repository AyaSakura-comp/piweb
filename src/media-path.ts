/**
 * Shared naming for served media.
 *
 * There must be exactly ONE spelling of a media path, used for both the
 * directory on disk and the URL. The first cut used `encodeURIComponent(jid)`
 * for the directory, so a session jid `web:abc` became a directory literally
 * named `web%3Aabc` — while the server decoded the URL segment back to
 * `web:abc` and looked for a directory that never existed. Result: every
 * generated image and every upload 404'd and rendered as a broken-image icon,
 * with the file sitting right there on disk.
 *
 * Sanitising to `[A-Za-z0-9._-]` removes the asymmetry: the name is both
 * filesystem-safe and URL-safe, so encoding it is a no-op in either direction.
 */

import { createHash } from 'node:crypto';

/** Directory name for a channel's media. Safe on disk and in a URL. */
export function mediaDirName(jid: string): string {
  return jid.replace(/[^\w.-]/g, '_');
}

/** File name for a stored attachment. Same character class as mediaDirName. */
export function mediaFileName(prefix: string, originalName: string): string {
  return `${prefix}-${originalName}`.replace(/[^\w.-]/g, '_');
}

/** Browser-facing URL for a stored file. */
export function mediaUrl(jid: string, fileName: string): string {
  return `/media/${mediaDirName(jid)}/${fileName}`;
}

/**
 * Stable namespace for one standard channel generation's request uploads.
 *
 * Requests stage below a global `.operations` tree rather than below the
 * durable owner media/upload roots. A suspended request can therefore resume
 * or clean up only its random operation directory after its lease is revoked;
 * it cannot recreate or remove files belonging to a later owner of the same
 * JID/folder.
 */
export function standardUploadOwnerDirName(
  jid: string,
  folder: string,
  storageToken: string,
): string {
  if (!storageToken) throw new Error('Standard upload storage token is required');
  const digest = createHash('sha256')
    .update(jid)
    .update('\0')
    .update(folder)
    .update('\0')
    .update(storageToken)
    .digest('hex')
    .slice(0, 16);
  return `${mediaDirName(jid)}-${digest}`;
}
