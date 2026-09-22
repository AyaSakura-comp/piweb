import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readChildActivity } from '../src/session/subagent-activity.js';
it('publishes only owned running native children with live runner proof', async () => {
  const root = mkdtempSync(join(tmpdir(), 'child-activity-'));
  const parent = '/sessions/p.jsonl';
  try {
    const put = (id: string, state: string, pid: number, owner = parent) => {
      mkdirSync(join(root, id));
      writeFileSync(
        join(root, id, 'status.json'),
        JSON.stringify({
          sessionId: owner,
          pid,
          state,
          steps: [
            { status: 'running', sessionFile: '/sessions/p/run/run-0/session.jsonl' },
            { status: 'completed', sessionFile: '/sessions/p/old/run-0/session.jsonl' },
            { status: 'running', sessionFile: '/elsewhere/session.jsonl' },
          ],
        }),
      );
    };
    put('run1', 'running', process.pid);
    put('run2', 'running', 2147483647);
    put('run3', 'stopped', process.pid);
    put('run4', 'running', process.pid, '/sessions/other.jsonl');
    expect(await readChildActivity(root, parent)).toEqual(['run/run-0/session.jsonl']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
