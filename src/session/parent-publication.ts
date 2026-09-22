/** Host runtime publication. A crashed publisher expires; normal exit removes only
 * its own token, never a replacement runtime's selection. No Pi imports. */
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { readChildActivity } from './subagent-activity.js';

export function publishParent(directory: string, owner: string, cwd: string) {
  const target = join(directory, '.piweb-current-parent.json');
  const runtime = randomUUID();
  let selected: { id?: string; file?: string } = {};
  let closed = false;
  let scanning = false;
  let activity: { files: string[]; expires: number } = { files: [], expires: 0 };
  const runRoot = join(
    tmpdir(),
    `pi-subagents-uid-${process.getuid?.() ?? 'unknown'}`,
    'async-subagent-runs',
  );
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
      JSON.stringify({ owner, cwd, runtime, ...selected, activity, expires: Date.now() + 5000 }) +
        '\n',
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
    if (selected.file && !scanning) {
      scanning = true;
      const file = selected.file;
      void readChildActivity(runRoot, join(directory, file))
        .then((files) => {
          if (!closed && owns() && selected.file === file)
            activity = { files, expires: Date.now() + 4000 };
        })
        .catch(() => {
          activity = { files: [], expires: 0 };
        })
        .finally(() => {
          scanning = false;
        });
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
      if (selected.file !== value.file) activity = { files: [], expires: 0 };
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
