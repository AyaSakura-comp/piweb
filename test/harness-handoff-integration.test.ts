import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
let dir = '';
const env = { ...process.env };
afterEach(async () => {
  (await import('../src/db.js')).closeDb();
  vi.resetModules();
  for (const key of ['DB_PATH', 'SESSIONS_DIR']) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it('does not lose older dialogue behind more than 5000 tool events', async () => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-many-tools-'));
  process.env.DB_PATH = join(dir, 'db');
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  vi.resetModules();
  const db = await import('../src/db.js');
  const bridge = await import('../src/agent/harness-handoff.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:many',
    name: 'Many',
    folder: 'web_many',
    kind: 'standard',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const channel = db.getChannel('web:many')!;
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'user',
    content: 'remember this early question',
  });
  for (let i = 0; i < 5010; i++)
    db.appendWebEvent({
      channelJid: channel.jid,
      kind: 'tool_result',
      role: 'bash',
      content: 'large noisy output',
    });
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'assistant',
    content: 'the final answer',
  });
  db.noteHarnessSelection(channel, 'pi');
  const handoff = bridge.prepareCrossHarnessHandoff(channel, 'agy');
  expect(handoff).toContain('remember this early question');
  expect(handoff).toContain('the final answer');
});

it('reports dialogue discarded by the 5000-record cap rather than claiming none was omitted', async () => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-cap-'));
  process.env.DB_PATH = join(dir, 'db');
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  vi.resetModules();
  const db = await import('../src/db.js');
  const bridge = await import('../src/agent/harness-handoff.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:cap',
    name: 'Cap',
    folder: 'web_cap',
    kind: 'standard',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const channel = db.getChannel('web:cap')!;
  for (let i = 0; i < 5010; i++)
    db.appendWebEvent({
      channelJid: channel.jid,
      kind: 'message',
      role: i % 2 ? 'assistant' : 'user',
      content: 'short-' + i,
    });
  db.noteHarnessSelection(channel, 'pi');
  const handoff = bridge.prepareCrossHarnessHandoff(channel, 'agy');
  expect(handoff).toMatch(/older records omitted: [1-9][0-9]*/);
  const meta = JSON.parse(
    readFileSync(join(dir, 'sessions', 'web_cap', '.piweb-handoff-agy.jsonl'), 'utf8').split(
      '\n',
    )[0],
  );
  expect(meta.omittedOlder).toBeGreaterThanOrEqual(10);
});

it('Pi-to-Pi remains native; Pi→AGY→Claude→Pi each imports only unseen dialogue', async () => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-flow-'));
  process.env.DB_PATH = join(dir, 'db');
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  vi.resetModules();
  const db = await import('../src/db.js');
  const bridge = await import('../src/agent/harness-handoff.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:flow',
    name: 'Flow',
    folder: 'web_flow',
    kind: 'standard',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const channel = db.getChannel('web:flow')!;
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'user',
    content: 'pi request',
  });
  const piAnswer = db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'assistant',
    content: 'pi answer',
  });
  db.noteHarnessSelection(channel, 'pi');
  expect(bridge.prepareCrossHarnessHandoff(channel, 'pi')).toBe('');
  const agy = bridge.prepareCrossHarnessHandoff(channel, 'agy');
  expect(agy).toContain('pi answer');
  const file = join(dir, 'sessions', 'web_flow', '.piweb-handoff-agy.jsonl');
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('pi answer');
  expect(agy).toContain(file);
  expect(bridge.prepareCrossHarnessHandoff(channel, 'agy')).toBe(agy); // failed attempt does not advance
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'user',
    content: 'agy request',
  });
  const agyAnswer = db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'assistant',
    content: 'agy answer',
  });
  db.commitHarnessTurn(channel, 'agy', agyAnswer);
  const claude = bridge.prepareCrossHarnessHandoff(channel, 'claude');
  expect(claude).toContain('agy answer');
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'assistant',
    content: 'claude answer',
  });
  db.commitHarnessTurn(channel, 'claude', db.getLastAssistantWebEventRowid(channel.jid));
  const back = bridge.prepareCrossHarnessHandoff(channel, 'pi');
  expect(back).toContain('agy answer');
  expect(back).toContain('claude answer');
  expect(back).not.toContain('pi answer');
  db.commitHarnessTurn(channel, 'pi', db.getLastAssistantWebEventRowid(channel.jid));
  expect(bridge.prepareCrossHarnessHandoff(channel, 'pi')).toBe('');
  expect(piAnswer).toBeLessThan(agyAnswer);
});
