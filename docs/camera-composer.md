# Camera composer

Order: transcript → composer → drag handle → bottom camera. No separate round
camera shortcut is rendered. Drag Send upward to reveal the pane; its height
follows the pointer in pixels. The arrow becomes a camera glyph. On initial
release it settles to a **2:3 width:height preview**, bounded by available space.
The divider allows subsequent manual height adjustment without re-snapping.
A downward swipe exceeding 40px on the preview (excluding buttons)
settles closed on release, without requiring a drag to the bottom. The divider
continues to resize freely when moved slowly; a quick downward flick closes it
without needing to reach the bottom. Flick detection uses the last 120ms of
samples, at least 18px downward travel and >0.55px/ms, with a freshness check so
a paused drag is not mistaken for a flick. Release below 80px also closes.
The ✕ button uses the same downward rebound animation; navigation/page hiding
still stops immediately. Dismissal fences pending permission responses at once.
Cancelling restores the previous height or closes a newly opened pane. A deliberate new tap is not
blocked by suppression of the preceding drag's trailing click.

Camera acquisition begins on release for a newly opened pane. During first
opening, the panel explicitly prompts to release to activate the camera. Keyboard
users can focus Send and press Up to open using the same 2:3 default height,
capped by available space; separator Up/Down changes height by 32px. Viewport
changes cap height to keep the composer and some transcript visible.

Preview fills the panel (`object-fit: cover`), without letterbox sidebars.
Controls overlay the view rather than occupying a separate black strip. The
capture calculation applies the same aspect-ratio crop and digital zoom as the
preview, so images match the visible field of view. This deliberately crops edges
when camera and panel aspect ratios differ. Safe-area padding belongs to camera
controls, not the elevated composer.

## Separate shutter and batch Send

The shutter captures one JPEG (max longest edge 1920px, quality .88) into the
composer's removable thumbnail tray; it does **not** upload. Repeated shutter
presses add photos, and a pending-count label shows how many are staged. Closing
the camera preserves these photos. Send uploads the staged attachments with the
draft, never an extra implicit snapshot. A blank camera-batch draft uses:

> 請幫我辨識並說明這些照片裡的內容。如果需要更多資訊，可以使用以圖搜尋或上網查證，並附上來源；無法確定的部分請明確說明，不要猜測。

User-written text takes precedence. The normal image-compression preference still
applies on Send. Camera thumbnails stay visible while uploading, with removal
and shutter capture disabled. Acknowledged success clears just that submitted
batch; failure retains photos and restores the draft only if the original
recipient still owns an otherwise empty composer. Preview URLs remain valid for
retry. A failed/lost response may be ambiguous: inspect the chat before retrying
to avoid duplicates. Pending photos are in-memory drafts, not reload-persistent.

While the camera is open, a real **送出** button beside the shutter replaces the
composer's normal send button. It submits the same form (including draft text),
without an extra snapshot. Confirmed success slides/rebounds the camera downward
and closes it; failure keeps the camera and staged photos open. Completion is
selection-fenced so it cannot close a different session's camera.
Closing/session selection/BTW/page hiding
stops tracks; pending permission acquisition is fenced. Permission failure leaves
an explanation and the normal attachment picker available. HTTPS and camera
permission are required. No video stream is uploaded.

## Ported Fuji controls

Adapted from `fuji_camera/static/index.html` camera sections:
- Tap focus: a yellow focus ring moves the sharp centre of the **simulated** radial
  bokeh mask. It does not promise optical autofocus or depth segmentation.
- Horizontal aperture wheel: f/1.2 through f/16, native scroll snapping, selected
  centre highlighted. **Default is f/16 (no simulated blur)**; the wheel centres
  on that stop when opened. f/1.2 gives stronger blur/smaller sharp area; f/16 turns off
  blur. The label explicitly says simulated depth of field.
- Two-finger pinch: zooms the track when capabilities expose hardware zoom;
  otherwise zooms a centre crop, labelled digital. Pinch does not resize or close
  the pane and lifting the second finger does not turn into a focus tap.
- Front/back switching releases the old stream; front preview and capture are
  mirrored consistently. A lens picker appears only if enumeration exposes
  multiple cameras, labelled by available device metadata, not invented focal
  lengths. Hardware zoom changes are serialized/coalesced during pinch.

`camera-effects.js` shares aperture/focus parameters between the masked CSS blur
preview and the captured JPEG. Capture applies a downsampled separable CPU blur
and radial blend so it works without relying on Safari Canvas filter support.
Preview and capture use the same crop/mirror/focus coordinates; their blur kernels
are approximate, not guaranteed pixel-identical. f/16 leaves capture pixels
untouched by the effect. The second preview video uses the same stream, not a
second camera permission request, and is detached on close/switch.

Fuji's server-side film/FLUX processing, burst uploader and gallery are not ported.
PiWeb sends the explicitly staged locally rendered images per Send. Physical aperture
and hardware autofocus are not claimed.

## Verification

`test/e2e/camera-composer.spec.ts`: mobile Chromium fake camera, follows multiple
held finger positions, upward/downward resizing, full pane coverage, JPEG crop
aspect, default and typed prompts, reduced viewport, downward close and stopped
tracks, text-only send, denied and late permissions.

`test/e2e/camera-send-live.spec.ts`: opt-in disposable loopback web-only PiWeb,
real authentication/upload/SSE/history/media serving; two photos are submitted
in one batch, then a third with user text. All three JPEGs persist after reload.
Both successful sends rebound the camera closed. No production conversation or
model worker. Fake camera only. Latest recording:
`artifacts/camera-shutter-send/workflow.mp4`.

`test/e2e/camera-batch.spec.ts` verifies shutter/no-upload, removal, preservation
on manual camera close, pending-upload immutability, success clearing, HTTP 503
retention/retry, the adjacent Send control and success-only auto-close.

`test/camera-effects.test.ts` covers blur math, aperture response and lens labels.
`test/e2e/camera-effects-render.spec.ts` verifies actual saved-frame pixel changes
outside the focus circle and exact preservation with f/16. The main camera E2E
also covers touch focus, wheel swiping, pinch without pane resize, and releasing
old tracks on front/back switches. Run the following against an isolated fixture:

```bash
npx vitest run
npx playwright test test/e2e/camera-batch.spec.ts test/e2e/camera-composer.spec.ts \
  test/e2e/camera-effects-render.spec.ts test/e2e/image-compression.spec.ts \
  test/e2e/life-mode.spec.ts --project chromium-mobile --workers=2
```

For the real web-only upload test, provide `PIWEB_CAMERA_TEST_URL` (loopback only)
and `PIWEB_CAMERA_TEST_TOKEN` for a disposable server with its own DB, sessions,
media, uploads and cwd; leave its worker disabled. Run
`test/e2e/camera-send-live.spec.ts` explicitly. This verifies storage/transport,
not an agent answer.

A WebKit render smoke test was attempted but could not launch: host dependencies
`libicu74`, `libavif16`, and `libmanette-0.2-0` are missing. No WebKit/iOS pass is
claimed and no system packages were installed as part of this change.

This does not establish real iOS/Android camera, keyboard or optical zoom
compatibility. Production deployment health and actual phone behavior are
separate from the Chromium verification.

Settling uses a bounded 460ms overshoot and smaller return; reduced-motion users
receive immediate settling. Pointer-down cancels settling for direct manipulation.
The portrait target is capped when keyboard/viewport constraints leave less room.
