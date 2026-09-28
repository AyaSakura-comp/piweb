import { describe, expect, it, vi } from 'vitest';
import { createClaudeUsageReader, formatClaudeUsage } from '../src/claude-usage.js';
const payload = {
  five_hour: { utilization: 4, resets_at: '2026-09-23T02:00:00Z' },
  seven_day: { utilization: 23, resets_at: null },
  seven_day_sonnet: null,
};
describe('Claude account usage', () => {
  it('formats actual utilization and optional model limits without inventing missing values', () => {
    const now = Date.parse('2026-09-23T00:15:00Z');
    const text = formatClaudeUsage(payload, now);
    expect(text).toContain('已用 4%  剩 96%  ░░░░░░░░░░');
    expect(text).toContain('🟢 5 小時窗');
    expect(text).toContain('（還有 1 小時 45 分）');
    expect(text).toContain('已用 23%  剩 77%  ██░░░░░░░░');
    expect(text).toContain('重置 未提供');
    expect(text).not.toContain('Sonnet');
    expect(formatClaudeUsage({}, 0)).toContain('未提供');
  });
  it('shows a full red bar near the limit', () => {
    const text = formatClaudeUsage({ seven_day: { utilization: 94, resets_at: null } }, 0);
    expect(text).toContain('🔴 週窗');
    expect(text).toContain('已用 94%  剩 6%  █████████░');
  });
  it('uses only the fixed OAuth endpoint and coalesces repeated requests', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload)));
    const reader = createClaudeUsageReader({
      readAuth: async () => ({ claudeAiOauth: { accessToken: 'test-secret' } }),
      fetcher,
      now: () => 1000,
    });
    const results = await Promise.all([reader(), reader()]);
    expect(results[0]).toEqual(results[1]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(results[0]).not.toContain('test-secret');
  });
  it.each([401, 429, 503])(
    'sanitizes HTTP %i and does not retry on repeated clicks',
    async (status) => {
      const fetcher = vi.fn(async () => new Response('private-secret', { status }));
      const reader = createClaudeUsageReader({
        readAuth: async () => ({ claudeAiOauth: { accessToken: 'test-secret' } }),
        fetcher,
        now: () => 1000,
      });
      await expect(reader()).rejects.toThrow(
        status === 401 ? /登入/ : status === 429 ? /頻繁/ : /無法/,
      );
      await expect(reader()).rejects.not.toThrow('private-secret');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('does not make a request without OAuth and never exposes file errors', async () => {
    const fetcher = vi.fn();
    const reader = createClaudeUsageReader({
      readAuth: async () => {
        throw Error('secret/path');
      },
      fetcher,
    });
    await expect(reader()).rejects.toThrow('登入');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('invalidates the cache on account/token change', async () => {
    let token = 'one';
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload)));
    const reader = createClaudeUsageReader({
      readAuth: async () => ({ claudeAiOauth: { accessToken: token } }),
      fetcher,
      now: () => 1000,
    });
    await reader();
    token = 'two';
    await reader();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
