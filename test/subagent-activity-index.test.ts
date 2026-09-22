import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { readChildActivity } from '../src/session/subagent-activity.js';
it('active index avoids starvation by more than 256 retained terminal runs and 2MiB history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'activity-index-'));
  try {
    for (let i = 0; i < 300; i++) {
      const d = join(root, 'old-' + i);
      mkdirSync(d);
      writeFileSync(
        join(d, 'status.json'),
        JSON.stringify({ state: 'complete', padding: 'x'.repeat(10000) }),
      );
    }
    mkdirSync(join(root, 'live'));
    writeFileSync(
      join(root, 'live', 'status.json'),
      JSON.stringify({
        state: 'running',
        pid: process.pid,
        sessionId: '/s/p.jsonl',
        steps: [{ status: 'running', sessionFile: '/s/p/run/session.jsonl' }],
      }),
    );
    mkdirSync(join(root, '.active-runs'));
    writeFileSync(join(root, '.active-runs', 'live'), '');
    expect(await readChildActivity(root, '/s/p.jsonl')).toEqual(['run/session.jsonl']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
