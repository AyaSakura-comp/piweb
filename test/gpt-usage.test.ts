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

function usageHeaders(): HeadersInit {
  return {
    'x-codex-plan-type': 'pro',
    'x-codex-active-limit': 'premium',
    'x-codex-credits-balance': '12.5',
    'x-codex-credits-has-credits': 'True',
    'x-codex-credits-unlimited': 'False',
    'x-codex-primary-used-percent': '37',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-at': '1786429200',
    'x-codex-primary-reset-after-seconds': '3600',
    'x-codex-secondary-used-percent': '52',
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-reset-at': '1787000000',
    'x-codex-secondary-reset-after-seconds': '570800',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('getGptUsage', () => {
  it('reads pi OAuth credentials and aborts the Codex probe after receiving usage headers', async () => {
    const authPath = await authFile({
      type: 'oauth',
      access: jwt('account-123'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
    });
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(init?.headers).toMatchObject({
        Authorization: expect.stringMatching(/^Bearer /),
        'chatgpt-account-id': 'account-123',
        originator: 'pi',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-5.5',
        stream: true,
        store: false,
      });
      capturedSignal = init?.signal ?? undefined;
      return new Response(null, { status: 429, headers: usageHeaders() });
    });

    const usage = await getGptUsage({ authPath, fetchImpl: fetchImpl as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(true);
    expect(usage).toMatchObject({
      plan: 'pro',
      activeLimit: 'premium',
      httpStatus: 429,
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
        return new Response(null, { status: 200, headers: usageHeaders() });
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

  it('rejects responses that contain no Codex rate-limit headers', async () => {
    const authPath = await authFile({
      type: 'oauth',
      access: jwt('account-123'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(getGptUsage({ authPath, fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(
      'No X-Codex-* headers returned (HTTP 401)',
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
