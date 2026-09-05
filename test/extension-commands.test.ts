import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS } from '../src/commands/catalog.js';

const originalDbPath = process.env.DB_PATH;

vi.mock('../src/commands/extension-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../src/commands/extension-runner.js')>(
    '../src/commands/extension-runner.js',
  );
  return {
    ...actual,
    executePiExtensionCommand: vi.fn(async (_channel, command, _args) => {
      if (command === 'kv status') {
        return {
          ok: true,
          text: '### ⚡ Pi KV Cache Manager Status\n- Active Session Tokens: 1,234',
        };
      }
      if (command === 'custom-ext') {
        return {
          ok: true,
          text: 'Custom extension executed',
        };
      }
      return { ok: false, text: `Unknown command: ${command}` };
    }),
  };
});

function createMockChannel() {
  return {
    jid: 'web:kv123',
    name: 'KV session',
    folder: 'web_kv123',
    storageToken: 'tok123',
    ownershipEpoch: 1,
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '' as const,
    cwdOverride: '',
  };
}

afterEach(() => {
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
});

describe('extension slash commands integration', () => {
  it('registers kv status and management commands in the catalog', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain('kv status');
    expect(names).toContain('kv save');
    expect(names).toContain('kv restore');
    expect(names).toContain('kv prune');
    expect(names).toContain('kv help');
    expect(names).toContain('kv');

    const kvSave = COMMANDS.find((c) => c.name === 'kv save');
    expect(kvSave?.arg?.name).toBe('name');
    expect(kvSave?.arg?.required).toBe(false);
  });

  it('routes kv status through runCommand to the extension runner', async () => {
    const { runCommand } = await import('../src/commands/index.js');
    const { executePiExtensionCommand } = await import('../src/commands/extension-runner.js');

    const result = await runCommand(createMockChannel(), 'kv status');

    expect(executePiExtensionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'web:kv123' }),
      'kv status',
      {},
      undefined,
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Pi KV Cache Manager Status');
  });

  it('routes unknown extension commands to the extension runner if recognized', async () => {
    process.env.DB_PATH = ':memory:';
    const db = await import('../src/db.js');
    db.initDb();

    try {
      db.setMeta(
        'extension_commands',
        JSON.stringify([
          {
            name: 'custom-ext',
            description: 'A custom extension',
          },
        ]),
      );

      const { runCommand } = await import('../src/commands/index.js');
      const result = await runCommand(createMockChannel(), 'custom-ext');
      expect(result.ok).toBe(true);
      expect(result.text).toBe('Custom extension executed');
    } finally {
      db.closeDb();
    }
  });

  it('returns unknown command error for truly unrecognized commands', async () => {
    const { runCommand } = await import('../src/commands/index.js');

    const result = await runCommand(createMockChannel(), 'nonexistent-command-xyz');
    expect(result.ok).toBe(false);
    expect(result.text).toContain('Unknown command: nonexistent-command-xyz');
  });

  it('discovers extension commands from Pi RPC or fallback', async () => {
    const { discoverPiExtensionCommands } = await import('../src/commands/extension-runner.js');
    const commands = await discoverPiExtensionCommands(4000);
    expect(commands.length).toBeGreaterThan(0);
    const names = commands.map((c) => c.name);
    expect(names).toContain('kv status');
    expect(names).toContain('kv');
  });
});
