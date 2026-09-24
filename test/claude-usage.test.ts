import { describe, expect, it, vi } from 'vitest';
import { createClaudeUsageReader, formatClaudeUsage } from '../src/claude-usage.js';
const payload = {
  five_hour: { utilization: 4, resets_at: '2026-09-23T02:00:00Z' },
  seven_day: { utilization: 23, resets_at: null },
  seven_day_sonnet: null,
};
describe('Claude account usage', () => {
  it('formats actual utilization and optional model limits without inventing missing values', () => {
    const text = formatClaudeUsage(payload, 0);
    expect(text).toContain('目前時段（5 小時）：4%');
    expect(text).toContain('本週：23%');
    expect(text).not.toContain('Sonnet');
    expect(formatClaudeUsage({}, 0)).toContain('未提供');
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
