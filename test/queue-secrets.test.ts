import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 🔑 login details at the worker (2026-11-12): the agent is told variable names,
// and anything that streams a value back is scrubbed before web_events.
// Made-up details only.

const USERNAME = 'octo-user-7731';
const PASSWORD = `pa$$ w0rd"q'x-9182`;

const { invokeAgentMock, invokeClaudeMock, sendResponseMock, streamMock } = vi.hoisted(() => ({
  invokeAgentMock: vi.fn(),
  invokeClaudeMock: vi.fn(),
  sendResponseMock: vi.fn(),
  streamMock: vi.fn(),
}));

vi.mock('../src/agent/invoke.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/invoke.js')>()),
  invokeAgent: invokeAgentMock,
}));
vi.mock('../src/agent/claude-tmux.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/claude-tmux.js')>()),
  invokeClaudeTmux: invokeClaudeMock,
}));
vi.mock('../src/agent/rpc-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/rpc-session.js')>()),
  closeRpcSession: vi.fn(),
}));
vi.mock('../src/agent/model-catalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/model-catalog.js')>()),
  listAvailableModels: () => [
    { ref: 'claude-code/haiku', provider: 'claude-code', id: 'haiku', name: 'Haiku', reasoning: true, supportsXhigh: true },
    { ref: 'local-llama/qwen', provider: 'local-llama', id: 'qwen', name: 'Qwen', reasoning: true, supportsXhigh: true },
  ],
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const KEYS = ['CLAUDE_TMUX_ENABLED', 'DB_PATH', 'MAX_CONCURRENCY', 'POLL_INTERVAL_MS', 'RPC_STEER', 'SESSIONS_DIR', 'SECRET_KEY_PATH', 'SECRETS_RUNTIME_DIR'];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const key of KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runTurn(model: string) {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-queue-secrets-'));
  tempDirs.push(tempDir);
  Object.assign(process.env, {
    CLAUDE_TMUX_ENABLED: 'true',
    DB_PATH: ':memory:',
    SESSIONS_DIR: resolve(tempDir, 'sessions'),
    POLL_INTERVAL_MS: '1',
    MAX_CONCURRENCY: '1',
    RPC_STEER: 'false',
    SECRET_KEY_PATH: resolve(tempDir, 'secret-key.pem'),
    SECRETS_RUNTIME_DIR: resolve(tempDir, 'runtime'),
  });
  const runtimeFile = resolve(tempDir, 'runtime', 'web_sec1.json');
  const seenDuringTurn: boolean[] = [];
  // The agent echoes the values back every way it can.
  const leaky = async (_folder: string, prompt: string, opts: any) => {
    seenDuringTurn.push(existsSync(runtimeFile));
    await opts.onEvent({ type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: `user ${USERNAME}` }] } });
    await opts.onEvent({ type: 'tool_execution_end', result: { content: [{ type: 'text', text: `pass ${PASSWORD}` }] } });
    return { ok: true, text: `Logged in as ${USERNAME} (${prompt.length})` };
  };
  invokeAgentMock.mockImplementation(leaky);
  invokeClaudeMock.mockImplementation(leaky);
  sendResponseMock.mockResolvedValue(true);
  streamMock.mockResolvedValue(undefined);

  vi.resetModules();
  const db = await import('../src/db.js');
  const queue = await import('../src/agent/queue.js');
  const transport = await import('../src/transport/index.js');
  const handoff = await import('../src/agent/secret-handoff.js');
  const { getMeta } = db;
  const { sealSecret, SECRET_PUBLIC_KEY_META } = await import('../src/secrets.js');
  transport.setTransport({
    sendResponse: sendResponseMock,
    sendFilesResponse: vi.fn().mockResolvedValue(true),
    setTyping: vi.fn().mockResolvedValue(undefined),
    clearTyping: vi.fn().mockResolvedValue(undefined),
    createEventStreamer: () => streamMock,
  });
  db.initDb();
  handoff.initSecretKey();
  try {
    db.registerChannel({
      jid: 'web:sec1',
      name: 'Secrets',
      folder: 'web_sec1',
      requiresTrigger: false,
      isMain: false,
      modelOverride: model,
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'web:sec1',
      sender: 'web',
      senderName: 'web',
      content: '幫我登入',
      timestamp: new Date().toISOString(),
      secrets: [sealSecret(getMeta(SECRET_PUBLIC_KEY_META)!, { name: 'GitHub', username: USERNAME, password: PASSWORD })],
    });
    queue.startProcessingLoop();
    await vi.waitFor(() => expect(sendResponseMock).toHaveBeenCalledTimes(1), { timeout: 3000, interval: 10 });
  } finally {
    await queue.stopProcessingLoop({ timeoutMs: 1000 });
    db.closeDb();
  }
  expect(handoff.secretFilesFor('web_sec1').json).toBe(runtimeFile);
  // The opened values were there for the agent, and gone once the turn ended.
  expect(seenDuringTurn).toEqual([true]);
  expect(existsSync(runtimeFile)).toBe(false);
  return { envFile: handoff.secretFilesFor('web_sec1').env };
}

function expectScrubbed() {
  const streamed = JSON.stringify(streamMock.mock.calls);
  expect(streamed).not.toContain(USERNAME);
  expect(streamed).not.toContain('w0rd');
  expect(streamed).toContain('user $PIWEB_SECRET_GITHUB_USER');
  expect(streamed).toContain('pass $PIWEB_SECRET_GITHUB_PASS');
  expect(sendResponseMock.mock.calls[0][1]).toMatch(/^Logged in as \$PIWEB_SECRET_GITHUB_USER \(\d+\)$/);
}

describe('a turn that brought login details', () => {
  it('tells Pi the variable names and scrubs what streams back', async () => {
    await runTurn('local-llama/qwen');
    const prompt: string = invokeAgentMock.mock.calls[0][1];
    expect(prompt).toContain('幫我登入');
    expect(prompt).toContain('- GitHub: account $PIWEB_SECRET_GITHUB_USER, password $PIWEB_SECRET_GITHUB_PASS');
    expect(prompt).toContain('it is filled in when the tool runs');
    expect(prompt).not.toContain(USERNAME);
    expect(prompt).not.toContain(PASSWORD);
    expectScrubbed();
  });

  it('tells Claude Code to source the file and scrubs its transcript relay', async () => {
    const { envFile } = await runTurn('claude-code/haiku');
    const prompt: string = invokeClaudeMock.mock.calls[0][1];
    expect(prompt).toContain(`. '${envFile}' && `);
    expect(prompt).not.toContain(USERNAME);
    expect(prompt).not.toContain(PASSWORD);
    expectScrubbed();
  });
});
