// Outbox markers ([[image: …]]) in a reply that may still be streaming.
//
// Mid-stream a marker still names the agent's local file; the worker publishes
// it and rewrites the marker to a /media URL only in the final reply. The
// renderer therefore sees each marker as a fixed-length token, [[media:N]],
// with the URL kept in a side table (null until published):
//
// - a streamed local marker never prints its path, yet the text after it keeps
//   streaming instead of waiting for the reply to finish;
// - the streamed and final sources are character-identical, so publishing the
//   image changes no block offsets and the already-read text is neither
//   remounted nor faded in again.

const MARKER = /\[\[(image|video|file)\s*:\s*([^\]]+?)\s*\]\]/gi;
const TOKEN = /\[\[media:\d+\]\]/g;
// An unfinished marker (or the start of one) at the very end of the stream.
const OPEN_TAIL =
  /\[\[(?:(?:image|video|file)\s*(?::[^\]]*\]?)?|i(?:m(?:a(?:g)?)?)?|v(?:i(?:d(?:e)?)?)?|f(?:i(?:l)?)?)?$/i;
const published = (target) => /^(?:\/media\/|https?:\/\/)/i.test(target);

/** `{ source, media }`: markers replaced by tokens indexing `media`. */
export function tokenizeOutbox(text, complete) {
  let source = text;
  if (!complete) {
    const tail = OPEN_TAIL.exec(source);
    if (tail) source = source.slice(0, tail.index);
  }
  const media = [];
  source = source.replace(MARKER, (marker, kind, target) => {
    const url = target.trim();
    // `raw` puts the marker back where Markdown keeps text literal (code).
    media.push({ kind: kind.toLowerCase(), url: published(url) ? url : null, raw: marker });
    return `[[media:${media.length - 1}]]`;
  });
  return { source, media };
}

/**
 * A finished reply's published markers as tokens, before Markdown parses it.
 * Left in the text, a marker is at the mercy of emphasis: a file named
 * `2e1b52f3-light-__.png` paired with the next marker's `__` became bold that
 * split both markers, and the images showed as literal text (2026-11-01).
 * Unpublished ones (the file was missing) stay visible text, as they were.
 */
export function tokenizePublishedOutbox(text) {
  const media = [];
  const source = text.replace(MARKER, (marker, kind, target) => {
    const url = target.trim();
    if (!published(url)) return marker;
    media.push({ kind: kind.toLowerCase(), url, raw: marker });
    return `[[media:${media.length - 1}]]`;
  });
  return { source, media };
}

const comparable = (source) => source.replace(OPEN_TAIL, '').replace(MARKER, '').replace(TOKEN, '');

/**
 * Whether `next` continues `previous` once outbox markers are ignored, so a
 * final reply that publishes (or drops) a marker is not treated as a rewrite.
 */
export function continuesSource(next, previous) {
  return comparable(next).startsWith(comparable(previous).trimEnd());
}
