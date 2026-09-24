import { expect, test, type Locator, type Page, type Route } from 'playwright/test';

const SESSION = {
  jid: 'web:settings-vision',
  name: 'Settings visual test',
  kind: 'standard',
  busy: false,
  lastActivity: '2026-05-19 00:00:00',
  lastReplyId: 0,
  model: 'openai-codex/gpt-5.6-sol',
  thinking: 'high',
  badge: { label: 'SOL', kind: 'sol' },
};

const DELETED_SESSION = {
  ...SESSION,
  jid: 'web:deleted-settings-preview',
  name: 'Deleted from Settings',
  events: 2,
  deletedAt: '2026-05-18 00:00:00',
  storageToken: 'deleted-storage-token',
  deletionToken: 'deleted-deletion-token',
};

type SubscriptionStage = 'disconnected' | 'waiting' | 'connected';

async function expectReachable(locator: Locator) {
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      width: rect.width,
      height: rect.height,
      reachable: hit === element || Boolean(hit && element.contains(hit)),
      blocker: hit instanceof HTMLElement ? hit.id || hit.className || hit.tagName : null,
    };
  });
  expect(result, `pointer blocker: ${result.blocker}`).toMatchObject({ reachable: true });
  expect(result.width).toBeGreaterThanOrEqual(44);
  expect(result.height).toBeGreaterThanOrEqual(44);
}

async function installApi(
  page: Page,
  { deletedSessions = [] }: { deletedSessions?: (typeof DELETED_SESSION)[] } = {},
) {
  let subscription: SubscriptionStage = 'disconnected';

  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    localStorage.setItem('piweb.theme', 'dark');
  });
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/me') {
      return route.fulfill({ json: { authed: true, via: 'token' } });
    }
    if (path === '/api/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/models') return route.fulfill({ json: { models: [] } });
    if (path === '/api/sessions' && request.method() === 'GET') {
      return route.fulfill({ json: { sessions: [SESSION] } });
    }
    if (path === '/api/sessions/deleted') {
      return route.fulfill({ json: { sessions: deletedSessions } });
    }
    if (path === '/api/subscriptions/openai-codex') {
      if (request.method() === 'POST') subscription = 'waiting';
      if (request.method() === 'DELETE') subscription = 'disconnected';
      const waiting = subscription === 'waiting';
      return route.fulfill({
        status: request.method() === 'GET' ? 200 : 202,
        json: {
          provider: 'openai-codex',
          connected: subscription === 'connected',
          job: waiting
            ? {
                id: 'fixture-device-job',
                provider: 'openai-codex',
                action: 'login',
                status: 'waiting',
                userCode: 'ABCD-EFGH',
                verificationUri: 'https://example.test/device',
                message: 'Waiting for authorization',
                error: '',
              }
            : null,
        },
      });
    }
    if (path.endsWith('/events')) {
      const deleted = path.includes(encodeURIComponent(DELETED_SESSION.jid));
      const session = deleted ? DELETED_SESSION : SESSION;
      return route.fulfill({
        json: {
          events: [],
          busy: false,
          hasMore: false,
          hasMoreNewer: false,
          partial: null,
          session: { jid: session.jid, name: session.name, kind: 'standard', deleted },
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

  return {
    completeLogin() {
      subscription = 'connected';
    },
  };
}

test('previewing Recently Deleted from Settings does not reopen Settings', async ({ page }) => {
  await installApi(page, { deletedSessions: [DELETED_SESSION] });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(SESSION.name);

  await page.locator('#btn-menu').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#btn-trash').click();
  await expect(page.locator('#trash-sheet')).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();

  await expect(page.locator('#trash-sheet')).toBeHidden();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect(page.locator('#session-name')).toHaveText(DELETED_SESSION.name);
  await expect(page.locator('#deleted-banner')).toBeVisible();
});

test('mobile Settings and OpenAI device-code workflow remains visually usable', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => failedRequests.push(request.url()));

  const fixture = await installApi(page);
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(SESSION.name);

  await page.locator('#btn-menu').click();
  await expect(page.locator('#drawer')).toHaveClass(/open/);
  await page.waitForTimeout(300);
  await page.screenshot({ path: testInfo.outputPath('00-drawer-settings-entry.png') });

  const settingsEntry = page.getByRole('button', { name: 'Settings', exact: true });
  await expectReachable(settingsEntry);
  await settingsEntry.click();
  const dialog = page.locator('#settings-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('animation-name', 'settings-enter');
  await expect(page.locator('#btn-notify')).toHaveAttribute('role', 'switch');
  await expect(page.locator('#btn-notify')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.notification-toggle')).toBeVisible();
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await expect(page.locator('#subscription-status')).toHaveText('Not connected');
  await page.screenshot({ path: testInfo.outputPath('01-settings-dark.png') });

  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const width = window.visualViewport?.width ?? window.innerWidth;
    const height = window.visualViewport?.height ?? window.innerHeight;
    return {
      contained: rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry).toEqual({ contained: true, documentOverflow: 0 });
  await expectReachable(page.locator('#subscription-action'));

  await page.locator('#btn-theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: testInfo.outputPath('02-settings-light.png') });

  await page.locator('#subscription-action').click();
  await expect(page.locator('#subscription-device')).toBeVisible();
  await expect(page.locator('#subscription-device-code')).toHaveText('ABCD-EFGH');
  await expect(page.locator('#subscription-verification-link')).toHaveAttribute(
    'href',
    'https://example.test/device',
  );
  await expectReachable(page.locator('#subscription-device-code'));
  await expectReachable(page.locator('#subscription-verification-link'));
  await page.screenshot({ path: testInfo.outputPath('03-device-code-waiting.png') });

  await page.locator('#subscription-device-code').click();
  await expect(page.locator('#toast-text')).toHaveText('Device code copied');
  await page.screenshot({ path: testInfo.outputPath('04-device-code-copied.png') });

  fixture.completeLogin();
  await expect(page.locator('#subscription-status')).toHaveText(
    'Connected to ChatGPT Plus / Pro',
    { timeout: 4_000 },
  );
  await expect(page.locator('#subscription-action')).toHaveText('Disconnect');
  await page.screenshot({ path: testInfo.outputPath('05-connected.png') });

  await page.locator('#subscription-action').click();
  await expect(page.locator('#subscription-status')).toHaveText('Not connected');
  await page.screenshot({ path: testInfo.outputPath('06-disconnected.png') });

  await page.locator('#btn-trash').click();
  await expect(page.locator('#trash-sheet')).toBeVisible();
  const trashPanel = page.locator('#trash-sheet .trash-panel');
  await expect(trashPanel).toHaveCSS('animation-name', 'trash-page-enter');
  await trashPanel.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  const trashGeometry = await trashPanel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight };
  });
  expect(trashGeometry).toEqual({ top: 0, bottom: 844, viewportHeight: 844 });
  await expect(page.locator('#trash-note')).toHaveText('Nothing here. Deleted sessions appear for 30 days.');
  await page.screenshot({ path: testInfo.outputPath('07-recently-deleted.png') });
  await page.locator('#btn-trash-close').click();
  await expect(page.locator('#trash-sheet')).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(page.locator('#btn-trash')).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('08-settings-restored.png') });

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
