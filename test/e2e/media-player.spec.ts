import { expect, test, type Locator } from 'playwright/test';

async function expectPointerReachable(locator: Locator) {
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      reachable: target === element || Boolean(target && element.contains(target)),
      blocker:
        target instanceof HTMLElement
          ? target.getAttribute('aria-label') || target.className || target.tagName
          : null,
    };
  });
  expect(hit, `pointer blocker: ${hit.blocker}`).toMatchObject({ reachable: true });
}

test('gallery video and audio open in the app with a top download action', async ({ page }) => {
  const browserErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(request.url()));

  await page.goto('/fixtures/media-player.html');
  const videoTile = page.getByRole('button', { name: 'video: demo-loop.webm' });
  await videoTile.click();

  const viewer = page.getByRole('dialog', { name: 'Media player' });
  const video = viewer.locator('video');
  const closePlayer = viewer.getByRole('button', { name: 'Close media player' });
  const downloadVideo = viewer.getByRole('link', { name: 'Download video demo-loop.webm' });
  await expect(viewer).toBeVisible();
  await expect(closePlayer).toBeFocused();
  await expect(video).toBeVisible();
  await expect(video).toHaveJSProperty('controls', true);
  await expect(video).toHaveJSProperty('playsInline', true);
  await expect(downloadVideo).toHaveAttribute('download', 'demo-loop.webm');
  await expectPointerReachable(downloadVideo);
  await downloadVideo.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(video).toBeFocused();
  await closePlayer.focus();

  const [viewerBox, videoBox, downloadBox] = await Promise.all([
    viewer.boundingBox(),
    video.boundingBox(),
    downloadVideo.boundingBox(),
  ]);
  expect(viewerBox).not.toBeNull();
  expect(videoBox).not.toBeNull();
  expect(downloadBox).not.toBeNull();
  expect(downloadBox!.y + downloadBox!.height).toBeLessThanOrEqual(videoBox!.y);
  expect(downloadBox!.width).toBeGreaterThanOrEqual(44);
  expect(downloadBox!.height).toBeGreaterThanOrEqual(44);
  expect(viewerBox!.x).toBeGreaterThanOrEqual(0);
  expect(viewerBox!.y).toBeGreaterThanOrEqual(0);
  expect(viewerBox!.x + viewerBox!.width).toBeLessThanOrEqual(390);
  expect(viewerBox!.y + viewerBox!.height).toBeLessThanOrEqual(844);

  await expect(viewer).toHaveScreenshot('video-player-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.001,
  });

  const videoDownload = page.waitForEvent('download');
  await downloadVideo.click();
  expect((await videoDownload).suggestedFilename()).toBe('demo-loop.webm');

  await closePlayer.click();
  await expect(viewer).toBeHidden();
  await expect(videoTile).toBeFocused();
  await expect(page.getByText('2 items')).toBeVisible();
  const audioTile = page.getByRole('button', { name: 'audio: demo-tone.mp3' });
  await audioTile.click();

  const audio = viewer.locator('audio');
  const downloadAudio = viewer.getByRole('link', { name: 'Download audio demo-tone.mp3' });
  await expect(viewer).toBeVisible();
  await expect(audio).toBeVisible();
  await expect(video).toBeHidden();
  await expect(audio).toHaveJSProperty('controls', true);
  await expect(downloadAudio).toHaveAttribute('download', 'demo-tone.mp3');
  await expectPointerReachable(downloadAudio);

  await expect(viewer).toHaveScreenshot('audio-player-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.001,
  });

  const audioDownload = page.waitForEvent('download');
  await downloadAudio.click();
  expect((await audioDownload).suggestedFilename()).toBe('demo-tone.mp3');

  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(page.getByText('2 items')).toBeVisible();
  await expect(audioTile).toBeFocused();

  const noHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
  );
  expect(noHorizontalOverflow).toBe(true);
  expect(browserErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
