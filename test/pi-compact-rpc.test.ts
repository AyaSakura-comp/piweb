import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { compactRpcSessionMock } = vi.hoisted(() => ({
  compactRpcSessionMock: vi.fn(),
}));

vi.mock('../src/agent/rpc-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/rpc-session.js')>()),
  compactRpcSession: compactRpcSessionMock,
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('/pi compact', () => {
  it('is exposed in the command catalog', async () => {
    const { COMMANDS } = await import('../src/commands/catalog.js');
    expect(COMMANDS.some((command) => command.name === 'pi compact')).toBe(true);
  });

  it('compacts the warm RPC session and reports the before/after token counts', async () => {
    compactRpcSessionMock.mockResolvedValue({
      summary: 'summary',
      tokensBefore: 427_779,
      estimatedTokensAfter: 31_234,
    });
    const { runCommand } = await setup();

    const result = await runCommand(channel(), 'pi compact', {});

    expect(compactRpcSessionMock).toHaveBeenCalledWith('web_compact', undefined);
    expect(result).toEqual({
      ok: true,
      text: 'Compacted context: 427,779 → approximately 31,234 tokens.',
    });
  });

  it('treats a session-too-small response as a successful no-op', async () => {
    compactRpcSessionMock.mockRejectedValue(new Error('Nothing to compact (session too small)'));
    const { runCommand } = await setup();

    const result = await runCommand(channel(), 'pi compact', {});

    expect(result).toEqual({ ok: true, text: 'Nothing to compact (session too small).' });
  });

  it('explains when no warm RPC session exists', async () => {
    compactRpcSessionMock.mockResolvedValue(undefined);
    const { runCommand } = await setup();

    const result = await runCommand(channel(), 'pi compact', {});

    expect(result.ok).toBe(false);
    expect(result.text).toContain('No active Pi session');
  });
});

function channel() {
  return {
    jid: 'web:compact',
    name: 'compact test',
    folder: 'web_compact',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  } as any;
}

async function setup() {
  const tempDir = mkdtempSync(join(tmpdir(), 'piweb-compact-command-'));
  tempDirs.push(tempDir);
  process.env.DB_PATH = ':memory:';
  process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

  vi.resetModules();
  const db = await import('../src/db.js');
  db.initDb();
  db.registerChannel(channel());
  const { runCommand } = await import('../src/commands/index.js');
  return { runCommand };
}
