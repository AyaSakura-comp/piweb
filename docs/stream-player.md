# Stream player

Chat and gallery video/audio play in one persistent **stream player**
(`public/stream-player.js`) with two placements:

- **Embedded** — tapping a chat poster or audio track opens the player in place:
  the item's box zooms (height + clip, ~360 ms, skipped under reduced motion)
  into the full player at the same spot, and the transcript below glides down.
  The original poster/track is hidden while the player stands in for it
  (`data-stream-embedded`); Close shrinks the player back into it. Embedded
  players are always fully open (no collapse button); tapping the picture or
  music icon toggles play/pause. Previous/next/auto-advance move the player to
  the next item's spot in the transcript.
- **Dock** — between the transcript and the composer (`.stream-dock`). Used for
  ⋯ → Media playback, and as the fallback when the embedded item leaves the
  transcript (another session selected, history reloaded): a `MutationObserver`
  on `#messages` re-homes the player — into the re-rendered node for the same
  item if there is one, else the dock — in the same task, so playback is not
  interrupted. Tapping the playing item in the transcript moves it back in place.

## User-visible behavior

- **Chat video** attachments and inline reply videos (`[[video: …]]`, Markdown
  and LobeHub) are posters with a play button; tapping one opens it
  embedded in place. The poster keeps its separate download row.
- **Chat audio** attachments are track rows (`音訊 · 串流播放`) instead of native
  `<audio>` controls; tapping one opens it embedded in place.
- **⋯ → Media**: an audio tile plays in the dock and leaves the sheet open, so
  you can keep browsing; a video tile closes the sheet to show the video.
- Tapping the item that is already loaded toggles play/pause instead of
  restarting it. The playing item is outlined and its glyph shows pause.
- Dock (collapsed): thumbnail/music icon, title, `elapsed / duration`
  (`· 緩衝中…` while buffering, `無法播放此檔案` on a decode error), previous,
  play/pause, next, close, and a seek bar showing played and buffered ranges.
  Tap the title to expand: large video, playlist position `n / N`, download
  (iOS home-screen two-tap share, as elsewhere) and full screen (video).
- **Playlist**: from the chat, every streamable item in the loaded transcript in
  reading order; from ⋯ → Media, the session's video/audio list, oldest first.
  The end of an item advances to the next one; previous restarts the current
  item after 3 s.
- Playback **persists** across transcript scrolling, the drawer, Life/sessions
  mode and switching sessions. It stops on Close or logout.
- **Lock screen / headset**: Media Session metadata (title, `Piweb`) and
  play/pause/previous/next/seek actions where the browser supports them.
- Images keep the swipeable album; a video reached by swiping from an image
  still plays inside the album (see [media album](media-album.md)).

## Streaming

The dock sets `src` to the `/media/...` URL and lets the browser fetch byte
ranges (`preload="auto"` only for the loaded item; posters use `metadata`).
The web tier already answers `Range` with `206 Partial Content`, so seeking
jumps without downloading the file first. No blob downloads are used for
playback.

**Known gap:** the web tier's static MIME map has no `.m4a`, `.aac`, `.flac`,
`.opus`, `.mov` or `.m4v` entries, so those are served as
`application/octet-stream` and iOS Safari may refuse to play them. Fixing that
is a `src/web/server.ts` change and needs a web image rebuild (ask first).

## Verification

```bash
npx vitest run test/stream-player.test.ts test/markdown-lists.test.ts
npx playwright test test/e2e/stream-player.spec.ts test/e2e/lightbox-album.spec.ts
```

The E2E fixture server serves byte ranges like production. The specs assert
Range requests, playback progress, seek, next/auto-advance, video↔audio
element handoff, Media Session metadata, playback continuing across a session
switch, Media sheet behavior, and no horizontal overflow at 390×844, with
screenshots in dark and light themes. They run in mobile Chromium, not a
physical iPhone: background-audio and lock-screen behavior on iOS are not
proven by them.
