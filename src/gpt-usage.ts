import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
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

function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function usageWindow(headers: Headers, prefix: 'primary' | 'secondary'): GptUsageWindow {
  return {
    usedPercent: numberHeader(headers, `x-codex-${prefix}-used-percent`),
    windowMinutes: numberHeader(headers, `x-codex-${prefix}-window-minutes`),
    resetAt: numberHeader(headers, `x-codex-${prefix}-reset-at`),
    resetAfterSeconds: numberHeader(headers, `x-codex-${prefix}-reset-after-seconds`),
  };
}

/**
 * Query ChatGPT/Codex quota using pi's OAuth credential. The response stream is
 * aborted as soon as its headers arrive, so the probe consumes negligible quota.
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
  try {
    response = await fetchImpl(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.access}`,
        'chatgpt-account-id': accountId,
        originator: 'pi',
        'OpenAI-Beta': 'responses=experimental',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'piweb',
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        instructions: '',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hi' }],
          },
        ],
        stream: true,
        store: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`Codex usage request failed: ${errorMessage(error)}`, { cause: error });
  } finally {
    controller.abort();
  }

  const usage: GptUsageData = {
    plan: response.headers.get('x-codex-plan-type'),
    activeLimit: response.headers.get('x-codex-active-limit'),
    credits: {
      balance: numberHeader(response.headers, 'x-codex-credits-balance'),
      hasCredits: response.headers.get('x-codex-credits-has-credits'),
      unlimited: response.headers.get('x-codex-credits-unlimited'),
    },
    primary: usageWindow(response.headers, 'primary'),
    secondary: usageWindow(response.headers, 'secondary'),
    httpStatus: response.status,
  };

  if (usage.primary.usedPercent == null && usage.secondary.usedPercent == null) {
    throw new Error(
      `No X-Codex-* headers returned (HTTP ${response.status}). Token may be invalid — try pi → /login again.`,
    );
  }

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
  }
  return lines.join('\n');
}

export async function getGptUsageText(options: GptUsageOptions = {}): Promise<string> {
  return formatGptUsage(await getGptUsage(options));
}
