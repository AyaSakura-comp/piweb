# Multi-session Tiling Dashboard (Tablet & Desktop)

This specification defines the architecture, interaction design, GPU-accelerated physics engine, 120Hz ProMotion rendering, and E2E verification suite for the **PiWeb Multi-Session Dashboard** workspace (`public/session-dashboard.js`, `public/session-dashboard.css`).

---

## 1. Scope and Foundations

The Multi-Session Dashboard provides a phone-first yet tablet/desktop-optimized concurrent workspace on viewports `>= 768px`. It enables users to tile, monitor, and interact with **1 to 12 active sessions simultaneously** in a responsive 2D split-tree layout.

Feature styles adhere strictly to `public/app.css` core design tokens:

| Token | Dark Mode | Light Mode | Usage |
| :--- | :--- | :--- | :--- |
| `--bg` | `#313338` | `#ffffff` | Primary dashboard background, toolbar, and pane headers |
| `--bg-alt` | `#2b2d31` | `#fbfaf7` | Pane containers, message bubbles, and composer backdrop |
| `--border` | `#3f4147` | `#dedbd3` | Toolbar borders, pane splitters, and card dividers |
| `--text` | `#dbdee1` | `#35332f` | Primary headings, session titles, and message text |
| `--text-2` | `#b5bac1` | `#56534d` | Metadata labels, pane counters, and inactive button icons |
| `--accent` | `#5865f2` | `#3f5f6f` | Live activity indicators, selection rings, and status dots |

Each pane operates as an autonomous, fully functional chat shell connected to its own persistent session channel (`web:<jid>`), maintaining its own independent Server-Sent Events (SSE) stream, message scroller, composer draft, sticky prompt pin, BTW side conversation, and multimedia attachment pipeline.

---

## 2. Workspace Layout & Grid Modes

The dashboard supports three layout modes selectable via the dark capsule switcher in the main toolbar:

1. **Horizontal (`horizontal`)**: Single row with $N$ vertically split columns. Ideal for side-by-side code diffs or comparing two to three agent executions.
2. **Vertical (`vertical`)**: Single column with $N$ horizontally split rows. Suited for wide-display log streams and continuous multi-turn monitoring.
3. **2D Grid (`grid`)**: Dynamically auto-balanced 2D split-tree matrix structured as:
   - **1 pane**: $1 \times 1$
   - **2 panes**: $1 \times 2$ (2 columns)
   - **3–4 panes**: $2 \times 2$ (2 rows $\times$ 2 columns)
   - **5–6 panes**: $2 \times 3$ (2 rows $\times$ 3 columns)
   - **7–9 panes**: $3 \times 3$ (3 rows $\times$ 3 columns)
   - **10–12 panes**: $3 \times 4$ (3 rows $\times$ 4 columns)

### Density-Aware Scaling
To ensure seamless multi-pane density across compact screens without clipping controls:
- **Default (1–4 panes)**: Full-size controls, 14px typography, standard margins.
- **Compact (5–8 panes)**: Pane min-dimensions `85px × 65px`, condensed action icons (32×32px), clamped padding.
- **Ultra (9–12 panes)**: Pane min-dimensions `55px × 48px`, ultra-compact composer and header bars, icon-only representations.

---

## 3. Toolbar & Workspace Navigation

The workspace topbar sits directly within `.main` at `52px` height, using `--bg` with a `1px solid var(--border)` bottom border:

- **Left**: "Session Dashboard" label (15px/weight 650) with an inline `--text-2` counter indicating the active tiled count (e.g., `4 個並排視窗`).
  - *Design Note*: The chevron-left back button (`#btn-dashboard-exit`) was removed from the toolbar per user design review. Session exit is handled via individual pane actions, breadcrumb navigation, or the primary navigation drawer.
- **Center-Right**: Dark capsule segmented layout switch (`border-radius: 999px`) with a high-contrast selection ring (`border-color: var(--text)`) toggling between **水平**, **垂直**, and **網格**.
- **Right**: Clean toolbar margin without redundant buttons.
  - *Design Note*: Per user design review, the top-right equalize and clear buttons (`#btn-dashboard-equalize`, `#btn-dashboard-clear`) were removed to keep the header minimal and prevent accidental destruction of workspace arrangements.

---

### Cross-Device Cloud Persistence (`/api/dashboard-layout`)
- **Multi-Device State Inheritance**: When switching between desktop, iPad, or mobile devices, the dashboard layout is automatically synchronized via the SQLite `meta` store (`meta.dashboard.layout`).
- **Instant Local Boot**: State is initialized immediately from local storage cache, while `GET /api/dashboard-layout` asynchronously fetches and applies the latest server topology if newer or if loading onto a fresh device.
- **Debounced Cloud Sync**: Changes to the layout (adding/closing panes, dragging splitters, toggling presets) are immediately committed locally and debounced (350ms) to `POST /api/dashboard-layout`.
- **Zero-Blank-Space Topology Normalization**: When a pane is closed in a column/row group, the group's weights are immediately re-normalized so the remaining pane always fills 100% of the allocated space with zero blank space.

## 4. Full Per-Pane Single-Session Parity

Every pane in the multi-session grid provides 100% feature parity with the primary single-session chat view, positioned in native locations:

### Top Header Bar (`.dashboard-pane-header`)
- **Inline Title Editing (`.dashboard-pane-title`)**: Tap/click to rename session inline; automatically commits on Enter or blur.
- **Running marker (2026-10-24)**: while the session works, a 13px spinning ring (`.work-spinner`) sits before the name, so an ellipsized title cannot push it out, and the pane gets `.pane-busy`, which runs a 2px `--accent` light bar along the header's foot (`::after` at `bottom: 0`, inside the header's `overflow: hidden`; reduced motion: a still bar). The spinner had styles only under `.session-item`, so in a pane it took no space and nothing showed which pane was running.
- **Model Badge (`.pane-badge`)**: Displays current model tag (e.g., `Claude 3.7 Sonnet`, `Opus 4.6`, `GPT-5o`).
- **Status Modal Trigger (`ℹ️`, `.btn-pane-status`)**: Opens session diagnostics, connection state, and token usage summary.
- **Usage Diagnostics (`📊`, `.btn-pane-usage`)**: Displays cumulative token consumption, prompt caching ratios, and estimated turn costs.
- **Model Selector Dropdown (`🤖`, `.btn-pane-model`)**: Live runtime model switching without re-opening the session.
- **Thinking Level Selector (`💡`, `.btn-pane-thinking`)**: Cycles thinking budget (`off` → `minimal` → `low` → `medium` → `high`) with an active green accent dot indicator.
- **`⋯` Overflow Menu (`.btn-pane-overflow`)**:
  - `🔍 搜尋對話`: Opens in-pane search bar.
  - `➕ 新增 Pi 對話`: Spawns a new concurrent session directly into the workspace.
  - `💬 BTW 側聊`: Opens the pane's isolated side-conversation drawer.
  - `🤖 子 Agent 列表`: Opens Subagents viewer for this session.
  - `🖼️ 媒體庫`: Opens multimedia asset drawer.
  - `◫ 水平分割` / `日 垂直分割`: Splits current pane along horizontal/vertical axis.
  - `⛶ 聚焦此對話`: Maximizes current pane to fill the entire workspace.
  - `🗑️ 刪除對話`: Deletes the session with confirmation.
- **Direct Action Buttons**: Split (`◫`), Maximize/Restore (`⛶`), and Close (`×`, `.btn-pane-close`).

### Under-Header Utilities
- **Per-Pane Search Bar (`.dashboard-pane-search-bar`)**: Real-time message query matching, match counter (`X / Y`), previous/next navigation, and Esc dismissal.
- **Per-Pane BTW Side Chat (`.dashboard-pane-btw`)**: Isolated side-channel transcript with dedicated header (`‹ 回主對話`, status label `BTW 側聊 · 不會加入主對話`, live dot, trash button). BTW turns execute in background without polluting main conversation history.
- **Sticky Prompt Pin (`createPromptPin`)**: Pinned header bar tracking the prompt for the turn currently in view. Folded (44px) by default; expands on click to `min(40dvh, 320px)`. Pushes up and down synchronously as adjacent prompt rows scroll past. A pane loads only the newest page (`?limit=50`), which in an agent session often holds one prompt or none, so its `getEarlier` asks `/events?before=<oldest loaded id>` for the prompt of a turn that began earlier, once per boundary; without it the pin vanished as soon as the reader scrolled up past the latest prompt (iPhone, 2026-10-22).

### Transcript & Message Rendering
- **Markdown Architecture**: Uses `@lobehub/streamdown` and `CachedMarkdown` for rendering streaming and static messages, mathematical LaTeX (`rehype-katex`), syntax-highlighted code blocks, and Mermaid diagrams.
- **Auto-Scroll to Latest**: Activating the dashboard or receiving new SSE events scrolls panes to the newest message automatically.
- **120Hz ProMotion Scrolling**: Custom `smoothScrollTo` function utilizing an Apple quartic ease-out curve (`1 - (1 - t)^4`) over 240ms, providing zero-lag momentum snapping on 120Hz iPad Pro and desktop monitors.
- **Live Jump Indicator (`.dashboard-pane-jump`)**: Displays unread counter when user has manually scrolled up; tapping jumps smoothly to the newest message.

### Composer & Attachment System
- **One Floating Composer (2026-10-20, reworked 2026-10-21)**: every pane still owns its composer (draft, attachments, quote, BTW, hot-keyword chips), wrapped with its typing line in `.dashboard-pane-dock`, but only the pane last tapped shows it — `selectComposerPane(jid)` puts `.composer-active` on the pane and `.is-floating` on its dock. Selection runs on `click` (capture), never `pointerdown`, and `focusin` only from a `textarea`/`input`: a button takes focus on press, so selecting earlier moved the card under the finger and lifted Jump to present away before the tap landed (iPhone report). A finger scroll never produces a click, so browsing another pane moves nothing; a finger tap (`pointerType === 'touch'`) on the transcript itself — not a control, image, video or text selection (`PANE_TAP_KEEPS_FOCUS`) — focuses that pane's textarea inside the tap (which is what lets iOS raise the keyboard) only when the pane already holds the card: the first tap brings the card, the second opens the keyboard, a third on the same pane closes it again (blur; the card stays) (2026-10-22, the keyboard popping up on every pane switch was unwanted). A keyboard already up (a dashboard composer focused at `pointerdown`, read there because the tap itself can blur it) moves along to the tapped pane instead of closing. The card is a row in the pane's flex column (`margin: 2px 8px 8px`, opaque `--bg-alt`), not an overlay: the transcript shrinks instead of scrolling behind it (the first version floated it and padded the transcript, but mid-history content still slid under it). `transcriptObserver` (a `ResizeObserver` on each transcript) keeps a reader who has not scrolled up at the bottom whenever the transcript resizes. Switching panes flies a non-interactive clone (`.dashboard-dock-ghost`, fixed, above the grid because panes clip overflow) placed on the landing rect and animated by `transform` only (translate + scale from the old card's rect, arc through `offset: 0.45`, 380ms), so the compositor can run it at the display rate. In the same 380ms the new pane's dock height grows from its typing-line height and the old pane's closes, so both transcripts ease rather than jump; the real card waits at `opacity: 0` (still focusable) until the clone lands. Reduced motion skips the flight, and closing the target pane cancels it. The active pane wears a 2px `--accent` frame (`::after`, above the content, 300ms border-color transition, soft inner glow while typing); none with a single pane. The choice persists in `localStorage` `piweb.dashboard.composer` and `ensureComposerPane()` falls back to the first pane. Below `240px` card width the paste button hides (system paste remains) and the placeholder never wraps. Each pane is a size container (`container: pane / size`; its size always comes from the layout): below `460px` pane height a card with an attachment drops its hot-keyword chips and the compression hint (an empty card keeps its chips), and the transcript keeps `min-height: min(30%, 96px)`, so a stacked pane with an image attached still shows a few lines and Jump to present inside the transcript (recording 2026-10-21: the card took ~255px of a ~360px pane).
- **Keyboard (2026-10-22)**: the keyboard never resizes the Dashboard. While `html.keyboard-shell` pins `.app` at the visual viewport's `offsetTop`, `.app.dashboard-active` keeps `height: 100dvh`, so every pane stays where it was on screen and the keyboard covers whatever is below it (the chat view still shrinks to the visible strip). `syncKeyboardLift()` moves only the active card, via `translate: 0 calc(-1 * var(--kb-lift))`, just far enough to clear the keyboard (6px gap, never above the visible top). It measures against the pinned shell (`.app`'s rect, visible strip `[0, vv.height]`), never `visualViewport.offsetTop`: while iOS animates the keyboard the two disagree for a moment, and the card flew ~100px too high before settling (iPhone recording 2026-10-22). A lifted pane gets `.kb-lifted` (`overflow: visible`, `z-index: 40` on it and its groups), so a lower pane's card can cover the pane above. It runs on visual viewport resize/scroll (re-sampled at 120/350/700ms), after layout rebuilds and synchronously in `selectComposerPane` so a hop lands already lifted. Before this, the shell shrank to the visible strip and two stacked panes were crushed to a line or two each (iPhone recording).
- **Pane media (2026-10-21)**: the stream player's tap delegation and anchor lookup cover `#messages` and every `.dashboard-pane-messages` (`STREAM_ROOTS` in `app.js`), the playlist is the tapped transcript's items, and a `MutationObserver` on `#dashboard-view` re-homes a player embedded in a re-rendered pane. The image viewer takes an optional target from a pane (`openLightbox(url, urls, target)`), so the draw-and-attach (annotate) PNG goes to that pane's composer (replacing a pending image in place) instead of the hidden chat composer.
- **Per-Pane Typing Status & BTW Link**: Live typing indicator row with `BTW ›` / `‹ 主對話` toggle link.
- **Slash Command Autocomplete**: Popup menu suggesting available slash commands (`/pi`, `/model`, `/clear`, etc.).
- **Quote Reply Preview**: Quote bar with dismiss button (`✕`), triggered by message `❝` quote buttons or transcript text selection.
- **Selecting and quoting in a pane (2026-10-24)**: a text selection in a pane gets the same
  `引用 / 複製` pill as the chat. Two things had kept it from ever appearing:
  - The Dashboard hides every `.main` child but `#dashboard-view`, and the pill
    (`#selection-actions`), highlight layer (`#sel-highlight-boxes`) and handle overlay
    (`#custom-selection-overlay`) are `.main` children. They are exempt from that rule now.
  - On touch every transcript is `user-select: none`, and the long-press selection was bound
    to the chat's `#messages` only. `app.js` binds a second instance to `#dashboard-grid` with
    `scope: '.dashboard-pane-messages'`: the pane long-pressed becomes the scroller, and the
    selection stays inside it. Both instances share the one overlay, so a module-level owner
    lets only the instance holding the selection drag the handles, and one starting a selection
    ends the other's.

  As in the chat, the selection quotes itself (2026-10-24; the first version waited for `引用`,
  which the user did not want). `showSelectionActions` calls `sessionDashboard.quoteSelection(jid,
  text, rect)`: the card comes to that pane without the hop or focus (so no keyboard) carrying the
  quote. The quote bar grows the card; `pane.holdScroll` keeps the keep-at-bottom observer and
  `selectComposerPane` from scrolling for two frames, the old `scrollTop` is restored, and the
  transcript scrolls only as far as needed to lift the selection above the card, never more than
  the room above the selection (scrolling by the card's full height pushed a selection near the top
  out of the pane). The return value moves the pill with the text. `引用` then only focuses that
  card (`setPaneQuote(jid, text, true)`). The pill is placed against the window bottom
  when the pane's composer is hidden (an all-zero rect used to flip it over the pane header).
  Tests: `session-dashboard-mobile.spec.ts` (long-press, 引用, handle drag in a second pane) and
  `session-dashboard-split.spec.ts` (mouse selection quotes at once, pill under the line, text above the card).
- **Multimedia Attachment Pipeline (`.pane-attachments`)**:
  - Supports image (PNG, JPEG, WebP, GIF), audio, and video attachments.
  - Thumbnail preview strip with file size tags and individual remove buttons.
  - Integrated Lightbox preview and image annotation canvas (`✎`).
  - Image compression toggle (`壓縮圖片`).
  - Immediate local rendering in the pane transcript upon sending.
- **Hot Keywords Chip Bar (`createHotKeywords`)**: One-tap query suggestions and prompt shortcuts.
- **Auto-Expanding Textarea (`.dashboard-pane-input`)**: Fluid vertical auto-growth with Enter-to-send and Shift+Enter newline handling.

---

## 5. Touch Hit-Zones, Interaction Models, & Drag-and-Swap

### Expanded Touch Hit-Zones
- Visual splitter width: `10px` on desktop, `12px` on touch devices, featuring an iPadOS Split-View style rounded pill handle (`40–44px` length, `4px` thickness).
- Draggable hit-target: An invisible `::before` pseudo-element expands the interactive touch zone to **`28px`** (pointer: fine) and **`36px`** (`@media (pointer: coarse)`), eliminating missed touches on touchscreens.

### High-Frequency Pointer Tracking
- Splitter dragging samples pointer events via `getCoalescedEvents()` where supported, ensuring smooth tracking with 120Hz/240Hz digitizers (such as Apple Pencil).
- **Push-through**: a splitter sees its whole row/column (`getChain`), not just its two neighbours. The pane it moves toward gives way first; once that pane is at its minimum (`95px` tall / `140px` wide) the next one in line is pushed, so a drag never stalls against another splitter. It stops only when every pane on that side is at its minimum (wall bounce on the outermost pane). Start sizes are layout sizes (`offsetWidth/Height`), since a neighbour may still be mid-bounce.
- The root container adds `.resizing-active` during active drag to lock cursor appearance, disable text selection, and eliminate pointer event overhead on underlying iframes and message text.

### Drag-and-Swap & Cross-Pane Dropping
Users can drag any existing pane header or drag a session card from the sidebar drawer directly onto any pane across the workspace. On touch the drag may start anywhere on the header, the session name and icon buttons included: movement decides intent (6px on bare header, 10px on a control so tap jitter stays a tap), and once a drag started on a control its trailing click is swallowed on the header itself (a swap re-parents the pane, so a window listener never sees it). Only the open rename field never starts a drag. Hovering over any pane activates a **5-way directional drop target** with clear contextual visual feedback, judged by where the finger (or pointer) is, in thirds of the pane under it (2026-10-23; it used to take the outer 20% band, which on a phone meant carrying a pane nearly through the other one before the preview flipped):
- **Top third**: `↑ 垂直並排（上方）`. **Bottom third**: `↓ 垂直並排（下方）`. They win the corners, so a
  pane picked up by the name at the left of its header and dragged straight down flips
  above/below a third of the way in, wherever it was grabbed. (A diagonal split from the center
  was tried first: with the finger at the left of the header it showed `左側` most of the way.)
- **Middle row**: left third `← 水平並排（左側）`, right third `→ 水平並排（右側）`, and the middle cell:
  - **Existing Pane Drag**: Displays `⇄ 交換視窗順序`. Dropping swaps the positions of the two panes in-place.
  - **Sidebar Session Drag**: Displays `➕ 加入此視窗旁`. Dropping cleanly inserts the new session adjacent to the target pane in the layout tree.
- **Over its own pane** there is no preview (the drop changes nothing).
- **The finger decides**, never the dragged pane's own center. A version that judged the carried
  pane's center (finger + its pick-up offset) shipped briefly on 2026-10-23 and was reverted the
  same day at the user's request: the drop should follow where the finger is.
- **An edge drop splits the pane under the finger, exactly as the preview shows.** The two panes
  share that pane's old space; the rest of its column (or row) is untouched. If the pane's own
  split already runs that way the dropped pane is inserted beside it; otherwise the pane becomes a
  nested split across the other axis. (Previously left/right inserted a whole new column next to
  the target's column, so dropping on the right half of a pane stacked over another one just moved
  the dragged pane to its own column — desktop screen recording, 2026-10-21.)
- **Stage edge band (wide layout only)**: the outermost `28px` on the left/right of the grid and
  `16px` at the top/bottom (thinner so picking a pane up by its header does not land there) drop
  *beside everything* instead of splitting the pane under the pointer: `⇤ 最左側（整欄）`,
  `最右側（整欄）⇥`, `⤒ 最上方（整列）`, `⤓ 最下方（整列）`. Along the top-level axis the pane becomes
  one more top-level cell with an average share (`1/(n+1)` of the stage); across it, the whole
  existing layout and the new pane split the stage in half and `direction` flips
  (`placeAtStageEdge()`). The preview strip shows that exact share.
- **Layout model**: a split tree. `direction` is the top-level axis; `groups` are the top-level
  cells `{ weight, items }`; an item is a pane `{ jid, weight }` or a nested split
  `{ weight, items }`, and each level runs perpendicular to its parent. `normalizeGroups()`
  collapses a split left with one child, flattens a split that ends up on its parent's axis, and
  lifts a lone top-level-axis split into separate top-level cells. Layouts saved before nesting are
  the same two-level shape and load unchanged; the server stores the layout as opaque JSON.
  Splitters locate their split by the first pane on each side (`siblingsOf()`), since normalization
  rebuilds the model objects. `test/e2e/session-dashboard-split.spec.ts`.
- Smooth animated reflows execute via a coordinated FLIP (First, Last, Invert, Play) spring animation.

### Session List Taps While Tiled (2026-10-25)
In the Dashboard a tap on a standard session row (`app.js` session-item click) no longer calls
`setActive(false)`. It calls `sessionDashboard.revealSession(jid)` and closes the drawer:
- not tiled yet → `addPane(jid)` (same placement as the row's tile button);
- already tiled → stays where it is; if another pane is zoomed, the zoom is released first so the
  pane can be seen;
- either way `selectComposerPane(jid)` flies the input card there. The textarea is focused only
  for `(pointer: fine)`, so a finger tap on the list never raises the keyboard;
- the pane gets `.pane-locating` (restarted with a reflow so a second tap replays it, removed after
  1200ms): an `--accent` wash plus an inset ring that pulse twice over 1.1s, drawn by the pane's
  `::after`. Reduced motion shows the frame without the pulse.
Life still leaves the Dashboard and opens on its own.

### Zoom a Pane Inside the Dashboard (2026-10-25)
Zoom is a view state (`zoomedJid`), not a layout change: the split tree, weights and saved layout
are untouched, and the other panes stay mounted with their SSE streams and drafts.
- **Entry points**: the header's expand button (`.pane-expand-btn`, title 放大此視窗, icon swaps to
  `ZOOM_OUT_ICON` with `aria-pressed="true"` and title 縮回並排 while zoomed), the `⋯` menu item of
  the same name (always present; the button folds into `⋯` in panes under 460px), or a double
  click / double tap on the header's bare space — two `pointerup`s within 350ms and 24px, ignoring
  buttons, inputs and `.pane-session-name` (double click there renames) and any release that ended
  a header drag (`pointerDrag.started`).
- **Exit**: the same controls again, any re-tiling (`animatePaneLayoutTransition` unzooms instantly
  first: add, close, swap, presets, equalize), a list tap on another session, or leaving the
  Dashboard. `setZoom` is a no-op with fewer than two panes.
- **Why `display: none`, not an overlay**: every group has `transform: translateZ(0)` and
  `overflow: hidden`, which makes it the containing block for `position: fixed` and clips anything
  that escapes, so a zoomed pane cannot be lifted out of its group. Instead `markZoomPath(jid)` tags
  the pane and every ancestor group up to the grid with `.zoom-path`; `.dashboard-grid.has-zoom`
  hides every group, pane and splitter not on that path and forces the path to `flex: 1 1 0px`, so
  the pane fills the stage through normal layout. Density classes are computed from the tiled
  layout only, not while zoomed.
- **Scroll**: on zoom-in every pane's distance from top and bottom is saved; on zoom-out each pane
  goes back to it (a reader at the bottom stays at the bottom). The zoomed pane takes the input
  card without the hop animation.
- **Motion**: both directions are a FLIP: measure every pane, apply the zoom, measure again, then
  animate `translate + scale` from the old rect (`transform-origin: 0 0`), 40 keyframes sampled from
  `solveSpringProgress(t, 0.6, 16)` over 620ms, so the pane overshoots slightly and settles. While it
  flies the grid has `.zoom-moving`: path groups stop clipping (`overflow: visible`, `z-index: 40`),
  the moving pane keeps its own clip and gets a shadow. Starting a zoom cancels running pane
  animations and the input card's flight (`dockGhost`), which otherwise showed the old pane's
  "Message …" card mid-zoom. Reduced motion applies the zoom without the flight.

### Two-Finger Pane Drag (touch, 2026-10-25)
Two fingers anywhere on a pane — transcript included — drag it exactly like its header: same
ghost (`.dashboard-drag-ghost`), same 5-way drop preview (`computeDropTarget`/`showDropPreview`),
same `body.dashboard-pointer-dragging` isolation, and `addPane(jid, target)` on release for a pane
or stage-edge target.
- It is built on touch events, not pointers: iOS cancels pointers when two fingers start a scroll
  or pinch. `touchstart` is passive; `touchmove` is non-passive and calls `preventDefault()`, and if
  the browser marks the move non-cancelable (it has already claimed the gesture) the drag is
  abandoned instead of fighting it.
- Starts only when both fingers are on the same pane, at least two panes are tiled, no pane is
  zoomed and no header drag is in progress (it clears a pending `pointerDrag`). The ghost appears
  after 10px of movement of the fingers' midpoint, which is also the point the drop is judged from.
- Lifting to fewer than two fingers drops; `touchcancel` abandons.
- The same two fingers can pinch instead: the first clear movement decides (midpoint moved 10px
  and more than the spread changed → drag; spread changed 14px and more than the midpoint moved →
  pinch). While a pane is zoomed only the zoomed pane can be pinched, and it cannot be dragged.

### Pinch a Pane (touch, 2026-10-25)
Two stages up, two down, with the zoom above as the top stage. Levels: 0 tile, 1 a little bigger,
2 the whole stage (`pinchLevel(jid)`).
- **Stage one is a layout change, not an overlay.** `enlargedLayout(jid)` walks the pane's path
  through the split tree and, at every level with siblings, raises its share by 30% of what the
  siblings hold (`ENLARGE_GAIN`), capped at 80% and at what leaves each sibling its minimum size
  (`MIN_PANE_WIDTH_PX`/`MIN_PANE_HEIGHT_PX`), scaling the siblings down proportionally. A pane in a
  2×2 grid goes from 1/4 to about 0.42 of the stage; the others stay visible and usable. If nothing
  can grow (already large), stage one is skipped and a spread goes straight to the zoom.
- **Back down exactly.** Committing stage one saves the layout (like a splitter) and keeps
  `enlarged = { jid, key, restore }`: `restore` is the layout before, `key` the layout after.
  Level 1 holds only while the live layout still equals `key`; any splitter move, preset, swap or
  pane change makes it a plain tile again (level 0), and a later spread enlarges from there. The
  zoom keeps the weights, so the enlargement survives a zoom in and out. `restore` lives in memory;
  after a reload the bigger pane is a level-0 tile.
- **Thresholds** on the ratio of finger distance to its start: ≥1.18 one step up, ≥1.6 straight to
  the zoom (from level 1 any step up is the zoom); ≤0.85 one step down, ≤0.6 from the zoom straight
  to level 0. From level 0 a pinch has nowhere to go and springs back.
- **While the fingers are down** (`beginPinch`/`trackPinch`) the pane gets the zoom's lift
  (`.zoom-path` + `.zoom-moving`: above its neighbours, not clipped by its groups) and
  `transform: translate(midpoint delta) scale(ratio)` about the start midpoint, clamped like rubber
  (×0.2) beyond 1.05× the scale that fills the stage and below 0.92× (0.5× when it can shrink). The
  drop preview element doubles as the landing outline (`.pinch-target`: no wash, no blur, so the
  pane under it stays sharp), sized from `predictPaneRect(jid, layout)` — the target layout's
  weights applied to the grid rect, splitters ignored — and labelled 放大一點 / 放到最大 / 縮回並排 /
  縮回原本大小.
- **On release** (`settlePinch`) the pane is measured where the fingers left it, the transform is
  dropped, and it springs from that rect: to the zoom via `setZoom(jid, { from })`, out of it via
  `setZoom(null, { from })` (restoring the old weights first, behind the zoom, when going to level
  0), and between levels 0 and 1 via `animatePaneLayoutTransition(mutate, { lift, from })`, which
  keeps the pinched pane lifted until it lands while its neighbours FLIP to their new tiles. No
  change → `springPinchBack` (the zoom spring, 460ms, from the current transform to none).
- `touchcancel` springs back. Header `pointerup`s within 400ms of a two-finger gesture are ignored
  (`twoFingerQuietUntil`), and iOS's own `gesturestart` is cancelled while two fingers own a pane.

### Splitter Drags in WebKit (2026-10-25)
An iPad recording with nine long panes showed a column splitter that moved once every 0.4–1.2s.
Measured on a copy of that layout in Playwright's WebKit (the same engine), one width change cost
73ms of style and layout per step (Chromium: under a frame). Bisected by switching parts off:
- `container: pane / size` on every pane: WebKit restyles the container's whole subtree, transcript
  included, whenever its size changes → 73 → 31ms without it. The pane is now `contain: size
  layout`; the header and the dock were already `inline-size` containers for their width queries.
  The two queries that needed the pane became classes: `.pane-short` (≤460px tall, from
  `paneSizeObserver`) hides the card's chips when something is attached, and `.is-narrow` on the
  `⋯` menu (pane ≤300px wide, measured when it opens) drops command hints.
- Rows out of view still laid out → `content-visibility: auto` on transcript rows while
  `.resizing-active`, with `contain-intrinsic-size: auto 120px` always on, so each row keeps its
  last rendered height: 31 → 10ms a step, scroll heights and the reading position unchanged (checked
  in both engines). The rows reflow at the new width once, on release. It stays off at rest
  because Safari has no scroll anchoring: rows at estimated heights would jump while paging
  history.

### iOS Touch Drag Isolation & Session List Scroll Freeze
On mobile Safari and iOS WebKit, dragging a session card previously suffered from an intermittent cancellation bug (where the ghost vanished) and accidental vertical scrolling of the session drawer while attempting to drag cards horizontally into the dashboard. This was diagnosed and resolved through a five-part isolation architecture:
1. **Suppression of Native Text Selection & Browser Pan (`touch-action: none`)**:
   Applied `user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: none;` to `.session-item` on `>= 768px`. This completely prevents the browser's native gesture engine from triggering accidental vertical scrolling or text selection on `<span class="name">` when touching a session card.
2. **Directional Intent Resolution (Drag vs. Scroll)**:
   Pointer movement samples directional vector ($\Delta x, \Delta y$).
   - When horizontal movement towards the dashboard stage is detected ($\Delta x \ge 6\text{px}$ or $\Delta x > 0 \land \Delta x \ge 0.6 |\Delta y|$), the interaction locks into `drag` mode.
   - When vertical movement in the drawer is detected ($|\Delta y| \ge 6\text{px} \land |\Delta y| > |\Delta x|$), the interaction locks into `scroll` mode, updating `sessionList.scrollTop` smoothly and coasting with momentum on release.
3. **Absolute Session List Scroll Freeze**:
   During `drag` mode, `sessionList.scrollTop` is strictly pinned to its initial `startScrollTop`. Any vertical pointer jitter while dragging across the screen cannot scroll the session list even by a single pixel.
4. **Underlying Hit & Scroll Isolation (`.dashboard-pointer-dragging`)**:
   During active drags, `body.dashboard-pointer-dragging` applies:
   ```css
   body.dashboard-pointer-dragging .session-list,
   body.dashboard-pointer-dragging #session-list,
   body.dashboard-pointer-dragging .drawer {
     overflow: hidden !important;
     touch-action: none !important;
     pointer-events: none !important;
   }
   ```
   along with `pointer-events: none !important` across all underlying `.dashboard-stage`, `.dashboard-pane`, `.dashboard-pane-messages`, `.dashboard-pane-composer`, and `.dashboard-splitter` elements. This prevents inner scroll containers from stealing the touch event stream and triggering synthetic `pointercancel`.
5. **Resilient Pointercancel Commit & Pointer Capture**:
   In `finishPointerDrag`, if `pointercancel` is dispatched while the pointer coordinates remain over `.main` or hovering a valid drop target, the drop transaction safely commits rather than discarding the action. Pointer capture (`setPointerCapture`) is cleanly released on completion.

---

## 6. 120Hz GPU Compositor Physics Engine

### Theoretical Model: Damped Harmonic Oscillator
When a user releases a splitter after dragging, the layout does not abruptly halt. Instead, it enters an underdamped inertial spring oscillation to provide organic, tactile tactile feedback:

$$m \frac{d^2 x}{dt^2} + c \frac{dx}{dt} + k x = 0$$

- **Stiffness ($k$)**: `420 N/m`
- **Damping coefficient ($c$)**: `10.5 N·s/m`
- **Damping ratio ($\zeta$)**: $\approx 0.25$ (underdamped)
- **Natural angular frequency ($\omega_n$)**: $\approx 20.5\text{ rad/s}$
- **Motion profile**: Yields a pronounced **35–68px inertial overshoot** beyond the release point, followed by **3 elastic rebounds** settling over approximately `440ms`.
- **Rubber-band wall collision**: A hard boundary cushion (`hardMinPx = 28`) reflects velocity ($v \leftarrow -0.72v$) if an overshoot collides with minimum pane dimensions.

### Zero-Reflow GPU Compositor Implementation
Previous implementations recalculated flexbox widths on every `requestAnimationFrame`, causing severe layout thrashing (50–90ms frame drops during ProMotion 120Hz rendering).

The current architecture resolves this completely:
1. **Compositor Promotion**: `.dashboard-group`, `.dashboard-pane`, and `.dashboard-splitter` are promoted to dedicated GPU compositor layers via:
   ```css
   will-change: transform;
   transform: translateZ(0);
   backface-visibility: hidden;
   ```
2. **Analytical Precomputation (`solveSpringProgress`)**:
   Upon splitter release, an analytical solver generates a 36-point keyframe trajectory representing the exact displacement curve:
   $$x(t) = e^{-\zeta \omega_n t} \left( A \cos(\omega_d t) + B \sin(\omega_d t) \right)$$
3. **Web Animations API (WAAPI) Keyframe Execution**:
   Splitter and adjacent panes execute Web Animations API keyframes driven entirely via GPU `scale3d` and `translate3d`:
   ```javascript
   const animSplitter = splitter.animate(splitterKeyframes, { duration: 440, easing: 'linear' });
   const animFirst = firstEl.animate(firstKeyframes, { duration: 440, easing: 'linear' });
   const animSecond = secondEl.animate(secondKeyframes, { duration: 440, easing: 'linear' });
   ```
4. **Pointer & Style Isolation**: The container applies `.spring-bouncing`, temporarily disabling pointer events and CSS transitions across messages and composer elements.
5. **Atomic Final Settlement**: Upon animation completion (`animSplitter.onfinish`), the final calculated flex weights are committed in a single atomic style write, and transforms are cleared. **Total layout reflows during the 440ms bounce: 0.**

---

## 7. Tablet, iPadOS, & Mobile Stability

1. **Layout-Viewport Shell at rest, Visual-Viewport Shell while typing**:
   `.app` is `100dvh`; single chat, Dashboard (`height: 100%`) and drawer inherit it. The on-screen keyboard only shrinks the *visual* viewport, and iOS pans it down the page. With a full-height shell that pan exposed everything under the input — the composer's safe-area padding and any page height past the shell — as a blank band above the keyboard (iPhone screenshot 2026-10-20). Shrinking the shell to `visualViewport.height` without following the pan (commit `715f9cc`) instead left the composer floating at the top. So while the keyboard is up (`layout − visual ≥ 150px`, pinch zoom ignored) `public/viewport-shell.js` sets `html.keyboard-shell` and `--keyboard-shell-top/height` from `visualViewport.offsetTop/height`; `.app` becomes `position: fixed` there, covering exactly the visible area, and the composer drops its home-indicator padding. Closing the keyboard removes the pin and any leftover document scroll. A short viewport alone is not trusted: iOS 26 can leave `visualViewport.height` short after the keyboard closes (WebKit 301857), which kept the shell squeezed into the top of an empty screen (iPhone screenshot 2026-10-22), so the pin also requires typing focus (a text field, textarea or contenteditable) and re-checks on `focusin`/`focusout`; the Dashboard's card lift follows the shell's `keyboard-shell` verdict. The same binder re-runs the composer/autocomplete/sheet policies, with settling samples (animation frame, 120/350/700ms) for late WebKit layout.
   The iOS 26 Home Screen gap under the composer that cleared only after rotating is WebKit 301108 (viewport short by the status-bar height while the page is shorter than the screen). It is fixed by a page-level rule in `app.css`: `@media (display-mode: standalone) { html { min-height: min(100lvh, calc(100% + env(safe-area-inset-top))) } }`. A taller shell does not help; WebKit stops drawing at the short edge.
2. **Focus Theft Prevention**:
   Toolbar and pane action buttons invoke `e.preventDefault()` on `pointerdown`, preventing textarea blur when toggling layouts, clicking presets, or activating menus.
3. **Touch Input Zoom Immunity**:
   All composer textareas and input fields maintain `font-size: 16px` to prevent Safari from triggering automatic page zoom.
4. **Background Poll State Preservation**:
   Background `/api/sessions` polling compares session signature hashes; DOM nodes are never re-created if the session set is unchanged. Resized pane weights are indexed dynamically by session JID, preventing polling cycles from resetting user-customized splitter dimensions.

---

## 8. Verification & E2E Testing Matrix

Comprehensive automated testing is executed via Playwright (`test/e2e/session-dashboard.spec.ts`):

```sh
PIWEB_E2E_PORT=4191 npx playwright test test/e2e/session-dashboard.spec.ts
```

### Verified Test Assertions
1. **1 to 12 Pane Scalability**: Verifies dynamic rendering across 1, 2, 4, 6, 8, 9, and 12 concurrent panes in horizontal, vertical, and grid orientations.
2. **Splitter Inertial Overshoot**: Measures real-time bounding boxes post-release via CDP, asserting:
   - 4-pane horizontal splitter overshoot: $> 10\text{px}$ beyond release point.
   - 4-pane vertical splitter overshoot: $> 10\text{px}$ beyond release point.
   - 12-pane high-density overshoot: $> 6\text{px}$ beyond release point.
3. **Drag-and-Swap Validation**: Simulates drag-and-drop of pane headers into the center drop zone; verifies in-place session swapping.
4. **Multimedia Attachment Send & Render**: Uploads Base64 PNG image attachments in Pane #12, asserts immediate thumbnail presence, sends message, and verifies immediate display in the message transcript (`.msg-files img`).
5. **Input Focus Retention & Zero-Blank-Space Pane Closure**: Focuses textarea, triggers layout preset changes (with FLIP bounce animation), and verifies `document.activeElement` remains unchanged. Verifies closing a vertically split pane in a column expands the remaining pane to 100% height with zero blank space.
6. **CDP 120Hz FPS Counter**: Connects Chrome DevTools Protocol session (`Overlay.setShowFPSCounter`) to verify 120Hz compositor smoothness without frame drops.
7. **Cross-Pane Touch Drag & Drop Verification**: Simulates touch drag (`PointerEvent` pointerdown, pointermove, pointerup) of a session card from `#session-list` across Pane 1 and onto Pane 2. Asserts that the drag ghost (`.dashboard-drag-ghost`) and drop indicator (`.dashboard-drop-preview`) remain active throughout the gesture without premature cancellation, and verifies that the stage successfully integrates the new session adjacent to the target pane (pane count increases from 2 to 3).
8. **Multi-Device Cloud Sync Verification**: Asserts that layout modifications are automatically persisted to `/api/dashboard-layout` in SQLite, and a new device opening the dashboard inherits the exact layout configuration.
9. **Session-List Tap While Tiled** (`session-dashboard-zoom.spec.ts`): a tap on an untiled row adds a fifth pane, moves the card there and sets `.pane-locating` (cleared within 2s); a tap on a tiled row keeps the pane count, moves the card and flashes; the Dashboard stays visible throughout.
10. **Zoom Spring Both Ways**: the expand button gives a non-identity transform 90ms in, then identity; the pane matches the stage size within 2px, its neighbours are hidden, `aria-pressed="true"`; collapsing is mid-flight at 90ms too, and every pane returns to its tile within 2px with no `zoom-moving`/`has-zoom` left on the grid.
11. **Header Double Click**: zooms and restores from a point on the header's bare space (found with `elementFromPoint`, recomputed after each change); a list tap on another session while zoomed releases the zoom.
12. **Two-Finger Drag**: two CDP touch points (`Input.dispatchTouchEvent`) carried from one pane's center to another's show the ghost and drop preview, and on lift the two panes swap places with the body drag class removed.

13. **Pinch Stages**: a 100→135px spread shows 放大一點 mid-gesture (pane transformed, outline visible), lands on a tile >1.4× wider but <70% of the stage with the others visible; a second spread shows 放到最大 and zooms; pinching 200→150 shows 縮回並排 and returns to the bigger tile, again shows 縮回原本大小 and returns to the original tile within 2px.
14. **Wide Spread / Small Spread**: 100→108 springs back to an identity transform with the size unchanged; 100→190 shows 放到最大 and zooms; the lifted fingers are not taken as a header double tap.

Splitter-release overshoot in `session-dashboard.spec.ts` is sampled every frame inside the page
(`releaseAndPeak`), not by polling `boundingBox` round trips, which missed the ~80ms peak whenever
the machine was busy (6 of 6 runs failed under load on the old sampler, 0 of 6 now).

```sh
PIWEB_E2E_PORT=4193 npx playwright test test/e2e/session-dashboard-zoom.spec.ts
```

### Visual & Video Artifacts
- **E2E Video Verification**: `artifacts/playwright/test-results/session-dashboard-120fps.mp4` (120 FPS high-refresh recording).
- **Milestone Walkthrough**: `artifacts/dashboard-vision/videos/full_workflow.mp4`.
- **12-Milestone Contact Sheet**: `artifacts/dashboard-vision/contact-sheet.png`.
- **Detailed Visual Report**: `artifacts/dashboard-vision/report.md`.

---

## 9. Deployment & Operations

### Frontend Hot-Deploy Workflow
Because the dashboard is implemented as static assets in `public/`, updates can be hot-deployed to the running `piweb-app` container without taking down the server or invalidating user sessions:

```bash
# 1. Build client assets (if client/ was modified)
npm run build:client

# 2. Inspect diff against live container
live=$(mktemp -d) && docker cp piweb-app:/app/public/. "$live"
diff -rq "$live" public

# 3. Copy updated dashboard files into container
for f in public/session-dashboard.js public/session-dashboard.css; do
  docker cp "$f" "piweb-app:/app/$f"
done

# 4. Verify public endpoint hash
curl -s https://piweb.crayfish-monitor.ts.net/session-dashboard.js | sha256sum
sha256sum public/session-dashboard.js
```

### Full Rebuild Workflow
If backend server routes (`src/web/server.ts`) or dependencies are modified:
```bash
docker compose build app && docker compose up -d
curl -s -o /dev/null -w '%{http_code}\n' https://piweb.crayfish-monitor.ts.net/
```


## Phone dashboard

Dashboard uses the same layout engine and functionality at every viewport width:
horizontal/vertical/grid presets, group and pane weights, directional drop zones,
touch/pointer dragging, splitters, per-pane controls and cloud layout persistence.
There is no phone-only stacked-card or pager implementation. Only single-row toolbar sizing (title left, presets right),
safe-area clearance and overlay drawer presentation adapt to the smaller screen.
Dragging from the overlay drawer closes it once drag begins to expose drop targets.

Shared narrow-pane header rules also apply to small desktop panes (2026-10-24).
The header stays one 44px row: the title ellipsizes, and icons fold into `⋯`
by pane width — at ≤460px Status / Usage / split / expand, at ≤300px also Model
and Thinking, at ≤220px the provider badge, at ≤170px ×. `⋯` (and Stop while
running) never leaves, and its menu shows Status, Usage, Model, Thinking level
and 關閉視窗 exactly when their icons are hidden (`getComputedStyle` at open).
The menu shrinks to fit the pane (`min-width: min(232px, 100% - 12px)`; command
hints hidden ≤300px), since the pane clips its overflow. The earlier version
wrapped the actions to a second row, which the fixed-height header clipped, so
a narrow pane showed no icons at all (iPad recording 2026-10-24).
`test/e2e/session-dashboard-split.spec.ts` "a pane too narrow for its icons…".

Regression coverage: `test/e2e/session-dashboard-mobile.spec.ts` checks two panes
remain side by side, four panes stay within the grid with three visible splitters,
rotation and saved layout preservation, close-to-single fill and overflow.
Chromium touch emulation is not physical iOS Safari validation.


### Mobile overlap and landscape regression

Jump-to-present floats inside a flex-sized transcript wrapper, 8px above its lower
edge. It consumes no layout row and does not resize the messages when shown/hidden.
The wrapper ends above BTW/keywords/composer, avoiding guessed composer offsets. Phone landscape (coarse pointer below 500px tall) uses the overlay drawer,
not the >=768px desktop rail. `app.js`, the dashboard and drawer CSS share that
breakpoint policy. Dashboard phone styling respects the top safe area. It does not add a second bottom safe-area strip below the grid; the mobile regression uses Chromium safe-area emulation (34px) and asserts the stage reaches the dashboard bottom.
The mobile regression spec checks jump/keyword geometry, landscape drawer open/
close and full workspace width, plus 320px and 708px document overflow.


### iPhone height-settling regression

- Unit: `test/viewport-shell.test.ts` (keyboard close with focus retained, delayed
  rotation measurements, page/visibility restore, pinch zoom, fallback, cleanup).
- Integration: `test/viewport-recovery.test.ts` guards shared shell wiring.
- Browser: `test/e2e/iphone-viewport-shell.spec.ts` runs the production UI with only
  the `visualViewport.height` reporting boundary controlled: 844 → 480 → 844,
  delayed orientation settling without a second event, pageshow, main-reader
  scroll preservation, and the same bottom geometry for Dashboard.
- Chromium emulation does not prove real iPhone Safari keyboard timing. The
  supplied real-device recording is the reproduction source; device confirmation
  is still required after deployment.
