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

  const expiry = parsed?.token?.expiry ? Date.parse(parsed.token.expiry) : NaN;
  if (Number.isFinite(expiry) && expiry <= now) {
    throw new AgyUsageError(
      'agy 的 access token 已過期。跑一次 agy（任何 prompt）讓它自動換發後再查詢。',
    );
  }

  return token;
}

export async function fetchAgyQuota(fetchImpl: typeof fetch = fetch): Promise<AgyQuotaGroup[]> {
  const token = await readAgyAccessToken();
  const response = await fetchImpl(QUOTA_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: '{}',
  });

  const text = await response.text();
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

function localTime(resetTime: string): string {
  const at = new Date(resetTime);
  if (Number.isNaN(at.getTime())) return resetTime;
  return at.toLocaleString('zh-TW', { hour12: false });
}

export function formatAgyUsage(groups: AgyQuotaGroup[], now = Date.now()): string {
  if (groups.length === 0) return '🤖 Antigravity (agy) 用量：沒有回報任何額度資訊。';

  const lines = ['🤖 Antigravity (agy) 用量'];
  for (const group of groups) {
    lines.push('', `▸ ${group.displayName}`);
    if (group.description) lines.push(`  ${group.description}`);
    for (const bucket of group.buckets ?? []) {
      const remaining = Number(bucket.remainingFraction ?? 0);
      const usedPercent = Math.round((1 - remaining) * 100);
      lines.push(
        `  ${dot(remaining)} ${bucket.displayName}` +
          ` 已用 ${usedPercent}% 剩 ${100 - usedPercent}% ${bar(remaining)}`,
      );
      lines.push(`     重置: ${localTime(bucket.resetTime)} (${humanizeUntil(bucket.resetTime, now)})`);
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
