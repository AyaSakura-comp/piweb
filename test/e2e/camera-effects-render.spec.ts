import { expect, test } from 'playwright/test';

test('simulated bokeh changes capture pixels outside focus but f/16 preserves the original', async ({
  page,
}) => {
  await page.route('**/api/**', (r) => r.fulfill({ json: { authed: false } }));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createCameraEffects } = await import('/camera-effects.js');
    const view = document.createElement('div');
    view.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:320px';
    const frame = document.createElement('div');
    frame.className = 'camera-frame';
    view.append(frame);
    const controls = document.createElement('div');
    document.body.append(view, controls);
    const effects = createCameraEffects({ view, controls });
    effects.focusAt(160, 160);
    function pattern() {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 320;
      const c = canvas.getContext('2d')!;
      for (let y = 0; y < 320; y += 4)
        for (let x = 0; x < 320; x += 4) {
          c.fillStyle = ((x + y) / 4) % 2 ? '#fff' : '#000';
          c.fillRect(x, y, 4, 4);
        }
      return canvas;
    }
    const raw = pattern(),
      soft = pattern();
    const initial = pattern();
    effects.composite(initial);
    const defaultOff = raw.toDataURL() === initial.toDataURL();
    (controls.querySelector('[aria-label="模擬光圈 f/1.2"]') as HTMLButtonElement).click();
    effects.composite(soft);
    const at = (c: HTMLCanvasElement, x: number, y: number) => [
      ...c.getContext('2d')!.getImageData(x, y, 1, 1).data,
    ];
    const centreSame = JSON.stringify(at(raw, 160, 160)) === JSON.stringify(at(soft, 160, 160));
    const outerChanged = Math.abs(at(raw, 10, 10)[0] - at(soft, 10, 10)[0]) > 40;
    (controls.querySelector('[aria-label="模擬光圈 f/16"]') as HTMLButtonElement).click();
    const sharp = pattern();
    effects.composite(sharp);
    const offSame = raw.toDataURL() === sharp.toDataURL();
    effects.detach();
    view.remove();
    controls.remove();
    return { defaultOff, centreSame, outerChanged, offSame };
  });
  expect(result).toEqual({ defaultOff: true, centreSame: true, outerChanged: true, offSame: true });
});
