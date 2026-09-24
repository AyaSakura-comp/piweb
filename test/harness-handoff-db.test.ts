import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
let dir = '';
const saved = { ...process.env };
afterEach(async () => {
  (await import('../src/db.js')).closeDb();
  vi.resetModules();
  for (const key of ['DB_PATH', 'SESSIONS_DIR']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it('tracks the last executing harness, not an unexecuted model selection, per channel generation', async () => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-db-'));
  process.env.DB_PATH = join(dir, 'db');
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:bridge',
    name: 'Bridge',
    folder: 'web_bridge',
    kind: 'standard',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const channel = db.getChannel('web:bridge')!;
  db.appendWebEvent({ channelJid: channel.jid, kind: 'message', role: 'user', content: 'hello' });
  const answer = db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'assistant',
    content: 'world',
  });
  db.noteHarnessSelection(channel, 'pi');
  expect(db.getHarnessContext(channel)).toMatchObject({ active: 'pi', cursors: { pi: answer } });
  db.noteHarnessSelection(channel, 'agy');
  expect(db.getHarnessContext(channel)?.active).toBe('pi');
  db.commitHarnessTurn(channel, 'agy', answer + 1);
  expect(db.getHarnessContext(channel)).toMatchObject({
    active: 'agy',
    cursors: { pi: answer, agy: answer + 1 },
  });
  expect(db.getLastAssistantWebEventRowid(channel.jid)).toBe(answer);
  const wrong = { ...channel, storageToken: 'different' };
  expect(db.getHarnessContext(wrong)).toBeUndefined();
  expect(() => db.commitHarnessTurn(wrong, 'claude', answer + 2)).toThrow();
});
