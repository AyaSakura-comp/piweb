import { afterEach, describe, expect, it, vi } from 'vitest';

const readFile = vi.fn();
const writeFile = vi.fn();
const mkdir = vi.fn();
const chmod = vi.fn();
const rename = vi.fn();
const unlink = vi.fn();
const execFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...a: unknown[]) => readFile(...a),
  writeFile: (...a: unknown[]) => writeFile(...a),
  mkdir: (...a: unknown[]) => mkdir(...a),
  chmod: (...a: unknown[]) => chmod(...a),
  rename: (...a: unknown[]) => rename(...a),
  unlink: (...a: unknown[]) => unlink(...a),
}));
vi.mock('node:child_process', () => ({ execFile: (...a: unknown[]) => execFile(...a) }));

const { readClaudeCodeCredentials, writeClaudeCodeCredentials } = await import(
  '../src/claude-code-credentials.js'
);

const realPlatform = process.platform;
function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}
const enoent = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
const keychainReturns = (stdout: string | Error) =>
  execFile.mockImplementation((_bin, _args, _opts, cb) =>
    stdout instanceof Error ? cb(stdout, '') : cb(null, stdout),
  );

describe('readClaudeCodeCredentials', () => {
  afterEach(() => {
    setPlatform(realPlatform);
    readFile.mockReset();
    execFile.mockReset();
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it('prefers the credentials file and never touches the Keychain when it exists', async () => {
    setPlatform('darwin');
    readFile.mockResolvedValue('{"claudeAiOauth":{"accessToken":"from-file"}}');
    await expect(readClaudeCodeCredentials()).resolves.toEqual({
      claudeAiOauth: { accessToken: 'from-file' },
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('falls back to the macOS Keychain item Claude Code writes when there is no file', async () => {
    setPlatform('darwin');
    readFile.mockImplementation(enoent);
    keychainReturns('{"claudeAiOauth":{"accessToken":"from-keychain"}}\n');
    await expect(readClaudeCodeCredentials()).resolves.toEqual({
      claudeAiOauth: { accessToken: 'from-keychain' },
    });
    expect(execFile.mock.calls[0][0]).toBe('/usr/bin/security');
    expect(execFile.mock.calls[0][1]).toEqual([
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ]);
  });

  it('tries the config-dir-suffixed service first when CLAUDE_CONFIG_DIR is set', async () => {
    setPlatform('darwin');
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-alt';
    readFile.mockImplementation(enoent);
    execFile
      .mockImplementationOnce((_b, _a, _o, cb) => cb(new Error('not found'), ''))
      .mockImplementationOnce((_b, _a, _o, cb) => cb(null, '{"claudeAiOauth":{}}'));
    await expect(readClaudeCodeCredentials()).resolves.toEqual({ claudeAiOauth: {} });
    expect(execFile.mock.calls[0][1][2]).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(execFile.mock.calls[1][1][2]).toBe('Claude Code-credentials');
  });

  it('rejects when neither the file nor the Keychain has credentials', async () => {
    setPlatform('darwin');
    readFile.mockImplementation(enoent);
    keychainReturns(new Error('item not found'));
    await expect(readClaudeCodeCredentials()).rejects.toThrow();
  });

  it('does not consult a Keychain off macOS', async () => {
    setPlatform('linux');
    readFile.mockImplementation(enoent);
    await expect(readClaudeCodeCredentials()).rejects.toThrow('ENOENT');
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('writeClaudeCodeCredentials', () => {
  afterEach(() => {
    readFile.mockReset();
    writeFile.mockReset();
    mkdir.mockReset();
    chmod.mockReset();
    rename.mockReset();
    unlink.mockReset();
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  it('merges fresh OAuth tokens, preserves metadata, and clears loginEnded', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-test';
    readFile.mockResolvedValue(
      JSON.stringify({
        mcpOAuth: { foo: 'bar' },
        claudeAiOauth: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: 0,
          refreshTokenExpiresAt: 123,
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_5x',
          loginEnded: 'time_limit',
        },
      }),
    );
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
    chmod.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);

    await writeClaudeCodeCredentials({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: 9999999,
      scopes: ['user:inference', 'user:sessions:claude_code'],
    });

    expect(mkdir).toHaveBeenCalledWith('/tmp/claude-test', { recursive: true, mode: 0o700 });
    const [tempPath, payload, opts] = writeFile.mock.calls[0];
    expect(tempPath).toMatch(/^\/tmp\/claude-test\/\.credentials\.json\.tmp-/);
    expect(opts).toEqual({ encoding: 'utf8', mode: 0o600 });
    expect(JSON.parse(payload)).toEqual({
      mcpOAuth: { foo: 'bar' },
      claudeAiOauth: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 9999999,
        scopes: ['user:inference', 'user:sessions:claude_code'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
      },
    });
    expect(chmod).toHaveBeenCalledWith(tempPath, 0o600);
    expect(rename).toHaveBeenCalledWith(tempPath, '/tmp/claude-test/.credentials.json');
  });
});
