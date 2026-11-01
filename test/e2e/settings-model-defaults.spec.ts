import { expect, test, type Page, type Route } from 'playwright/test';

// Settings → 預設模型: one model for Life and one for ordinary sessions
// (開發模式), used by Life and by every session that picked no model of its own.

const SESSION = {
  jid: 'web:model-defaults',
  name: 'Model defaults test',
  kind: 'standard',
  busy: false,
  lastActivity: '2026-11-01 00:00:00',
  lastReplyId: 0,
  model: '',
  thinking: '',
};

const MODELS = [
  ['agy', 'gemini-4-argon-high', 'Gemini 4 Argon (High)'],
  ['claude-code', 'opus', 'Claude Opus (Claude Code)'],
  ['local-strata', 'qwen3.8-flash', 'Qwen 3.8 Flash (Strata, IQ3_S abliterated)'],
  ['openai-codex', 'gpt-5.6-sol', 'GPT-5.6 Sol (Codex)'],
  ['openai-codex', 'gpt-6-luna', 'GPT-6 Luna'],
].map(([provider, id, name]) => ({
  ref: `${provider}/${id}`,
  provider,
  id,
  name,
  reasoning: true,
}));

async function installApi(page: Page, theme: string, life = '') {
  const defaults = { life, standard: '', piDefault: 'local-strata/qwen3.8-flash' };
  const posted: unknown[] = [];
  let sessionLoads = 0;
  await page.addInitScript((value) => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.theme', value);
  }, theme);
  await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true, via: 'token' } });
    if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
    if (path === '/api/system-metrics') return route.fulfill({ json: {} });
    if (path === '/api/models') return route.fulfill({ json: { models: MODELS } });
    if (path === '/api/sessions' && request.method() === 'GET') {
      sessionLoads++;
      // The server badges a session with no model of its own by the default.
      const follows = defaults.standard
        ? {
            provider: defaults.standard.split('/')[0],
            runningModel: defaults.standard,
            pending: true,
            badge: { label: 'SOL', kind: 'sol' },
          }
        : { provider: '', runningModel: '', pending: true, badge: null };
      return route.fulfill({
        json: {
          sessions: [{ ...SESSION, ...follows }],
          thinkingDefaults: { life: 'low', standard: 'medium' },
          modelDefaults: defaults,
        },
      });
    }
    if (path === '/api/model-defaults' && request.method() === 'POST') {
      const body = request.postDataJSON();
      posted.push(body);
      defaults[body.mode as 'life' | 'standard'] = body.model;
      return route.fulfill({ json: { defaults } });
    }
    if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
    if (path.startsWith('/api/subscriptions/')) {
      return route.fulfill({
        json: { provider: path.split('/').pop(), connected: false, job: null },
      });
    }
    if (path.endsWith('/events')) {
      return route.fulfill({
        json: {
          events: [],
          busy: false,
          hasMore: false,
          hasMoreNewer: false,
          partial: null,
          session: { jid: SESSION.jid, name: SESSION.name, kind: 'standard', deleted: false },
        },
      });
    }
    if (path.endsWith('/stream')) {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: 'retry: 60000\n\n',
      });
    }
    if (path.endsWith('/media')) return route.fulfill({ json: { items: [] } });
    return route.fulfill({ status: 404, json: { error: `Unhandled fixture route: ${path}` } });
  });
  return { posted, sessionLoads: () => sessionLoads };
}

async function openSettings(page: Page) {
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(SESSION.name);
  await page.locator('#btn-menu').tap();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  await expect(page.locator('#settings-dialog')).toBeVisible();
}

const optionTexts = (page: Page, id: string) =>
  page.locator(`#${id} option`).evaluateAll((options) =>
    options.map((option) => {
      const group = option.parentElement as HTMLOptGroupElement;
      return `${group.tagName === 'OPTGROUP' ? `${group.label} › ` : ''}${option.textContent}`;
    }),
  );

for (const theme of ['dark', 'light'] as const) {
  test(`Settings sets the default model for Life and 開發模式 (${theme})`, async ({
    page,
  }, testInfo) => {
    const api = await installApi(page, theme);
    await openSettings(page);

    const life = page.locator('#model-default-life');
    const standard = page.locator('#model-default-standard');
    await expect(life).toHaveValue('');
    await expect(standard).toHaveValue('');
    // Pi's default first, named; then the models by provider. Life runs on Pi
    // only, so it lists no agy or Claude Code model.
    expect(await optionTexts(page, 'model-default-life')).toEqual([
      'Pi 預設：Qwen 3.8 Flash (Strata, IQ3_S abliterated)',
      'local-strata › Qwen 3.8 Flash (Strata, IQ3_S abliterated)',
      'openai-codex › GPT-5.6 Sol (Codex)',
      'openai-codex › GPT-6 Luna',
    ]);
    expect(await optionTexts(page, 'model-default-standard')).toEqual([
      'Pi 預設：Qwen 3.8 Flash (Strata, IQ3_S abliterated)',
      'agy › Gemini 4 Argon (High)',
      'claude-code › Claude Opus (Claude Code)',
      'local-strata › Qwen 3.8 Flash (Strata, IQ3_S abliterated)',
      'openai-codex › GPT-5.6 Sol (Codex)',
      'openai-codex › GPT-6 Luna',
    ]);

    // A model name is too long for the row's end: like the voice URLs, the
    // value is a second line under the label, plain text, in the group's
    // 22px icon column.
    const layout = await page.evaluate(() =>
      ['#model-default-life', '#model-default-standard', '#thinking-default-life'].map((id) => {
        const select = document.querySelector(id)!;
        const row = select.closest('.settings-row')!;
        const label = row.querySelector('.settings-row-label')!.getBoundingClientRect();
        const icon = row.querySelector('.settings-row-icon')!.getBoundingClientRect();
        const box = select.getBoundingClientRect();
        const style = getComputedStyle(select);
        return {
          grouped: Boolean(row.closest('.settings-group')),
          iconLeft: Math.round(icon.left),
          iconWidth: Math.round(icon.width),
          rowHeight: row.getBoundingClientRect().height,
          underLabel: box.top >= label.bottom - 1 && Math.abs(box.left - label.left) < 1,
          fillsRow: Math.abs(box.right - label.right) < 1,
          border: style.borderTopWidth,
          background: style.backgroundColor,
          fontSize: style.fontSize,
        };
      }),
    );
    const [lifeRow, standardRow, thinkingRow] = layout;
    for (const row of [lifeRow, standardRow]) {
      expect(row).toMatchObject({
        grouped: true,
        iconLeft: thinkingRow.iconLeft,
        iconWidth: 22,
        underLabel: true,
        fillsRow: true,
        border: '0px',
        background: 'rgba(0, 0, 0, 0)',
        fontSize: '16px',
      });
      expect(row.rowHeight).toBeGreaterThanOrEqual(54);
    }
    expect(thinkingRow.underLabel).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await page.locator('#settings-model-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`model-defaults-${theme}.png`) });

    const loadsBefore = api.sessionLoads();
    await standard.selectOption('openai-codex/gpt-5.6-sol');
    await life.selectOption('openai-codex/gpt-6-luna');
    await expect
      .poll(() => api.posted)
      .toEqual([
        { mode: 'standard', model: 'openai-codex/gpt-5.6-sol' },
        { mode: 'life', model: 'openai-codex/gpt-6-luna' },
      ]);
    await expect(standard).toHaveValue('openai-codex/gpt-5.6-sol');
    await expect(life).toHaveValue('openai-codex/gpt-6-luna');
    // The sessions reload, so one following the default wears its badge.
    expect(api.sessionLoads()).toBeGreaterThan(loadsBefore);
    await expect(page.locator('#header-badge')).toHaveText('SOL');

    // Back to Pi's default.
    await life.selectOption('');
    await expect.poll(() => api.posted.at(-1)).toEqual({ mode: 'life', model: '' });
    await expect(life).toHaveValue('');

    // The session's model sheet says which default it follows.
    await page.locator('#btn-settings-close').tap();
    await expect(page.locator('#settings-dialog')).toBeHidden();
    await page.locator('#btn-model').tap();
    await expect(page.locator('#model-note')).toHaveText(
      'This session follows the default, openai-codex/gpt-5.6-sol.',
    );
  });
}

test('a default model the catalog no longer offers stays visible, marked', async ({ page }) => {
  await installApi(page, 'dark', 'local-gone/old-model');
  await openSettings(page);
  const life = page.locator('#model-default-life');
  await expect(life).toHaveValue('local-gone/old-model');
  await expect(life.locator('option:checked')).toHaveText(
    'local-gone/old-model（目前不能用，先用 Pi 預設）',
  );
});
