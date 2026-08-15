import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { abortRpcSessionMock } = vi.hoisted(() => ({
  abortRpcSessionMock: vi.fn(),
}));

vi.mock('../src/agent/rpc-session.js', () => ({
  abortRpcSession: abortRpcSessionMock,
  closeAllRpcSessions: vi.fn(),
  getRpcSession: vi.fn(),
}));

const originalDbPath = process.env.DB_PATH;
let db: typeof import('../src/db.js');
let queue: typeof import('../src/agent/queue.js');

beforeAll(async () => {
  process.env.DB_PATH = ':memory:';
  vi.resetModules();
  db = await import('../src/db.js');
  db.initDb();
  queue = await import('../src/agent/queue.js');
});

afterAll(() => {
  db.closeDb();
  vi.resetModules();
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
});

describe('stopChannelTask with a persistent RPC session', () => {
  it('uses RPC abort while preserving the Pi process and queued messages', () => {
    db.registerChannel({
      jid: 'web:stop',
      name: 'stop test',
      folder: 'web_stop',
      requiresTrigger: false,
      isMain: false,
      modelOverride: '',
      thinkingOverride: '',
      cwdOverride: '',
    });
    db.enqueueMessage({
      channelJid: 'web:stop',
      sender: 'web',
      senderName: 'web',
      content: 'queued follow-up',
      timestamp: new Date().toISOString(),
    });
    abortRpcSessionMock.mockReturnValue(true);

    const result = queue.stopChannelTask('web:stop');

    expect(abortRpcSessionMock).toHaveBeenCalledWith('web_stop');
    expect(result).toEqual({ aborted: true, cleared: 0, preservedSession: true });
    expect(db.channelsWithPending()).toContain('web:stop');
  });
});
