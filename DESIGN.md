# PiWeb design specification

## Scope and foundations

Phone-first chat UI. `public/app.css` is the source of truth for shared tokens;
feature styles reuse these tokens rather than introducing separate palettes.
This document currently specifies the shared viewer foundation and Subagents
navigation. It does not change Life, Settings or browser-native navigation.

| Token      | Dark      | Light     |
| ---------- | --------- | --------- |
| `--bg`     | `#313338` | `#ffffff` |
| `--bg-alt` | `#2b2d31` | `#fbfaf7` |
| `--border` | `#3f4147` | `#dedbd3` |
| `--text`   | `#dbdee1` | `#35332f` |
| `--text-2` | `#b5bac1` | `#56534d` |
| `--accent` | `#5865f2` | `#3f5f6f` |

Subagents uses the inherited system font, a 20px/650-weight heading, 15px card
names and 12–13px metadata. Use 16px horizontal content spacing, 12px card gaps
and visible keyboard focus. Header buttons are at least 44×44px.

## Viewer layout

- Mobile (below 768px; primary test viewport 390×844): Subagents occupies the
  full viewport, `100dvh`, without outer border or radius. Header and bottom
  padding respect safe-area insets. Only the body scrolls.
- Tablet/desktop (768px and above; desktop reference 1280px): retain the existing
  centered, bounded Subagents shell (maximum width 720px and height 860px).
- Commands reuse the header/theme but use their own edge-to-edge shell.
  The swipe navigation specified below applies to **Subagents**, not Commands.

## Subagents navigation contract

Hierarchy: **main chat → Subagents list → child transcript**. Nested native
children remain selectable transcript entries; the viewer exposes one detail
level rather than a separate navigation stack per runner depth.

| Action                                      | Destination      | Motion                                                             |
| ------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| Open Subagents                              | List             | Shell enters from the right, moving left to rest                   |
| Select a child                              | Child transcript | Content enters from the right, moving left                         |
| Right drag in a child transcript            | Subagents list   | Foreground follows the finger right, revealing the list underneath |
| Right swipe in the list                     | Main chat        | Shell exits to the right                                           |
| Back button                                 | List             | Same as child right swipe                                          |
| Close, Escape or desktop backdrop dismissal | Main chat        | Shell exits to the right                                           |

Opening uses 220ms and child navigation 200ms with
`cubic-bezier(.2,.8,.2,1)`; closing uses 140ms ease-in. Travel uses horizontal
`translateX` only, with no vertical slide or scale transition. Rapid navigation
cancels superseded animations and requests. Programmatic session invalidation
closes immediately rather than animating obsolete content.

### Gesture recognition and exclusions

Navigation uses a **finger-following right drag** on both the list and child
transcript. After 12px of rightward, horizontally dominant movement (1.5× the
vertical distance), the entire foreground surface tracks the finger 1:1, clamped
to the viewer width. There is no hold timeout: keeping a finger down does not
navigate or snap back automatically.

For iOS scroll arbitration, cancel the first clearly rightward touchmove even
below the 12px visual threshold. Waiting until the visual threshold can let
Safari claim native scrolling first. Vertical-first movement remains uncancelled.
The regression checks a 4px rightward event separately from vertical movement;
Chromium CDP coverage is not physical iPhone Safari verification.

Validation record: the user reported that dragging did not work on iPhone before
this early-touch cancellation fix, then gave positive feedback after deployment.
Treat that as user-reported confirmation, not an automated real-device test matrix;
the iOS version and Safari/PWA launch mode were not recorded. Keep the small-move
regression: cancel a 4px rightward move, but do not cancel a vertical-first move.

- In a child transcript, an inert snapshot of the saved list is revealed below
  the moving surface. It cannot receive focus, clicks or screen-reader navigation.
- In the list, the moving surface reveals the actual main chat. The native
  dialog retains input ownership until the return animation has finished.
- Release at 28% of viewer width commits one level back. A faster flick can
  commit from 60px when smoothed rightward velocity is at least 0.5px/ms and
  the 180ms projected distance reaches that same threshold.
- Velocity expires after 100ms without movement; reversing direction cancels
  a fling. Short drags, touch cancellation and multi-touch settle back to zero.
- Release animates from the **current finger position**, not from the start of
  the page: 120–280ms, based on remaining distance and velocity, with
  `cubic-bezier(.2,.8,.2,1)`. Input is blocked during settlement.
- Both the viewer generation and selected child must still match on completion;
  closing or switching sessions cancels pending settlement callbacks.

Vertical-dominant movement beyond 12px cancels recognition before horizontal
lock. Leftward motion never commits navigation.
Navigation cards participate in list swipes; their ordinary taps still open
child transcripts. Do not capture gestures starting on other buttons, links,
form controls, editable content, disclosure summaries, code/preformatted text
or horizontally scrollable containers. An active text selection also disables swipe navigation. These
exclusions preserve native scrolling, selection and tool-output interactions.

### Accessibility and state

- Back and Close remain usable without touch; swipe is never the only exit.
- `prefers-reduced-motion: reduce` skips autonomous opening/settling animations;
  direct finger-following movement remains under the user's control.
- Returning to the list restores its scroll position and the selected card's
  focus once; later polling must not steal focus or move the list.
- Closing invalidates in-flight responses and timers, so delayed child output
  cannot reopen the viewer or populate a different session.
- While any native dialog is open, global Life and Sessions-drawer gestures
  cannot begin. A swipe inside Subagents must never open Life underneath it.

## Image annotation

The image lightbox exposes a pencil action for writable main conversations. It opens a native modal above the viewer: fullscreen on mobile, bounded to 1100px with 24px desktop margins. Header Cancel/Confirm, colour swatches, brush width, Undo and Clear have at least 44px targets. Actions reuse the image viewer’s transparent monochrome outline-icon buttons (no accent-filled Confirm or boxed text actions); brush width uses a dark capsule and colour selection uses a circular white ring. Icon actions retain accessible names and tooltips. The canvas fits inside the remaining space and owns pointer gestures; the viewer beneath stays inert. Single-pointer input draws; two fingers pinch from 1× to 8× and pan within image bounds. Switching to a pinch removes its unfinished initial stroke; drawing resumes only after all gesture fingers lift. Zoom is view-only: the PNG always contains the complete image, not just the visible crop. Confirm adds a flattened PNG to the existing composer, preserves the draft and never sends automatically. See [image annotation](docs/image-annotation.md) for limits and browser regression coverage.

## Render-first replies

Live assistant/thinking content buffers unfinished Markdown and renders only new,
completed blocks. Diagrams/images finish preparation before display. Each reply
shares one reading-order cursor: each measured text row scans left-to-right through
a 56px feather, then continues on the next row below. Earlier rows stay opaque;
future rows stay hidden. New content extends the same progress without restarting
a row/block-specific fade. Text ranges are measured without per-character wrappers.
Graphics use vertical reveal bands; a started chunk finishes on responsive reflow
to avoid remasking read glyphs. Velocity follows recent positive
source-text arrival, calibrated to prepared height, with a soft lookahead and smoothed
acceleration/deceleration; slow pacing survives idle gaps. Cold-start, EOF and oversized
backlogs have catch-up safeguards. This is client-observed cadence, not decode TPS.
No vertical translation, resizing, per-token spans or replay of old paragraphs.
Real readiness gaps may pause the front.
Final replies reuse their compatible partial DOM rather than briefly duplicating
it, and expanded thinking stays expanded. Historical text does not replay; reduced
motion shows ready content immediately. Native EOF keeps the preview visible until
atomic durable delivery hands off its body; cancellation still clears it.
Settings → General → **自動捲動** defaults OFF, persists per browser, and uses a
54px outline-icon switch row with the existing capsule styling. OFF cancels
composer locks and disables browser scroll anchoring and automatic reply/asset
following; manual scrolling and Jump to present remain available. Normal Send is
explicit navigation: match the saved user event ID, place this question 12px below
the transcript's top, and reserve the remaining visible turn through bottom padding.
Send uses a cancellable 360ms cubic ease-in-out real-scroll animation, not a
translated clone. Capture keyboard visibility before blur; wait for reported closure,
120ms viewport quiet, a 220ms initial keyboard guard and two layout frames. Later
height/offset reports pause/resume from the current position; stale keyboard reports
have a bounded 1000ms fallback, not a hardcoded iPhone animation duration. Fresh
geometry always waits for 120ms quiet, including delayed acknowledgements after
that fallback threshold. Automatic reply-follow cannot compete during the transition.
Reduced motion skips the tween
but still waits for keyboard settlement; composer refocus/reader gestures cancel it.
These timings have deterministic Chromium boundary tests, not physical Safari proof.
Typing alone does not move it. Replies fill that space without pushing OFF readers;
ON follows overflowing replies only while at the tail. Short replies retain blank
space; no per-message spacers accumulate. New sends replace the active anchor;
reader gestures release re-pinning and navigation/manual Jump removes reservation.
This applies to the main and Life transcripts; slash commands/BTW are excluded.
The existing palette and composer/viewer controls are unchanged. See
[render-first reply reveal](docs/render-reveal.md) for software architecture,
component/state ownership, the live-to-final workflow, buffering and evidence limits.

## Verification

```sh
PIWEB_E2E_PORT=4191 npx playwright test \
  test/e2e/subagents.spec.ts \
  test/e2e/subagents-reconnect.spec.ts \
  test/e2e/subagents-ux.spec.ts
```

The main regression uses CDP touch input, verifies live translation while held
(including an 800ms hold), touchcancel snap-back and both right-swipe return levels,
rejects short/left/vertical/code-area swipes, and retains button navigation and
session isolation coverage. Other specs cover reconnect paging, stable polling,
light/dark themes and reduced motion. These UI tests use controlled API fixtures;
they are not new real-inference lifecycle verification.

See [Subagents documentation](docs/subagents.md) for data, ownership and backend
constraints. Generated video and screenshots stay under ignored `artifacts/`.
