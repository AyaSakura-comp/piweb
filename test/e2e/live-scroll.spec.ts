import { expect, test, type Page } from 'playwright/test';

const liveUrl = process.env.PIWEB_E2E_LIVE_URL;
const liveToken = process.env.PIWEB_E2E_TOKEN;

async function openLiveTranscript(page: Page): Promise<void> {
  await page.goto(liveUrl!, { waitUntil: 'domcontentloaded' });

  const login = page.locator('#login');
  if (await login.isVisible()) {
    if (!liveToken) {
      throw new Error('PIWEB_E2E_TOKEN is required when the live E2E target shows token login');
    }
    await page.locator('#login-token').fill(liveToken);
    await page.locator('#login-form button[type="submit"]').click();
  }

  await expect(page.locator('#messages')).toBeVisible({ timeout: 10_000 });
}

async function transcriptIsAtTail(page: Page): Promise<boolean> {
  return page.locator('#messages').evaluate((messages) => {
    const jump = document.getElementById('jump-live');
    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 80;
    return nearBottom && !jump?.classList.contains('visible');
  });
}

async function sendComposerText(page: Page, text: string): Promise<void> {
  await page.locator('#input').fill(text);
  await page.locator('#btn-send').click();
}

function completedTranscriptRows(page: Page) {
  return page.locator('#messages > .msg:not(.partial), #messages > .event:not(.partial)');
}

async function transcriptIsScrollable(page: Page): Promise<boolean> {
  return page
    .locator('#messages')
    .evaluate((messages) => messages.scrollHeight - messages.clientHeight > 80);
}

async function waitForStatusOutput(
  page: Page,
  previousCount: number,
  expectedOutputs = 1,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const rows = completedTranscriptRows(page);
        const currentCount = await rows.count();
        if (currentCount <= previousCount) return 0;
        const newRows = await rows.evaluateAll(
          (nodes, start) => nodes.slice(start).map((node) => node.textContent || ''),
          previousCount,
        );
        return newRows.filter((text) => text.includes('Model') && text.includes('Context')).length;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(expectedOutputs);
}

async function sendAndWaitForStatusOutput(page: Page): Promise<void> {
  const previousCount = await completedTranscriptRows(page).count();
  await sendComposerText(page, '/pi status');
  await waitForStatusOutput(page, previousCount);
}

async function waitForQuotedReply(page: Page, previousCount: number): Promise<void> {
  await expect
    .poll(async () => {
      const rows = completedTranscriptRows(page);
      const currentCount = await rows.count();
      if (currentCount <= previousCount) return false;
      const newRows = await rows.evaluateAll(
        (nodes, start) => nodes.slice(start).map((node) => node.textContent || ''),
        previousCount,
      );
      return newRows.some((text) => text.includes('這是帶有引用的回覆'));
    })
    .toBe(true);
}

test.describe('opt-in live mobile transcript scroll guard', () => {
  test.skip(!liveUrl, 'Set PIWEB_E2E_LIVE_URL to run tests against a deployed piweb account');

  test.beforeEach(async ({ page }) => {
    await openLiveTranscript(page);
  });

  test('returns to the live tail after reading older history', async ({ page }) => {
    expect(await transcriptIsAtTail(page)).toBe(true);

    const availableScroll = await page.locator('#messages').evaluate((messages) => {
      const available = messages.scrollHeight - messages.clientHeight;
      messages.scrollTop = Math.max(0, available - 400);
      messages.dispatchEvent(new Event('scroll'));
      return available;
    });
    test.skip(availableScroll < 160, 'The selected live session has too little history to scroll');

    await expect(page.locator('#jump-live')).toHaveClass(/visible/);
    await page.locator('#jump-live').click();
    await expect.poll(() => transcriptIsAtTail(page)).toBe(true);
  });

  test('stays at the tail after a command produces transcript output', async ({ page }) => {
    test.skip(!(await transcriptIsScrollable(page)), 'The selected live session is not scrollable');
    await sendAndWaitForStatusOutput(page);
    await expect.poll(() => transcriptIsAtTail(page), { timeout: 10_000 }).toBe(true);
  });

  test('keeps following back-to-back command output', async ({ page }) => {
    test.skip(!(await transcriptIsScrollable(page)), 'The selected live session is not scrollable');
    const previousCount = await completedTranscriptRows(page).count();
    await sendComposerText(page, '/pi status');
    await page.waitForTimeout(100);
    await sendComposerText(page, '/pi status');
    await waitForStatusOutput(page, previousCount, 2);

    await expect.poll(() => transcriptIsAtTail(page), { timeout: 10_000 }).toBe(true);
  });

  test('keeps a quoted reply at the bottom', async ({ page }) => {
    test.skip(!(await transcriptIsScrollable(page)), 'The selected live session is not scrollable');
    await sendAndWaitForStatusOutput(page);

    const selected = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(
        '#messages .msg-text, #messages .event-body',
      );
      if (!host) return false;
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      const textNode = walker.nextNode();
      if (!textNode?.textContent) return false;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(30, textNode.textContent.length));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    });
    test.skip(!selected, 'The selected live session has no transcript text to quote');

    await expect(page.locator('#quote-preview')).toBeVisible();
    const previousCount = await completedTranscriptRows(page).count();
    await sendComposerText(page, '這是帶有引用的回覆');
    await waitForQuotedReply(page, previousCount);
    await expect.poll(() => transcriptIsAtTail(page), { timeout: 10_000 }).toBe(true);
  });
});
