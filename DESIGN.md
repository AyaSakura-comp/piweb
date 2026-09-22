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
