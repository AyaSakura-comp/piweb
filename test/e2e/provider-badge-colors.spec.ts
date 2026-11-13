import { expect, test } from 'playwright/test';

// 2026-11-13: 「Local and agy 的 tag 做點顏色區隔」 — in the light drawer LOCAL
// (green text on white) and AGY (the grey fallback) both read as grey.

const session = (id: string, name: string, provider: string, badge: { label: string; kind: string }) => ({
  jid: `web:${id}`,
  name,
  model: `${provider}/test`,
  provider,
  kind: 'standard',
  deleted: false,
  busy: false,
  badge,
});

const SESSIONS = [
  session('opus-row', 'Piweb', 'claude-code', { label: 'OPUS', kind: 'claude' }),
  // The live web tier still files agy under 'other'; the page colours it anyway.
  session('agy-row', 'Hay 潮汐', 'agy', { label: 'AGY', kind: 'other' }),
  session('local-row', '登入line', 'ds4', { label: 'LOCAL', kind: 'local' }),
];

for (const theme of ['light', 'dark'] as const) {
  test(`LOCAL, AGY and Claude badges read apart (${theme})`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((value) => {
      localStorage.setItem('piweb.theme', value);
      localStorage.setItem('piweb.mode', 'sessions');
    }, theme);
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/me') return route.fulfill({ json: { authed: true } });
      if (path === '/api/sessions') return route.fulfill({ json: { sessions: SESSIONS } });
      if (path.endsWith('/events'))
        return route.fulfill({ json: { events: [], busy: false, session: SESSIONS[0] } });
      if (path.endsWith('/stream'))
        return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      return route.fulfill({ json: { commands: [], models: [], sessions: [] } });
    });
    await page.goto('/');
    await page.locator('#btn-menu').click();
    const drawer = page.locator('#drawer');
    const badge = (label: string) => drawer.locator('.provider-badge', { hasText: new RegExp(`^${label}$`) });
    for (const label of ['OPUS', 'AGY', 'LOCAL']) await expect(badge(label)).toBeVisible();
    await page.waitForTimeout(400);

    const look = async (label: string) =>
      badge(label).evaluate((el) => {
        const s = getComputedStyle(el);
        const rgb = (c: string) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        return { border: rgb(s.borderTopColor), text: rgb(s.color), fill: s.backgroundColor };
      });
    const opus = await look('OPUS');
    const agy = await look('AGY');
    const local = await look('LOCAL');

    // Each rim is its own colour, not the neutral hairline the others share.
    const rims = [opus.border, agy.border, local.border].map((c) => c.join(','));
    expect(new Set(rims).size).toBe(3);
    // AGY is plainly blue, LOCAL plainly green, by rim and by text (the old
    // grey fallback was itself a faintly blue grey, so a margin is required).
    for (const c of [agy.border, agy.text]) expect(c[2] - Math.max(c[0], c[1])).toBeGreaterThan(30);
    for (const c of [local.border, local.text]) expect(c[1] - Math.max(c[0], c[2])).toBeGreaterThan(15);

    await page.screenshot({ path: info.outputPath(`drawer-badges-${theme}.png`) });
    expect(errors).toEqual([]);
  });
}
