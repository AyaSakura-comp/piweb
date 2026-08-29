import { expect, test, type Locator } from 'playwright/test';

async function expectPointerReachable(locator: Locator) {
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      reachable: hit === element || Boolean(hit && element.contains(hit)),
      blocker:
        hit instanceof HTMLElement
          ? hit.getAttribute('aria-label') || hit.className || hit.tagName
          : null,
    };
  });
  expect(result, `pointer blocker: ${result.blocker}`).toMatchObject({ reachable: true });
}

async function expectPlayerGeometry(player: Locator) {
  await expect(player).toBeVisible();
  await expect(player).toBeInViewport();
  const geometry = await player.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const frameRect = element.querySelector('.youtube-inline-frame')!.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    return {
      contained:
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= viewportWidth &&
        rect.bottom <= viewportHeight,
      frameWidth: frameRect.width,
      frameHeight: frameRect.height,
      ratio: frameRect.width / frameRect.height,
      documentOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry.contained).toBe(true);
  expect(geometry.frameWidth).toBeGreaterThanOrEqual(200);
  expect(geometry.frameHeight).toBeGreaterThanOrEqual(200);
  if (geometry.frameWidth >= 356) {
    expect(geometry.ratio).toBeGreaterThan(1.7);
    expect(geometry.ratio).toBeLessThan(1.82);
  } else {
    // YouTube requires a 200x200 viewport; narrower message columns use a
    // slightly taller player rather than violating that minimum.
    expect(geometry.ratio).toBeGreaterThanOrEqual(1);
  }
  expect(geometry.documentOverflow).toBe(0);
}

async function expectPlayerControls(player: Locator, sourceLink: Locator) {
  for (const control of [
    sourceLink,
    player.getByRole('link', { name: 'Open in YouTube' }),
    player.getByRole('button', { name: 'Close video' }),
  ]) {
    const box = await control.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expectPointerReachable(control);
  }
}

test('YouTube links open one inline mobile player and retain an external fallback', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const embedRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.route('https://www.youtube-nocookie.com/embed/**', async (route) => {
    const url = new URL(route.request().url());
    const videoId = url.pathname.split('/').pop() || '';
    embedRequests.push(route.request().url());
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><meta name="viewport" content="width=device-width"><style>html,body{height:100%;margin:0;background:#101010;color:#fff;font:16px system-ui}body{display:grid;place-items:center;text-align:center}.play{display:grid;gap:8px}.icon{color:#ff0033;font-size:42px}small{color:#aaa}</style><div class="play"><span class="icon">▶</span><strong>Inline YouTube player</strong><small>${videoId}</small></div>`,
    });
  });
  await page.context().route('https://www.youtube.com/**', async (route) => {
    await route.fulfill({ contentType: 'text/html', body: '<title>YouTube external fallback</title>' });
  });

  await page.goto('/fixtures/markdown-links.html');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');

  const firstLink = page.getByRole('link', {
    name: 'Play YouTube video: 攀山者繩盤收繩法示範',
    exact: true,
  });
  const secondLink = page.getByRole('link', {
    name: 'Play YouTube video: 【蝴蝶收繩法 Part 1】',
    exact: true,
  });
  const userLink = page.getByRole('link', {
    name: 'Play YouTube video: User video',
    exact: true,
  });
  const eventLink = page.getByRole('link', {
    name: 'Play YouTube video: Event video',
    exact: true,
  });
  const channelLink = page.getByRole('link', { name: '與繩同行 YouTube 頻道', exact: true });

  await expect(firstLink).toHaveAttribute('href', 'https://www.youtube.com/watch?v=3CzZO7JujJU');
  await expect(secondLink).toHaveAttribute('href', 'https://youtu.be/3eCNZafONJo');
  await expect(channelLink).not.toHaveAttribute('aria-expanded', /.+/);
  await expect(page.locator('.youtube-inline-player')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('00-youtube-links.png') });
  await page.waitForTimeout(600); // Evidence pacing: keep the idle state legible in video.

  const pageCountBeforeModifiedClick = page.context().pages().length;
  await firstLink.click({ modifiers: ['Control'] });
  await expect.poll(() => page.context().pages().length).toBe(pageCountBeforeModifiedClick + 1);
  const popup = page.context().pages().at(-1)!;
  await popup.close();
  expect(await page.evaluate(() => window.__documentLinkIntercepts)).toBe(0);
  await expect(page.locator('.youtube-inline-player')).toHaveCount(0);

  const pageCountBeforeMiddleClick = page.context().pages().length;
  await firstLink.click({ button: 'middle' });
  await expect.poll(() => page.context().pages().length).toBe(pageCountBeforeMiddleClick + 1);
  await page.context().pages().at(-1)!.close();
  expect(await page.evaluate(() => window.__documentLinkIntercepts)).toBe(0);
  await expect(page.locator('.youtube-inline-player')).toHaveCount(0);

  await expectPointerReachable(firstLink);
  await firstLink.click();

  const player = page.locator('.youtube-inline-player');
  const frame = player.locator('iframe');
  await expect(firstLink).toHaveAttribute('aria-expanded', 'true');
  await expect(frame).toHaveAttribute(
    'src',
    'https://www.youtube-nocookie.com/embed/3CzZO7JujJU?autoplay=1&playsinline=1&rel=0',
  );
  await expect(frame).toHaveAttribute('allowfullscreen', '');
  await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  await expect(page.frameLocator('.youtube-inline-player iframe').getByText('Inline YouTube player')).toBeVisible();
  await expect(player.getByRole('link', { name: 'Open in YouTube' })).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=3CzZO7JujJU',
  );
  await expect(player.getByRole('link', { name: 'Open in YouTube' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  await expectPlayerGeometry(player);
  await expectPlayerControls(player, firstLink);
  await page.screenshot({ path: testInfo.outputPath('01-youtube-player-open.png') });
  await page.waitForTimeout(750); // Evidence pacing: show the loaded inline player.

  await secondLink.click();
  await expect(page.locator('.youtube-inline-player')).toHaveCount(1);
  await expect(firstLink).toHaveAttribute('aria-expanded', 'false');
  await expect(secondLink).toHaveAttribute('aria-expanded', 'true');
  await expect(frame).toHaveAttribute(
    'src',
    'https://www.youtube-nocookie.com/embed/3eCNZafONJo?autoplay=1&playsinline=1&rel=0',
  );
  await expect(page.frameLocator('.youtube-inline-player iframe').getByText('3eCNZafONJo')).toBeVisible();
  expect(embedRequests).toHaveLength(2);
  await expectPlayerGeometry(player);
  await page.screenshot({ path: testInfo.outputPath('02-second-youtube-player.png') });
  await page.waitForTimeout(750); // Evidence pacing: show replacement rather than stacked players.

  const closeAssistant = player.getByRole('button', { name: 'Close video' });
  await closeAssistant.click();
  await expect(player).toHaveCount(0);
  await expect(secondLink).toHaveAttribute('aria-expanded', 'false');

  await userLink.click();
  await expect(player).toHaveCount(1);
  expect(await player.evaluate((element) => element.parentElement?.id)).toBe('user-content');
  await expectPlayerGeometry(player);
  await expectPlayerControls(player, userLink);
  await page.screenshot({ path: testInfo.outputPath('03-nested-user-player.png') });
  await page.waitForTimeout(750); // Evidence pacing: show the narrow user-message case.
  await player.getByRole('button', { name: 'Close video' }).click();
  await expect(player).toHaveCount(0);

  await eventLink.click();
  await expect(player).toHaveCount(1);
  expect(await player.evaluate((element) => element.parentElement?.id)).toBe('event-content');
  await expectPlayerGeometry(player);
  await expectPlayerControls(player, eventLink);
  await page.screenshot({ path: testInfo.outputPath('04-event-player.png') });
  await page.waitForTimeout(750); // Evidence pacing: show the event-body case.

  const close = player.getByRole('button', { name: 'Close video' });
  await expectPointerReachable(close);
  await close.click();
  await expect(player).toHaveCount(0);
  await expect(eventLink).toHaveAttribute('aria-expanded', 'false');
  await expect(eventLink).toBeFocused();
  await expect(channelLink).not.toHaveAttribute('aria-expanded', /.+/);
  expect(embedRequests).toHaveLength(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('05-youtube-player-closed.png') });
  await page.waitForTimeout(600); // Evidence pacing: show the restored transcript.

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

declare global {
  interface Window {
    __documentLinkIntercepts: number;
  }
}
