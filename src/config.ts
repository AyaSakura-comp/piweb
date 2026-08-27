import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const DEFAULT_CONFIG_PATH = defaultConfigPath();
const DEFAULT_DATA_DIR = defaultDataDir();
const LEGACY_ENV_PATH = resolve(process.cwd(), '.env');
const CONFIG_SOURCE = buildConfigSource();

function defaultConfigPath(): string {
  switch (process.platform) {
    case 'win32':
      return resolve(
        process.env.APPDATA || resolve(homedir(), 'AppData/Roaming'),
        'piscord-gateway/config.env',
      );
    case 'darwin':
      return resolve(homedir(), 'Library/Application Support/piscord-gateway/config.env');
    default:
      return resolve(homedir(), '.config', 'pi-discord-gateway', 'config.env');
  }
}

export function defaultDataDir(): string {
  switch (process.platform) {
    case 'win32':
      return resolve(
        process.env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local'),
        'piscord-gateway',
      );
    case 'darwin':
      return resolve(homedir(), 'Library/Application Support/piscord-gateway');
    default:
      return resolve(homedir(), '.local/share', 'piscord-gateway');
  }
}

export function resolveConfigPath(): string {
  const configuredPath = process.env.PIDG_CONFIG?.trim() ?? '';
  if (configuredPath) {
    return resolveUserPath(configuredPath);
  }

  return DEFAULT_CONFIG_PATH;
}

function resolveUserPath(inputPath: string): string {
  const expanded = expandHome(inputPath.trim());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') {
    return homedir();
  }

  if (inputPath.startsWith('~/')) {
    return resolve(homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function readEnvValue(key: string): string | undefined {
  return CONFIG_SOURCE[key];
}

function buildConfigSource(): Record<string, string> {
  return {
    ...loadEnvFile(LEGACY_ENV_PATH),
    ...loadEnvFile(resolveConfigPath()),
    ...readProcessEnv(),
  };
}

function loadEnvFile(filePath: string): Record<string, string> {
  try {
    return parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    throw error;
  }
}

function readProcessEnv(): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      values[key] = value;
    }
  }

  return values;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function env(key: string, fallback = ''): string {
  return (readEnvValue(key) ?? '').trim() || fallback;
}

function envInt(key: string, fallback: number, opts: { min?: number } = {}): number {
  const raw = env(key);
  if (!raw) return fallback;

  const v = Number.parseInt(raw, 10);
  if (Number.isNaN(v)) return fallback;
  if (opts.min !== undefined && v < opts.min) return fallback;
  return v;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = env(key).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

const VALID_CHANNEL_POLICIES = ['open', 'open-trigger', 'allowlist'] as const;
type ChannelPolicy = (typeof VALID_CHANNEL_POLICIES)[number];

function parseChannelPolicy(value: string): ChannelPolicy {
  if ((VALID_CHANNEL_POLICIES as readonly string[]).includes(value)) {
    return value as ChannelPolicy;
  }
  return 'allowlist';
}

export const config = {
  /** Discord bot token (required) */
  discordToken: env('DISCORD_BOT_TOKEN'),

  /** Pi binary path */
  piBin: env('PI_BIN', 'pi'),

  /**
   * Google Antigravity (`agy`) bridge. When enabled, `agy models` are offered
   * as `agy/<id>` refs and every turn on such a model is delegated to the agy
   * CLI instead of pi.
   */
  agyEnabled: envBool('AGY_ENABLED', true),

  /** agy binary path */
  agyBin: env('AGY_BIN', 'agy'),

  /** Timeout for the `agy models` catalog probe */
  agyModelsTimeoutMs: envInt('AGY_MODELS_TIMEOUT_MS', 20000, { min: 1000 }),

  /**
   * Passed to agy as --print-timeout (agy's own default is 5m).
   *
   * A deliberate middle ground. 15m was too short: it ended a legitimate
   * multi-step deploy at exactly 900s. But unbounded is worse — agy can launch
   * a foreground daemon that never exits (observed: it started the nodriver
   * browser server without detaching, and run_command waited on it forever), and
   * a long cap turns that into a session locked up for hours. 60m covers real
   * work while still self-healing from a wedged tool.
   */
  agyPrintTimeout: env('AGY_PRINT_TIMEOUT', '60m'),

  /**
   * How long a single agy tool call may run before the transcript says so.
   * Without this a wedged command is invisible: the tool row is already on
   * screen with no result, and nothing distinguishes "slow" from "hung".
   */
  agyToolStallWarnMs: envInt('AGY_TOOL_STALL_WARN_MS', 120_000, { min: 5_000 }),

  /**
   * agy blocks on interactive tool-permission prompts, and Piweb has no UI to
   * answer them, so auto-approval is on by default. Turning it off makes any
   * tool-using agy turn hang until --print-timeout.
   */
  agySkipPermissions: envBool('AGY_SKIP_PERMISSIONS', true),

  /**
   * Stream the assistant's reply into the UI as it is generated, instead of
   * posting it only when the turn finishes. Costs one small SQLite write per
   * 150ms of output.
   */
  streamPartialText: envBool('STREAM_PARTIAL_TEXT', true),

  /** Default model for pi */
  piModel: env('PI_MODEL'),

  /** Thinking level for pi */
  piThinking: env('PI_THINKING'),

  /** Base directory for per-channel session folders */
  sessionsDir: env('SESSIONS_DIR', resolve(DEFAULT_DATA_DIR, 'sessions')),

  /** Days to retain archived sessions (0 = never clean) */
  archiveRetentionDays: envInt('ARCHIVE_RETENTION_DAYS', 30, { min: 0 }),

  /** SQLite database path */
  dbPath: env('DB_PATH', resolve(DEFAULT_DATA_DIR, 'gateway.db')),

  /** Bot trigger name (default: bot's own display name) */
  triggerName: env('TRIGGER_NAME', 'pi'),

  /** Max concurrent agent invocations */
  maxConcurrency: envInt('MAX_CONCURRENCY', 3, { min: 1 }),

  /** Max scheduled tasks enqueued per scheduler tick */
  maxScheduledConcurrency: envInt('MAX_SCHEDULED_CONCURRENCY', 1, { min: 1 }),

  /** Poll interval for message queue (ms) */
  pollInterval: envInt('POLL_INTERVAL_MS', 1000, { min: 1 }),

  /** Graceful shutdown timeout before aborting in-flight tasks (ms) */
  shutdownTimeoutMs: envInt('SHUTDOWN_TIMEOUT_MS', 15_000, { min: 0 }),

  /** Log level */
  logLevel: env('LOG_LEVEL', 'info'),

  /** Working directory for pi agent */
  piCwd: env('PI_CWD', homedir()),

  /** Extra pi flags (space-separated) */
  piExtraFlags: env('PI_EXTRA_FLAGS'),

  /** CPU-only llama.cpp binary used for ephemeral first-prompt session titles. */
  sessionTitleBin: env('SESSION_TITLE_BIN'),

  /** Small GGUF model loaded by the one-shot CPU title process. */
  sessionTitleModelPath: env('SESSION_TITLE_MODEL_PATH'),

  /** Hard timeout for the one-shot title summary process. */
  sessionTitleTimeoutMs: envInt('SESSION_TITLE_TIMEOUT_MS', 60_000, { min: 1_000 }),

  /**
   * When a triggering message lands in a top-level guild text channel, spin up
   * a thread off that message and route the conversation into it. Follow-ups
   * inside the thread don't need to re-trigger. DMs are unaffected (no threads).
   */
  autoThread: envBool('AUTO_THREAD', false),

  /**
   * When a new message arrives while pi is still processing an earlier one in
   * the same channel, interrupt the in-flight run (SIGTERM the pi subprocess —
   * "pi stop") and process the new message instead, replying `interrupt` to
   * acknowledge. When false, new messages queue and wait for the current run to
   * finish (the original serial behaviour).
   */
  interruptOnNewMessage: envBool('INTERRUPT_ON_NEW_MESSAGE', true),

  /**
   * Run pi as a persistent `--mode rpc` session per channel instead of a
   * one-shot `pi -p` per message. Lets a new message that arrives mid-turn be
   * *steered* into the running turn (redirect the agent in-flight) rather than
   * killing the process. When false, the gateway uses the original one-shot
   * print-mode path (and INTERRUPT_ON_NEW_MESSAGE's kill-based interrupt).
   */
  rpcSteer: envBool('RPC_STEER', false),

  /**
   * Idle timeout (ms) after which a persistent RPC session is shut down to free
   * memory. The next message respawns it (pi --continue reloads the session).
   */
  rpcIdleTimeoutMs: envInt('RPC_IDLE_TIMEOUT_MS', 600000),

  /**
   * Force every channel (including DMs and auto-threads) to require the
   * trigger prefix / @bot mention before pi responds. Overrides each
   * registered channel's per-channel `requiresTrigger` flag.
   */
  alwaysRequireTrigger: envBool('ALWAYS_REQUIRE_TRIGGER', false),

  /**
   * Live-stream pi's intermediate events (thinking, tool calls, tool results)
   * into the channel as separate messages while pi is still running. The
   * final assistant text still flows through the normal outbox/marker path,
   * so attachments keep working. Disable to fall back to the old buffer-then-
   * send-final-text behavior.
   */
  streamThinking: envBool('STREAM_THINKING', true),
  streamTools: envBool('STREAM_TOOLS', true),

  /** Truncate any single streamed event message to this many chars (Discord caps at 2000). */
  maxEventChars: envInt('MAX_EVENT_CHARS', 1800, { min: 200 }),

  /** Auto-transcribe Discord voice/audio attachments with a local Breeze ASR HTTP server. */
  voiceAsrEnabled: envBool('VOICE_ASR_ENABLED', true),
  voiceAsrUrl: env('VOICE_ASR_URL', 'http://127.0.0.1:8025'),
  voiceAsrTimeoutMs: envInt('VOICE_ASR_TIMEOUT_MS', 30_000, { min: 1000 }),
  voiceAsrRetries: envInt('VOICE_ASR_RETRIES', 1, { min: 0 }),
  voiceAsrRetryDelayMs: envInt('VOICE_ASR_RETRY_DELAY_MS', 10_000, { min: 0 }),

  /** Auto-register DM channels */
  autoRegisterDMs: envBool('AUTO_REGISTER_DMS', true),

  /** Channel access policy: open, open-trigger, or allowlist */
  channelPolicy: parseChannelPolicy(env('CHANNEL_POLICY', 'allowlist')),

  /** Comma-separated channel IDs to exclude from auto-registration */
  excludedChannels: new Set(
    env('EXCLUDED_CHANNELS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),

  /** Max size for a single Discord attachment in bytes (0 disables the limit) */
  maxAttachmentBytes: envInt('MAX_ATTACHMENT_BYTES', 25 * 1024 * 1024, { min: 0 }),

  /** Max combined attachment size per Discord message in bytes (0 disables the limit) */
  maxTotalAttachmentBytes: envInt('MAX_TOTAL_ATTACHMENT_BYTES', 50 * 1024 * 1024, { min: 0 }),

  // ── piweb: web server ──

  /** Port the web UI/API listens on */
  webPort: envInt('WEB_PORT', 8099, { min: 1 }),

  /**
   * Bind address. Defaults to loopback: the Tailscale sidecar shares this
   * container's network namespace and proxies to 127.0.0.1, so loopback is
   * enough — and it is what makes the injected identity headers trustworthy
   * (nothing else on the docker network can reach the port to forge them).
   * Only widen this if you are NOT using WEB_TRUST_TAILSCALE_IDENTITY.
   */
  webHost: env('WEB_HOST', '127.0.0.1'),

  /**
   * Shared secret required to use the UI. pi can run arbitrary commands on the
   * host, so an empty token is refused at startup rather than silently serving
   * an unauthenticated remote-code-execution endpoint.
   */
  webAuthToken: env('WEB_AUTH_TOKEN'),

  /**
   * Accept `tailscale serve`'s injected identity headers instead of requiring
   * the token. Trusted ONLY for connections arriving on loopback, because any
   * client that can open the port directly can simply set the header itself.
   */
  webTrustTailscaleIdentity: envBool('WEB_TRUST_TAILSCALE_IDENTITY', true),

  /**
   * Comma-separated Tailscale logins allowed in (e.g. "you@github"). Empty =>
   * any tailnet user with an identity. Tagged devices carry no user identity
   * and are always rejected on this path.
   */
  webAllowedLogins: env('WEB_ALLOWED_LOGINS'),

  /**
   * Public origin, e.g. https://piweb.example.ts.net — used to reject
   * cross-site state-changing requests. Identity headers do NOT stop CSRF:
   * serve stamps the device's identity onto ANY request the browser makes,
   * including one triggered by a malicious page, so the Origin check is what
   * actually prevents that. Empty => same-origin is inferred from Host.
   */
  webPublicOrigin: env('WEB_PUBLIC_ORIGIN'),

  /** How long a login cookie stays valid (seconds) */
  webSessionTtlSec: envInt('WEB_SESSION_TTL_SEC', 30 * 24 * 3600, { min: 60 }),

  /** Where agent-produced files are copied so the browser can fetch them */
  webMediaDir: env('WEB_MEDIA_DIR', resolve(DEFAULT_DATA_DIR, 'web-media')),

  /** Where browser uploads are staged before being handed to pi as @file args */
  webUploadDir: env('WEB_UPLOAD_DIR', resolve(DEFAULT_DATA_DIR, 'web-uploads')),

  /**
   * Days a deleted session stays in the trash before it is purged for good
   * (0 disables automatic purging). Purging destroys the transcript AND pi's
   * session directory, which is why deletion is soft by default.
   */
  webTrashRetentionDays: envInt('WEB_TRASH_RETENTION_DAYS', 30, { min: 0 }),

  /**
   * Run the pi worker loop inside the web process. Off by default: the worker
   * normally runs on the host (full host access) while the web server runs in
   * Docker. Turn on for an all-in-one container.
   */
  webEmbeddedWorker: envBool('WEB_EMBEDDED_WORKER', false),
} as const;

export type Config = typeof config;
