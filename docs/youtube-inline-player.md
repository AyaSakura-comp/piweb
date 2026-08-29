# Inline YouTube player

Piweb progressively enhances safe YouTube links in rendered message and event Markdown. The original anchor remains the baseline: an ordinary click opens an inline privacy-enhanced player, while modified clicks and the visible fallback continue to open YouTube itself.

## Supported links

`getYouTubeVideoId()` in `public/markdown.js` accepts HTTP(S) URLs only when the normalized hostname is exactly one of:

- `youtube.com`, `m.youtube.com`, or `music.youtube.com`
- `youtube-nocookie.com`
- `youtu.be`

Supported video paths are:

- `youtube.com/watch?v=VIDEO_ID`
- `youtu.be/VIDEO_ID`
- `youtube.com/shorts/VIDEO_ID`
- `youtube.com/live/VIDEO_ID`
- `youtube.com/embed/VIDEO_ID`
- `youtube.com/v/VIDEO_ID`

A video ID must match `^[A-Za-z0-9_-]{11}$`. Channel/profile links, missing or malformed IDs, unsafe schemes, Bilibili links, and lookalike hosts such as `youtube.com.evil.test` remain ordinary links and never create an iframe.

## Interaction and lifecycle

1. Rendering adds a 44px play affordance and accessible `aria-label` to a validated source link. No iframe or third-party request exists yet.
2. An unmodified primary click prevents external navigation and creates:
   `https://www.youtube-nocookie.com/embed/VIDEO_ID?autoplay=1&playsinline=1&rel=0`.
3. Each `.msg-text` or `.event-body` owns at most one player. Selecting another YouTube link in the same scope removes the old iframe before inserting the new one, which also stops old playback.
4. Selecting the currently expanded source again collapses it.
5. **Close** removes the iframe, resets `aria-expanded`/`aria-controls`, and returns focus to the source link.
6. **Open in YouTube** remains available at all times for owner-disabled, age-restricted, sign-in-gated, or otherwise unembeddable videos.

Control-, Command-, Shift-, Alt-, and middle-clicks preserve native external navigation. Their events stop before piweb's delegated message-link copy handler, without calling `preventDefault()`.

## Security and privacy contract

- Model-authored content is converted to DOM/text nodes; it is never assigned to `innerHTML`.
- The iframe path interpolates only the validated 11-character ID.
- The embed uses `youtube-nocookie.com`, `referrerpolicy="strict-origin-when-cross-origin"`, and an explicit feature allowlist.
- External anchors use `target="_blank"` and `rel="noopener noreferrer"`.
- Existing Markdown's HTTP(S)/mailto allowlist remains unchanged.
- Player placement climbs out of tables, paragraphs, lists, and blockquotes to a direct message/event child, preventing nested overflow and clipping.

## Mobile layout and accessibility

- Source, external-open, and close targets are at least 44×44px and pointer hit-tested.
- Standard assistant cards use 16:9 up to a 640px maximum width.
- YouTube requires a player viewport of at least 200×200. When a user or event column is narrower than the width needed for both 16:9 and 200px height, piweb keeps the 200px minimum and intentionally uses a taller card.
- Cards must remain within the visual viewport and must not increase document horizontal scroll width.
- The player is an accessible named region; source links expose `aria-expanded` and `aria-controls`; close restores focus without scrolling.

## Verification

Run the focused checks:

```bash
npm test -- test/markdown-youtube.test.ts
npx playwright test test/e2e/markdown-links.spec.ts
```

The Playwright workflow records the 390×844 mobile sequence and checks:

- no eager iframe;
- Control- and middle-click external navigation without delegated interception;
- open, replace, same-scope singleton, nested user-message, event-body, and close states;
- exact embed URL and iframe attributes;
- 44px pointer-reachable controls, viewport containment, minimum dimensions, and zero horizontal overflow;
- focus/ARIA restoration and empty page/console error lists.

The deterministic E2E route fulfills only the third-party iframe document while preserving and asserting the real `youtube-nocookie.com` request URL. This avoids external flakiness but does not claim that every video owner permits embedding.

Release verification for feature commit `95074cd` completed on 2026-08-29:

- Vitest: 69 files / 344 tests passed.
- Full mobile Playwright: 76 passed / 4 opt-in live tests skipped.
- A directly inspected 6.60-second H.264 390×844 workflow showed idle, open, replacement, nested user, event, and close states without clipping or stale frames.
- Post-deploy production smoke loaded the real rope-coiling YouTube video image and native controls, advanced playback, retained piweb's fallback/close actions, and returned HTTP 200 through both Tailnet and the public Funnel path.

Generated videos, screenshots, traces, metrics, and reports belong under `artifacts/` and remain gitignored.

## Implementation map

| Area | File |
|---|---|
| URL/ID validation, lazy iframe, ARIA, lifecycle | `public/markdown.js` |
| Delegated link-handler exclusion | `public/app.js` |
| Responsive player and 44px controls | `public/app.css` |
| Parser/handler unit contract | `test/markdown-youtube.test.ts` |
| Mobile behavior, geometry, video evidence | `test/e2e/markdown-links.spec.ts` |
| Deterministic rendered fixture | `test/e2e/fixtures/markdown-links.html` |
