import { describe, expect, it } from 'vitest';
import {
  AgyUsageError,
  fetchAgyQuota,
  formatAgyUsage,
  humanizeUntil,
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

  it('passes an abort signal so the timeout can fire', async () => {
    let seen: any;
    const fake = (async (_url: string, init: any) => {
      seen = init;
      return { ok: true, status: 200, text: async () => JSON.stringify({ groups: [] }) };
    }) as unknown as typeof fetch;
    await fetchAgyQuota(fake, 'test-token');
    expect(seen.signal).toBeDefined();
  });

  it('explains an expired login rather than dumping the 403 body', async () => {
    const fake = (async () => ({
      ok: false,
      status: 403,
      text: async () => '{"error":{"status":"PERMISSION_DENIED"}}',
    })) as unknown as typeof fetch;
    await expect(fetchAgyQuota(fake, 'test-token')).rejects.toThrow(/憑證已失效或過期/);
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
