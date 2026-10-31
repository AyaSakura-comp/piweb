import { expect, test, type Page } from 'playwright/test';
import { formatClaudeUsage } from '../../src/claude-usage.js';
import { formatGptUsage } from '../../src/gpt-usage.js';
import { formatAgyUsage } from '../../src/agy-usage.js';

// 2026-10-31: /claude-usage rendered as a monospace box of emoji lights and
// ░ text bars inside the notice. The three usage reports are now a card.
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

const now = Date.parse('2026-10-31T11:54:00Z');
const fence = (text: string) => '```text\n' + text + '\n```';
const claude = formatClaudeUsage(
  {
    five_hour: { utilization: 2, resets_at: '2026-10-31T16:29:00Z' },
    seven_day: { utilization: 62, resets_at: '2026-11-03T05:59:00Z' },
    seven_day_opus: { utilization: 94, resets_at: '2026-11-03T05:59:00Z' },
  },
  now,
);
const gpt = formatGptUsage({
  plan: 'plus',
  activeLimit: null,
  credits: { balance: '0', hasCredits: false, unlimited: 'False' },
  primary: { usedPercent: 32, windowMinutes: 300, resetAt: 1793460000, resetAfterSeconds: 7380 },
  secondary: { usedPercent: 84, windowMinutes: 10080, resetAt: 1793900000, resetAfterSeconds: 400000 },
  httpStatus: 200,
} as any);
const agy = formatAgyUsage(
  [
    {
      displayName: 'Gemini',
      buckets: [
        { window: '5h', remainingFraction: 0.97, resetTime: '2026-10-31T16:29:00Z' },
        { window: 'weekly', disabled: true, remainingFraction: 1, resetTime: '' },
      ],
    },
  ] as any,
  now,
);

function events() {
  const rows: any[] = [
    ['user', '/claude-usage'],
    ['claude-usage', fence(claude)],
    ['user', '/gpt-usage'],
    ['gpt-usage', fence(gpt)],
    ['user', '/agy-usage'],
    ['agy-usage', fence(agy)],
    ['user', '/agy-usage'],
    ['agy-usage', fence('⚠️ agy 憑證自動換發後仍被拒絕，請重新登入。')],
  ];
  return rows.map(([role, content], i) => ({
    id: i + 1,
    kind: role === 'user' ? 'message' : 'system',
    role,
    content,
    files: [],
    createdAt: '2026-10-31 11:54:00',
  }));
}

async function setup(page: Page, theme: string) {
  const session = { jid: 'web:usage-card', name: '用量', kind: 'standard', deleted: false, busy: false, model: 'claude-code/opus', provider: 'claude-code', lastReplyId: 8 };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((t) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.theme', t);
  }, theme);
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: events(), session, busy: false, hasMore: false } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    return route.fulfill({ json: { commands: [], models: [], sessions: [], items: [] } });
  });
  await page.goto('/');
  await expect(page.locator('.event.system')).toHaveCount(4);
  return errors;
}

for (const theme of ['dark', 'light']) {
  test(`usage reports read as cards (${theme})`, async ({ page }, info) => {
    const errors = await setup(page, theme);
    const cards = page.locator('.event.system.usage');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0).locator('summary .label')).toHaveText('ⓘ Claude Code 用量');
    await expect(cards.nth(1).locator('summary .label')).toHaveText('ⓘ ChatGPT/Codex 用量');
    await expect(cards.nth(2).locator('summary .label')).toHaveText('ⓘ Antigravity 用量');

    // No emoji lights, text bars or monospace box left in a card.
    for (const text of await cards.locator('.event-body').allInnerTexts()) expect(text).not.toMatch(/[🟢🟠🔴🔵⚪🤖💳█░]/u);
    await expect(cards.locator('pre')).toHaveCount(0);

    // One meter per window, its fill the share used; 90 % and up in the danger colour.
    const claudeRows = cards.nth(0).locator('.usage-row');
    await expect(claudeRows).toHaveCount(3);
    await expect(claudeRows.nth(1).locator('[role=meter]')).toHaveAttribute('aria-valuenow', '62');
    await expect(claudeRows.nth(1).locator('[role=meter]')).toHaveAttribute('aria-valuetext', '已用 62%，剩 38%');
    await expect(claudeRows.nth(1)).toContainText('11/03 13:59 重置 · 還有 2 天 18 小時');
    const fills = await claudeRows.locator('.usage-fill').evaluateAll((nodes) =>
      nodes.map((n) => ({
        share: Math.round((n.getBoundingClientRect().width / n.parentElement!.getBoundingClientRect().width) * 100),
        colour: getComputedStyle(n).backgroundColor,
      })),
    );
    expect(fills.map((f) => f.share)).toEqual([2, 62, 94]);
    expect(fills[0].colour).toBe(fills[1].colour);
    expect(fills[2].colour).not.toBe(fills[1].colour);
    await expect(claudeRows.nth(2)).toHaveAttribute('data-level', 'high');

    await expect(cards.nth(1).locator('.usage-row').nth(1)).toContainText('還有 4 天 15 小時');
    await expect(cards.nth(2).locator('.usage-group-name')).toHaveText('Gemini');
    await expect(cards.nth(2).locator('.usage-row.is-disabled')).toContainText('已停用');

    // A report it cannot read keeps its text.
    const plain = page.locator('.event.system:not(.usage)');
    await expect(plain).toContainText('agy 憑證自動換發後仍被拒絕');

    // Nothing runs off the side of a phone.
    const overflow = await page.evaluate(() => {
      const wide = [...document.querySelectorAll('.usage-report *')].filter((n) => {
        const r = n.getBoundingClientRect();
        const card = n.closest('.event')!.getBoundingClientRect();
        return r.right > card.right + 0.5 || r.left < card.left - 0.5;
      });
      return { page: document.documentElement.scrollWidth > innerWidth, wide: wide.length };
    });
    expect(overflow).toEqual({ page: false, wide: 0 });

    await cards.nth(0).screenshot({ path: info.outputPath(`claude-${theme}.png`) });
    await cards.nth(1).screenshot({ path: info.outputPath(`gpt-${theme}.png`) });
    await cards.nth(2).screenshot({ path: info.outputPath(`agy-${theme}.png`) });
    await cards.nth(0).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`chat-${theme}.png`) });

    // Still folds like any notice.
    await cards.nth(0).locator('summary').click();
    await expect(cards.nth(0)).not.toHaveAttribute('open', '');
    expect(errors).toEqual([]);
  });
}
