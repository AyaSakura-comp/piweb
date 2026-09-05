/**
 * Usage reporting for the Antigravity (`agy`) CLI.
 *
 * agy has no usage subcommand, but the CLI itself calls an internal Code Assist
 * RPC that returns the account's quota buckets, and it authenticates with the
 * OAuth token agy already stores on disk. This module reuses both.
 *
 * The endpoint is gated on **client identity sent as a User-Agent header**, not
 * on the request body: the same token with no User-Agent returns
 *   403 PERMISSION_DENIED / SUBSCRIPTION_REQUIRED "You do not have a valid
 *   license of this product"
 * which reads like an account problem and is not one. Sending
 * `antigravity-cli/<version>` makes the identical request succeed. Do not
 * "simplify" the header away.
 */
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { config } from './config.js';

const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const USER_AGENT = 'antigravity-cli/1.1.13';

/**
 * The control loop drains commands strictly serially and does not schedule its
 * next tick until the current one resolves, so a request that never settles
 * wedges every command for every session — `/pi stop` included. Node's fetch
 * has no default timeout, so this bound is the only thing preventing that.
 */
const QUOTA_TIMEOUT_MS = 10_000;

export function agyTokenPath(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

export interface AgyQuotaBucket {
  bucketId: string;
  displayName: string;
  window: string;
  resetTime: string;
  description?: string;
  remainingFraction: number;
}

export interface AgyQuotaGroup {
  displayName: string;
  description?: string;
  buckets: AgyQuotaBucket[];
}

export class AgyUsageError extends Error {}

export interface AgyAuth {
  auth_method?: string;
  token: {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expiry?: string;
  };
  [key: string]: unknown;
}

type OAuthClient = readonly [clientId: string, clientSecret: string];

interface AgyTokenDependencies {
  fetchImpl: typeof fetch;
  now: () => number;
  readAuth: () => Promise<AgyAuth>;
  oauthClientCandidates: () => Promise<OAuthClient[]>;
}

async function readAgyAuth(): Promise<AgyAuth> {
  let raw: string;
  try {
    raw = await readFile(agyTokenPath(), 'utf8');
  } catch {
    throw new AgyUsageError('找不到 agy 的登入憑證，請先在終端機跑一次 agy 登入。');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgyUsageError('agy 的憑證檔格式無法解析。');
  }
  if (typeof parsed?.token?.access_token !== 'string' || !parsed.token.access_token) {
    throw new AgyUsageError('agy 的憑證檔沒有 access token。');
  }
  return parsed as AgyAuth;
}

/** Extract the public installed-app OAuth client metadata bundled in agy. */
export function extractAgyOAuthClientCandidates(binary: Buffer): OAuthClient[] {
  const text = binary.toString('latin1');
  const ids = [...text.matchAll(/\d+-[a-z0-9-]+\.apps\.googleusercontent\.com/g)].map(
    (match) => match[0],
  );
  const secrets = [...text.matchAll(/GOCSPX-[A-Za-z0-9_-]{28}/g)].map((match) => match[0]);
  const candidates: OAuthClient[] = [];
  for (const id of ids.reverse()) {
    for (const secret of secrets) {
      if (!candidates.some(([seenId, seenSecret]) => seenId === id && seenSecret === secret)) {
        candidates.push([id, secret]);
        if (candidates.length === 8) return candidates;
      }
    }
  }
  return candidates;
}

async function resolveAgyBinaryPath(): Promise<string> {
  if (isAbsolute(config.agyBin) || config.agyBin.includes('/')) return config.agyBin;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, config.agyBin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new AgyUsageError(`在 PATH 中找不到 agy 執行檔：${config.agyBin}`);
}

async function findAgyOAuthClientCandidates(): Promise<OAuthClient[]> {
  const envId = process.env.AGY_OAUTH_CLIENT_ID;
  const envSecret = process.env.AGY_OAUTH_CLIENT_SECRET;
  if (envId && envSecret) return [[envId, envSecret]];

  const agyBinary = await resolveAgyBinaryPath();
  let binary: Buffer;
  try {
    binary = await readFile(agyBinary);
  } catch {
    throw new AgyUsageError(`無法讀取 agy 執行檔以自動換發憑證：${agyBinary}`);
  }
  // Current agy builds contain two IDs and two secrets. The active pair is
  // first in this ordering; keep fallback combinations for version changes but
  // cap them so malformed binaries cannot turn refresh into an unbounded loop.
  const candidates = extractAgyOAuthClientCandidates(binary).slice(0, 8);
  if (candidates.length === 0) {
    throw new AgyUsageError('agy 執行檔中找不到 OAuth client metadata，無法自動換發憑證。');
  }
  return candidates;
}

const DEFAULT_TOKEN_DEPENDENCIES: AgyTokenDependencies = {
  fetchImpl: fetch,
  now: Date.now,
  readAuth: readAgyAuth,
  oauthClientCandidates: findAgyOAuthClientCandidates,
};

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function refreshAgyAuth(auth: AgyAuth, dependencies: AgyTokenDependencies): Promise<AgyAuth> {
  const refreshToken = auth.token.refresh_token;
  if (!refreshToken) throw new AgyUsageError('agy 憑證沒有 refresh token，請重新登入。');

  let lastStatus = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTA_TIMEOUT_MS);
  try {
    const candidates = await withAbort(dependencies.oauthClientCandidates(), controller.signal);
    for (const [clientId, clientSecret] of candidates) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      const response = await dependencies.fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      lastStatus = response.status;
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) continue;
        throw new AgyUsageError(`agy 憑證自動換發失敗 (HTTP ${response.status})。`);
      }

      let result: any;
      try {
        result = await response.json();
      } catch (error: any) {
        if (error?.name === 'AbortError') throw error;
        throw new AgyUsageError('agy 憑證自動換發回應不是合法 JSON。');
      }
      if (typeof result?.access_token !== 'string' || !result.access_token) {
        throw new AgyUsageError('agy 憑證自動換發回應缺少 access token。');
      }
      const expiresIn = Number(result.expires_in ?? 3600);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) {
        throw new AgyUsageError('agy 憑證自動換發回應的有效期限不合法。');
      }
      return {
        ...auth,
        token: {
          ...auth.token,
          access_token: result.access_token,
          refresh_token: result.refresh_token ?? refreshToken,
          token_type: result.token_type ?? auth.token.token_type ?? 'Bearer',
          expiry: new Date(dependencies.now() + expiresIn * 1000).toISOString(),
        },
      };
    }
  } catch (error: any) {
    if (error instanceof AgyUsageError) throw error;
    throw new AgyUsageError(
      error?.name === 'AbortError'
        ? `agy 憑證自動換發逾時（${QUOTA_TIMEOUT_MS / 1000} 秒）。`
        : `agy 憑證自動換發失敗：${error?.message ?? error}`,
    );
  } finally {
    clearTimeout(timer);
  }
  throw new AgyUsageError(`agy 憑證自動換發失敗 (HTTP ${lastStatus || 'unknown'})，請重新登入。`);
}

/** Return a usable token, refreshing it in memory when needed. */
export async function getAgyAccessToken(
  forceRefresh = false,
  overrides: Partial<AgyTokenDependencies> = {},
): Promise<string> {
  const dependencies = { ...DEFAULT_TOKEN_DEPENDENCIES, ...overrides };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTA_TIMEOUT_MS);
  try {
    let auth = await withAbort(dependencies.readAuth(), controller.signal);
    const expiry = auth.token.expiry ? Date.parse(auth.token.expiry) : NaN;
    if (forceRefresh || (Number.isFinite(expiry) && expiry - dependencies.now() < 60_000)) {
      auth = await withAbort(refreshAgyAuth(auth, dependencies), controller.signal);
    }
    return auth.token.access_token;
  } catch (error: any) {
    if (error instanceof AgyUsageError) throw error;
    throw new AgyUsageError(
      error?.name === 'AbortError'
        ? `讀取或換發 agy 憑證逾時（${QUOTA_TIMEOUT_MS / 1000} 秒）。`
        : `讀取或換發 agy 憑證失敗：${error?.message ?? error}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Backwards-compatible reader used by callers that only need the current token. */
export async function readAgyAccessToken(): Promise<string> {
  return (await readAgyAuth()).token.access_token;
}

export async function fetchAgyQuota(
  fetchImpl: typeof fetch = fetch,
  tokenOverride?: string,
  tokenProvider: (forceRefresh: boolean) => Promise<string> = (forceRefresh) =>
    getAgyAccessToken(forceRefresh, { fetchImpl }),
): Promise<AgyQuotaGroup[]> {
  let token = tokenOverride ?? (await tokenProvider(false));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUOTA_TIMEOUT_MS);
    let response: Awaited<ReturnType<typeof fetch>>;
    let text: string;
    try {
      response = await fetchImpl(QUOTA_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: '{}',
        signal: controller.signal,
      });
      text = await response.text();
    } catch (err: any) {
      throw new AgyUsageError(
        err?.name === 'AbortError'
          ? `查詢 agy 額度逾時（${QUOTA_TIMEOUT_MS / 1000} 秒）。`
          : `查詢 agy 額度失敗：${err?.message ?? err}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 && attempt === 0 && !tokenOverride) {
      token = await tokenProvider(true);
      continue;
    }
    if (response.status === 401) {
      throw new AgyUsageError('agy 憑證自動換發後仍被拒絕，請重新登入。');
    }
    if (response.status === 403) {
      throw new AgyUsageError('agy 額度 API 拒絕存取；登入仍可能有效，請檢查帳號授權或方案權限。');
    }
    if (!response.ok) {
      throw new AgyUsageError(`查詢 agy 額度失敗 (HTTP ${response.status})：${text.slice(0, 200)}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AgyUsageError('agy 額度回應不是合法 JSON。');
    }
    return Array.isArray(parsed?.groups) ? parsed.groups : [];
  }
  throw new AgyUsageError('查詢 agy 額度失敗。');
}

function bar(remainingFraction: number): string {
  const used = Math.min(10, Math.max(0, Math.round((1 - remainingFraction) * 10)));
  return '█'.repeat(used) + '░'.repeat(10 - used);
}

function dot(remainingFraction: number): string {
  if (remainingFraction <= 0.05) return '🔴';
  if (remainingFraction <= 0.25) return '🟠';
  return '🟢';
}

/** "還有 5 天 6 小時" / "還有 36 分" */
export function humanizeUntil(resetTime: string, now: number): string {
  const at = Date.parse(resetTime);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return '已重置';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `還有 ${days} 天 ${hours} 小時`;
  if (hours > 0) return `還有 ${hours} 小時 ${minutes} 分`;
  return `還有 ${minutes} 分`;
}

/** "08/23 18:06" — the year is noise for a window that resets within a week. */
function localTime(resetTime: string): string {
  const at = new Date(resetTime);
  if (Number.isNaN(at.getTime())) return resetTime;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * agy's own bucket labels ("Five Hour Limit Remaining") plus a reset stamp
 * overflow a 390px phone and get clipped mid-bar, so the window field drives a
 * short label instead.
 */
function windowLabel(bucket: AgyQuotaBucket): string {
  if (bucket.window === 'weekly') return '週窗';
  if (bucket.window === '5h') return '5小時窗';
  return bucket.displayName;
}

export function formatAgyUsage(groups: AgyQuotaGroup[], now = Date.now()): string {
  if (groups.length === 0) return '🤖 Antigravity (agy) 用量：沒有回報任何額度資訊。';

  // Kept narrow on purpose: this renders in a code block on a phone, and the
  // group descriptions agy returns ("Models within this group: …") are alone
  // wide enough to push the bars off screen.
  const lines = ['🤖 Antigravity (agy) 用量'];
  for (const group of groups) {
    lines.push('', `▸ ${group.displayName}`);
    for (const bucket of group.buckets ?? []) {
      const remaining = Number(bucket.remainingFraction ?? 0);
      const usedPercent = Math.round((1 - remaining) * 100);
      const label = windowLabel(bucket).padEnd(6, ' ');
      lines.push(`  ${dot(remaining)} ${label} 已用 ${usedPercent}% ${bar(remaining)}`);
      lines.push(`     ${localTime(bucket.resetTime)} ${humanizeUntil(bucket.resetTime, now)}`);
    }
  }
  return lines.join('\n');
}

export async function getAgyUsageReport(fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    return formatAgyUsage(await fetchAgyQuota(fetchImpl));
  } catch (err: any) {
    if (err instanceof AgyUsageError) return `⚠️ ${err.message}`;
    return `⚠️ 查詢 agy 額度時發生錯誤：${err?.message ?? err}`;
  }
}
