import { expect, it } from 'vitest';
import { bokehSettings, blurPixels, classifyLens } from '../public/camera-effects.js';

it('ports Fuji aperture response without claiming real optics', () => {
  expect(bokehSettings(1.2)).toEqual({ blur: 8, inner: 0.22, outer: 0.56 });
  expect(bokehSettings(16)).toEqual({ blur: 0, inner: 1, outer: 1.3 });
  expect(bokehSettings(4).blur).toBeLessThan(8);
});
it('blurs a bright pixel while preserving opaque alpha and constant colours', () => {
  const a = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  const b = blurPixels(a, 3, 1, 1);
  expect(b[0]).toBeGreaterThan(0);
  expect(b[4]).toBeLessThan(255);
  expect(b[3]).toBe(255);
  expect(a[4]).toBe(255);
  const solid = new Uint8ClampedArray([80, 90, 100, 255, 80, 90, 100, 255]);
  expect(blurPixels(solid, 2, 1, 2)).toEqual(solid);
});
it('classifies lens labels without inventing focal lengths', () => {
  expect(classifyLens('Back Ultra Wide Camera')).toBe('超廣角');
  expect(classifyLens('後置望遠')).toBe('望遠');
  expect(classifyLens('FaceTime Front Camera')).toBe('前鏡頭');
  expect(classifyLens('USB Camera')).toBe('相機');
});
