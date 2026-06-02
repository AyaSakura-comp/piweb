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
const MARKER_RE = /\[\[(?:image|video|file)\s*:\s*([^\]]+?)\s*\]\]/gi;

export interface OutboxResult {
  text: string;
  files: string[];
}

export function parseOutboxMarkers(raw: string, baseDir: string = homedir()): OutboxResult {
  const files: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(raw)) !== null) {
    // strip surrounding quotes or markdown angle brackets the model might add
    const p = m[1].trim().replace(/^['"<]+|['">]+$/g, '');
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

  return { text, files };
}
