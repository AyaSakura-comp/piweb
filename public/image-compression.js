/** Local-only upload preparation. Originals remain untouched until Send. */
export const IMAGE_MAX_PIXELS = 528 * 1025;
export const IMAGE_COMPRESSION_KEY = 'piweb.compress-images';

export function fitImageSize(width, height, maxPixels = IMAGE_MAX_PIXELS) {
  if (![width, height, maxPixels].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new RangeError('Invalid image dimensions or pixel budget');
  }
  if (width * height <= maxPixels) return { width, height };

  // One uniform scale for both axes; the constraint is area, not a long edge.
  const scale = Math.sqrt(maxPixels / width / height);
  let targetWidth = Math.max(1, Math.round(width * scale));
  let targetHeight = Math.max(1, Math.round(height * scale));
  if (targetWidth * targetHeight > maxPixels) {
    // Rounding may exceed the budget (e.g. 736²). Floor the uniformly scaled
    // dimensions instead, keeping squares square and each axis within 1 pixel.
    targetWidth = Math.max(1, Math.floor(width * scale));
    targetHeight = Math.max(1, Math.floor(height * scale));
    // Extremely thin images can reach the one-pixel minimum on one axis.
    if (targetWidth * targetHeight > maxPixels) {
      if (targetWidth >= targetHeight) targetWidth = Math.floor(maxPixels / targetHeight);
      else targetHeight = Math.floor(maxPixels / targetWidth);
    }
  }
  return { width: targetWidth, height: targetHeight };
}

export function readCompressionPreference(storage) {
  try {
    return (storage || globalThis.localStorage).getItem(IMAGE_COMPRESSION_KEY) !== 'false';
  } catch {
    return true;
  }
}

async function isAnimatedPng(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, i) => bytes[i] === value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // APNG's animation control precedes IDAT. Skip chunks, not arbitrary strings
  // in compressed pixel data; malformed chunks are handled by the decoder.
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = view.getUint32(offset);
    if (offset + length + 12 > bytes.length) return false;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += length + 12;
  }
  return false;
}

async function decodeImage(file, runtime) {
  if (runtime.createImageBitmap) {
    try {
      return await runtime.createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Older Safari may decode through <img> but not createImageBitmap.
    }
  }
  const url = runtime.URL.createObjectURL(file);
  try {
    const image = new runtime.Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Cannot decode image'));
      image.src = url;
    });
    return image;
  } finally {
    runtime.URL.revokeObjectURL(url);
  }
}

/**
 * Static JPEG/PNG only: never flatten animated GIF/WebP/APNG or rasterize SVG.
 * Unsupported formats and small images retain their exact original bytes.
 * Resize failures also retain the original but must be surfaced by the caller.
 */
export async function prepareImageUpload(file, enabled = true, runtime = globalThis) {
  const original = { file, resized: false, warning: '' };
  if (!enabled || !['image/jpeg', 'image/png'].includes(file.type)) return original;
  let image;
  let canvas;
  try {
    if (file.type === 'image/png' && (await isAnimatedPng(file))) return original;
    image = await decodeImage(file, runtime);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const size = fitImageSize(width, height);
    if (size.width === width && size.height === height) return original;
    canvas = runtime.document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, size.width, size.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, file.type, 0.9));
    if (!blob || !['image/jpeg', 'image/png'].includes(blob.type)) {
      throw new Error('Cannot encode image');
    }
    // Canvas may fall back to PNG; filename must match the actual bytes.
    const name =
      blob.type === file.type && file.name
        ? file.name
        : `${(file.name || 'image').replace(/\.[^.]+$/, '')}.${blob.type === 'image/png' ? 'png' : 'jpg'}`;
    const resized = new runtime.File([blob], name, {
      type: blob.type,
      lastModified: file.lastModified,
    });
    return { file: resized, resized: true, warning: '' };
  } catch {
    return { ...original, warning: '圖片壓縮失敗，將傳送原檔' };
  } finally {
    image?.close?.();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
