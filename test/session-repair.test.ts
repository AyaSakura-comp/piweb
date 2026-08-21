import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * repairSessionForContinue makes a session left non-continuable by a run
 * interrupted mid-tool-loop safe for the next `pi --continue`, WITHOUT
 * discarding history.
 *
 * Only a trailing assistant message with an unanswered toolCall actually breaks
 * pi ("Cannot continue from message role: assistant"); a session ending on a
 * toolResult continues fine. So the fix closes the open call with a synthetic
 * toolResult instead of truncating. The old truncating version threw away whole
 * tool loops — one real session lost 98 of 150 events and 45 of 66 thinking
 * blocks to a single interrupt.
 */

const dirs: string[] = [];

function session(folder: string, lines: object[]): string {
  const root = mkdtempSync(join(tmpdir(), 'piweb-repair-'));
  dirs.push(root);
  process.env.SESSIONS_DIR = root;
  // config reads SESSIONS_DIR at module load and caches it; reset so the next
  // import of path.js (and its config) sees this test's dir.
  vi.resetModules();
  const sessionDir = join(root, folder);
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, '2026-01-01T00-00-00-000Z_s.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const user = (text: string) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
const reply = (text: string) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } });
// pi's real shape: {type:'toolCall', id, name, arguments}
const toolCall = (id: string, thinking = 'x') => ({
  type: 'message',
  id: `a-${id}`,
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking },
      { type: 'toolCall', id, name: 'bash', arguments: {} },
    ],
  },
});
const toolResult = (id: string) => ({
  type: 'message',
  message: { role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text: 'out' }] },
});

function events(file: string): any[] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function lastMessageRole(file: string): string | undefined {
  const msgs = events(file).filter((e) => e.type === 'message');
  return msgs.length ? msgs[msgs.length - 1].message.role : undefined;
}

async function repair(folder: string): Promise<boolean> {
  // Import fresh each time so the module reads the current SESSIONS_DIR.
  const { repairSessionForContinue } = await import('../src/session/path.js');
  return repairSessionForContinue(folder);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('repairSessionForContinue', () => {
  it('leaves a session interrupted after a toolResult completely untouched', async () => {
    const file = session('web_a', [
      { type: 'session', id: 's' },
      user('hi'),
      reply('done'),
      user('do a thing'),
      toolCall('c1', 'deep thought'),
      toolResult('c1'), // interrupted here — no closing assistant reply
    ]);
    const before = readFileSync(file, 'utf8');

    expect(await repair('web_a')).toBe(false);

    // pi continues from a toolResult tail, so nothing may be dropped: the user
    // turn, the thinking block and the tool result all survive.
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(file, 'utf8')).toContain('do a thing');
    expect(readFileSync(file, 'utf8')).toContain('deep thought');
    expect(existsSync(`${file}.prerepair.bak`)).toBe(false);
  });

  it('leaves an already-complete session untouched', async () => {
    const file = session('web_b', [{ type: 'session', id: 's' }, user('hi'), reply('done')]);
    expect(await repair('web_b')).toBe(false);
    expect(existsSync(`${file}.prerepair.bak`)).toBe(false);
  });

  it('closes a dangling toolCall with a synthetic result and keeps all history', async () => {
    const file = session('web_c', [
      { type: 'session', id: 's' },
      user('a'),
      reply('first answer'),
      user('b'),
      // text AND an unanswered toolCall = mid-loop, the one tail pi refuses
      {
        type: 'message',
        id: 'a-c9',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'partial' },
            { type: 'toolCall', id: 'c9', name: 'bash', arguments: {} },
          ],
        },
      },
    ]);

    expect(await repair('web_c')).toBe(true);

    const after = events(file);
    // Nothing removed …
    expect(readFileSync(file, 'utf8')).toContain('first answer');
    expect(readFileSync(file, 'utf8')).toContain('partial');
    // … and the open call is now answered, so the tail is continuable.
    expect(lastMessageRole(file)).toBe('toolResult');
    const tail = after[after.length - 1];
    expect(tail.message.toolCallId).toBe('c9');
    expect(tail.message.toolName).toBe('bash');
    expect(tail.message.content[0].text).toContain('interrupted');
    expect(existsSync(`${file}.prerepair.bak`)).toBe(true);
  });

  it('closes every unanswered call in the trailing message', async () => {
    const file = session('web_d', [
      { type: 'session', id: 's' },
      { type: 'model_change', id: 'm' },
      user('hi'),
      {
        type: 'message',
        id: 'a-multi',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'p1', name: 'bash', arguments: {} },
            { type: 'toolCall', id: 'p2', name: 'read', arguments: {} },
          ],
        },
      },
    ]);

    expect(await repair('web_d')).toBe(true);

    const after = events(file);
    const results = after.filter((e) => e.type === 'message' && e.message.role === 'toolResult');
    expect(results.map((r) => r.message.toolCallId)).toEqual(['p1', 'p2']);
    // The user turn and the assistant's calls are still there — no preamble-only wipe.
    expect(after.some((e) => e.type === 'message' && e.message.role === 'user')).toBe(true);
    expect(after.some((e) => e.type === 'session')).toBe(true);
  });

  it('does not re-close a call that already has its result', async () => {
    const file = session('web_e', [
      { type: 'session', id: 's' },
      user('hi'),
      toolCall('c1'),
      toolResult('c1'),
      reply('all done'),
    ]);
    expect(await repair('web_e')).toBe(false);
    expect(existsSync(`${file}.prerepair.bak`)).toBe(false);
  });
});
