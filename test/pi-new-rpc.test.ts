import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { closeRpcSessionMock, rotateMock } = vi.hoisted(() => ({
  closeRpcSessionMock: vi.fn(() => true),
  rotateMock: vi.fn(() => '/archived/path'),
}));

vi.mock('../src/agent/rpc-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/rpc-session.js')>()),
  closeRpcSession: closeRpcSessionMock,
}));

vi.mock('../src/session/path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/session/path.js')>()),
  rotateChannelSessionDir: rotateMock,
}));

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const k of ['DB_PATH', 'SESSIONS_DIR']) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('/pi new with a warm RPC session', () => {
  // The RPC process was started with --session-dir and has already resolved a
  // session file inside it. Rotating that directory while it is alive makes the
  // next prompt open a .jsonl that has moved into the archive:
  //   ENOENT: no such file or directory, open '.../<uuid>.jsonl'
  it('closes the RPC session before rotating the directory', async () => {
    const order: string[] = [];
    closeRpcSessionMock.mockImplementation(() => {
      order.push('close');
      return true;
    });
    rotateMock.mockImplementation(() => {
      order.push('rotate');
      return '/archived/path';
    });

    const { runCommand } = await loadCommands();
    const result = await runCommand(channel(), 'pi new', {});

    expect(result.ok).toBe(true);
    expect(closeRpcSessionMock).toHaveBeenCalledWith('ch_new');
    expect(order).toEqual(['close', 'rotate']);
  });

  it('rechecks control ownership after RPC retirement and before rotation', async () => {
    let checks = 0;
    closeRpcSessionMock.mockResolvedValue(true);
    const { runCommand } = await loadCommands();

    const result = await runCommand(
      channel(),
      'pi new',
      {},
      {
        assertOwnership: () => {
          checks += 1;
          if (checks === 2) throw new Error('control ownership changed during RPC retirement');
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(closeRpcSessionMock).toHaveBeenCalledTimes(1);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it('refuses rotation when a message starts while RPC retirement is pending', async () => {
    let releaseRetirement!: (closed: boolean) => void;
    closeRpcSessionMock.mockImplementation(
      () =>
        new Promise<boolean>((resolveClosed) => {
          releaseRetirement = resolveClosed;
        }),
    );
    const { runCommand, queue } = await loadCommands();
    const processing = vi
      .spyOn(queue, 'isChannelProcessing')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const pending = runCommand(channel(), 'pi new', {});
    await vi.waitFor(() => expect(closeRpcSessionMock).toHaveBeenCalledTimes(1));
    releaseRetirement(true);
    const result = await pending;

    expect(processing).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it('refuses rotation when another worker already claimed a message', async () => {
    closeRpcSessionMock.mockResolvedValue(true);
    const { db, runCommand } = await loadCommands();
    const rowid = db.enqueueMessage({
      channelJid: channel().jid,
      sender: 'test',
      senderName: 'Test',
      content: 'claimed elsewhere',
      timestamp: new Date().toISOString(),
    });
    expect(db.claimNextMessage(channel().jid)?.rowid).toBe(rowid);

    const result = await runCommand(channel(), 'pi new', {});

    expect(result.ok).toBe(false);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it('refuses rotation while another process owns a durable RPC/request lease', async () => {
    closeRpcSessionMock.mockResolvedValue(false);
    const { db, runCommand } = await loadCommands();
    const owner = db.getChannel(channel().jid)!;
    const operationId = db.beginChannelOperation(owner.jid, owner.folder, owner.storageToken);
    expect(operationId).toBeTruthy();

    const result = await runCommand(owner, 'pi new', {});

    expect(result.ok).toBe(false);
    expect(rotateMock).not.toHaveBeenCalled();
    db.finishChannelOperation(operationId!);
  });

  it('still succeeds when there is no RPC session to close', async () => {
    closeRpcSessionMock.mockReturnValue(false);
    const { runCommand } = await loadCommands();
    const result = await runCommand(channel(), 'pi new', {});
    expect(result.ok).toBe(true);
    expect(rotateMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the RPC session alone when the reset is refused mid-run', async () => {
    const { runCommand, queue } = await loadCommands();
    vi.spyOn(queue, 'isChannelProcessing').mockReturnValue(true);

    const result = await runCommand(channel(), 'pi new', {});

    expect(result.ok).toBe(false);
    expect(closeRpcSessionMock).not.toHaveBeenCalled();
    expect(rotateMock).not.toHaveBeenCalled();
  });
});

function channel() {
  return {
    jid: 'web:new1',
    name: 'reset test',
    folder: 'ch_new',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  } as any;
}

async function loadCommands() {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-pinew-'));
  tempDirs.push(tempDir);
  process.env.DB_PATH = ':memory:';
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  db.registerChannel(channel());
  const queue = await import('../src/agent/queue.js');
  const { runCommand } = await import('../src/commands/index.js');
  return { db, runCommand, queue };
}
