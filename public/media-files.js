/**
 * DOM helpers for transcript media attachments.
 *
 * Kept outside app.js so the player/download behavior is testable without
 * booting the whole application shell.
 */

/** Recover a friendly original name from piweb's `<uuid>-<name>` media path. */
export function downloadNameFromMediaUrl(url) {
  let path;
  try {
    path = new URL(String(url), 'https://piweb.local').pathname;
  } catch {
    path = String(url).split(/[?#]/, 1)[0];
  }

  const encoded = path.slice(path.lastIndexOf('/') + 1);
  let name;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    name = encoded;
  }

  // Stored outputs and uploads receive an eight-character random prefix.
  return name.replace(/^[0-9a-f]{8}-/i, '') || 'video';
}

/** Build a native inline player with an explicit, mobile-friendly download. */
export function createVideoAttachment(url, doc = document) {
  const name = downloadNameFromMediaUrl(url);
  const card = doc.createElement('div');
  card.className = 'video-file';

  const video = doc.createElement('video');
  video.src = url;
  video.controls = true;
  video.playsInline = true;

  const download = doc.createElement('a');
  download.className = 'video-download';
  download.href = url;
  download.download = name;
  download.textContent = '↓ Download video';
  download.setAttribute('aria-label', `Download video ${name}`);

  card.append(video, download);
  return card;
}
