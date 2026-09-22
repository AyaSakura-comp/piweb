import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { readSubagents } from '../src/session/subagents.js';
it('orders confirmed running first then update time, clearing stale activity despite inventory cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subagent-sort-'));
  const parent = 'parent.jsonl';
  const owner = 'owner';
  try {
    writeFileSync(
      join(root, parent),
      JSON.stringify({ type: 'session', id: 'parent', cwd: root }) + '\n',
    );
    for (const [name, time] of [
      ['old', 1000],
      ['active', 2000],
      ['recent', 3000],
    ] as const) {
      const dir = join(root, 'parent', name);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'session.jsonl');
      writeFileSync(
        path,
        [
          { type: 'session', id: name },
          { type: 'session_info', name },
          {
            type: 'message',
            message: {
              role: 'assistant',
              stopReason: 'stop',
              content: [{ type: 'text', text: 'done' }],
            },
          },
        ]
          .map((x) => JSON.stringify(x))
          .join('\n') + '\n',
      );
      utimesSync(path, time, time);
    }
    const publish = (expires: number) =>
      writeFileSync(
        join(root, '.piweb-current-parent.json'),
        JSON.stringify({
          owner,
          cwd: root,
          runtime: 'r',
          file: parent,
          id: 'parent',
          expires: Date.now() + 5000,
          activity: { expires, files: ['active/session.jsonl'] },
        }) + '\n',
      );
    publish(Date.now() + 3000);
    let result = await readSubagents(root, owner);
    expect(result.children.map((x) => x.name)).toEqual(['active', 'recent', 'old']);
    expect(result.children[0].running).toBe(true);
    publish(0);
    result = await readSubagents(root, owner);
    expect(result.children.map((x) => x.name)).toEqual(['recent', 'active', 'old']);
    expect(result.children.every((x) => !x.running)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
