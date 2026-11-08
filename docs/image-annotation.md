# Image annotation

Open a chat/Media image or a pending image thumbnail, then tap the pencil (**畫筆標註**). Drawing happens in the image viewer itself, not in a second window (2026-11-08): the picture becomes a canvas at the same spot and zoom, the viewer's top bar becomes **×** / **✓**, and its filmstrip row becomes the pen tools. A same-origin picture is drawn from the viewer's own `<img>`, so nothing is downloaded again — the old modal re-fetched the image and showed 載入圖片… until that download finished (iPad recording 2026-11-08: still loading when closed after about 2 s). Draw with a finger, mouse or pen; select a colour and brush width, undo (**復原**), or clear (**清除**). **取消** / Escape / Android Back discards the edit and leaves the viewer as it was, at the zoom the drawing ended on. **確定加入附件** flattens the image plus marks into a new PNG File and queues it in the existing composer. It preserves the draft and existing attachments; it never sends automatically. Send/remove/compression use the ordinary image attachment path. The original file is never modified.

The editor is available for images in writable main conversations, not videos, deleted-session previews, or the BTW side composer. Pending image thumbnails now open in the same viewer. A confirmed edit of a pending image replaces it in place (same position); an image from the transcript is added as a new attachment.

## Button style and accessibility

The editor follows the existing image viewer: transparent white outline-icon buttons, a dark capsule for brush width, and circular colour swatches with a white selection ring. There is no purple-filled confirmation button or boxed text action. **×** cancels, **✓** adds the PNG attachment, the curved arrow undoes, and the trash icon clears. Actions retain accessible Chinese names and hover tooltips; all editor controls have at least 44×44px touch targets. Disabled Undo/Clear remain dimmed until a stroke exists. Undo is also disabled while a pointer stroke is active; Ctrl/Cmd+Z becomes available after lifting the pointer. This prevents cancellation of an interrupted stroke from deleting an earlier completed stroke.

## Two-finger zoom and pan

Inside the editor, a single finger, mouse or pen draws; two fingers pinch to zoom (1–8×) and drag together to move the image. Zoom is centred on the gesture midpoint where the image bounds permit, and panning is bounded so the image cannot disappear. Pinch inward to return to the fitted view.

Starting a two-finger gesture discards its unfinished initial stroke, preventing accidental marks. Completed strokes remain unchanged. Lift **both** fingers before starting the next drawing stroke; the last remaining pinch finger never becomes a drawing pointer. Brush coordinates follow the zoomed image, with the selected width measured on screen for detailed work. Undo continues to affect strokes, not view transforms.

The view transform never changes the canvas bitmap. Confirm always exports the **complete** image plus marks, including content outside the zoomed viewport, with the same output-size limits.

The pencil keeps the viewer's zoom: drawing starts on the part of the picture that was on screen, and Cancel hands the zoom back to the viewer (bounded by the viewer's own maximum). The tools take the bottom row, so the picture's fit can shrink a little; zoom and pan offsets are scaled by the fit change and the canvas glides from the photo's old rect to its new one (and back on Cancel). While drawing, the viewer's swipe-to-page, swipe-to-dismiss, backdrop tap, arrow keys, filmstrip and arrows are off; the canvas owns every gesture.

## Limits and safety

- Canvas output preserves aspect ratio and natural dimensions up to a 4096px longest edge; larger camera photos are downscaled to bound phone bitmap memory.
- Animated images export one decoded still frame. Transparent areas remain transparent in the PNG.
- A picture from another origin is fetched instead (a canvas drawn from a cross-origin `<img>` cannot export); it must permit browser CORS fetch, and a blocked/invalid image shows a load failure without adding a file.
- If the pencil is tapped while the viewer's picture is still loading, drawing waits for it (**✓** stays disabled). Cancel/close aborts fetching and invalidates delayed decode/export results. The original JID plus selection generation must still own the composer before a file can be queued.
- The viewer's gesture handlers stand down while drawing (`imageAnnotator.active`), so swipe/pinch and background taps cannot compete with drawing. Pointer capture keeps strokes continuous outside the image; pointercancel discards the interrupted stroke.

## Verification

```sh
PIWEB_E2E_PORT=4193 npx playwright test test/e2e/image-annotation.spec.ts --workers=1

# Human-readable continuous mobile recording (presentation pacing only):
PIWEB_ANNOTATION_VIDEO=1 PIWEB_E2E_PORT=4194 npx playwright test \
  test/e2e/image-annotation.spec.ts -g 'mobile annotation' --workers=1 \
  --output=artifacts/image-annotation-style/recording
```

Tests render production HTML/JS/CSS with isolated API/media fixtures. In-place drawing (2026-11-08) is asserted directly: no `dialog[open]`, the viewer stays up, the picture is not requested again, the canvas lies on the viewer photo's box (within 1px) with the photo hidden under it, the viewer zoom carries into drawing (same size, same spot in the stage) and back out on Cancel, and a picture still loading when the pencil is tapped holds ✓ disabled and stays cancelled. Mobile CDP touch and desktop mouse paths cover open, draw, colour/width, undo, clear, cancel, confirm, preview the resulting attachment, Escape, and normal Send. Assertions include source dimensions, changed/exported pixels, normal PNG/base64 request payload, preserved draft, no automatic send, original file untouched, tool-row viewport containment, touch targets, hit-testing, and unexpected browser errors. The API fixture retains accepted uploads; reloading the real UI verifies the sent PNG renders in the transcript with the same marked pixels. Additional cancellation coverage protects delayed loads/exports, and a touch-plus-keyboard regression verifies that Undo during an active touch followed by pointer cancellation preserves the previous completed stroke. CDP multi-touch regressions cover pinch enlargement, two-finger panning, no accidental pinch marks, the all-fingers-up drawing boundary, drawing/Undo after zoom, 1×/8× bounds, Cancel handing the zoom back (clamped to the viewer's maximum) with no cancelled finger surviving the reopen, and full-image PNG export while zoomed.

Record just the zoom/draw workflow:

```sh
PIWEB_ANNOTATION_VIDEO=1 PIWEB_E2E_PORT=4194 npx playwright test \
  test/e2e/image-annotation.spec.ts -g 'two-finger zoom' --workers=1 \
  --output=artifacts/image-annotation-pinch/recording
```

The style contract checks transparent/borderless action buttons, outline SVGs, and the capsule selector on both mobile and desktop. Screenshots and native WebM recordings are saved in the selected output directory (default: ignored `artifacts/playwright/`). Convert WebM to H.264 MP4 for delivery; do not merely rename its extension:

```sh
mkdir -p artifacts/image-annotation-style/videos
WEBM="$(find artifacts/image-annotation-style/recording -name video.webm -print -quit)"
ffmpeg -y -i "$WEBM" -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  artifacts/image-annotation-style/videos/full-workflow.mp4
ffprobe -v error -show_entries stream=codec_name,pix_fmt,width,height \
  -show_entries format=duration,size \
  artifacts/image-annotation-style/videos/full-workflow.mp4
```

### Recorded verification and limits

The reviewed mobile recording is 390×844, 21.44 seconds, H.264/yuv420p. Its continuous journey covers viewer → editor → draw → undo → clear → cancel → reopen → colour/width change → confirm → queued attachment → reopen → Escape → Send → reload with the persisted marked image. The paced test passed; the related annotation/viewer/compression/camera suite passed all 12 tests.

Visual verification inspected full-resolution milestone screenshots and chronological samples extracted at 8 fps across the complete recording. The inspected samples match the viewer's button style, show no clipping or error messages, and show the sent marks correctly. This was sampled-frame inspection, **not direct MP4 playback or every encoded frame**. Persistence is an isolated API fixture; physical-iPhone Safari and real-agent image understanding were not verified.

Evidence remains ignored and is not part of the source commit: `artifacts/image-annotation-style/{videos,frames,screenshots}`, `contact-sheet.png`, `video-metadata.json`, and `report.md`.

### Two-finger acceptance

The expanded annotation/viewer/compression/camera suite passed all **15 browser tests**; the unit suite passed **633 tests** with one skipped. Lint, build and diff checks passed. The continuous pinch recording is **11.84 seconds**, 390×844, H.264/yuv420p; its paced test passed in 10.1 seconds. It demonstrates an existing stroke → pinch enlargement → two-finger pan → lift all fingers → draw a new stroke while zoomed → Undo → pinch back to fit → enlarge again → confirm a complete-image attachment.

Four chronological 8fps frame sheets and a full-resolution zoomed-drawing screenshot were inspected. Controls remain outside the clipped image stage, completed marks survive navigation, and no unwanted error messages were observed in the samples. The export test compares the queued PNG with the complete pre-zoom bitmap, rather than only checking the thumbnail. The same sampled-playback, isolated-fixture and physical-Safari limits above apply.

Ignored pinch evidence: `artifacts/image-annotation-pinch/videos/workflow.mp4`, `frames/`, `recording/`, `video-metadata.json`, and `report.md`.
