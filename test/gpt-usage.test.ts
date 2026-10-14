import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatGptUsage, getGptUsage } from '../src/gpt-usage.js';

const tempDirs: string[] = [];

function jwt(accountId: string): string {
  const encoded = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `header.${encoded}.signature`;
}

async function authFile(credential: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'piweb-gpt-usage-'));
  tempDirs.push(dir);
  const path = join(dir, 'auth.json');
  await writeFile(
    path,
    JSON.stringify({ other: { type: 'api_key', key: 'keep-me' }, 'openai-codex': credential }),
  );
  return path;
}

function usageResponse(status = 200): Response {
  return new Response(JSON.stringify({
    plan_type: 'pro', rate_limit_reached_type: 'premium',
    credits: { balance: '12.5', has_credits: true, unlimited: false },
    rate_limit: {
      primary_window: { used_percent: 37, limit_window_seconds: 18000, reset_at: 1786429200, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 52, limit_window_seconds: 604800, reset_at: 1787000000, reset_after_seconds: 570800 },
    },
  }), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('getGptUsage', () => {
  it('reads pi OAuth credentials and reads usage JSON without submitting a model prompt', async () => {
    const authPath = await authFile({
      type: 'oauth',
      access: jwt('account-123'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
    });
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://chatgpt.com/backend-api/wham/usage');
      expect(init?.headers).toMatchObject({
        Authorization: expect.stringMatching(/^Bearer /),
        'chatgpt-account-id': 'account-123',
        originator: 'pi',
      });
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      capturedSignal = init?.signal ?? undefined;
      return usageResponse();
    });

    const usage = await getGptUsage({ authPath, fetchImpl: fetchImpl as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(true);
    expect(usage).toMatchObject({
      plan: 'pro',
      activeLimit: 'premium',
      httpStatus: 200,
      credits: { balance: 12.5, hasCredits: 'True', unlimited: 'False' },
      primary: { usedPercent: 37, windowMinutes: 300 },
      secondary: { usedPercent: 52, windowMinutes: 10080 },
    });
  });

  it('refreshes an expiring token, preserves unrelated auth entries, and probes with the new account', async () => {
    const authPath = await authFile({
      type: 'oauth',
      access: jwt('old-account'),
      refresh: 'old-refresh',
      expires: 1,
    });
    const newAccess = jwt('new-account');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        const concurrentlyUpdated = JSON.parse(await readFile(authPath, 'utf8'));
        concurrentlyUpdated.other.key = 'updated-while-refreshing';
        await writeFile(authPath, JSON.stringify(concurrentlyUpdated));
        return new Response(
          JSON.stringify({
            access_token: newAccess,
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      })
      .mockImplementationOnce(async (_input, init) => {
        expect(init?.headers).toMatchObject({
          Authorization: `Bearer ${newAccess}`,
          'chatgpt-account-id': 'new-account',
        });
        return usageResponse();
      });

    await getGptUsage({ authPath, fetchImpl, now: () => 1_000_000 });

    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://auth.openai.com/oauth/token');
    expect(String(fetchImpl.mock.calls[0][1]?.body)).toContain('refresh_token=old-refresh');
    const persisted = JSON.parse(await readFile(authPath, 'utf8'));
    expect(persisted.other).toEqual({ type: 'api_key', key: 'updated-while-refreshing' });
    expect(persisted['openai-codex']).toMatchObject({
      type: 'oauth',
      access: newAccess,
      refresh: 'new-refresh',
      expires: 4_600_000,
      accountId: 'new-account',
    });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it('reports a login hint when pi has no Codex OAuth credential', async () => {
    const authPath = await authFile({ type: 'api_key', key: 'not-oauth' });

    await expect(getGptUsage({ authPath, fetchImpl: vi.fn() as typeof fetch })).rejects.toThrow(
      'pi → /login',
    );
  });

  it.each([400, 403, 429, 500])('does not blame login for HTTP %s', async (status) => {
    const authPath = await authFile({ type: 'oauth', access: jwt('account-123'), refresh: 'secret-refresh', expires: Date.now() + 3600000 });
    const fetchImpl = vi.fn(async () => new Response('private upstream body', { status }));
    const error = await getGptUsage({ authPath, fetchImpl: fetchImpl as typeof fetch }).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).not.toMatch(/login|Token may|private upstream/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { rate_limit: {} }, { rate_limit: { primary_window: { used_percent: 'unknown' } } }])('rejects missing or invalid usage windows', async (body) => {
    const authPath = await authFile({ type: 'oauth', access: jwt('account-123'), refresh: 'refresh', expires: Date.now() + 3600000 });
    await expect(getGptUsage({ authPath, fetchImpl: vi.fn(async () => Response.json(body)) as typeof fetch })).rejects.toThrow('no valid usage windows');
  });

  it('accepts a single weekly window and zero usage', async () => {
    const authPath = await authFile({ type: 'oauth', access: jwt('account-123'), refresh: 'refresh', expires: Date.now() + 3600000 });
    const result = await getGptUsage({ authPath, fetchImpl: vi.fn(async () => Response.json({rate_limit: {secondary_window: {used_percent: 0, limit_window_seconds: 604800}}})) as typeof fetch });
    expect(result.primary.usedPercent).toBeNull();
    expect(result.secondary).toMatchObject({usedPercent: 0, windowMinutes: 10080});
  });

  it('rejects responses that contain no Codex rate-limit headers', async () => {
    const authPath = await authFile({
      type: 'oauth',
      access: jwt('account-123'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(getGptUsage({ authPath, fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(
      'authentication failed (HTTP 401)',
    );
  });
});

describe('formatGptUsage', () => {
  it('formats windows, remaining quota, reset time, credits, and a 429 warning in Traditional Chinese', () => {
    const output = formatGptUsage({
      plan: 'pro',
      activeLimit: 'premium',
      credits: { balance: 12.5, hasCredits: 'True', unlimited: 'False' },
      primary: {
        usedPercent: 37,
        windowMinutes: 300,
        resetAt: 1786429200,
        resetAfterSeconds: 3600,
      },
      secondary: {
        usedPercent: 52,
        windowMinutes: 10080,
        resetAt: 1787000000,
        resetAfterSeconds: 570800,
      },
      httpStatus: 429,
    });

    expect(output).toContain('方案: pro / premium');
    expect(output).toContain('短窗 (5 小時 滾動)');
    expect(output).toContain('已用 37%  剩 63%');
    expect(output).toContain('長窗 (7 天)');
    expect(output).toContain('額外 credits: 12.5');
    expect(output).toContain('目前短窗已達上限 (429)');
    expect(output).toContain('台灣');
  });
});
