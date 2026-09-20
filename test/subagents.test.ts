import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  utimesSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSubagents } from '../src/session/subagents.js';
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'piweb-children-'));
  roots.push(root);
  writeFileSync(
    join(root, 'parent.jsonl'),
    JSON.stringify({ type: 'session', id: 'parent-id' }) + '\n',
  );
  return root;
}
const jsonl = (values: any[]) => values.map((e) => JSON.stringify(e)).join('\n') + '\n';
function child(root: string, name: string, done = true) {
  const dir = join(root, 'parent', name, 'run-0');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session', id: name },
      { type: 'session_info', name: 'Luna ' + name },
      { type: 'model_change', provider: 'openai-codex', modelId: 'gpt-5.6-luna' },
      { type: 'message', id: 'u', message: { role: 'user', content: 'Inspect **this**' } },
      {
        type: 'message',
        id: 'a',
        message: {
          role: 'assistant',
          stopReason: done ? 'stop' : 'toolUse',
          content: [
            { type: 'text', text: '## Result' },
            { type: 'toolCall', name: 'read', arguments: { path: 'fixture.txt' } },
          ],
        },
      },
      ...(!done
        ? [
            {
              type: 'message',
              id: 't',
              message: {
                role: 'toolResult',
                toolName: 'read',
                content: [{ type: 'text', text: '<script>unsafe</script>' }],
              },
            },
          ]
        : []),
    ]),
  );
  return file;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('current-parent artifact projection', () => {
  it('filters cold selection by the effective cwd and ignores retired legacy markers', async () => {
    const root = fixture();
    child(root, 'one');
    writeFileSync(
      join(root, 'parent.jsonl'),
      jsonl([{ type: 'session', id: 'parent-id', cwd: '/expected' }]),
    );
    writeFileSync(
      join(root, 'zzz.jsonl'),
      jsonl([{ type: 'session', id: 'other', cwd: '/different' }]),
    );
    utimesSync(join(root, 'zzz.jsonl'), new Date(), new Date(Date.now() + 1000));
    expect((await readSubagents(root, 'owner', { cwd: '/expected' })).children).toHaveLength(1);
    writeFileSync(
      join(root, '.piweb-current-parent.json'),
      jsonl([{ owner: 'owner', file: 'zzz.jsonl', id: 'other' }]),
    );
    expect((await readSubagents(root, 'owner', { cwd: '/expected' })).children).toHaveLength(1);
  });
  it('matches Pi cold discovery normalization, header parsing and equal-mtime ordering', async () => {
    const root = fixture();
    child(root, 'one');
    writeFileSync(
      join(root, 'parent.jsonl'),
      '\ninvalid\n' + JSON.stringify({ type: 'session', id: 'parent-id', cwd: '/expected/.' }),
    );
    writeFileSync(
      join(root, 'zzz.jsonl'),
      jsonl([{ type: 'session', id: 'other', cwd: '/expected' }]),
    );
    const same = new Date(10000);
    utimesSync(join(root, 'parent.jsonl'), same, same);
    utimesSync(join(root, 'zzz.jsonl'), same, same);
    expect((await readSubagents(root, 'owner', { cwd: '/expected' })).children).toHaveLength(1);
  });
  it('publishes actual runtime selection, replaces it and retires only its own marker', async () => {
    const { publishParent } = await import('../src/session/parent-publication.js');
    const root = fixture();
    child(root, 'one');
    writeFileSync(
      join(root, 'zzz.jsonl'),
      jsonl([{ type: 'session', id: 'other', cwd: '/expected' }]),
    );
    const runtime = publishParent(root, 'owner', '/expected');
    try {
      // Pending runtime selection must not advertise an older cold parent.
      expect((await readSubagents(root, 'owner', { cwd: '/expected' })).children).toHaveLength(0);
      runtime.select({ id: 'parent-id', file: 'parent.jsonl' });
      expect((await readSubagents(root, 'owner', { cwd: '/expected' })).children).toHaveLength(1);
      // Print mode reports a header ID, not a file; resolve only that ID.
      runtime.select({ id: 'other' });
      expect((await readSubagents(root, 'owner', { cwd: '/expected' })).children).toHaveLength(0);
      const replacement = publishParent(root, 'owner', '/expected');
      replacement.select({ id: 'parent-id', file: 'parent.jsonl' });
      runtime.close();
      expect((await readSubagents(root, 'owner', { cwd: '/expected' })).children).toHaveLength(1);
      replacement.close();
      expect((await readSubagents(root, 'owner', { cwd: '/expected' })).children).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
  it('discovers default fork children and presents only active branch ancestry', async () => {
    const root = fixture();
    mkdirSync(join(root, 'parent', 'forks'), { recursive: true });
    writeFileSync(
      join(root, 'parent', 'forks', '2026_child.jsonl'),
      jsonl([
        { type: 'session', id: 'fork-id', parentSession: join(root, 'parent.jsonl') },
        {
          type: 'message',
          id: 'u',
          parentId: null,
          message: { role: 'user', content: 'inherited task' },
        },
        {
          type: 'message',
          id: 'old',
          parentId: 'u',
          message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] },
        },
        {
          type: 'message',
          id: 'new',
          parentId: 'u',
          message: { role: 'assistant', content: [{ type: 'text', text: 'current' }] },
        },
      ]),
    );
    const list = await readSubagents(root, 'owner');
    expect(list.children).toHaveLength(1);
    const detail = await readSubagents(root, 'owner', {
      scope: list.scope,
      child: list.children[0].id,
    });
    expect(detail.events?.some((e) => e.content === 'abandoned')).toBe(false);
    expect(detail.events?.some((e) => e.content === 'current')).toBe(true);
    expect(list.children[0].task).toBe('');
  });
  it('uses live parent identity rather than lexical filename and most-recent fallback', async () => {
    const root = fixture();
    child(root, 'one');
    writeFileSync(join(root, 'zzz.jsonl'), jsonl([{ type: 'session', id: 'other' }]));
    utimesSync(join(root, 'parent.jsonl'), new Date(), new Date(Date.now() + 1000));
    expect((await readSubagents(root, 'owner')).children).toHaveLength(1);
    writeFileSync(
      join(root, '.piweb-current-parent.json'),
      jsonl([
        {
          owner: 'owner',
          file: 'zzz.jsonl',
          id: 'other',
          expires: Date.now() + 5000,
          runtime: 'test',
        },
      ]),
    );
    expect((await readSubagents(root, 'owner')).children).toHaveLength(0);
  });
  it('lists ALL native children beyond fleet caps with honest response-state labels', async () => {
    const root = fixture();
    for (let i = 0; i < 25; i++) child(root, 'child-' + i, i !== 24);
    const result = await readSubagents(root, 'owner-token');
    expect(result.children).toHaveLength(25);
    expect(result.children.filter((c) => c.state === 'Response complete')).toHaveLength(24);
    expect(result.children[0].task).toBe('Inspect **this**');
  });
  it('projects production message/tool events without interpreting HTML', async () => {
    const root = fixture();
    child(root, 'one', false);
    const list = await readSubagents(root, 'owner-token');
    const detail = await readSubagents(root, 'owner-token', {
      scope: list.scope,
      child: list.children[0].id,
    });
    expect(detail.events?.map((e) => e.kind)).toEqual([
      'message',
      'message',
      'tool',
      'tool_result',
    ]);
    expect(detail.events?.at(-1)?.content).toBe('<script>unsafe</script>');
  });
  it('rejects cross-owner IDs, path input and previous-parent scopes', async () => {
    const root = fixture();
    child(root, 'one');
    const list = await readSubagents(root, 'owner-token');
    await expect(
      readSubagents(root, 'other-owner', { scope: list.scope, child: list.children[0].id }),
    ).rejects.toThrow('changed');
    await expect(
      readSubagents(root, 'owner-token', { scope: list.scope, child: '../secret' }),
    ).rejects.toThrow('not found');
    writeFileSync(join(root, 'zzz-new.jsonl'), jsonl([{ type: 'session', id: 'replacement' }]));
    utimesSync(join(root, 'zzz-new.jsonl'), new Date(), new Date(Date.now() + 1000));
    await expect(readSubagents(root, 'owner-token', { scope: list.scope })).rejects.toThrow(
      'changed',
    );
    expect((await readSubagents(root, 'owner-token')).children).toEqual([]);
  });
  it('never follows symlink directories/files or hard-linked transcripts', async () => {
    const root = fixture(),
      foreign = fixture(),
      file = child(foreign, 'secret');
    mkdirSync(join(root, 'parent'));
    symlinkSync(join(foreign, 'parent', 'secret'), join(root, 'parent', 'linked'));
    mkdirSync(join(root, 'parent', 'files'));
    symlinkSync(file, join(root, 'parent', 'files', 'session.jsonl'));
    mkdirSync(join(root, 'parent', 'hard'));
    linkSync(file, join(root, 'parent', 'hard', 'session.jsonl'));
    expect((await readSubagents(root, 'owner-token')).children).toEqual([]);
  });
  it('ignores incomplete trailing writes and isolates corrupt siblings', async () => {
    const root = fixture(),
      file = child(root, 'one');
    writeFileSync(file, '{"type":"session","id":"one"}\n{"type":');
    expect((await readSubagents(root, 'owner-token')).children).toHaveLength(1);
    writeFileSync(file, 'broken\n');
    child(root, 'two');
    // Inventory metadata is intentionally reused for one polling interval.
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const list = await readSubagents(root, 'owner-token');
    expect(list.children).toHaveLength(2);
    expect(list.children.some((c) => c.state === 'Unreadable artifact')).toBe(true);
  });
  it('catches up every event after a mobile suspension exceeding a page', async () => {
    const root = fixture(),
      file = child(root, 'one');
    const list = await readSubagents(root, 'owner');
    const query = { scope: list.scope, child: list.children[0].id };
    const first = await readSubagents(root, 'owner', query);
    appendFileSync(
      file,
      jsonl(
        Array.from({ length: 450 }, (_, i) => ({
          type: 'message',
          id: 'extra' + i,
          message: { role: 'user', content: 'row' + i },
        })),
      ),
    );
    const second = await readSubagents(root, 'owner', {
      ...query,
      after: first.events!.at(-1)!.id,
    });
    expect(second.events?.[0].content).toBe('row0');
    expect(second.events).toHaveLength(200);
    expect(second.hasMoreNewer).toBe(true);
    const third = await readSubagents(root, 'owner', {
      ...query,
      after: second.events!.at(-1)!.id,
    });
    expect(third.events?.[0].content).toBe('row200');
  });
  it('reads only the large parent header rather than parsing all parent history', async () => {
    const root = fixture();
    child(root, 'one');
    appendFileSync(join(root, 'parent.jsonl'), ' '.repeat(17 * 1024 * 1024));
    expect((await readSubagents(root, 'owner')).children).toHaveLength(1);
  });
});
