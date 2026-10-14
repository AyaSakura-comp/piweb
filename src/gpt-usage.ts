import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const JWT_AUTH_CLAIM = 'https://api.openai.com/auth';
const DEFAULT_MODEL = 'gpt-5.5';

interface OAuthCredential {
  type: 'oauth';
  access: string;
  refresh: string;
  expires?: number;
  accountId?: string;
}

interface AuthStore {
  [provider: string]: unknown;
  'openai-codex'?: OAuthCredential;
}

export interface GptUsageWindow {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetAt: number | null;
  resetAfterSeconds: number | null;
}

export interface GptUsageData {
  plan: string | null;
  activeLimit: string | null;
  credits: {
    balance: number | null;
    hasCredits: string | null;
    unlimited: string | null;
  };
  primary: GptUsageWindow;
  secondary: GptUsageWindow;
  httpStatus: number;
}

export interface GptUsageOptions {
  authPath?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function defaultAuthPath(): string {
  return process.env.PI_AUTH_PATH || join(homedir(), '.pi/agent/auth.json');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeAccountId(accessToken: string): string | null {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const claim = decoded[JWT_AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
    return typeof claim?.chatgpt_account_id === 'string' && claim.chatgpt_account_id
      ? claim.chatgpt_account_id
      : null;
  } catch {
    return null;
  }
}

function isOAuthCredential(value: unknown): value is OAuthCredential {
  if (!value || typeof value !== 'object') return false;
  const credential = value as Partial<OAuthCredential>;
  return (
    credential.type === 'oauth' &&
    typeof credential.access === 'string' &&
    credential.access.length > 0 &&
    typeof credential.refresh === 'string'
  );
}

async function loadAuthStore(authPath: string): Promise<AuthStore> {
  let raw: string;
  try {
    raw = await readFile(authPath, 'utf8');
  } catch {
    throw new Error(
      `Cannot read ${authPath} — is pi logged into ChatGPT? Run pi → /login (ChatGPT Plus/Pro).`,
    );
  }

  try {
    return JSON.parse(raw) as AuthStore;
  } catch {
    throw new Error(`Cannot parse ${authPath} — run pi → /login again to repair authentication.`);
  }
}

function isFsError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as NodeJS.ErrnoException).code) === code
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireAuthLock(authPath: string): Promise<() => Promise<void>> {
  const lockPath = `${authPath}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!isFsError(error, 'EEXIST')) throw error;

      // Match pi's proper-lockfile convention. Its default stale interval is
      // shorter than this; 30 seconds avoids removing a healthy, heartbeating lock.
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for pi's authentication lock: ${lockPath}`);
}

async function saveCredential(authPath: string, credential: OAuthCredential): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireAuthLock(authPath);
    const latestStore = await loadAuthStore(authPath);
    latestStore['openai-codex'] = credential;
    await writeFile(authPath, JSON.stringify(latestStore, null, 2), { mode: 0o600 });
    await chmod(authPath, 0o600);
  } catch (error) {
    throw new Error(`Cannot persist refreshed pi credentials: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    await release?.();
  }
}

async function refreshCredential(
  credential: OAuthCredential,
  authPath: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<OAuthCredential> {
  if (!credential.refresh) {
    throw new Error('OpenAI Codex OAuth credential has no refresh token. Run pi → /login again.');
  }

  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refresh,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
    });
  } catch (error) {
    throw new Error(`OpenAI Codex token refresh failed: ${errorMessage(error)}`, { cause: error });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `OpenAI Codex token refresh failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    );
  }

  const token = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof token.access_token !== 'string' ||
    typeof token.refresh_token !== 'string' ||
    typeof token.expires_in !== 'number'
  ) {
    throw new Error('OpenAI Codex token refresh returned incomplete credentials.');
  }

  const accountId = decodeAccountId(token.access_token);
  if (!accountId) {
    throw new Error('OpenAI Codex token refresh returned a token without an account ID.');
  }

  const refreshed: OAuthCredential = {
    type: 'oauth',
    access: token.access_token,
    refresh: token.refresh_token,
    expires: now() + token.expires_in * 1000,
    accountId,
  };
  await saveCredential(authPath, refreshed);
  return refreshed;
}

function parseWindow(raw: unknown): GptUsageWindow {
  if (!raw || typeof raw !== 'object') {
    return {
      usedPercent: null,
      windowMinutes: null,
      resetAt: null,
      resetAfterSeconds: null,
    };
  }
  const w = raw as Record<string, unknown>;
  const usedPercent =
    typeof w.used_percent === 'number' && Number.isFinite(w.used_percent) ? w.used_percent : null;
  const limitWindowSeconds =
    typeof w.limit_window_seconds === 'number' && Number.isFinite(w.limit_window_seconds)
      ? w.limit_window_seconds
      : null;
  const windowMinutes = limitWindowSeconds != null ? Math.round(limitWindowSeconds / 60) : null;
  const resetAt =
    typeof w.reset_at === 'number' && Number.isFinite(w.reset_at) ? w.reset_at : null;
  const resetAfterSeconds =
    typeof w.reset_after_seconds === 'number' && Number.isFinite(w.reset_after_seconds)
      ? w.reset_after_seconds
      : null;

  return {
    usedPercent,
    windowMinutes,
    resetAt,
    resetAfterSeconds,
  };
}

/**
 * Query ChatGPT/Codex quota using pi's OAuth credential via the WHAM usage endpoint.
 */
export async function getGptUsage(options: GptUsageOptions = {}): Promise<GptUsageData> {
  const authPath = options.authPath || defaultAuthPath();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const store = await loadAuthStore(authPath);
  let credential = store['openai-codex'];

  if (!isOAuthCredential(credential)) {
    throw new Error(
      'No openai-codex OAuth credentials in auth.json. Run pi → /login and pick ChatGPT Plus/Pro (Codex).',
    );
  }

  if (typeof credential.expires === 'number' && now() >= credential.expires - 60_000) {
    credential = await refreshCredential(credential, authPath, fetchImpl, now);
  }

  const accountId = credential.accountId || decodeAccountId(credential.access);
  if (!accountId) {
    throw new Error('Cannot extract the ChatGPT account ID. Run pi → /login again.');
  }

  const controller = new AbortController();
  let response: Response;
  let json: any = null;
  try {
    response = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.access}`,
        'chatgpt-account-id': accountId,
        originator: 'pi',
        'User-Agent': 'piweb',
      },
      signal: controller.signal,
    });
    if (response.status === 401) {
      throw new Error('authentication failed (HTTP 401)');
    }
    if (!response.ok) {
      throw new Error(`Codex usage request failed (HTTP ${response.status})`);
    }
    json = await response.json();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('authentication failed') ||
        error.message.startsWith('Codex usage request failed'))
    ) {
      throw error;
    }
    throw new Error(`Codex usage request failed: ${errorMessage(error)}`, { cause: error });
  } finally {
    controller.abort();
  }

  const rawCredits = json?.credits;
  let balance: number | null = null;
  if (rawCredits?.balance != null) {
    const num = Number(rawCredits.balance);
    balance = Number.isFinite(num) ? num : null;
  }

  let hasCredits: string | null = null;
  if (rawCredits?.has_credits === true) {
    hasCredits = 'True';
  } else if (rawCredits?.has_credits === false) {
    hasCredits = 'False';
  } else if (typeof rawCredits?.has_credits === 'string') {
    hasCredits = rawCredits.has_credits;
  }

  let unlimited: string | null = null;
  if (rawCredits?.unlimited === true) {
    unlimited = 'True';
  } else if (rawCredits?.unlimited === false) {
    unlimited = 'False';
  } else if (typeof rawCredits?.unlimited === 'string') {
    unlimited = rawCredits.unlimited;
  }

  let activeLimit: string | null = null;
  if (typeof json?.rate_limit_reached_type === 'string') {
    activeLimit = json.rate_limit_reached_type;
  } else if (json?.rate_limit_reached_type && typeof json.rate_limit_reached_type === 'object') {
    activeLimit =
      (json.rate_limit_reached_type as any).type ?? JSON.stringify(json.rate_limit_reached_type);
  }

  const primary = parseWindow(json?.rate_limit?.primary_window);
  const secondary = parseWindow(json?.rate_limit?.secondary_window);

  if (primary.usedPercent == null && secondary.usedPercent == null) {
    throw new Error('no valid usage windows returned in rate limit data');
  }

  const usage: GptUsageData = {
    plan: json?.plan_type ? String(json.plan_type) : null,
    activeLimit,
    credits: {
      balance,
      hasCredits,
      unlimited,
    },
    primary,
    secondary,
    httpStatus: response.status,
  };

  return usage;
}

function taiwanTime(epochSeconds: number | null): string {
  if (!epochSeconds) return '—';
  const timestamp = new Date(epochSeconds * 1000).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour12: false,
  });
  return `${timestamp} (台灣時間)`;
}

function duration(seconds: number | null): string {
  if (seconds == null) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} 小時 ${remainder} 分`;
}

function usageBar(percent: number | null): string {
  if (percent == null) return '';
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function windowDuration(minutes: number | null): string {
  if (minutes == null) return '?';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小時`;
  return `${minutes} 分`;
}

function remaining(percent: number | null): string {
  return percent == null ? '—' : String(100 - percent);
}

/** Format a quota report for piweb and Discord users. */
export function formatGptUsage(data: GptUsageData): string {
  const primary = data.primary;
  const secondary = data.secondary;
  const lines = [
    `🤖 ChatGPT/Codex 用量  (方案: ${data.plan ?? '?'}${data.activeLimit ? ` / ${data.activeLimit}` : ''})`,
    '',
    `🟠 短窗 (${windowDuration(primary.windowMinutes)} 滾動)`,
    `   已用 ${primary.usedPercent ?? '—'}%  剩 ${remaining(primary.usedPercent)}%   ${usageBar(primary.usedPercent)}`,
    `   重置: ${taiwanTime(primary.resetAt)} (還有 ${duration(primary.resetAfterSeconds)})`,
    '',
    `🔵 長窗 (${windowDuration(secondary.windowMinutes)})`,
    `   已用 ${secondary.usedPercent ?? '—'}%  剩 ${remaining(secondary.usedPercent)}%   ${usageBar(secondary.usedPercent)}`,
    `   重置: ${taiwanTime(secondary.resetAt)} (還有 ${duration(secondary.resetAfterSeconds)})`,
  ];

  if (data.credits.balance != null) {
    lines.push(
      '',
      `💳 額外 credits: ${data.credits.balance}${data.credits.unlimited === 'True' ? ' (unlimited)' : ''}`,
    );
  }
  if (data.httpStatus === 429) {
    lines.push('', '⚠️ 目前短窗已達上限 (429)，要等重置或換模型/本機 qwen。');
  } else if (primary.usedPercent !== null && primary.usedPercent >= 100) {
    lines.push('', '⚠️ 目前短窗已達上限，要等重置或換模型/本機 qwen。');
  }
  return lines.join('\n');
}

export async function getGptUsageText(options: GptUsageOptions = {}): Promise<string> {
  return formatGptUsage(await getGptUsage(options));
}
