import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/agent/model-catalog.js', async (original) => ({
  ...(await original<typeof import('../src/agent/model-catalog.js')>()),
  listAvailableModels: () => [
    {
      ref: 'openai-codex/gpt-6-sol',
      provider: 'openai-codex',
      id: 'gpt-6-sol',
      name: 'Pi',
      reasoning: true,
    },
    {
      ref: 'openai-codex/gpt-5.6-sol',
      provider: 'openai-codex',
      id: 'gpt-5.6-sol',
      name: 'Pi 2',
      reasoning: true,
    },
    {
      ref: 'agy/gemini-3.1-pro-high',
      provider: 'agy',
      id: 'gemini-3.1-pro-high',
      name: 'AGY',
      reasoning: true,
    },
  ],
}));
const env = { ...process.env };
let dir = '';
afterEach(async () => {
  (await import('../src/db.js')).closeDb();
  vi.resetModules();
  for (const key of ['DB_PATH', 'SESSIONS_DIR']) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it('pi new excludes archived conversation from later cross-harness handoffs', async () => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-new-'));
  process.env.DB_PATH = join(dir, 'db');
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  vi.resetModules();
  const db = await import('../src/db.js');
  const { runCommand } = await import('../src/commands/index.js');
  const { prepareCrossHarnessHandoff } = await import('../src/agent/harness-handoff.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:new-bridge',
    name: 'New',
    folder: 'web_new-bridge',
    kind: 'standard',
    requiresTrigger: false,
    isMain: false,
    modelOverride: 'openai-codex/gpt-6-sol',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const channel = db.getChannel('web:new-bridge')!;
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'assistant',
    content: 'old private chat',
  });
  db.noteHarnessSelection(channel, 'pi');
  expect((await runCommand(channel, 'pi new')).ok).toBe(true);
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'user',
    content: 'fresh question',
  });
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'assistant',
    content: 'fresh answer',
  });
  db.setChannelModelOverride(channel.jid, 'agy/gemini-3.1-pro-high');
  const context = prepareCrossHarnessHandoff(channel, 'agy');
  expect(context).toContain('fresh answer');
  expect(context).not.toContain('old private chat');
});

it('real model command bootstraps prior Pi harness without treating Pi model changes as external', async () => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-command-'));
  process.env.DB_PATH = join(dir, 'db');
  process.env.SESSIONS_DIR = join(dir, 'sessions');
  vi.resetModules();
  const db = await import('../src/db.js');
  const { runCommand } = await import('../src/commands/index.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:command',
    name: 'Bridge',
    folder: 'web_command',
    kind: 'standard',
    requiresTrigger: false,
    isMain: false,
    modelOverride: 'openai-codex/gpt-6-sol',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const channel = db.getChannel('web:command')!;
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'assistant',
    content: 'prior Pi answer',
  });
  expect((await runCommand(channel, 'pi model', { model: 'openai-codex/gpt-5.6-sol' })).ok).toBe(
    true,
  );
  expect(db.getHarnessContext(channel)?.active).toBe('pi');
  expect(
    (
      await runCommand(db.getChannel(channel.jid)!, 'pi model', {
        model: 'agy/gemini-3.1-pro-high',
      })
    ).ok,
  ).toBe(true);
  expect(db.getHarnessContext(channel)?.active).toBe('pi');
  expect(
    (await import('../src/agent/harness-handoff.js')).prepareCrossHarnessHandoff(channel, 'agy'),
  ).toContain('prior Pi answer');
});
