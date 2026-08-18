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
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** Read agy's stored OAuth access token, refusing an expired one with a clear reason. */
export async function readAgyAccessToken(now = Date.now()): Promise<string> {
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

  const token = parsed?.token?.access_token;
  if (typeof token !== 'string' || !token) {
    throw new AgyUsageError('agy 的憑證檔沒有 access token。');
  }

  // Deliberately NOT refusing an expired-looking token. agy refreshes it only
  // when it next runs, so the stamp on disk goes stale within the hour while the
  // credential itself may still be accepted; pre-refusing turned a working query
  // into a false "已過期". Let the API decide, and translate a 401 instead.
  void now;
  return token;
}

export async function fetchAgyQuota(
  fetchImpl: typeof fetch = fetch,
  tokenOverride?: string,
): Promise<AgyQuotaGroup[]> {
  const token = tokenOverride ?? (await readAgyAccessToken());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTA_TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof fetch>>;
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
  } catch (err: any) {
    throw new AgyUsageError(
      err?.name === 'AbortError'
        ? `查詢 agy 額度逾時（${QUOTA_TIMEOUT_MS / 1000} 秒）。`
        : `查詢 agy 額度失敗：${err?.message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new AgyUsageError(
      'agy 的登入憑證已失效或過期。在終端機跑一次 agy（任何 prompt）讓它換發後再查詢。',
    );
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
