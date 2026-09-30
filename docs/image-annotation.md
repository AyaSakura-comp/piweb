# Image annotation

Open a chat/Media image or a pending image thumbnail, then tap the pencil (**畫筆標註**). Draw with a finger, mouse or pen; select a colour and brush width, undo (**復原**), or clear (**清除**). **取消** / Escape discards the edit and returns to the original viewer. **確定加入附件** flattens the image plus marks into a new PNG File and queues it in the existing composer. It preserves the draft and existing attachments; it never sends automatically. Send/remove/compression use the ordinary image attachment path. The original file is never modified.

The editor is available for images in writable main conversations, not videos, deleted-session previews, or the BTW side composer. Pending image thumbnails now open in the same viewer. A confirmed edit of a pending image adds a new copy rather than replacing the pending original.

## Button style and accessibility

The editor follows the existing image viewer: transparent white outline-icon buttons, a dark capsule for brush width, and circular colour swatches with a white selection ring. There is no purple-filled confirmation button or boxed text action. **×** cancels, **✓** adds the PNG attachment, the curved arrow undoes, and the trash icon clears. Actions retain accessible Chinese names and hover tooltips; all editor controls have at least 44×44px touch targets. Disabled Undo/Clear remain dimmed until a stroke exists. Undo is also disabled while a pointer stroke is active; Ctrl/Cmd+Z becomes available after lifting the pointer. This prevents cancellation of an interrupted stroke from deleting an earlier completed stroke.

## Limits and safety

- Canvas output preserves aspect ratio and natural dimensions up to a 4096px longest edge; larger camera photos are downscaled to bound phone bitmap memory.
- Animated images export one decoded still frame. Transparent areas remain transparent in the PNG.
- Remote image URLs must permit browser CORS fetch; a blocked/invalid image shows a load failure without adding a file.
- Cancel/close aborts fetching and invalidates delayed decode/export results. The original JID plus selection generation must still own the composer before a file can be queued.
- Editing uses a native modal, preventing viewer swipe/pinch and background controls from competing with drawing. Pointer capture keeps strokes continuous outside the image; pointercancel discards the interrupted stroke.

## Verification

```sh
PIWEB_E2E_PORT=4193 npx playwright test test/e2e/image-annotation.spec.ts --workers=1

# Human-readable continuous mobile recording (presentation pacing only):
PIWEB_ANNOTATION_VIDEO=1 PIWEB_E2E_PORT=4194 npx playwright test \
  test/e2e/image-annotation.spec.ts -g 'mobile annotation' --workers=1 \
  --output=artifacts/image-annotation-style/recording
```

Tests render production HTML/JS/CSS with isolated API/media fixtures. Mobile CDP touch and desktop mouse paths cover open, draw, colour/width, undo, clear, cancel, confirm, preview the resulting attachment, Escape, and normal Send. Assertions include source dimensions, changed/exported pixels, normal PNG/base64 request payload, preserved draft, no automatic send, original file untouched, modal viewport containment, touch targets, hit-testing, and unexpected browser errors. The API fixture retains accepted uploads; reloading the real UI verifies the sent PNG renders in the transcript with the same marked pixels. Additional cancellation coverage protects delayed loads/exports, and a touch-plus-keyboard regression verifies that Undo during an active touch followed by pointer cancellation preserves the previous completed stroke.

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
