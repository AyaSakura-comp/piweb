// Host-only projection of documented async status files. Never expose global
// run paths to the web tier, and never infer liveness from transcript age.
import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { resolve, relative, sep, join } from 'node:path';
export async function readChildActivity(root: string, parentFile: string): Promise<string[]> {
  const ownedRoot = parentFile.replace(/\.jsonl$/, '');
  const result = new Set<string>();
  let visited = 0,
    bytes = 0;
  // The package's active index excludes retained terminal runs. Never let
  // historical/unrelated archives consume the live-discovery budget first.
  const index = await open(
    join(root, '.active-runs'),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  try {
    const directory = await opendir(index ? `/proc/self/fd/${index.fd}` : root).catch(
      () => undefined,
    );
    if (!directory) return [];
    for await (const entry of directory) {
      if (++visited > 256) break;
      if ((index ? !entry.isFile() : !entry.isDirectory()) || entry.name.startsWith('.')) continue;
      let file;
      try {
        // Open relative to a no-follow directory descriptor to reject symlink swaps.
        const dir = await open(
          join(root, entry.name),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          file = await open(
            `/proc/self/fd/${dir.fd}/status.json`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } finally {
          await dir.close();
        }
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) continue;
        bytes += stat.size;
        if (bytes > 2 * 1024 * 1024) break;
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await file.read(buffer, 0, stat.size, 0);
        const s = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        if (
          s.sessionId !== parentFile ||
          s.state !== 'running' ||
          !Number.isInteger(s.pid) ||
          s.pid <= 0
        )
          continue;
        try {
          process.kill(s.pid, 0);
        } catch {
          continue;
        }
        for (const step of Array.isArray(s.steps) ? s.steps : []) {
          if (step.status !== 'running' || typeof step.sessionFile !== 'string') continue;
          const rel = relative(resolve(ownedRoot), resolve(step.sessionFile));
          if (
            !rel ||
            rel.startsWith('..' + sep) ||
            rel === '..' ||
            rel.startsWith(sep) ||
            !rel.endsWith('.jsonl')
          )
            continue;
          if (JSON.stringify([...result, rel]).length > 8000) continue;
          result.add(rel);
          if (result.size >= 128) return [...result];
        }
      } catch {
        /* Unknown/corrupt state is never shown as running. */
      } finally {
        await file?.close();
      }
    }
    return [...result];
  } finally {
    await index?.close();
  }
}
