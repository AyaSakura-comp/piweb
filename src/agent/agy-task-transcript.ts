import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Read only the disclosed conversation's bounded transcript through a verified fd. */
export function readAgyTaskTranscript(conversationId: string): any[] {
  if (!/^[a-f0-9-]{36}$/i.test(conversationId)) return [];
  const source = join(
    homedir(),
    '.gemini',
    'antigravity-cli',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  let fd: number | undefined;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (realpathSync(`/proc/self/fd/${fd}`) !== source) return [];
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) return [];
    return readFileSync(fd, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
