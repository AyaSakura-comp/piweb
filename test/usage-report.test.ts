import { describe, expect, it } from 'vitest';
import { formatClaudeUsage } from '../src/claude-usage.js';
import { formatGptUsage } from '../src/gpt-usage.js';
import { formatAgyUsage } from '../src/agy-usage.js';
import { parseUsageReport } from '../public/usage-report.js';

// The card reads back the worker's own text, so these run the real formatters:
// a change on either side that the other does not follow fails here.
const fence = (text: string) => '```text\n' + text + '\n```';
const now = Date.parse('2026-10-31T11:54:00Z');

describe('usage report card', () => {
  it('reads /claude-usage: every window, reset, caption and footer', () => {
    const text = formatClaudeUsage(
      {
        five_hour: { utilization: 2, resets_at: '2026-10-31T16:29:00Z' },
        seven_day: { utilization: 62, resets_at: '2026-11-03T05:59:00Z' },
        seven_day_opus: { utilization: 94.5, resets_at: null },
      },
      now,
    );
    const report = parseUsageReport('claude-usage', fence(text))!;
    expect(report.title).toBe('Claude Code 用量');
    expect(report.caption).toBe('主機登入帳號，非單一對話');
    expect(report.sections[0].rows).toEqual([
      expect.objectContaining({ label: '5 小時窗', used: 2, left: 98, reset: '11/01 00:29', until: '還有 4 小時 35 分' }),
      expect.objectContaining({ label: '週窗', used: 62, left: 38, reset: '11/03 13:59', until: '還有 2 天 18 小時' }),
      expect.objectContaining({ label: 'Opus 週窗', used: 94.5, left: 5.5, reset: '', until: '' }),
    ]);
    expect(report.footer).toMatch(/^查詢 10\/31 19:54 台北時間/);
  });

  it('reads /claude-usage with no readings as a note, never as zero', () => {
    const report = parseUsageReport('claude-usage', fence(formatClaudeUsage({}, now)))!;
    expect(report.sections[0].rows).toEqual([]);
    expect(report.notes[0].text).toContain('不代表使用量為零');
  });

  it('reads /gpt-usage, with its long durations in days', () => {
    const text = formatGptUsage({
      plan: 'plus',
      activeLimit: null,
      credits: { balance: '0', hasCredits: false, unlimited: 'False' },
      primary: { usedPercent: 32, windowMinutes: 300, resetAt: 1793460000, resetAfterSeconds: 7380 },
      secondary: { usedPercent: 100, windowMinutes: 10080, resetAt: 1793900000, resetAfterSeconds: 400000 },
      httpStatus: 429,
    } as any);
    for (const role of ['gpt-usage', 'pi gpt-usage']) {
      const report = parseUsageReport(role, fence(text))!;
      expect(report.caption).toBe('方案 plus');
      expect(report.sections[0].rows).toEqual([
        expect.objectContaining({ label: '短窗', sub: '5 小時滾動', used: 32, left: 68, until: '還有 2 小時 3 分' }),
        expect.objectContaining({ label: '長窗', sub: '7 天', used: 100, left: 0, until: '還有 4 天 15 小時' }),
      ]);
      expect(report.sections[0].rows[0].reset).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
      expect(report.notes).toEqual([
        { text: '額外 credits: 0', tone: '' },
        expect.objectContaining({ tone: 'warn' }),
      ]);
    }
  });

  it('reads /gpt-usage windows the service left out as missing', () => {
    const text = formatGptUsage({
      plan: null,
      activeLimit: null,
      credits: { balance: null, hasCredits: null, unlimited: null },
      primary: { usedPercent: 5, windowMinutes: 300, resetAt: null, resetAfterSeconds: null },
      secondary: { usedPercent: null, windowMinutes: null, resetAt: null, resetAfterSeconds: null },
      httpStatus: 200,
    } as any);
    const report = parseUsageReport('gpt-usage', fence(text))!;
    expect(report.caption).toBe('');
    expect(report.sections[0].rows[1]).toEqual(expect.objectContaining({ used: null, left: null, reset: '', until: '' }));
  });

  it('reads /agy-usage groups, disabled windows included', () => {
    const text = formatAgyUsage(
      [
        {
          displayName: 'Gemini',
          buckets: [
            { window: '5h', remainingFraction: 0.97, resetTime: '2026-10-31T16:29:00Z' },
            { window: 'weekly', disabled: true, remainingFraction: 1, resetTime: '' },
          ],
        },
        { displayName: 'Claude', buckets: [{ window: 'weekly', remainingFraction: 0.04, resetTime: '2026-11-03T05:59:00Z' }] },
      ] as any,
      now,
    );
    const report = parseUsageReport('agy-usage', fence(text))!;
    expect(report.title).toBe('Antigravity 用量');
    expect(report.sections.map((s) => s.name)).toEqual(['Gemini', 'Claude']);
    expect(report.sections[0].rows).toEqual([
      expect.objectContaining({ label: '5 小時窗', used: 3, left: 97, until: '還有 4 小時 35 分' }),
      expect.objectContaining({ label: '週窗', disabled: '已停用（受週窗上限限制）' }),
    ]);
    expect(report.sections[1].rows[0]).toEqual(expect.objectContaining({ used: 96, until: '還有 2 天 18 小時' }));
  });

  it('keeps the plain text for anything it cannot read whole', () => {
    expect(parseUsageReport('agy-usage', fence('⚠️ agy 憑證自動換發後仍被拒絕，請重新登入。'))).toBeNull();
    expect(parseUsageReport('agy-usage', fence(formatAgyUsage([], now)))).toBeNull();
    expect(parseUsageReport('claude-usage', '無法取得 Claude usage，請稍後再試。')).toBeNull();
    expect(parseUsageReport('pi status', fence(formatClaudeUsage({ five_hour: { utilization: 1 } }, now)))).toBeNull();
    // An unknown line anywhere: the whole report stays text, nothing is dropped.
    const extra = formatClaudeUsage({ five_hour: { utilization: 1 } }, now) + '\n新的一行';
    expect(parseUsageReport('claude-usage', fence(extra))).toBeNull();
  });
});
