# PiWeb design specification

## Scope and foundations

Phone-first chat UI. `public/app.css` is the source of truth for shared tokens;
feature styles reuse these tokens rather than introducing separate palettes.
This document currently specifies the shared viewer foundation, Subagents
navigation and Settings motion. It does not change Life or browser-native
navigation.

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

The image lightbox exposes a pencil action for writable main conversations. It opens a native modal above the viewer: fullscreen on mobile, bounded to 1100px with 24px desktop margins. Header Cancel/Confirm, colour swatches, brush width, Undo and Clear have at least 44px targets. Actions reuse the image viewer’s transparent monochrome outline-icon buttons (no accent-filled Confirm or boxed text actions); brush width uses a dark capsule and colour selection uses a circular white ring. Icon actions retain accessible names and tooltips. The canvas fits inside the remaining space and owns pointer gestures; the viewer beneath stays inert. Single-pointer input draws; two fingers pinch from 1× to 8× and pan within image bounds. Switching to a pinch removes its unfinished initial stroke; drawing resumes only after all gesture fingers lift. Zoom is view-only: the PNG always contains the complete image, not just the visible crop. Confirm adds a flattened PNG to the existing composer, preserves the draft and never sends automatically. Annotating an image that is still a pending composer attachment replaces that attachment in place (same position, old object URL revoked), so re-editing never leaves the old copy behind; an image from the transcript is added as a new attachment. See [image annotation](docs/image-annotation.md) for limits and browser regression coverage.

## Render-first replies

Live assistant/thinking replies use a reply-only React 19 island backed by
**`@lobehub/streamdown@1.4.0`**, not Vercel Streamdown. Use upstream's balanced
smoothing, character reveal and 180ms fade without a piweb animation overlay.
There are no piweb Highlight ranges, geometric masks, duplicate surfaces or
custom pacing. The package owns CommonMark parsing and incomplete-tail repair;
`remark-gfm`, `remark-math` and `rehype-katex` provide tables/tasks/math.
Existing highlighting, Mermaid controls, media/lightbox delegation and palette
remain leaf integrations. Fading controls are inert until their upstream fades
finish; selection excludes still-fading character spans, not readable prefixes.
Compatible EOF keeps the same React root/body and Streamdown instance. Upstream
may coalesce its temporary character spans; individual Text-node identity is
not a contract. Static assistant/thinking history and reduced motion use the
package's non-animated `CachedMarkdown`. User messages and other notices retain
the existing renderer. Late asset resize callbacks recheck reader ownership;
Send/scroll/attachment workflows are not converted to React.
This intentionally replaces the live parser instead of attempting another repair
to the old indented-fence scanner. Its legacy pure exports remain for compatibility,
not production reply parsing. New-parser tests and visual approval do not clear
the historical failed publication review. A document-context adapter preserves
blank-line display math and cross-block reference definitions through progressive
rendering and connected EOF; focused regressions verify agreement with history.
Cross-block footnotes and exhaustive nested constructs remain uncertified, and
the legacy animation E2E suite has not been fully migrated. Validation is not deployment approval,
GPT implementation parity, model TPS or physical-device/GPU-FPS proof.

Final replies reuse their compatible partial DOM rather than briefly duplicating
it, and expanded thinking stays expanded. Historical text does not replay; reduced
motion shows ready content immediately. Native EOF keeps the preview visible until
atomic durable delivery hands off its body; cancellation still clears it.
Settings → General → **自動捲動** defaults OFF, persists per browser, and uses a
54px outline-icon switch row with the existing capsule styling. OFF cancels
composer locks and disables browser scroll anchoring and automatic reply/asset
following; manual scrolling and Jump to present remain available. Normal Send is
explicit navigation: match the saved user event ID, align the question's outer row
with the transcript's clipping edge (rounding upward for fractional pixels), and
reserve the remaining visible turn through bottom padding. The row's own padding
keeps its contents inset; no part of the previous turn remains visible above it.
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

## Pinned prompt

While reading a turn whose prompt has scrolled away, that prompt is pinned to
the top of the transcript, directly under the header (`public/prompt-pin.js`).

- **Which prompt**: the last user message whose first line of text is above
  the transcript's top edge, so it follows the reader turn by turn. Not its row
  edge: a just-sent prompt is placed flush with the edge (`prompt-turn-scroll`)
  and must not be covered by its own pin. Slash-command
  echoes (`/claude-usage`, `/pi model …`; not `/until <goal>`) are not prompts
  and are skipped. Recomputed (at most once per animation frame) on scroll,
  resize, any change inside the transcript (subtree mutations, image `load`,
  `details` toggle, font loading): rows also move without a scroll while
  replies render, and a pin computed only on scroll went stale.
- **Sticky-header hand-off**: the next prompt's own row (its top edge) pushes the bar up and
  out of its clip once it comes within the bar's height (the bar's bottom edge
  rides on the row's top edge), so scrolling up a prompt settles back into its
  original place while the previous prompt is pushed back down into the pin.
  The new prompt's own bar does not pop in: it slides down from the edge as
  that prompt's text scrolls above it (bar bottom = how far the text has gone
  past), fully in once the text is a bar's height past. It is scroll-linked,
  not timed, so it reverses exactly when scrolling back. The shadow is dropped while pushed, and a fully pushed-out bar is inert.
  When that prompt is on an older page that is not loaded (a long tool loop
  fills the newest page), the latest user message before the oldest loaded
  event is fetched through `/events?before=` (up to 5×200 events), once per
  page boundary.
- **Folded (default)**: one line, the prompt's first non-empty line with an
  ellipsis, on the `--bg` surface with a bottom border; 44px tall. It overlays
  the transcript instead of pushing it, so appearing never moves the reading
  position.
- **Expanded**: a tap shows the whole prompt with its line breaks, up to
  `min(40dvh, 320px)` and scrolling inside beyond that; a second tap folds it.
  The bar is a `role="button"` div (Enter/Space too), not a `<button>`, because
  iOS does not scroll content inside a native button. Reaching another turn's
  prompt folds it again.
- Pressed, the translucent `--bg-hover` tint is layered over `--bg`, never in
  place of it, so the transcript cannot show through a held bar. The clip sits
  on its own compositing layer (`translateZ(0)`) for iOS momentum scrolling.
- Hidden in the BTW view; it belongs to the main transcript.

## BTW side conversation

BTW reuses the main shell and the single composer; only the transcript and a
slim header change. Keyboard/screen-reader users get the same actions as touch.

- **Header (52px, directly under the topbar)**: same `--bg` surface and bottom
  border as the topbar — no `--bg-alt` slab. Left: `‹` back icon (回主對話).
  Centre: “BTW 側聊” at 15px/650 and one 12px `--text-2` status line with
  ellipsis (主對話執行中 · 不會加入主對話 / BTW 回答中… / 清除中… /
  不會加入主對話); a 6px accent dot marks live work. Right: trash icon
  (清除 BTW, with confirmation). Both actions are borderless 44×44px icon
  buttons with accessible names and tooltips; no boxed text buttons.
- **Main view**: no recipient row. A quiet 12px “BTW ›” link sits at the right
  end of the typing line, directly above the composer, whenever the session can
  use BTW (Pi models, not read-only); it reads “BTW 回答中 ›” while a side answer
  is pending. Either opens BTW. In the BTW view the same spot reads “‹ 主對話”
  and returns to the main transcript, mirroring the header's back icon.
  The row stays 25px so it can share the typing line, but the link's touch
  target is 44px tall (`::after`). A touch switches on `pointerup` (≤10px of
  movement) and the click synthesized after it is ignored, because iOS Safari
  can withhold that click; the label is only rewritten when it changes, so a
  tap is never followed by a content change under the finger.
  The visually hidden `#btw-context-label` keeps the polite live announcement.
- **Composer**: placeholder “問 BTW…”; the isolation note lives in the header.
- **Motion**: horizontal `translateX` only, no rebound. Enter BTW 220ms and
  return 140ms ease-in; a committed drag settles from the finger over 120–280ms
  with `cubic-bezier(.2,.8,.2,1)`. Drag commits at 28% of the width or by the
  same flick rule as Subagents (≥60px, ≥0.5px/ms, 180ms projection, velocity
  expires after 100ms). Reduced motion skips automatic animation.

## Settings motion

Settings (`#settings-dialog`) is a pushed page on a phone and a centred card
from 700px up. All of its motion lives in `public/settings-motion.js` (Web
Animations API), not CSS keyframes, because a native `<dialog>` disappears the
moment `close()` runs; the exit has to finish before the dialog closes.
It follows the same motion language as Subagents and BTW.

| Action                                | Phone (< 700px)                                                                    | Card (≥ 700px)                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Open (drawer → Settings)              | Page enters from the right, `translateX(100%)→0`, 220ms `cubic-bezier(.2,.8,.2,1)` | Fades and lifts in from `translateY(10px) scale(.985)`, 220ms same curve |
| Close button, Escape, backdrop click  | Page exits to the right, 140ms `ease-in`, then `dialog.close()`                    | Fades and drops back out, 140ms `ease-in`                                |
| Right drag on the page                | Page follows the finger; release commits or settles back                           | No drag                                                                  |
| Logout, Preview from Recently deleted | Closes immediately (programmatic, not animated)                                    | Same                                                                     |
| Back from Recently deleted            | Settings is already underneath; no second entrance                                 | Same                                                                     |

- **Backdrop.** The 58% black dimming fades with the page (WAAPI on
  `::backdrop`, 220ms ease-out in / 140ms ease-in out). During a drag
  `--settings-reveal` (0→1 by distance / width) lightens it so the chat shows
  through; browsers that cannot animate `::backdrop` just show/hide it.
- **One surface moves at a time.** Opening from the drawer leaves the drawer
  still under the entering page and closes it only once Settings fully covers
  it (`settingsMotion.open()` resolves), so the drawer never slides left while
  Settings slides in from the right.
- **Interrupts.** Reopening during an exit picks the page up from its current
  offset (duration scaled to the distance left). A close during the entrance
  starts from where the page is. Every animation carries an epoch so a stale
  `finished` never closes or resets a newer state. The dialog is `inert` while
  it is leaving or settling.
- **Drag.** The Subagents rules: 12px of rightward movement that is 1.5× the
  vertical distance locks the drag (a clear rightward first move is claimed
  even below 12px so iOS cannot latch scrolling); vertical-first movement over
  12px is left to scrolling. The page tracks the finger 1:1, clamped to its
  width. Release commits at 28% of the width, or a ≥60px flick at ≥0.5px/ms
  whose 180ms projection reaches 28% (velocity expires after 100ms; reversing
  faster than −0.2px/ms never commits). Release settles from the finger over
  120–280ms with `cubic-bezier(.2,.8,.2,1)`. Settings rows are buttons and form
  most of the page, so they stay part of the drag surface (a drag never fires
  their tap); links, inputs, selects, the device code and horizontally
  scrollable content keep their own gestures. Multi-touch or `touchcancel`
  settles back.
- **Reduced motion.** `prefers-reduced-motion: reduce` opens and closes with no
  animation and settles a release instantly; the finger-following drag stays.
- **State hook.** `data-motion` on the dialog is `opening`, `dragging`,
  `settling` or `closing` while something moves, and absent at rest; tests and
  styles (`will-change`) key off it.
- **Not yet covered.** The Recently deleted sub-page still uses its older CSS
  entrance (`trash-page-enter`, 240ms) and closes without an exit.

Verified by `test/e2e/settings-motion.spec.ts`: a frozen mid-entrance frame,
close/Escape exits, a held drag at 130px then release closing, a short drag
settling back without toggling the row under the finger, vertical movement not
moving the page, reduced motion and the desktop card fade.

## Multi-session tiling dashboard (tablet & desktop)

On viewports `>= 768px`, the **Dashboard** workspace (`public/session-dashboard.js`,
`public/session-dashboard.css`) tiles 1 to 12 concurrent sessions in a 2D split-tree
grid (`horizontal`, `vertical`, or auto-balanced `grid` such as `2×2`, `3×2`, `3×3`,
`4×3`) with independent live SSE streams and composers per pane. Only one composer is
shown at a time: a card in its own row at the bottom of the pane last tapped, framed in
`--accent` so the pane in use is obvious. A tap on another pane flies the card there in an
arc while both transcripts ease to their new height (the newest message rides up with
the card); nothing ever scrolls behind it. On a touch screen that tap also opens the
keyboard; a finger scroll moves nothing.

- **Header (52px, directly in `.main`)**: same `--bg` surface and `1px solid var(--border)`
  bottom border as the topbar and BTW header — no `--bg-alt` slab. Left: “Session Dashboard” at 15px/650
  and a 12px `--text-2` counter (`N 個並排視窗`). Centre-right: dark capsule layout
  switcher (`border-radius: 999px`) with selection ring (`border-color: var(--text)`)
  for **水平 / 垂直 / 網格**. Right: borderless 44×44px outline-icon buttons for
  **均分視窗大小** (`#btn-dashboard-equalize`) and **清空並排** (`#btn-dashboard-clear`);
  no boxed text buttons or accent-filled primary actions.
- **Pane headers, full single-session parity & native positions**: `--bg` surface with
  `1px solid var(--border)` bottom border. Every tiled pane provides full single-session
  feature parity in the exact native locations:
  - **Top header bar**: inline session rename, model badge, Status (`ℹ️`), Usage (`📊`),
    Model selector (`🤖`), Thinking level selector (`💡` with active level dot), per-pane
    `⋯` overflow menu (Search in pane, New pi session, BTW side chat, Subagents, Media
    gallery, Split horizontal/vertical, Focus single session, Delete session), plus
    direct Split, Expand, and Close (`×`) borderless outline-icon buttons (`36×36px`).
  - **Under header**: per-pane search bar (`🔍`), per-pane BTW side-chat ownership card
    (`BTW 側聊 · 不會加入主對話` with `‹` back and trash clear), and per-pane `createPromptPin`
    sticky prompt bar.
  - **Above composer**: per-pane typing indicator row + `BTW ›` / `‹ 主對話` quick toggle
    link, slash-command autocomplete popup (`/pi …`), upload progress bar, `引用` quote
    reply preview bar (with `❝` quote buttons on every message and text-selection quote),
    image/multimedia attachment thumbnail preview strip with lightbox + image editor (`✎`),
    image compression toggle (`壓縮圖片`), and `createHotKeywords` quick-input chip bar.
- **Drag-and-swap & directional drop zones**: dragging a session from the sidebar or
  dragging any pane header over another pane highlights a 5-way drop target:
  dropping in the center (`20%..80%`) swaps the two panes in-place (`⇄ 交換視窗順序` for existing panes,
  or `➕ 加入此視窗旁` when dragged from sidebar), while dropping near the left/right/top/bottom edge splits along that axis
  (`← 水平並排（左側）`, `→ 水平並排（右側）`, `↑ 垂直並排（上方）`, `↓ 垂直並排（下方）`). Active dragging promotes pointer capture
  (`setPointerCapture`), isolates underlying panes and session list (`dashboard-pointer-dragging` with `pointer-events: none; overflow: hidden !important; touch-action: none !important`),
  enforces `touch-action: none` on `.session-item` to eliminate native scroll competition, and freezes `sessionList.scrollTop` throughout the gesture so the drawer never scrolls while dragging cards over to the dashboard.
- **120Hz+ zero-lag splitters, 28–36px touch hit-zones & true 120Hz GPU compositor spring physics**:
  visual splitters stay slim (`10px` desktop, `12px` coarse pointer) with a visible
  iPadOS Split-View style pill handle (`40–44px`), while an invisible `::before`
  hit-target expands the draggable touch zone to `28px` (`36px` on `@media (pointer: coarse)`).
  Dragging `.dashboard-splitter` processes high-rate `getCoalescedEvents()` samples
  synchronously with `.resizing-active`. Releasing a horizontal or vertical splitter
  executes an analytical damped harmonic oscillator solver (`solveSpringProgress`, `stiffness = 420, damping = 10.5`,
  rubber-band cushion down to `28px`, 35–68px overshoot, 3-stage elastic rebound) compiling 36-point linear keyframes via Web Animations API (WAAPI),
  driving `scale3d` and `translate3d` purely on GPU compositor layers (`will-change: transform`, `translateZ(0)`) with zero layout reflows during the 440ms bounce.
  Message scrolling runs at 120Hz ProMotion with Apple quartic ease-out (`smoothScrollTo`). Pane moves, swaps, layout switches, and equalization
  animate via a multi-stage FLIP spring collision bounce (`animatePaneLayoutTransition`).
- **Auto-scroll to latest & iPadOS virtual keyboard stability**: activating Dashboard
  or hydrating a pane automatically scrolls every tiled pane to the latest message and
  re-pins after lazy media layout. Background `/api/sessions` polls skip DOM
  reconstruction when the session signature is unchanged, dynamic index/JID lookup in
  splitter callbacks prevents resized weights from snapping back on poll, toolbar/pane
  buttons prevent focus theft on `pointerdown`, and touch inputs keep `font-size: 16px`
  and the shell stays on the layout viewport (`.app` `100dvh`) for both single
  chat and Dashboard at rest. While the keyboard is up it is pinned to the
  visual viewport (`html.keyboard-shell`: fixed at `visualViewport.offsetTop`,
  `visualViewport.height`), because iOS pans the page and a full-height shell
  shows a blank band above the keyboard; a shell shrunk without following that
  pan floats the composer at the top. The iOS 26 standalone short-viewport gap
  (WebKit 301108) is fixed by the `display-mode: standalone` `html` min-height
  rule in `app.css`, not by remeasuring, rotating, or a `display:none` remount.

## Verification

```sh
PIWEB_E2E_PORT=4191 npx playwright test \
  test/e2e/subagents.spec.ts \
  test/e2e/subagents-reconnect.spec.ts \
  test/e2e/subagents-ux.spec.ts \
  test/e2e/session-dashboard.spec.ts
```

The main regression uses CDP touch input, verifies live translation while held
(including an 800ms hold), touchcancel snap-back and both right-swipe return levels,
rejects short/left/vertical/code-area swipes, and retains button navigation and
session isolation coverage. Other specs cover reconnect paging, stable polling,
light/dark themes and reduced motion. These UI tests use controlled API fixtures;
they are not new real-inference lifecycle verification.

See [Multi-session tiling dashboard](docs/session-dashboard.md) for full architecture, GPU spring solver, touch drag isolation, per-pane parity, and verification matrix.
See [Subagents documentation](docs/subagents.md) for data, ownership and backend constraints.
Generated video and screenshots stay under ignored `artifacts/`.
