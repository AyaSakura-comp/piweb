import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Used by Claude Code /usage. Internal endpoint: fail closed on auth/schema changes.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export class ClaudeUsageError extends Error {}

function resetDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function taipei(date: Date): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** "還有 1 天 3 小時" / "還有 42 分" — the same phrasing /gpt-usage and /agy-usage use. */
function remaining(until: Date, now: number): string {
  const minutes = Math.max(0, Math.round((until.getTime() - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return `還有 ${days} 天 ${hours} 小時`;
  if (hours) return `還有 ${hours} 小時 ${mins} 分`;
  return `還有 ${mins} 分`;
}

/** Ten-cell bar matching /gpt-usage and /agy-usage. */
function bar(percent: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(percent / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/** Monospace columns: CJK characters take two cells. */
function cells(text: string): number {
  return [...text].reduce((n, ch) => n + (/[\u2E80-\uFFEF]/.test(ch) ? 2 : 1), 0);
}

function light(percent: number): string {
  if (percent >= 90) return '🔴';
  if (percent >= 60) return '🟠';
  return '🟢';
}

export function formatClaudeUsage(data: unknown, now = Date.now()): string {
  const lines = ['🤖 Claude Code 用量（主機登入帳號，非單一對話）', ''];
  const labels = [
    ['five_hour', '5 小時窗'],
    ['seven_day', '週窗'],
    ['seven_day_sonnet', 'Sonnet 週窗'],
    ['seven_day_opus', 'Opus 週窗'],
  ];
  const present = labels.filter(([key]) => Number.isFinite((data as any)?.[key]?.utilization));
  const width = Math.max(0, ...present.map(([, label]) => cells(label)));
  let found = false;
  for (const [key, label] of labels) {
    const bucket = (data as any)?.[key];
    if (
      typeof bucket?.utilization !== 'number' ||
      !Number.isFinite(bucket.utilization) ||
      bucket.utilization < 0
    )
      continue;
    found = true;
    const percent = Math.round(bucket.utilization * 10) / 10;
    const reset = resetDate(bucket.resets_at);
    lines.push(
      `${light(percent)} ${label}${' '.repeat(width - cells(label) + 2)}已用 ${percent}%  剩 ${Math.max(0, Math.round((100 - percent) * 10) / 10)}%  ${bar(percent)}`,
      `   重置 ${reset ? `${taipei(reset)}（${remaining(reset, now)}）` : '未提供'}`,
    );
  }
  if (!found) lines.push('服務未提供可用的額度資料；不代表使用量為零。');
  lines.push('', `查詢 ${taipei(new Date(now))} 台北時間 · 結果最多快取 60 秒`);
  return lines.join('\n');
}

/** Worker-only; read credentials locally, never copy tokens into events or logs. */
export function createClaudeUsageReader(
  options: {
    readAuth?: () => Promise<unknown>;
    fetcher?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const readAuth =
    options.readAuth ??
    (async () =>
      JSON.parse(
        await readFile(
          join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json'),
          'utf8',
        ),
      ));
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let cache: { key: string; until: number; promise: Promise<string> } | undefined;
  async function request(token: string): Promise<string> {
    let response: Response;
    try {
      response = await fetcher(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ClaudeUsageError('無法連線 Claude usage，請稍後再試。');
    }
    if (response.status === 401 || response.status === 403)
      throw new ClaudeUsageError('Claude 登入已過期或權限不足，請在主機 Claude Code 重新登入。');
    if (response.status === 429)
      throw new ClaudeUsageError('Claude usage 查詢過於頻繁，請稍候再試。');
    if (!response.ok) throw new ClaudeUsageError('無法取得 Claude usage，服務暫時不可用。');
    try {
      return formatClaudeUsage(await response.json(), now());
    } catch {
      throw new ClaudeUsageError('Claude usage 回應格式無法辨識。');
    }
  }
  return async (): Promise<string> => {
    let auth: any;
    try {
      auth = await readAuth();
    } catch {
      throw new ClaudeUsageError('找不到可用的 Claude Code 登入資訊，請先在主機登入。');
    }
    const token = auth?.claudeAiOauth?.accessToken;
    if (typeof token !== 'string' || !token.trim())
      throw new ClaudeUsageError(
        'Claude Code 尚未使用訂閱帳號登入；API key 不提供此訂閱額度查詢。',
      );
    const key = createHash('sha256').update(token).digest('hex');
    if (cache?.key === key && now() < cache.until) return cache.promise;
    const promise = request(token);
    cache = { key, until: now() + 60000, promise };
    return promise;
  };
}

export const getClaudeUsageText = createClaudeUsageReader();
