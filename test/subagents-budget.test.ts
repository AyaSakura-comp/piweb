import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const stats = vi.hoisted(() => ({ bytes: 0, opens: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      stats.opens++;
      const file = await fs.open(...args);
      const read = file.read.bind(file);
      file.read = ((...args: any[]) => {
        stats.bytes += args[2] || 0;
        return (read as any)(...args);
      }) as any;
      return file;
    },
  };
});
import { readSubagents } from '../src/session/subagents.js';
const line = (v: any) => JSON.stringify(v) + '\n';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'piweb-budget-'));
  writeFileSync(join(root, 'p.jsonl'), line({ type: 'session', id: 'p' }));
  mkdirSync(join(root, 'p', 'child'), { recursive: true });
  const file = join(root, 'p', 'child', 'session.jsonl');
  writeFileSync(file, line({ type: 'session', id: 'child' }));
  return { root, file };
}
it('caches selected history across reconnect pages and parses only appended bytes', async () => {
  const { root, file } = fixture();
  try {
    appendFileSync(
      file,
      Array.from({ length: 1000 }, (_, i) =>
        line({
          type: 'message',
          id: 'm' + i,
          message: { role: 'user', content: 'x'.repeat(2000) },
        }),
      ).join(''),
    );
    const list = await readSubagents(root, 'owner');
    const query = { scope: list.scope, child: list.children[0].id };
    await readSubagents(root, 'owner', query);
    stats.bytes = stats.opens = 0;
    for (let i = 0; i < 4; i++)
      await readSubagents(root, 'owner', { ...query, after: 'm' + i * 200 + ':0' });
    expect(stats.bytes).toBeLessThan(200000);
    expect(stats.opens).toBeLessThan(80);
    stats.bytes = 0;
    appendFileSync(
      file,
      line({ type: 'message', id: 'new', message: { role: 'user', content: 'incremental' } }),
    );
    const next = await readSubagents(root, 'owner', { ...query, after: 'm999:0' });
    expect(next.events?.map((e) => e.content)).toEqual(['incremental']);
    expect(stats.bytes).toBeLessThan(100000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('rejects excessive aggregate inventory bytes before reading all individually valid siblings', async () => {
  const { root } = fixture();
  try {
    for (let i = 0; i < 60; i++) {
      const dir = join(root, 'p', 'child' + i);
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'session.jsonl'),
        line({ type: 'session', id: String(i) }) +
          line({ type: 'message', id: 'm', message: { role: 'user', content: 'x'.repeat(30000) } }),
      );
    }
    stats.bytes = 0;
    await expect(readSubagents(root, 'owner')).rejects.toMatchObject({ status: 413 });
    expect(stats.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('bounds parsing work as well as bytes for a dense selected history', async () => {
  const { root, file } = fixture();
  try {
    appendFileSync(
      file,
      Array.from({ length: 20001 }, (_, i) =>
        line({ type: 'message', id: String(i), message: { role: 'user', content: 'x' } }),
      ).join(''),
    );
    const list = await readSubagents(root, 'owner');
    await expect(
      readSubagents(root, 'owner', { scope: list.scope, child: list.children[0].id }),
    ).rejects.toMatchObject({ status: 413 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('admits at most two concurrent inspections with no unbounded waiting queue', async () => {
  const { root } = fixture();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => readSubagents(root, 'owner')),
    );
    expect(results.filter((r) => r.status === 'rejected' && r.reason.status === 429)).toHaveLength(
      6,
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
