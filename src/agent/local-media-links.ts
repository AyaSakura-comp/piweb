import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

/**
 * Convert markdown links to real local files into Piweb outbox markers. Agent
 * CLIs naturally return `![chart](/tmp/chart.png)`, while the shared delivery
 * path deliberately accepts only explicit `[[file: …]]` markers.
 */
const MARKDOWN_LINK_RE = /(!?)\[([^\]]*)\]\(([^()]+)\)/g;

export function convertLocalMediaLinks(text: string, baseDir = config.piCwd): string {
  if (!text) return text;

  return text.replace(MARKDOWN_LINK_RE, (whole, bang: string, label: string, target: string) => {
    let candidate = target.trim().replace(/^['"<]+|['">]+$/g, '');
    if (!candidate || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      if (!/^file:\/\//i.test(candidate)) return whole;
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        return whole;
      }
    }

    const abs = isAbsolute(candidate) ? candidate : resolve(baseDir, candidate);
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) return whole;
    } catch {
      return whole;
    }

    const caption = label.trim();
    const marker = `[[file: ${abs}]]`;
    return caption && !bang ? `${caption} ${marker}` : marker;
  });
}
