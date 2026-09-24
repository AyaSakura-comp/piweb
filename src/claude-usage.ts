import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Used by Claude Code /usage. Internal endpoint: fail closed on auth/schema changes.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export class ClaudeUsageError extends Error {}

function timestamp(value: unknown): string {
  if (typeof value !== 'string') return '未提供';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '未提供';
  return (
    new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date) + ' 台北時間'
  );
}

export function formatClaudeUsage(data: unknown, now = Date.now()): string {
  const lines = [
    'Claude current status / usage',
    '來源：主機 Claude Code 登入帳號（非單一對話 token 統計）',
  ];
  const labels = [
    ['five_hour', '目前時段（5 小時）'],
    ['seven_day', '本週'],
    ['seven_day_sonnet', 'Sonnet 本週'],
    ['seven_day_opus', 'Opus 本週'],
  ];
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
    lines.push(
      `${label}：${Math.round(bucket.utilization * 10) / 10}% 已使用`,
      `  重置：${timestamp(bucket.resets_at)}`,
    );
  }
  if (!found) lines.push('服務未提供可用的額度資料；不代表使用量為零。');
  lines.push(`查詢：${timestamp(new Date(now).toISOString())}`, '結果最多快取 60 秒。');
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
