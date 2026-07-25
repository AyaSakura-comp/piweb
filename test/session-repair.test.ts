import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * repairSessionForContinue heals a session left non-continuable by a run
 * interrupted mid-tool-loop, which otherwise makes pi refuse the next
 * `--continue` with "Cannot continue from message role: assistant".
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
const toolCall = () => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'toolCall', toolCall: { name: 'bash' } }] } });
const toolResult = () => ({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'out' }] } });

function lastMessageRole(file: string): string | undefined {
  const msgs = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'message');
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
  it('truncates a session interrupted after a toolResult back to the last complete reply', async () => {
    const file = session('web_a', [
      { type: 'session', id: 's' },
      user('hi'),
      reply('done'),
      user('do a thing'),
      toolCall(),
      toolResult(), // interrupted here — no closing assistant reply
    ]);
    expect(lastMessageRole(file)).toBe('toolResult');
    expect(await repair('web_a')).toBe(true);
    expect(lastMessageRole(file)).toBe('assistant');
    expect(readFileSync(file, 'utf8')).toContain('done');
    expect(readFileSync(file, 'utf8')).not.toContain('do a thing');
    expect(existsSync(`${file}.prerepair.bak`)).toBe(true);
  });

  it('leaves an already-complete session untouched', async () => {
    const file = session('web_b', [{ type: 'session', id: 's' }, user('hi'), reply('done')]);
    expect(await repair('web_b')).toBe(false);
    expect(existsSync(`${file}.prerepair.bak`)).toBe(false);
  });

  it('treats an assistant message with a trailing toolCall as incomplete', async () => {
    const file = session('web_c', [
      { type: 'session', id: 's' },
      user('a'),
      reply('first answer'),
      user('b'),
      // text AND a dangling toolCall = mid-loop, not a finished turn
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }, { type: 'toolCall', toolCall: { name: 'bash' } }] } },
    ]);
    expect(await repair('web_c')).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('first answer');
    expect(readFileSync(file, 'utf8')).not.toContain('partial');
  });

  it('keeps only the preamble when no complete reply exists', async () => {
    const file = session('web_d', [
      { type: 'session', id: 's' },
      { type: 'model_change', id: 'm' },
      user('hi'),
      toolCall(),
    ]);
    expect(await repair('web_d')).toBe(true);
    const kept = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(kept.every((e) => e.type !== 'message')).toBe(true); // no messages left
    expect(kept.some((e) => e.type === 'session')).toBe(true); // header preserved
  });
});
