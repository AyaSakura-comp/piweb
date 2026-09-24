import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const { agyRun, claudeRun, piRun } = vi.hoisted(() => ({
  agyRun: vi.fn(),
  claudeRun: vi.fn(),
  piRun: vi.fn(),
}));
vi.mock('../src/agent/claude-tmux.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/claude-tmux.js')>()),
  invokeClaudeTmux: claudeRun,
}));
vi.mock('../src/agent/invoke.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/invoke.js')>()),
  invokeAgent: piRun,
}));
vi.mock('../src/agent/agy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/agy.js')>()),
  invokeAgy: agyRun,
}));
const saved = { ...process.env };
let dir = '';
afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const key of [
    'DB_PATH',
    'SESSIONS_DIR',
    'POLL_INTERVAL_MS',
    'MAX_CONCURRENCY',
    'PI_CWD',
    'RPC_STEER',
    'CLAUDE_TMUX_ENABLED',
  ]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it('retries a handoff after abort, then stops repeating it after successful delivery', async () => {
  dir = mkdtempSync(join(tmpdir(), 'queue-handoff-'));
  const dbPath = join(dir, 'db');
  Object.assign(process.env, {
    DB_PATH: dbPath,
    SESSIONS_DIR: join(dir, 'sessions'),
    PI_CWD: dir,
    POLL_INTERVAL_MS: '1',
    MAX_CONCURRENCY: '1',
    RPC_STEER: 'false',
    CLAUDE_TMUX_ENABLED: 'true',
  });
  vi.resetModules();
  const db = await import('../src/db.js');
  const queue = await import('../src/agent/queue.js');
  const transport = await import('../src/transport/index.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:handoff',
    name: 'Bridge',
    folder: 'web_handoff',
    kind: 'standard',
    requiresTrigger: false,
    isMain: false,
    modelOverride: 'openai-codex/gpt-6-sol',
    thinkingOverride: '',
    cwdOverride: '',
  });
  const channel = db.getChannel('web:handoff')!;
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'user',
    content: 'old pi user',
  });
  db.appendWebEvent({
    channelJid: channel.jid,
    kind: 'message',
    role: 'assistant',
    content: 'old pi assistant',
  });
  db.noteHarnessSelection(channel, 'pi');
  db.setChannelModelOverride(channel.jid, 'agy/gemini-3.1-pro-high');
  transport.setTransport({
    sendResponse: vi.fn(async (jid, text) => {
      db.appendWebEvent({ channelJid: jid, kind: 'message', role: 'assistant', content: text });
      return true;
    }),
    sendFilesResponse: vi.fn(async () => true),
    setTyping: vi.fn(async () => {}),
    clearTyping: vi.fn(async () => {}),
    createEventStreamer: () => async () => {},
  });
  agyRun
    .mockResolvedValueOnce({ ok: false, text: '', aborted: true })
    .mockResolvedValue({ ok: true, text: 'AGY reply' });
  const enqueue = (content: string) =>
    db.enqueueMessage({
      channelJid: channel.jid,
      sender: 'web',
      senderName: 'web',
      content,
      timestamp: new Date().toISOString(),
    });
  enqueue('new request');
  try {
    queue.startProcessingLoop();
    await vi.waitFor(() => expect(agyRun).toHaveBeenCalledTimes(1), { timeout: 2500 });
    await vi.waitFor(
      () => {
        const inspect = new Database(dbPath, { readonly: true });
        const status = (
          inspect.prepare('select status from message_queue order by rowid limit 1').get() as {
            status: string;
          }
        ).status;
        inspect.close();
        expect(status).toBe('aborted');
      },
      { timeout: 2500 },
    );
    expect(db.getHarnessContext(channel)?.active).toBe('pi');
    const first = agyRun.mock.calls[0][1];
    expect(first).toContain('old pi user');
    expect(first).toContain('old pi assistant');
    expect(first).toContain('new request');
    enqueue('retry request');
    await vi.waitFor(() => expect(agyRun).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(agyRun.mock.calls[1][1]).toContain('cross-harness context');
    await vi.waitFor(() => expect(db.getHarnessContext(channel)?.active).toBe('agy'), {
      timeout: 2500,
    });
    enqueue('follow-up');
    await vi.waitFor(() => expect(agyRun).toHaveBeenCalledTimes(3), { timeout: 2500 });
    expect(agyRun.mock.calls[2][1]).not.toContain('cross-harness context');
    await vi.waitFor(() => expect(db.getHarnessContext(channel)?.cursors.agy).toBeGreaterThan(0), {
      timeout: 2500,
    });
    claudeRun.mockResolvedValue({ ok: true, text: 'Claude reply' });
    db.setChannelModelOverride(channel.jid, 'claude-code/opus');
    enqueue('ask Claude');
    await vi.waitFor(() => expect(claudeRun).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(claudeRun.mock.calls[0][1]).toContain('AGY reply');
    await vi.waitFor(() => expect(db.getHarnessContext(channel)?.active).toBe('claude'), {
      timeout: 2500,
    });
    piRun.mockResolvedValue({ ok: true, text: 'Pi resumed' });
    db.setChannelModelOverride(channel.jid, 'openai-codex/gpt-6-sol');
    enqueue('back to Pi');
    await vi.waitFor(() => expect(piRun).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(piRun.mock.calls[0][1]).toContain('Claude reply');
    expect(piRun.mock.calls[0][1]).toContain('AGY reply');
    expect(piRun.mock.calls[0][1]).not.toContain('old pi assistant');
    await vi.waitFor(() => expect(db.getHarnessContext(channel)?.active).toBe('pi'), {
      timeout: 2500,
    });
    const inspect = new Database(dbPath, { readonly: true });
    expect(
      inspect.prepare("select count(*) n from message_queue where status='done'").get(),
    ).toMatchObject({ n: 4 });
    inspect.close();
  } finally {
    await queue.stopProcessingLoop({ timeoutMs: 2000 });
    db.closeDb();
  }
});
