import { describe, expect, it, vi } from 'vitest';
import {
  fitImageSize,
  prepareImageUpload,
  readCompressionPreference,
} from '../public/image-compression.js';

function runtime(width = 1057, height = 2052, fail = false) {
  const close = vi.fn();
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toBlob: vi.fn((cb: (b: Blob | null) => void, type: string) =>
      cb(fail ? null : new Blob(['encoded'], { type })),
    ),
  };
  return {
    api: {
      createImageBitmap: vi.fn(async () => ({ width, height, close })),
      document: { createElement: () => canvas },
      File,
    },
    canvas,
    close,
    drawImage,
  };
}

describe('client-side image preparation', () => {
  it('fits both orientations without cropping, stretching, or upscaling', () => {
    expect(fitImageSize(1057, 2052)).toEqual({ width: 528, height: 1025 });
    expect(fitImageSize(2052, 1057)).toEqual({ width: 1025, height: 528 });
    expect(fitImageSize(1080, 2410)).toEqual({ width: 492, height: 1099 });
    expect(fitImageSize(4032, 3024)).toEqual({ width: 849, height: 637 });
    expect(fitImageSize(3024, 4032)).toEqual({ width: 637, height: 849 });
    expect(fitImageSize(2000, 2000)).toEqual({ width: 735, height: 735 });
    expect(fitImageSize(528, 1025)).toEqual({ width: 528, height: 1025 });
    expect(fitImageSize(200, 100)).toEqual({ width: 200, height: 100 });
    expect(fitImageSize(2000, 200)).toEqual({ width: 2000, height: 200 });
    expect(fitImageSize(1, 5000)).toEqual({ width: 1, height: 5000 });
    expect(fitImageSize(1000, 1000, 10000)).toEqual({ width: 100, height: 100 });
    expect(() => fitImageSize(0, 100)).toThrow();
    expect(() => fitImageSize(100, 100, 0)).toThrow();
  });
  it('never exceeds the pixel budget or enlarges either dimension, including rounding edges', () => {
    for (const width of [1, 17, 528, 735, 736, 1025, 4032, 600000]) {
      for (const height of [1, 17, 528, 735, 736, 1025, 4032, 600000]) {
        const output = fitImageSize(width, height);
        expect(output.width * output.height).toBeLessThanOrEqual(541200);
        expect(output.width).toBeGreaterThanOrEqual(1);
        expect(output.height).toBeGreaterThanOrEqual(1);
        expect(output.width).toBeLessThanOrEqual(width);
        expect(output.height).toBeLessThanOrEqual(height);
        if (width * height <= 541200) expect(output).toEqual({ width, height });
      }
    }
  });
  it('defaults on even when storage is unavailable, but remembers explicit opt-out', () => {
    expect(readCompressionPreference({ getItem: () => null })).toBe(true);
    expect(readCompressionPreference({ getItem: () => 'false' })).toBe(false);
    expect(
      readCompressionPreference({
        getItem: () => {
          throw Error('blocked');
        },
      }),
    ).toBe(true);
  });
  it('decodes orientation, resizes PNG losslessly, and releases the bitmap', async () => {
    const r = runtime();
    const file = new File(['png'], 'screen.png', { type: 'image/png' });
    const result = await prepareImageUpload(file, true, r.api);
    expect(result.resized).toBe(true);
    expect(result.file.type).toBe('image/png');
    expect(result.file.name).toBe('screen.png');
    expect(r.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 528, 1025);
    expect(r.canvas.width).toBe(0);
    expect(r.canvas.height).toBe(0);
    expect(r.api.createImageBitmap).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(r.close).toHaveBeenCalledOnce();
  });
  it('keeps original bytes when disabled, small, non-image, or animation-capable format', async () => {
    const file = new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' });
    const r = runtime(100, 50);
    expect((await prepareImageUpload(file, false, r.api)).file).toBe(file);
    expect(r.api.createImageBitmap).not.toHaveBeenCalled();
    expect((await prepareImageUpload(file, true, r.api)).file).toBe(file);
    for (const type of [
      'application/pdf',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'image/heic',
    ]) {
      const f = new File(['original'], 'input', { type });
      expect((await prepareImageUpload(f, true, r.api)).file).toBe(f);
    }
  });
  it('does not flatten APNG animation', async () => {
    const bytes = new Uint8Array(28);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    new DataView(bytes.buffer).setUint32(8, 8);
    bytes.set([97, 99, 84, 76], 12);
    const file = new File([bytes], 'animation.png', { type: 'image/png' });
    const r = runtime();
    expect((await prepareImageUpload(file, true, r.api)).file).toBe(file);
    expect(r.api.createImageBitmap).not.toHaveBeenCalled();
  });
  it('uses JPEG for photos and returns a warning plus original if encoding fails', async () => {
    const file = new File(['jpeg'], 'photo.jpeg', { type: 'image/jpeg' });
    const good = runtime();
    const encoded = await prepareImageUpload(file, true, good.api);
    expect(encoded.file.type).toBe('image/jpeg');
    expect(good.canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.9);
    const bad = runtime(2000, 1000, true);
    const result = await prepareImageUpload(file, true, bad.api);
    expect(result.file).toBe(file);
    expect(result.warning).toBeTruthy();
    expect(bad.close).toHaveBeenCalledOnce();
  });
});
