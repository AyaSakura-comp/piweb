# Split camera composer

Historical initial plan. Requirements evolved; [current camera documentation](../camera-composer.md)
is authoritative for layout, gesture settling, batch capture and Send behavior.

1. Add a failing mobile Playwright contract: send-button upward touch gesture opens a camera pane without sending; drag divider changes height; snapshot sends JPEG and default prompt; typed prompt wins; closing stops tracks.
2. Implement `public/camera-composer.js` and CSS: native local preview, cancellable permission acquisition, front/back switching, Fuji-inspired zoom slider (hardware when supported, clearly marked digital crop otherwise), range separator with keyboard access, explicit open/close buttons. No simulated optical aperture or backend image generation.
3. Wire into `public/index.html` and `public/app.js`. Capture synchronously before the existing attachment pipeline; keep preview open after sending. Fence navigation and stop tracks when hidden. Preserve text-only submission and prevent gesture-release clicks.
4. Exercise permission denial and delayed acquisition cancellation, playback/capture, empty and typed prompts, resizing, session changes, normal send and closing. Use browser fake camera + fixture API, not a real phone or production chat.
5. Record continuous mobile workflow, inspect screenshots and extracted frames, run regression/unit/type/lint checks. Document limits and leave production deployment separate.
