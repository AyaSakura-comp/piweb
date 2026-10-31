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

## Text selection and quoting

A long press (300ms) on transcript text starts a custom selection
(`public/text-selection.js`) with two drag handles and a quote/copy pill; the
same rules hold in the chat and in a Dashboard pane.

- **One bubble, not line boxes.** The selection is drawn as a single rounded,
  translucent outline around the selected text (`public/selection-bubble.js`,
  `.sel-bubble`): lines on one visual row merge, neighbouring lines fuse edge to
  edge (paragraph gaps up to 48px stay in the same bubble, the next message gets
  its own), 5px/2px padding, 11px radius. The outline follows the finger on a
  slightly under-damped spring (stiffness 340, damping 25), so it flows and
  settles instead of jumping box to box. Line rects come from the selected text
  nodes only; Chrome's per-paragraph-break boxes drew stray tabs.
- **Handles stay on the line under the finger.** A dragged handle resolves only
  to drawn text; LobeHub's `"\n"` text nodes between blocks used to resolve
  above the whole list and flip the selection upward. The fallback picks the
  nearest line box and character, never the nearest parent element.
- **The quote/copy pill** is a larger glass bubble that pops in. A finished
  selection quotes itself, in the chat and in a Dashboard pane alike; the user
  did not want to wait for 引用. In a pane the input card comes to that pane
  carrying the quote, without focus (so no keyboard).
- **A tap on a composer card goes through the selection backdrop.** The
  full-screen backdrop that dismisses a selection would also swallow the first
  tap on the card the selection just quoted itself into. The chat's card stacks
  above it, a Dashboard pane's cannot, so the backdrop passes a tap that lands on
  a `.composer-wrap` on to it (×, Send, chips, the box; a still finger, focus from
  `touchend` so iOS raises the keyboard). Elsewhere a tap only dismisses.
- **Lifting a long press never presses what is under the finger.** The pill opens
  while the finger is still down and can open right under it; the `touchend` that
  finishes a long press cancels its default, so the lift is not a click on 引用.
  A short tap still clicks.

## On-screen keyboard (iOS)

While a text field has focus and the keyboard covers the layout viewport, the
shell is pinned to the visual viewport (`public/viewport-shell.js`,
`html.keyboard-shell`; full rules in the Dashboard section below).

- **Send stays under the finger.** Tapping Send blurs the box before iOS lowers
  the keyboard. The shell keeps following the visual viewport for 650ms after
  typing focus leaves, all the way down, so Send does not move between
  `mousedown` and `mouseup` and the topbar does not shoot off the top.
- **Whole-keyboard jumps ease.** When iOS reports the full keyboard move at once
  it is still animating its pan; the shell eases along curves fitted to a
  recording (opening 190ms `cubic-bezier(0.3, 0.2, 0.6, 0.95)`, closing 320ms
  `cubic-bezier(0.25, 0.4, 0, 1)`) instead of showing a keyboard-tall blank band.
- **Send mid-composition** commits the IME text before reading the box, so marked
  text is sent rather than left behind.

## Voice input (Komorebi)

A borderless mic button sits before Send in the chat composer and in each
Dashboard pane composer (44px target on touch; accent when on, `--danger` after
an error). It is one app-wide switch that stays on until turned off. While on,
the composers set `inputmode="none"` (no iPhone/iPad keyboard), speech streams
into the visible composer as the cleaned-up draft plus the sentence being heard,
and the composer shows a listening ring: an inset 1–2px `--accent` ring and an
inner glow following the microphone level, brighter while a sentence is heard.
It is a `box-shadow` inside the box, so it takes no space; reduced motion drops
its 120ms easing. The clean-up shows as on the Komorebi IME page: a sentence
being spoken is `--text-dim` with a 1.5px accent underline and a blinking accent
caret; once heard it is normal text with a dotted accent underline until its
rewrite lands (no breathing: the clean-up can take seconds, and send never waits
more than 1.2s for it); when the rewrite lands, inserted
characters get a 34% `--accent` highlight that fades over 1.2s and removed ones
stay struck through in `--danger`, then fade and fold away. This is drawn in a
layer over the textarea (its text transparent, caret kept), only while there is
something to show. Status goes in the placeholder (說話即可輸入… / 點一下畫面開始收音…
/ 語音輸入：<error>), never a toast. Settings → 語音輸入（Komorebi） uses stacked
rows (label above a full-width 16px input, `.settings-field`) for the server and
clean-up API URLs. A 整理草稿 switch (the standard `.settings-toggle`, on by default)
turns the clean-up off; while off the clean-up API rows are disabled at 45%
opacity. A 通話模式收音 switch (same toggle, on by default) turns the browser's
call-style mic processing off. While voice input is on, a sideways finger
stroke on the box circles whole words without a long press: the quote
selection's bubble (`.sel-bubble`, same spring and colours) drawn over the box,
and the quote pill's glass (`.selection-actions`) above the words with 刪除 and
取消 (44px; a finger acts on `pointerup`, like the BTW link). The next sentence
spoken replaces the circled words; a tap elsewhere puts the circle away;
vertical strokes still scroll. See [voice input](docs/voice-input.md).

## Render-first replies

Live assistant/thinking replies use a reply-only React 19 island backed by
**`@lobehub/streamdown@1.4.0`**, not Vercel Streamdown. Use upstream's balanced
smoothing, character reveal and 180ms fade without a piweb animation overlay.
There are no piweb Highlight ranges, geometric masks, duplicate surfaces or
custom pacing. The package owns CommonMark parsing and incomplete-tail repair;
`remark-gfm`, `remark-math` and `rehype-katex` provide tables/tasks/math.
`remark-cjk-friendly` (plus its GFM strikethrough twin) relaxes the flanking
rule so `**品質：**perplexity` bolds the label: plain CommonMark leaves `**`
literal when the closer sits between full-width punctuation and a letter.
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

## Tables

A reply's table keeps its in-transcript form (13.5px, cells on one line,
scrolling sideways inside `.table-wrap`). A tap on it opens it full screen in
the same pan/zoom viewer as Mermaid (`openTableViewer()` in
`public/markdown.js`): a copy, first shrunk to the viewer's width so every
column is in view (never below half size; a wider table pans), placed at its
top left. Pinch, pan, double-tap, the zoom buttons and Reset (back to that
first view) work as for diagrams; close with ×, the backdrop or Escape. Unlike
the always-dark Mermaid figure, the table viewer follows the light/dark
appearance. A link in a cell keeps its own tap (copy, with Open), a sideways swipe still
scrolls the table, and selecting its text (long press, or a mouse drag) is not
a tap. Same in Dashboard panes. How it moves is "Viewer motion" below.

## Viewer motion

The full-screen table and Mermaid viewer (`zoomViewer()` in `public/markdown.js`,
physics in `public/viewer-physics.js`) moves like a native photo viewer: what
you tap grows out of its place, a throw keeps going, edges give and pull back.
The user asked for "120fps + 物理慣性" after a recording (2026-10-31) showed it
cutting in and out with no motion and stopping dead under the finger.

- **How it runs at the display's rate.** While a finger is down the stage
  follows it 1:1, one `transform` write per touch event and nothing else (no
  layout reads, no CSS transition). Every motion after the finger lifts is
  computed up front as a function of time and played as Web Animations
  keyframes on `transform` (the card also on `opacity`), one keyframe per
  120Hz frame (`FRAME_MS` = 8.33ms), `easing: linear`. The browser runs those
  on its compositor at the screen's refresh rate (120Hz on ProMotion), and a
  long task on the main thread cannot stall them. No `requestAnimationFrame`
  loops: those are held to the page's frame rate. A finger landing mid-motion
  reads the position from the animation's `currentTime` and the motion's own
  function, never from `getComputedStyle`, and the stage stops exactly there.
- **Open.** The content (the table copy, the diagram) flies from the figure's
  visible part in the reply (scaled to its width) to its first view, on a
  slightly underdamped spring (`bouncyProgress`, ω 0.024/ms, ζ 0.8: about 1.5%
  overshoot, settled in ~360ms). The card around it grows from 94% about the
  figure's centre on the same spring and fades in over 120ms; the dimmed
  backdrop fades in over 240ms. A figure scrolled off screen: the card grows
  from 94% at the centre and the content starts in place.
- **Close** (×, backdrop, Escape). The reverse on a critically damped spring
  (ω 0.03/ms, ~300ms): the content flies back onto the figure from wherever it
  was panned or zoomed, the card shrinks to 94% and fades out as the content
  lands (from 55% to 95% of the way), the backdrop fades with it. It takes no
  taps on the way out.
- **Pan.** A throw keeps its speed (the last 100ms of movement; none if the
  finger held still 80ms before lifting; capped at 8px/ms) and slows by
  UIScrollView's normal rate, 0.998 per ms, stopping once under half a pixel
  is left. Reaching an edge it runs on past it and springs back onto it
  (critically damped, ω 0.02/ms).
- **Edges.** The content always covers the viewer when larger than it, and has
  exactly one place to rest along an axis where it fits: a table at the top
  and centred across, a diagram centred. Dragged past that, it gives way like a
  rubber band (iOS's `(1 − 1/(x·0.55/d + 1))·d`, d = the viewer's size), and
  coming back the finger is 1:1 again. Released past an edge, it springs back,
  with the throw.
- **Zoom.** Pinch between 0.2× and 6×; past a limit it gives way less and less
  (`limit · (raw/limit)^0.3`) and springs back to the limit about the fingers
  on release. Lifting one finger of two pans on from there. The zoom buttons
  (1.3× about the centre), double tap (2.2× about the tap, or back to the first
  view) and Reset move on a critically damped spring (ω 0.02/ms). Scale moves
  evenly in ratio and the content point the two views share stays put, so a
  zoom grows from where it is aimed (`viewBetween`). Every zoom ends inside the
  edges.
- **Reduced motion.** Opens and closes at once, a throw does not glide, zooms
  jump; the finger-following drag stays.
- **State hooks.** `data-motion` on `#mermaid-modal` is `opening` or `closing`
  while the card moves, and on `.mm-modal-stage` is `moving` while a glide or
  spring plays; both absent at rest. Tests wait on them before measuring.

Verified by `test/viewer-physics.test.ts` (glide distance and steady slowing,
the edge bounce, rubber band and its inverse, springs, the zoom fixed point,
keyframe sampling, release speed) and `test/e2e/viewer-motion.spec.ts` (real
CDP touches, every frame sampled: the opening starts over the reply's table and
grows without a jumped frame; keyframes on transform/opacity only, one per
120Hz frame; a throw gliding on and slowing inside the table; the rubber band
and spring back; a fitted table springing back to the top; closing back into
the table; a finger catching a glide; a pinch past 6×; reduced motion; frames
in both themes). Headless Chromium draws at 60Hz, so the 120Hz rate itself is
not measured there.

## Full-screen reading

A tap on the chat's transcript gives the conversation the whole screen
(`public/session-fullscreen.js`, `.session-fullscreen` in `app.css`); another
tap brings everything back, and so does Escape. There is no button for it: the
tap is the gesture, as in a reader.

- **What goes**: the header, the pinned prompt, the search bar, the typing line
  with BTW ›, the chips and the composer (its draft, quote and attachments are
  kept). "Jump to present" stays, at the foot. The status bar keeps a `--bg`
  band (`safe-area-inset-top`) so text never runs under the clock, and the last
  line clears the home indicator.
- **Nothing under the finger moves.** Going full screen, the header and the
  composer turn into overlays, the transcript grows under them and its scroll
  offset is corrected in the same frame; then they slide off (header up,
  composer down, 140ms ease-in, the exit curve), uncovering more of it. Coming
  back they slide in over the transcript (220ms `cubic-bezier(.2,.8,.2,1)`) and
  the layout returns only once they cover its edges. A transcript at its newest
  message stays at its newest message instead: its last line rides down and up
  with the composer (not while a just-sent prompt holds the top).
- **What is a tap**: a touch tap only (a mouse click selects or deselects).
  Anything with its own tap keeps it — links (copy), code (copy), tables
  (viewer), images, media, tool cards, buttons — and so do a long-press
  selection and the touch that ends one. A scroll, and a tap while typing in
  the composer, are not taps. A tap while the chrome is still moving is
  ignored, so a double tap is not two.
- The main chat and Life; not the BTW view or Dashboard panes. Switching
  sessions leaves full screen. Reduced motion switches at once.
- Messages get their hover tint only with a real hover (`@media (hover:
  hover)`): iOS left it on the last tapped message.

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
- **Typing line wording**: “pi is working…” while the agent works; “等待背景命令…”
  once its reply is in and only background commands it started keep the turn
  open (Claude Code / AGY). Same line, same dots, in the chat and in Dashboard panes.
- **Main view**: no recipient row. A quiet 12px “BTW ›” link sits at the right
  end of the typing line, directly above the composer, whenever the session can
  use BTW (Pi and Claude Code models, not AGY or read-only); it reads “BTW 回答中 ›” while a side answer
  is pending. Either opens BTW. In the BTW view the same spot reads “‹ 主對話”
  and returns to the main transcript, mirroring the header's back icon.
  The row stays 25px so it can share the typing line, but the link's touch
  target is 44px tall (`::after`). A touch switches on `pointerup` (≤10px of
  movement) and the click synthesized after it is ignored, because iOS Safari
  can withhold that click; the label is only rewritten when it changes, so a
  tap is never followed by a content change under the finger.
  The visually hidden `#btw-context-label` keeps the polite live announcement.
- **Composer**: placeholder “問 BTW…”; the isolation note lives in the header.
- **Coming back**: each view keeps its own place. A view left at its newest
  message comes back at its newest message, including what arrived while the
  other view was in front (never under “Jump to present”); one scrolled up to
  read comes back where it was.
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

## Settings: subscriptions

Settings → Subscriptions has one card each for ChatGPT Plus / Pro (device code),
Claude Pro / Max and Antigravity (open a link, paste the code back). The card's
single action reads Connect, Cancel or Disconnect; status sits on its first line
and errors show under the code field in the error colour, never as a toast. The
code or link panel scrolls into view when it opens.

- Claude signs in through Anthropic's own code page, not pi's localhost redirect,
  which never loads on a phone.
- The Claude card reads Connected when the host's Claude Code is signed in, since
  `claude-code/*` sessions run on it. Disconnect refuses to sign the host's Claude
  Code out and says where to do it instead.
- A mistyped or expired code, a pasted link, a declined consent, rate limits and
  network failures keep the sign-in waiting with the reason under the field (at
  most 5 tries); fatal problems end it with a specific, secret-free message.
- A worker that never claims the job shows "The host worker is not answering".

Flow, storage and error classes: [subscription sign-in](docs/subscription-sign-in.md).

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

- **Settings → General → Dashboard** (on by default, per browser): the standard 54px
  outline-icon switch row (four-squares icon, `.settings-toggle`) after 自動捲動, with a
  footnote. Off removes every way in rather than greying it out: the drawer's Dashboard
  entry, the topbar button and each row's tile button are not rendered, rows are not
  draggable, and an open Dashboard gives way to the chat. The tiled layout is kept, so
  turning it back on restores the panes.
- **Header (52px, directly in `.main`)**: same `--bg` surface and `1px solid var(--border)`
  bottom border as the topbar and BTW header — no `--bg-alt` slab. Left: “Session Dashboard” at 15px/650
  and a 12px `--text-2` counter (`N 個並排視窗`). Centre-right: dark capsule layout
  switcher (`border-radius: 999px`) with selection ring (`border-color: var(--text)`)
  for **水平 / 垂直 / 網格**. Between the two, the drawer's host readings
  (`#dashboard-host-metrics`, `mountMetricsStrip()` in `public/system-metrics.js`,
  painted from the drawer's own request): each a 13px/600 value over its 11px
  `--text-2` label, the same wording as the drawer, after a 1px `--border` divider.
  Shown only as far as there is room: GPU, CPU, Power, RAM, GPU temp, CPU temp,
  NPU power, NPU in that order, dropped from the end, never cut off; none (and no
  divider) when even GPU does not fit or no sensor answers, and not at all on a
  phone. A reading keeps the widest width it has had at this header width, so one
  gaining a digit cannot make the last reading blink every second. The right end
  grows as much as the readings do, so the switcher keeps its place midway
  between the title and the right edge. Display only: no tap. (User request,
  2026-10-31: "有餘裕的情況下把這個資訊顯示在這".) Right: borderless 44×44px outline-icon buttons for
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
- **Session list while tiled**: a tap on a session row does not leave the Dashboard. The
  session joins the tiles (or keeps its place if already there), takes the input card
  (focused for a mouse, no keyboard on touch), and its pane flashes (`pane-locating`: an
  `--accent` wash and inset ring that pulse twice over 1.1s; reduced motion shows the
  frame only). Life still opens on its own.
- **Zoom inside the Dashboard**: the pane's expand button (`.pane-expand-btn`, or 放大此視窗
  in its `⋯` menu) or a double click / double tap on the header's bare space (not the name,
  which renames, nor a button) blows the pane up to the whole stage; the same again, or
  any re-tiling, adding or moving of panes, puts it back. The other panes are hidden, not
  closed: their streams keep running and their scroll comes back. Both directions are a
  FLIP transform on a spring (`solveSpringProgress(t, 0.6, 16)`, 620ms) that overshoots a
  little and settles; mid-flight the pane is drawn above its neighbours with a shadow.
  The button swaps to a collapse icon (`aria-pressed="true"`, 縮回並排) while zoomed.
  Two releases on the header within 350ms and 24px count as a double tap; a release
  that ends a header drag never does. Zoom needs at least two panes. Leaving the
  Dashboard unzooms instantly. Because groups clip their children (`overflow: hidden`,
  `translateZ(0)`), zoom is not a fixed overlay: panes and groups off the zoomed pane's
  path get `display: none` (`.has-zoom`, `.zoom-path`), and only during the flight do
  the path's groups stop clipping (`.zoom-moving`). In a pane under 460px wide the
  expand button folds into `⋯`, so a double tap is the quick way there.
- **Two-finger pane drag (touch)**: two fingers anywhere on a pane drag it like its header,
  with the same ghost and 5-way drop zones, from the pair's midpoint. It uses touch events
  with a cancelled `touchmove` so iOS does not turn the gesture into a scroll or a pinch.
  Both fingers must land on the same pane and at least two panes must be tiled. The first
  clear movement decides: the midpoint moving 10px (more than the fingers' spread changed)
  is a drag, the spread changing 14px (more than the midpoint moved) is a pinch. Lifting a
  finger drops; `touchcancel`, or a `touchmove` the browser will not let us cancel,
  abandons it. A second finger also cancels a pending long-press selection.
- **Pinch a pane (touch)**: the pane moves along a ladder of sizes, one step per gesture.
  A step multiplies its area by 1.7, shared out over every level of the split tree where it
  has neighbours (so in a grid it grows on both axes), each share kept between its own
  minimum size and what leaves every neighbour its minimum, at most 80%. The steps are not
  a fixed count: going up, a step that would cover 60% or more of the stage is the zoom
  instead (**fills the stage**, as the expand button), so a 2×2 grid has a step below,
  the tile, a step bigger and the whole stage, while two side-by-side panes go from the tile
  straight to the whole stage. Going down there is one step below the pane's own tile.
  Spreading past 1.18× the start spread goes a step up, past 2.1× straight to the zoom;
  pinching below 0.85× goes a step down, below 0.6× from above the tile straight back to it.
  The ratio counts from at least 100px, so fingers set down close together need a real
  spread. While the fingers are down the pane follows them (scale with the spread, move with
  the midpoint, rubber past the stage size), drawn over its neighbours, and a dashed outline
  without the drop wash shows where it lands with a label (放大一點 / 縮小一點 / 放到最大 /
  縮回並排 / 縮回原本大小 / 放回原本大小). On release it springs from where the fingers left it
  to that place; a spread too small to change anything springs back. A step is saved like a
  splitter change; the layout it steps from is kept in memory, so stepping back to the tile
  restores those weights exactly until anything else resizes the layout. Header taps within
  400ms of a two-finger gesture are its fingers lifting, not a double tap.
- **Splitter drags stay light in WebKit (120fps side to side)**: nothing in a pane is a
  CSS container. A container makes WebKit restyle its whole subtree on every size change;
  with nine long panes a splitter step took 73ms and the drag froze on the iPad
  (2026-10-25). The size steps are classes set by a `ResizeObserver` on each pane, its
  header and its dock (`.pane-short`, `.pane-w460`/`300`/`220`/`170` from the header's
  content width, `.pane-w240` from the dock's), so styles change only when a step is
  crossed; a narrow pane's `⋯` menu gets `.is-narrow` when it opens. While a splitter
  changes widths every transcript keeps the width it had (clipped, or with room to
  spare), so a step is 2–3ms of layout in WebKit (1ms for heights). On release each
  transcript eases to its new width alongside the 440ms bounce (cubic ease-out), so the
  text flows into its new lines instead of jumping; a transcript at the bottom stays
  there, and one scrolled up keeps the line at the top of its view at the same height
  while the text rewraps around it. Reduced motion rewraps at once. Hiding or showing
  the docked session list slides it out or in (260ms `cubic-bezier(.2,.8,.2,1)`, its
  `margin-left`), the panes widening or narrowing with it; their text holds its width
  during the slide and flows into the new one after (360ms), as after a splitter drag. During the drag one cover over the grid
  (`.resizing-active::after`) keeps taps and selection off the panes; inherited
  `pointer-events`/`user-select` on the panes restyled every transcript node at the
  start and end of each drag (65ms / 80ms).
- **Busy panes**: a running session shows a 13px spinner before its name and a 2px
  `--accent` light bar along the header's foot (`.pane-busy`; a still bar under reduced
  motion), so a busy pane is visible without opening the session list.
- **Unread panes**: the session list's three states, in the header before the name:
  spinner (working), the list's 9px `--tool` green dot (`.unread-dot`, `.pane-unread`:
  finished, not looked at on this device), neither (idle and read). Only the pane
  holding the input card counts as read when a reply lands, like the open chat; any
  other pane keeps its dot, across a reload too, until it is tapped (the card comes)
  or its transcript is scrolled or touched (the card stays). Same `piweb.seen` marks
  as the list, so its row clears with the pane. A reply that arrives while the app is
  in the background is read when the app is back on screen.
- **Selecting text in a pane** quotes it at once, as in the chat (see "Text selection
  and quoting"); a narrow pane keeps `⋯` in its header and folds Status, Usage, split and
  expand into that menu (at ≤460px; at ≤300px Model too).
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
  test/e2e/session-dashboard.spec.ts \
  test/e2e/session-dashboard-split.spec.ts \
  test/e2e/session-dashboard-mobile.spec.ts \
  test/e2e/session-dashboard-zoom.spec.ts \
  test/e2e/session-dashboard-unread.spec.ts \
  test/e2e/viewer-motion.spec.ts \
  test/e2e/dashboard-host-metrics.spec.ts \
  test/e2e/table-fullscreen.spec.ts \
  test/e2e/text-selection.spec.ts \
  test/e2e/session-fullscreen.spec.ts \
  test/e2e/keyboard-send.spec.ts \
  test/e2e/iphone-viewport-shell.spec.ts \
  test/e2e/settings-motion.spec.ts
```

`session-dashboard-unread.spec.ts` covers the pane states (running, unread, read), a
reply in the pane in use, reload, tap, scroll, a reply only the session poll knew of, and
screenshots in both themes.

`session-dashboard-zoom.spec.ts` covers the session-list tap (tile + flash, staying in
the Dashboard), the zoom spring both ways (a mid-flight transform, stage size, hidden
neighbours, `aria-pressed`, the tile restored), header double click, unzoom on a list
tap, and a two-finger drag swap sent as real CDP touch points.

The main regression uses CDP touch input, verifies live translation while held
(including an 800ms hold), touchcancel snap-back and both right-swipe return levels,
rejects short/left/vertical/code-area swipes, and retains button navigation and
session isolation coverage. Other specs cover reconnect paging, stable polling,
light/dark themes and reduced motion. These UI tests use controlled API fixtures;
they are not new real-inference lifecycle verification.

See [Multi-session tiling dashboard](docs/session-dashboard.md) for full architecture, GPU spring solver, touch drag isolation, per-pane parity, and verification matrix.
See [Subagents documentation](docs/subagents.md) for data, ownership and backend constraints.
Generated video and screenshots stay under ignored `artifacts/`.
