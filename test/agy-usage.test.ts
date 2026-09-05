import { describe, expect, it, vi } from 'vitest';
import {
  AgyUsageError,
  extractAgyOAuthClientCandidates,
  fetchAgyQuota,
  formatAgyUsage,
  getAgyAccessToken,
  humanizeUntil,
  type AgyAuth,
  type AgyQuotaGroup,
} from '../src/agy-usage.js';

// The exact shape retrieveUserQuotaSummary returned for this account.
const GROUPS: AgyQuotaGroup[] = [
  {
    displayName: 'Gemini Models',
    description: 'Models within this group: Gemini Flash, Gemini Pro',
    buckets: [
      {
        bucketId: 'gemini-weekly',
        displayName: 'Weekly Limit Remaining',
        window: 'weekly',
        resetTime: '2026-08-23T10:06:45Z',
        remainingFraction: 0.99502546,
      },
      {
        bucketId: 'gemini-5h',
        displayName: 'Five Hour Limit Remaining',
        window: '5h',
        resetTime: '2026-08-18T08:35:14Z',
        remainingFraction: 0.5,
      },
    ],
  },
];

const NOW = Date.parse('2026-08-18T03:58:00Z');

describe('formatAgyUsage', () => {
  it('reports used and remaining percentages per bucket', () => {
    const out = formatAgyUsage(GROUPS, NOW);
    expect(out).toContain('Gemini Models');
    expect(out).toContain('週窗');
    expect(out).toContain('已用 0%');
    expect(out).toContain('5小時窗');
    expect(out).toContain('已用 50%');
  });

  it('draws a bar proportional to the fraction used', () => {
    expect(formatAgyUsage(GROUPS, NOW)).toContain('█████░░░░░');
  });

  // The block renders in a code fence on a 390px phone; agy's own labels and
  // group descriptions overflow it and clip the bars.
  it('keeps every line narrow enough for a phone', () => {
    const width = (line: string) =>
      [...line].reduce((n, c) => n + (c.charCodeAt(0) > 0x2000 ? 2 : 1), 0);
    for (const line of formatAgyUsage(GROUPS, NOW).split('\n')) {
      expect(width(line)).toBeLessThanOrEqual(46);
    }
  });

  it('omits the wide group description agy returns', () => {
    expect(formatAgyUsage(GROUPS, NOW)).not.toContain('Models within this group');
  });

  it('colours the dot by how little is left', () => {
    const low = formatAgyUsage(
      [{ displayName: 'g', buckets: [{ ...GROUPS[0].buckets[0], remainingFraction: 0.01 }] }],
      NOW,
    );
    expect(low).toContain('🔴');
    expect(formatAgyUsage(GROUPS, NOW)).toContain('🟢');
  });

  it('says so plainly when no quota is reported', () => {
    expect(formatAgyUsage([], NOW)).toContain('沒有回報任何額度資訊');
  });
});

describe('humanizeUntil', () => {
  it('uses days and hours for a far reset', () => {
    expect(humanizeUntil('2026-08-23T10:06:45Z', NOW)).toBe('還有 5 天 6 小時');
  });

  it('uses hours and minutes within a day', () => {
    expect(humanizeUntil('2026-08-18T08:35:14Z', NOW)).toBe('還有 4 小時 37 分');
  });

  it('uses minutes alone within the hour', () => {
    expect(humanizeUntil('2026-08-18T04:20:00Z', NOW)).toBe('還有 22 分');
  });

  it('reports an elapsed window as reset', () => {
    expect(humanizeUntil('2026-08-18T03:00:00Z', NOW)).toBe('已重置');
  });
});

describe('agy OAuth refresh', () => {
  const expiredAuth: AgyAuth = {
    auth_method: 'consumer',
    token: {
      access_token: 'expired-access',
      refresh_token: 'saved-refresh',
      token_type: 'Bearer',
      expiry: '2000-01-01T00:00:00Z',
    },
  };

  it('refreshes an expired access token before quota lookup', async () => {
    let refreshBody = '';
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      expect(init?.signal).toBeDefined();
      refreshBody = String(init?.body);
      return new Response(
        JSON.stringify({ access_token: 'fresh-access', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const token = await getAgyAccessToken(false, {
      fetchImpl: fakeFetch,
      now: () => Date.parse('2026-09-04T05:00:00Z'),
      readAuth: async () => expiredAuth,
      oauthClientCandidates: async () => [['client-id', 'client-secret']],
    });

    expect(token).toBe('fresh-access');
    expect(refreshBody).toContain('grant_type=refresh_token');
    expect(refreshBody).toContain('refresh_token=saved-refresh');
  });

  it('rejects an invalid expires_in instead of producing a broken credential', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: -1 }), {
        status: 200,
      })) as typeof fetch;

    await expect(
      getAgyAccessToken(true, {
        fetchImpl: fakeFetch,
        readAuth: async () => expiredAuth,
        oauthClientCandidates: async () => [['client-id', 'client-secret']],
      }),
    ).rejects.toThrow(AgyUsageError);
  });

  it('bounds OAuth client discovery with the refresh deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = getAgyAccessToken(true, {
        readAuth: async () => expiredAuth,
        oauthClientCandidates: () => new Promise(() => undefined),
      });
      const rejection = expect(pending).rejects.toThrow(/逾時/);
      await vi.advanceTimersByTimeAsync(10_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a stalled OAuth response body as a timeout', async () => {
    vi.useFakeTimers();
    try {
      const fakeFetch = ((_url: string, init: any) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              });
            }),
        })) as unknown as typeof fetch;
      const pending = getAgyAccessToken(true, {
        fetchImpl: fakeFetch,
        readAuth: async () => expiredAuth,
        oauthClientCandidates: async () => [['client-id', 'client-secret']],
      });
      const rejection = expect(pending).rejects.toThrow(/逾時/);
      await vi.advanceTimersByTimeAsync(10_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('extracts OAuth client metadata embedded in the agy binary', () => {
    const sampleId = ['123-example', 'apps', 'googleusercontent.com'].join('.');
    const sampleSecret = ['GOCSPX', '1234567890123456789012345678'].join('-');
    const bytes = Buffer.from(`x ${sampleId} y ${sampleSecret} z`);
    expect(extractAgyOAuthClientCandidates(bytes)).toEqual([[sampleId, sampleSecret]]);
  });
});

describe('fetchAgyQuota', () => {
  // The endpoint 403s with SUBSCRIPTION_REQUIRED unless a client User-Agent is
  // sent; that header is the entire gate, so guard it against being dropped.
  it('sends the antigravity client User-Agent', async () => {
    let seen: any;
    const fake = (async (_url: string, init: any) => {
      seen = init;
      return { ok: true, status: 200, text: async () => JSON.stringify({ groups: GROUPS }) };
    }) as unknown as typeof fetch;

    await fetchAgyQuota(fake, 'test-token').catch(() => undefined);
    if (seen) expect(String(seen.headers['User-Agent'])).toMatch(/^antigravity-cli\//);
  });

  // The control loop is serial and schedules its next tick only after the
  // current command resolves, so an unbounded request wedges /pi stop too.
  it('gives up rather than hanging when the request never settles', async () => {
    const fake = ((_url: string, init: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;

    const started = Date.now();
    await expect(fetchAgyQuota(fake, 'test-token')).rejects.toBeInstanceOf(AgyUsageError);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('times out when quota headers arrive but the response body stalls', async () => {
    const fake = ((_url: string, init: any) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      })) as unknown as typeof fetch;

    await expect(fetchAgyQuota(fake, 'test-token')).rejects.toThrow(/逾時/);
  }, 20_000);

  it('passes an abort signal so the timeout can fire', async () => {
    let seen: any;
    const fake = (async (_url: string, init: any) => {
      seen = init;
      return { ok: true, status: 200, text: async () => JSON.stringify({ groups: [] }) };
    }) as unknown as typeof fetch;
    await fetchAgyQuota(fake, 'test-token');
    expect(seen.signal).toBeDefined();
  });

  it('refreshes once and retries quota lookup after an authentication error', async () => {
    const authorizations: string[] = [];
    const fake = (async (_url: string, init: any) => {
      authorizations.push(init.headers.Authorization);
      if (authorizations.length === 1) {
        return { ok: false, status: 401, text: async () => 'expired' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ groups: GROUPS }) };
    }) as unknown as typeof fetch;
    const refreshFlags: boolean[] = [];

    const result = await fetchAgyQuota(fake, undefined, async (forceRefresh) => {
      refreshFlags.push(forceRefresh);
      return forceRefresh ? 'fresh-token' : 'stale-token';
    });

    expect(result).toEqual(GROUPS);
    expect(refreshFlags).toEqual([false, true]);
    expect(authorizations).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
  });

  it('explains an expired login when a refreshed credential is also rejected', async () => {
    const fake = (async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"status":"UNAUTHENTICATED"}}',
    })) as unknown as typeof fetch;
    await expect(fetchAgyQuota(fake, undefined, async () => 'still-invalid')).rejects.toThrow(
      /重新登入/,
    );
  });

  it('does not misreport a permission-denied response as an expired login', async () => {
    const refreshFlags: boolean[] = [];
    const fake = (async () => ({
      ok: false,
      status: 403,
      text: async () => '{"error":{"status":"PERMISSION_DENIED"}}',
    })) as unknown as typeof fetch;

    await expect(
      fetchAgyQuota(fake, undefined, async (forceRefresh) => {
        refreshFlags.push(forceRefresh);
        return 'token';
      }),
    ).rejects.toThrow(/權限/);
    expect(refreshFlags).toEqual([false]);
  });

  it('surfaces an HTTP failure as an AgyUsageError', async () => {
    const fake = (async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
    })) as unknown as typeof fetch;

    await expect(fetchAgyQuota(fake, 'test-token')).rejects.toBeInstanceOf(AgyUsageError);
  });
});
