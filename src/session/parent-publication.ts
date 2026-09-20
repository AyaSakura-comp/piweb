/** Host runtime publication. A crashed publisher expires; normal exit removes only
 * its own token, never a replacement runtime's selection. No Pi imports. */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function publishParent(directory: string, owner: string, cwd: string) {
  const target = join(directory, '.piweb-current-parent.json');
  const runtime = randomUUID();
  let selected: { id?: string; file?: string } = {};
  let closed = false;
  const owns = () => {
    try {
      return JSON.parse(readFileSync(target, 'utf8')).runtime === runtime;
    } catch {
      return false;
    }
  };
  const write = () => {
    const temporary = target + '.' + runtime;
    writeFileSync(
      temporary,
      JSON.stringify({ owner, cwd, runtime, ...selected, expires: Date.now() + 5000 }) + '\n',
      { mode: 0o600 },
    );
    renameSync(temporary, target);
  };
  write();
  const timer = setInterval(() => {
    if (!owns()) {
      clearInterval(timer);
      closed = true;
      return;
    }
    try {
      write();
    } catch {
      clearInterval(timer);
      closed = true;
    }
  }, 1000);
  timer.unref();
  return {
    select(value: { id: string; file?: string }) {
      if (closed || !owns()) return;
      selected = value;
      write();
    },
    close() {
      clearInterval(timer);
      if (!closed && owns()) unlinkSync(target);
      closed = true;
    },
  };
}
