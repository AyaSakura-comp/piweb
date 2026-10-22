import { expect, test, type Page } from 'playwright/test';

// Settings → Claude / Antigravity: Connect shows a sign-in link to open and a
// field for the code the provider hands back; the worker finishes the login.
const SESSION = {
  jid: 'web:claude-login',
  name: 'Claude login',
  kind: 'standard',
  busy: false,
  lastActivity: '2026-10-22 00:00:00',
  lastReplyId: 0,
  badge: { label: 'OPUS', kind: 'claude' },
};
const PROVIDERS = [
  {
    provider: 'anthropic',
    title: 'Claude',
    authUrl: 'https://claude.ai/oauth/authorize?code=true&state=fixture',
    pasted: 'http://localhost:53692/callback?code=abc&state=fixture',
    connected: 'Connected to Claude Pro / Max',
  },
  {
    provider: 'agy',
    title: 'Antigravity',
    authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=x&state=fixture',
    pasted: '4/0AVGtestCODE123',
    connected: 'Connected to Google',
  },
];

for (const { provider, title, authUrl: AUTH_URL, pasted, connected } of PROVIDERS) {
  const id = (part: string) => `#subscription-${provider}-${part}`;

  async function installApi(page: Page) {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    let stage: 'idle' | 'waiting' | 'checking' | 'connected' | 'rejected' = 'idle';
    const job = () =>
      stage === 'idle' || stage === 'connected'
        ? null
        : {
            id: `${provider}-job`,
            provider,
            action: 'login',
            status: stage === 'rejected' ? 'failed' : 'waiting',
            authUrl: stage === 'rejected' ? '' : AUTH_URL,
            codeSubmitted: stage === 'checking',
            userCode: '',
            verificationUri: '',
            message: '',
            error:
              stage === 'rejected'
                ? 'Authorization code was not accepted; connect again for a new link'
                : '',
          };
    await page.addInitScript(() => {
      localStorage.setItem('piweb.mode', 'sessions');
      localStorage.setItem('piweb.theme', 'dark');
    });
    await page.route('**/media/piweb-shared/hot-keywords.json', (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    await page.route('**/api/**', (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.startsWith(`/api/subscriptions/${provider}`)) {
        calls.push({ path, method: request.method(), body: request.postDataJSON() ?? undefined });
        if (path.endsWith('/code')) stage = 'checking';
        else if (path.endsWith('/cancel')) stage = 'idle';
        else if (request.method() === 'POST') stage = 'waiting';
        else if (request.method() === 'DELETE') stage = 'idle';
        return route.fulfill({
          json: { provider, connected: stage === 'connected', job: job() },
        });
      }
      if (path === '/api/me') return route.fulfill({ json: { authed: true, via: 'token' } });
      if (path === '/api/sessions') return route.fulfill({ json: { sessions: [SESSION] } });
      if (path === '/api/sessions/deleted') return route.fulfill({ json: { sessions: [] } });
      const other = path.match(/^\/api\/subscriptions\/([a-z-]+)$/)?.[1];
      if (other) return route.fulfill({ json: { provider: other, connected: false, job: null } });
      if (path === '/api/dashboard-layout') return route.fulfill({ json: { layout: null } });
      if (path === '/api/system-metrics') return route.fulfill({ json: {} });
      if (path.endsWith('/events'))
        return route.fulfill({
          json: {
            events: [],
            busy: false,
            hasMore: false,
            session: { ...SESSION, deleted: false },
          },
        });
      if (path.endsWith('/stream'))
        return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      return route.fulfill({ json: { commands: [], models: [], items: [] } });
    });
    return { calls, set: (next: typeof stage) => (stage = next) };
  }

  test(`${title} sign-in: open the link, paste the code, connected`, async ({ page }, info) => {
    const api = await installApi(page);
    await page.goto('/');
    await expect(page.locator('#session-name')).toHaveText(SESSION.name);
    await page.locator('#btn-menu').click();
    await page.locator('#btn-settings').click();
    const dialog = page.locator('#settings-dialog');
    await expect(dialog).not.toHaveAttribute('data-motion', /.+/);
    const status = page.locator(id('status'));
    const action = page.locator(id('action'));
    await expect(status).toHaveText('Not connected');
    await expect(page.locator(id('auth'))).toBeHidden();

    await action.click();
    const link = page.locator(id('link'));
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', AUTH_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(action).toHaveText('Cancel');
    await expect(status).toHaveText('Waiting for sign-in');
    await page.locator(id('auth')).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`01-${provider}-link.png`) });

    // Polling while the user types must not wipe the field.
    const input = page.locator(id('code'));
    await input.fill(pasted);
    await page.waitForTimeout(2300);
    await expect(input).toHaveValue(pasted);
    await page.screenshot({ path: info.outputPath(`02-${provider}-pasted.png`) });

    await input.press('Enter');
    await expect(page.locator(id('progress'))).toHaveText('Checking code…');
    await expect(input).toBeDisabled();
    expect(api.calls.find((c) => c.path.endsWith('/code'))?.body).toEqual({ code: pasted });

    api.set('connected');
    await expect(status).toHaveText(connected, { timeout: 5000 });
    await expect(page.locator(id('auth'))).toBeHidden();
    await expect(action).toHaveText('Disconnect');
    await page.screenshot({ path: info.outputPath(`03-${provider}-connected.png`) });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test(`${title} sign-in can be cancelled and shows a rejected code`, async ({ page }) => {
    const api = await installApi(page);
    await page.goto('/');
    await page.locator('#btn-menu').click();
    await page.locator('#btn-settings').click();
    const action = page.locator(id('action'));
    await action.click();
    await expect(action).toHaveText('Cancel');
    await action.click();
    await expect(action).toHaveText('Connect');
    await expect(page.locator(id('auth'))).toBeHidden();
    expect(api.calls.some((c) => c.path.endsWith('/cancel') && c.method === 'POST')).toBe(true);

    await action.click();
    await page.locator(id('code')).fill('wrong');
    await page.locator(id('submit')).click();
    api.set('rejected');
    await expect(page.locator(id('status'))).toHaveText(
      'Authorization code was not accepted; connect again for a new link',
      { timeout: 5000 },
    );
    await expect(action).toHaveText('Connect');
    await expect(page.locator(id('auth'))).toBeHidden();
  });
}
