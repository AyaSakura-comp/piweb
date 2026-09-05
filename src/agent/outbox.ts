import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Method C "outbox" convention: the pi agent signals files to attach by emitting
 * a marker in its reply, e.g.
 *
 *   [[image: /home/chihmin/.pi-outbox/chart.png]]
 *   [[file: out/report.pdf]]
 *
 * Markers may appear on their own line or inline within prose — models
 * frequently chain multiple markers on one line ("Here are the screenshots:
 * [[image: a.png]] [[image: b.png]]"), so this regex is not line-anchored.
 * parseOutboxMarkers extracts the referenced files (that actually exist) and
 * returns the reply text with the markers removed.
 */
const MARKER_RE = /\[\[(image|video|file)\s*:\s*([^\]]+?)\s*\]\]/gi;

export interface OutboxResult {
  text: string;
  files: string[];
  rawText: string;
}

export function parseOutboxMarkers(raw: string, baseDir: string = homedir()): OutboxResult {
  const files: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(raw)) !== null) {
    // strip surrounding quotes or markdown angle brackets the model might add
    const p = m[2].trim().replace(/^['"<]+|['">]+$/g, '');
    if (!p) continue;
    const abs = isAbsolute(p) ? p : resolve(baseDir, p);
    if (seen.has(abs)) continue;
    try {
      if (existsSync(abs) && statSync(abs).isFile()) {
        files.push(abs);
        seen.add(abs);
      }
    } catch {
      /* ignore unreadable paths */
    }
  }

  const text = raw
    .replace(MARKER_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, files, rawText: raw };
}

/**
 * Replace local outbox markers with their published URLs so the web client
 * renders media inline at the exact positions chosen by the model.
 * Markers whose files were not published (or do not exist) are stripped.
 */
export function embedOutboxMediaUrls(
  text: string,
  published: Map<string, string>,
  baseDir: string = homedir(),
): string {
  if (!text) return '';
  MARKER_RE.lastIndex = 0;
  return text
    .replace(MARKER_RE, (_match, kind: string, p: string) => {
      const clean = p.trim().replace(/^['"<]+|['">]+$/g, '');
      if (!clean) return '';
      if (clean.startsWith('/media/') || /^https?:\/\//i.test(clean)) {
        return `[[${kind.toLowerCase()}: ${clean}]]`;
      }
      const abs = isAbsolute(clean) ? clean : resolve(baseDir, clean);
      const url = published.get(abs);
      if (url) {
        return `[[${kind.toLowerCase()}: ${url}]]`;
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
