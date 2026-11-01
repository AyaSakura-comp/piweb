import { expect, test, type Page, type Route } from 'playwright/test';

// Settings → 預設 thinking: one level for Life and one for ordinary sessions
// (開發模式), used by every session that picked no level of its own.

const SESSION = {
  jid: 'web:thinking-defaults',
  name: 'Thinking defaults test',
  kind: 'standard',
  busy: false,
  lastActivity: '2026-11-01 00:00:00',
  lastReplyId: 0,
  model: '',
  thinking: '',
};

async function installApi(page: Page, theme: string, standard: string) {
  const defaults = { life: 'low', standard };
  const posted: unknown[] = [];
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
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path === '/api/sessions' && request.method() === 'GET') {
      return route.fulfill({ json: { sessions: [SESSION], thinkingDefaults: defaults } });
    }
    if (path === '/api/thinking-defaults' && request.method() === 'POST') {
      const body = request.postDataJSON();
      posted.push(body);
      defaults[body.mode as 'life' | 'standard'] = body.level;
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
  return posted;
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

for (const theme of ['dark', 'light'] as const) {
  test(`Settings sets the default thinking for Life and 開發模式 (${theme})`, async ({
    page,
  }, testInfo) => {
    const posted = await installApi(page, theme, 'medium');
    await openSettings(page);

    // A session with no level of its own shows the 開發模式 default.
    await expect(page.locator('#btn-thinking')).toHaveAttribute('data-level', 'medium');

    const life = page.locator('#thinking-default-life');
    const standard = page.locator('#thinking-default-standard');
    await expect(life).toHaveValue('low');
    await expect(standard).toHaveValue('medium');
    await expect(standard.locator('option')).toHaveText([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);

    // Rows of one group like General: same 22px icon column, a plain value.
    const rows = await page.evaluate(() =>
      ['#btn-trash', '#thinking-default-life', '#thinking-default-standard'].map((id) => {
        const row = document.querySelector(id)!.closest('.settings-row')!;
        const icon = row.querySelector('.settings-row-icon')!.getBoundingClientRect();
        return {
          grouped: Boolean(row.closest('.settings-group')),
          iconLeft: Math.round(icon.left),
          iconWidth: icon.width,
          height: row.getBoundingClientRect().height >= 54,
        };
      }),
    );
    expect(new Set(rows.map((row) => JSON.stringify(row))).size).toBe(1);
    expect(rows[0]).toMatchObject({ grouped: true, iconWidth: 22, height: true });
    expect(
      await standard.evaluate((el) => {
        const style = getComputedStyle(el);
        return { border: style.borderTopWidth, background: style.backgroundColor };
      }),
    ).toEqual({ border: '0px', background: 'rgba(0, 0, 0, 0)' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await page.locator('#settings-thinking-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`thinking-defaults-${theme}.png`) });

    await standard.selectOption('high');
    await life.selectOption('minimal');
    await expect
      .poll(() => posted)
      .toEqual([
        { mode: 'standard', level: 'high' },
        { mode: 'life', level: 'minimal' },
      ]);
    await expect(standard).toHaveValue('high');
    await expect(life).toHaveValue('minimal');
    await expect(page.locator('#btn-thinking')).toHaveAttribute('data-level', 'high');
  });
}

test('開發模式 without PI_THINKING shows Pi 預設 until a level is picked', async ({ page }) => {
  const posted = await installApi(page, 'dark', '');
  await openSettings(page);
  const standard = page.locator('#thinking-default-standard');
  await expect(standard).toHaveValue('');
  await expect(standard.locator('option').first()).toHaveText('Pi 預設');
  await expect(page.locator('#btn-thinking')).toHaveAttribute('data-level', 'default');

  await standard.selectOption('low');
  await expect.poll(() => posted).toEqual([{ mode: 'standard', level: 'low' }]);
  await expect(standard.locator('option')).toHaveCount(7);
  await expect(page.locator('#btn-thinking')).toHaveAttribute('data-level', 'low');
});
