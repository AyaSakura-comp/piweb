import { expect, test, type Page } from 'playwright/test';

// The selection bubble's spring runs on the compositor (iOS holds a
// requestAnimationFrame loop to 60Hz; the user reported "這個沒有120hz" while
// dragging a selection on 2026-11-09). These checks pin that down: the motion is
// transform keyframes on a 120Hz grid, nothing redraws the outline frame by
// frame, and the quote pill waits for the lift instead of following the finger.

const FRAME_MS = 1000 / 120;

/**
 * Watch the bubble from inside the page: Playwright's polling would only see
 * a motion that lasts half a second after it ended. The moment the bubble
 * starts moving, its pieces' animations are read, and the spring is stepped
 * through (paused, at chosen frames) before it goes on.
 */
async function watchBubble(page: Page) {
  await page.addInitScript((frameMs) => {
    const w = window as any;
    w.__outlineWrites = 0;
    w.__motion = [];
    const set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name: string, value: string) {
      if (name === 'd' && this.matches?.('.sel-bubble, .sel-bubble-moving')) w.__outlineWrites += 1;
      return set.call(this, name, value);
    };
    document.addEventListener('DOMContentLoaded', () => {
      const boxes = document.getElementById('sel-highlight-boxes')!;
      let state = boxes.dataset.bubble;
      new MutationObserver(() => {
        if (boxes.dataset.bubble === state) return;
        state = boxes.dataset.bubble;
        const entry: any = { state, outlineWrites: w.__outlineWrites };
        if (state === 'moving') {
          const animations = document
            .getAnimations()
            .filter((animation) =>
              (animation.effect as KeyframeEffect)?.target?.matches?.('.sel-bubble-piece'),
            );
          entry.pieces = animations.map((animation) => {
            const effect = animation.effect as KeyframeEffect;
            return {
              duration: Number(effect.getTiming().duration),
              easing: effect.getTiming().easing,
              frames: effect
                .getKeyframes()
                .map(({ offset, computedOffset, easing, composite, ...rest }) => ({
                  offset: Number(computedOffset),
                  properties: Object.keys(rest),
                })),
            };
          });
          // What each piece shows: its own box, cut to the outline it draws.
          const span = () => {
            const shown = [...document.querySelectorAll('.sel-bubble-piece')].map((piece) => {
              const box = piece.getBoundingClientRect();
              const outline = piece.querySelector('path')!.getBoundingClientRect();
              return {
                left: Math.max(box.left, outline.left),
                right: Math.min(box.right, outline.right),
              };
            });
            return Math.max(...shown.map((b) => b.right)) - Math.min(...shown.map((b) => b.left));
          };
          const times = animations.map((animation) => animation.currentTime);
          entry.widths = [0, 2, 4, 8, 16, Infinity].map((frame) => {
            animations.forEach((animation) => {
              const end = Number(animation.effect!.getTiming().duration);
              animation.currentTime = Math.min(end, frame * frameMs);
            });
            return span();
          });
          animations.forEach((animation, i) => (animation.currentTime = times[i]));
          entry.rest = document
            .querySelector('#sel-highlight-boxes path.sel-bubble')!
            .getBoundingClientRect().width;
        }
        w.__motion.push(entry);
      }).observe(boxes, { attributes: true, attributeFilter: ['data-bubble'] });
    });
  }, FRAME_MS);
}

const motionLog = (page: Page) => page.evaluate(() => (window as any).__motion);

async function longPress(page: Page) {
  await page.goto('/fixtures/text-selection.html');
  const paragraph = page.locator('.msg-text p').first();
  await expect(paragraph).toBeVisible();
  const box = (await paragraph.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
    });
  await touch('touchStart', box.x + 40, box.y + box.height / 2);
  await expect(page.locator('#custom-selection-overlay')).toBeVisible();
  return { touch, box };
}

test('the bubble springs as compositor keyframes, not a frame-by-frame redraw', async ({
  page,
}) => {
  await watchBubble(page);
  const { touch } = await longPress(page);
  await expect(page.locator('#sel-highlight-boxes')).toHaveAttribute('data-bubble', 'settled');
  const [moving, settled] = await motionLog(page);

  // The fresh selection inflated: pieces playing transform keyframes.
  expect(moving.state).toBe('moving');
  expect(moving.pieces.length).toBeGreaterThan(0);
  for (const piece of moving.pieces) {
    expect(piece.easing).toBe('linear');
    for (const frame of piece.frames) {
      expect(frame.properties).toEqual(['transform']);
      // Every keyframe sits on a 120Hz frame of the spring.
      const at = (frame.offset * piece.duration) / FRAME_MS;
      expect(Math.abs(at - Math.round(at))).toBeLessThan(1e-6);
    }
  }
  // While it settled, nothing redrew the outline: only the final drawing at rest.
  expect(settled.state).toBe('settled');
  expect(settled.outlineWrites - moving.outlineWrites).toBeLessThanOrEqual(1);
  // At rest one outline is drawn, and no pieces are left over.
  await expect(page.locator('#sel-highlight-boxes .sel-bubble-piece')).toHaveCount(0);
  await expect(page.locator('#sel-highlight-boxes path.sel-bubble')).toHaveCount(1);
  await touch('touchEnd');
});

test('mid-spring, the pieces grow from the pressed word to the selection and land on it', async ({
  page,
}) => {
  await watchBubble(page);
  await longPress(page);
  await expect(page.locator('#sel-highlight-boxes')).toHaveAttribute('data-bubble', 'settled');
  const [{ widths, rest }] = await motionLog(page);
  // From a sliver to the full word, never far past its overshoot, and at the
  // end exactly the drawing at rest.
  expect(widths[0]).toBeLessThan(rest * 0.5);
  expect(widths[3]).toBeGreaterThan(widths[1]);
  expect(Math.max(...widths)).toBeLessThan(rest * 1.15);
  expect(widths[5]).toBeCloseTo(rest, 0);
});

test('the quote pill steps aside while a handle is dragged and comes back on the lift', async ({
  page,
}) => {
  const { touch, box } = await longPress(page);
  await touch('touchEnd');
  const pill = page.getByRole('toolbar');
  await expect(pill).toBeVisible();
  const word = await page.evaluate(() => (window as any).__selectedText);

  const knob = (await page.locator('#sel-handle-end .sel-handle-knob').boundingBox())!;
  const from = { x: knob.x + knob.width / 2, y: knob.y + knob.height / 2 };
  await touch('touchStart', from.x, from.y);
  await expect(pill).toBeHidden();
  for (let step = 1; step <= 6; step++) {
    await touch('touchMove', Math.min(box.x + box.width - 4, from.x + step * 30), from.y);
    await expect(pill).toBeHidden();
  }
  // The selection did grow under the finger, unreported.
  const live = await page.evaluate(
    () => [...((CSS as any).highlights.get('piweb-selection') ?? [])][0]?.toString() ?? '',
  );
  expect(live.length).toBeGreaterThan(word.length);
  expect(await page.evaluate(() => (window as any).__selectedText)).toBe(word);

  await touch('touchEnd');
  await expect(pill).toBeVisible();
  expect(await page.evaluate(() => (window as any).__selectedText)).toBe(live.trim());
});
