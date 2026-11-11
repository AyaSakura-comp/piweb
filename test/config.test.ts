import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = [
  'AUTO_REGISTER_DMS',
  'CLAUDE_TMUX_BIN',
  'CLAUDE_TMUX_ENABLED',
  'CLAUDE_TMUX_POLL_MS',
  'CLAUDE_TMUX_STARTUP_TIMEOUT_MS',
  'CLAUDE_TMUX_TMUX_BIN',
  'CLAUDE_TMUX_TURN_TIMEOUT_MS',
  'DB_PATH',
  'DISCORD_BOT_TOKEN',
  'HOME',
  'LOG_LEVEL',
  'MAX_ATTACHMENT_BYTES',
  'MAX_CONCURRENCY',
  'MAX_TOTAL_ATTACHMENT_BYTES',
  'PIDG_CONFIG',
  'PI_BIN',
  'PI_CWD',
  'PI_EXTRA_FLAGS',
  'PI_MODEL',
  'PI_THINKING',
  'POLL_INTERVAL_MS',
  'SESSIONS_DIR',
  'SHUTDOWN_TIMEOUT_MS',
  'TRIGGER_NAME',
];

afterEach(() => {
  vi.resetModules();
  process.chdir(originalCwd);

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveConfigPath', () => {
  it('uses PIDG_CONFIG when set', async () => {
    process.env.PIDG_CONFIG = '~/custom/pi-discord/config.env';

    const { resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(resolve(homedir(), 'custom/pi-discord/config.env'));
  });

  it('falls back to the platform default config path', async () => {
    delete process.env.PIDG_CONFIG;

    const { resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(expectedDefaultConfigPath(homedir()));
  });
});

describe('config loading', () => {
  it('merges process env over config file over cwd .env fallback', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();
    const configPath = resolve(homeDir, 'custom/config.env');

    writeEnvFile(resolve(workDir, '.env'), {
      DB_PATH: '/legacy/gateway.db',
      SESSIONS_DIR: '/legacy/sessions',
      PI_CWD: '/legacy/project',
    });
    writeEnvFile(configPath, {
      DB_PATH: '/config/gateway.db',
      SESSIONS_DIR: '/config/sessions',
      PI_CWD: '/config/project',
    });

    process.chdir(workDir);
    process.env.HOME = homeDir;
    process.env.PIDG_CONFIG = configPath;
    process.env.PI_CWD = '/env/project';
    delete process.env.DB_PATH;
    delete process.env.SESSIONS_DIR;

    const { config, resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(configPath);
    expect(config.dbPath).toBe('/config/gateway.db');
    expect(config.sessionsDir).toBe('/config/sessions');
    expect(config.piCwd).toBe('/env/project');
  });

  it('uses the default config file before the cwd .env fallback', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();
    const defaultConfigPath = expectedDefaultConfigPath(homeDir);

    writeEnvFile(resolve(workDir, '.env'), {
      DB_PATH: '/legacy/gateway.db',
      SESSIONS_DIR: '/legacy/sessions',
    });
    writeEnvFile(defaultConfigPath, {
      DB_PATH: '/default/gateway.db',
      SESSIONS_DIR: '/default/sessions',
    });

    process.chdir(workDir);
    process.env.HOME = homeDir;
    delete process.env.PIDG_CONFIG;
    delete process.env.DB_PATH;
    delete process.env.SESSIONS_DIR;

    const { config, resolveConfigPath } = await loadConfigModule();

    expect(resolveConfigPath()).toBe(defaultConfigPath);
    expect(config.dbPath).toBe('/default/gateway.db');
    expect(config.sessionsDir).toBe('/default/sessions');
  });

  it('loads the opt-in Claude tmux bridge settings with safe defaults', async () => {
    const workDir = createTempDir();
    process.chdir(workDir);
    process.env.PIDG_CONFIG = resolve(workDir, 'missing.env');
    process.env.CLAUDE_TMUX_ENABLED = 'true';
    process.env.CLAUDE_TMUX_BIN = '/opt/claude';
    process.env.CLAUDE_TMUX_TMUX_BIN = '/opt/tmux';
    process.env.CLAUDE_TMUX_POLL_MS = '75';
    process.env.CLAUDE_TMUX_STARTUP_TIMEOUT_MS = '12000';
    process.env.CLAUDE_TMUX_TURN_TIMEOUT_MS = '900000';

    const { config } = await loadConfigModule();

    expect(config.claudeTmuxEnabled).toBe(true);
    expect(config.claudeTmuxBin).toBe('/opt/claude');
    expect(config.claudeTmuxTmuxBin).toBe('/opt/tmux');
    expect(config.claudeTmuxPollMs).toBe(75);
    expect(config.claudeTmuxStartupTimeoutMs).toBe(12000);
    expect(config.claudeTmuxTurnTimeoutMs).toBe(900000);
  });

  it('keeps the Claude tmux bridge disabled unless explicitly enabled', async () => {
    const workDir = createTempDir();
    process.chdir(workDir);
    process.env.PIDG_CONFIG = resolve(workDir, 'missing.env');
    delete process.env.CLAUDE_TMUX_ENABLED;
    delete process.env.CLAUDE_TMUX_BIN;
    delete process.env.CLAUDE_TMUX_TMUX_BIN;

    const { config, platformDefaults } = await loadConfigModule();

    expect(config.claudeTmuxEnabled).toBe(false);
    expect(config.claudeTmuxBin).toBe(platformDefaults().claudeBin);
    expect(config.claudeTmuxTmuxBin).toBe(platformDefaults().tmuxBin);
  });

  it('fills gaps with per-platform defaults: Linux split deployment, macOS all-in-one', async () => {
    const { platformDefaults } = await loadConfigModule();
    const none = () => false;
    const linux = platformDefaults('linux', '/home/u', none);
    expect(linux).toEqual({
      embeddedWorker: false,
      trustTailscaleIdentity: true,
      voiceAsrEnabled: true,
      agyEnabled: true,
      iconSet: '',
      tmuxBin: 'tmux',
      claudeBin: 'claude',
      agyBin: 'agy',
    });
    const mac = platformDefaults('darwin', '/Users/u', none);
    expect(mac).toMatchObject({
      embeddedWorker: true,
      trustTailscaleIdentity: false,
      voiceAsrEnabled: false,
      agyEnabled: false,
      iconSet: 'piweb-mini',
      tmuxBin: 'tmux',
    });
    // launchd/systemd PATHs lack Homebrew and ~/.local/bin: found binaries are used directly.
    const installed = new Set(['/opt/homebrew/bin/tmux', '/Users/u/.local/bin/claude']);
    const found = platformDefaults('darwin', '/Users/u', (p) => installed.has(p));
    expect(found.tmuxBin).toBe('/opt/homebrew/bin/tmux');
    expect(found.claudeBin).toBe('/Users/u/.local/bin/claude');
    expect(found.agyBin).toBe('agy');
    expect(found.agyEnabled).toBe(false);
    // agy from Homebrew on the Mac: offered, by absolute path.
    const brewAgy = platformDefaults('darwin', '/Users/u', (p) => p === '/opt/homebrew/bin/agy');
    expect(brewAgy.agyEnabled).toBe(true);
    expect(brewAgy.agyBin).toBe('/opt/homebrew/bin/agy');
  });

  it('lets config.env override a platform default', async () => {
    const workDir = createTempDir();
    process.chdir(workDir);
    const configPath = resolve(workDir, 'config.env');
    writeFileSync(configPath, 'VOICE_ASR_ENABLED=false\nWEB_EMBEDDED_WORKER=true\n');
    process.env.PIDG_CONFIG = configPath;
    delete process.env.VOICE_ASR_ENABLED;
    delete process.env.WEB_EMBEDDED_WORKER;

    const { config } = await loadConfigModule();

    expect(config.voiceAsrEnabled).toBe(false);
    expect(config.webEmbeddedWorker).toBe(true);
  });

  it('uses the piweb platform data directory defaults when storage paths are unset', async () => {
    const homeDir = createTempDir();
    const workDir = createTempDir();

    process.chdir(workDir);
    process.env.HOME = homeDir;
    delete process.env.PIDG_CONFIG;
    delete process.env.DB_PATH;
    delete process.env.SESSIONS_DIR;

    const { config } = await loadConfigModule();

    const dataDir = expectedDefaultDataDir(homeDir);
    expect(config.dbPath).toBe(resolve(dataDir, 'gateway.db'));
    expect(config.sessionsDir).toBe(resolve(dataDir, 'sessions'));
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pidg-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeEnvFile(filePath: string, values: Record<string, string>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

function expectedDefaultConfigPath(homeDir: string): string {
  switch (process.platform) {
    case 'win32':
      return resolve(
        process.env.APPDATA || resolve(homeDir, 'AppData/Roaming'),
        'piweb/config.env',
      );
    case 'darwin':
      return resolve(homeDir, 'Library/Application Support/piweb/config.env');
    default:
      return resolve(homeDir, '.config', 'piweb', 'config.env');
  }
}

function expectedDefaultDataDir(homeDir: string): string {
  switch (process.platform) {
    case 'win32':
      return resolve(
        process.env.LOCALAPPDATA || resolve(homeDir, 'AppData/Local'),
        'piweb',
      );
    case 'darwin':
      return resolve(homeDir, 'Library/Application Support/piweb');
    default:
      return resolve(homeDir, '.local/share', 'piweb');
  }
}

async function loadConfigModule() {
  vi.resetModules();
  return import('../src/config.js');
}
