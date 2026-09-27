# Browser-side image upload resizing

The attachment composer shows a **壓縮圖片** checkbox whenever an image is queued.
It is enabled by default; an explicit opt-out is remembered in localStorage.
Storage access failures leave it usable for the current page.

## Contract

- Resize on **Send**, in the browser, before base64 serialization and the
  `/messages` HTTP upload. Originals remain queued so unchecking before Send
  uploads the exact original bytes; no additional original-image upload occurs.
- Preserve aspect ratio with integer dimensions. Limit **total pixel area** to
  **541,200 pixels (= 528×1025)**, without cropping or enlarging small images.
  Apply `scale = sqrt(541200 / (width * height))` to both axes only when over budget.
  Round to nearest integers; if that exceeds the budget, floor both scaled axes.
  Extremely thin images respect a one-pixel minimum and the same area cap.
  This is **not** a fixed longest edge or 528×1025 bounding box.
  Examples: 1057×2052 → **528×1025**; 4032×3024 → **849×637**;
  2000×2000 → **735×735**; 1080×2410 → **492×1099**.
  A 2000×200 image remains unchanged because its area is already below the cap.
- Static JPEG is encoded as JPEG at quality 0.9. Static PNG stays PNG, retaining
  transparency and avoiding additional lossy screenshot compression.
- Browser EXIF orientation is applied before computing target dimensions.
- GIF, WebP, SVG, HEIC and APNG stay original: do not silently flatten animations
  or discard unsupported format content. Non-image documents/audio/video also
  stay byte-identical. A decode/encode failure keeps the original and shows a
  toast explaining that it will be uploaded uncompressed.
- File-picker and clipboard attachments share the same send path. Existing
  session/draft ownership is preserved across asynchronous resizing. Preference
  is captured once at submit and disabled while upload is in progress.
- Bitmap, object URL and canvas resources are released. Conversion is sequential
  to avoid holding several full-resolution image buffers concurrently.

This uses browser Canvas high-quality resampling, not Pillow Lanczos. Matching
pixel dimensions does not guarantee identical pixels or OCR output. The prior
528×1025 OCR observation was image-specific, not a universal quality guarantee.
Dimension reduction also does not guarantee a smaller byte size for every image.

## Implementation

- `public/image-compression.js`: geometry, safe format policy and image encoding.
- `public/app.js`: preference and shared submit integration.
- `public/index.html` / `public/app.css`: native accessible checkbox and hint;
  label has a 44px touch target and follows existing theme tokens.

No server API, worker, model or upload size-limit changes are required.
Unsupported original uploads remain subject to the existing server limits.

## Verification

```sh
npx vitest run test/image-compression.test.ts
PIWEB_E2E_PORT=4196 npx playwright test test/e2e/image-compression.spec.ts
```

The E2E uses the real frontend with mocked API boundaries and checks the actual
base64 HTTP payload: portrait/landscape, 4:3, square and tall image pixel budgets,
small-area panoramas whose long edge exceeds 1025, JPEG EXIF rotation, checkbox
opt-out byte identity, preference persistence, clipboard paste, small-image
identity and mixed non-image/GIF preservation. It also checks mobile pointer
reachability, desktop overflow, screenshots and unexpected browser errors.
Unit coverage includes APNG, storage failure and encoder failure behavior.

Chromium verification is not physical iPhone/Safari validation. Live upload to
production and downstream OCR are not part of this fixture test. Evidence stays
under ignored `artifacts/`; deployment is a separate operation.
