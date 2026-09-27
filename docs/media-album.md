# Image and video album

## User-visible behavior

- Tap an attachment image in a chat to open the lightbox at that image. It opens
  immediately with loaded transcript media, then requests the session media
  list (`GET /api/sessions/:jid/media`) to include older, unloaded attachments.
- Images and videos share an oldest-first album. The counter and thumbnail strip
  expand when the list arrives, without reloading the currently displayed item.
- Chat videos appear as poster buttons with a play indicator and a separate
  download link. Tap the poster to open that video in the album; playback uses
  native video controls rather than an inline chat player.
- Swipe between images and videos. Video thumbnails carry a play indicator.
  Video control-band gestures are excluded from album swipes; videos do not use
  image pinch/double-tap zoom.
- Leaving a video or closing the album pauses it and removes its source, so it
  does not continue playing in the background.
- **⋯ → Media** opens images/videos in the same mixed album. Audio retains the
  separate in-app player.

## Loading and safety boundaries

The media list is metadata, not a request to download every original file.
Image prefetch remains a sliding window around the current item. If the album
request fails, the loaded-transcript album still works. Late responses are
fenced against closing the viewer, changing sessions and changing Life generation.
Markdown images that are not registered attachments may not occur in the session
media list and retain the loaded-transcript fallback.

The video poster uses `#t=0.1` with metadata preloading. Poster behavior and codec
support depend on the browser; Chromium coverage is not proof of iOS compatibility.

Implementation: `public/app.js` (`openLightbox`, `widenLightboxToAlbum`, media
rendering and viewer gesture/lifecycle handlers).

## Reproducible verification

```bash
npx playwright test test/e2e/lightbox-album.spec.ts \
  test/e2e/media-player.spec.ts test/e2e/life-mode.spec.ts \
  --project chromium-mobile --workers=2
```

The focused suite passed **100 tests**. The album spec was then strengthened to
call video playback and assert `currentTime > 0.1` with no media error; both album
tests passed again. Coverage includes opening on the selected image/video, full
album ordering and counts, touch swipes, video-to-image transitions, source removal
on exit, existing audio/player behavior and Life navigation regressions.

Tests use the production UI with fixture API/media responses and mobile Chromium,
not a physical iPhone, Safari or a live-account provider run. The playback assertion
starts a muted video programmatically; it does not prove native-control touch
interaction or autoplay behavior on every device. Screenshot/video artifacts are
local ignored evidence, not repository assets. No product changes were needed in
the latest verification; `0c3c8eb` adds the stronger playback assertion.
