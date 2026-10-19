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
- **Sticky Prompt Pin (`createPromptPin`)**: Pinned header bar tracking the prompt for the turn currently in view. Folded (44px) by default; expands on click to `min(40dvh, 320px)`. Pushes up and down synchronously as adjacent prompt rows scroll past.

### Transcript & Message Rendering
- **Markdown Architecture**: Uses `@lobehub/streamdown` and `CachedMarkdown` for rendering streaming and static messages, mathematical LaTeX (`rehype-katex`), syntax-highlighted code blocks, and Mermaid diagrams.
- **Auto-Scroll to Latest**: Activating the dashboard or receiving new SSE events scrolls panes to the newest message automatically.
- **120Hz ProMotion Scrolling**: Custom `smoothScrollTo` function utilizing an Apple quartic ease-out curve (`1 - (1 - t)^4`) over 240ms, providing zero-lag momentum snapping on 120Hz iPad Pro and desktop monitors.
- **Live Jump Indicator (`.dashboard-pane-jump`)**: Displays unread counter when user has manually scrolled up; tapping jumps smoothly to the newest message.

### Composer & Attachment System
- **Per-Pane Typing Status & BTW Link**: Live typing indicator row with `BTW ›` / `‹ 主對話` toggle link.
- **Slash Command Autocomplete**: Popup menu suggesting available slash commands (`/pi`, `/model`, `/clear`, etc.).
- **Quote Reply Preview**: Quote bar with dismiss button (`✕`), triggered by message `❝` quote buttons or transcript text selection.
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
- The root container adds `.resizing-active` during active drag to lock cursor appearance, disable text selection, and eliminate pointer event overhead on underlying iframes and message text.

### Drag-and-Swap & Cross-Pane Dropping
Users can drag any existing pane header or drag a session card from the sidebar drawer directly onto any pane across the workspace. Hovering over any pane activates a **5-way directional drop target** with clear contextual visual feedback:
- **Center Zone (`20%..80%` relative X and Y)**:
  - **Existing Pane Drag**: Displays `⇄ 交換視窗順序`. Dropping swaps the positions of the two panes in-place.
  - **Sidebar Session Drag**: Displays `➕ 加入此視窗旁`. Dropping cleanly inserts the new session adjacent to the target pane in the layout tree.
- **Outer Edge Zones (`< 20%` or `> 80%`)**:
  - `relX < 0.20`: Left edge split (`← 水平並排（左側）`)
  - `relX > 0.80`: Right edge split (`→ 水平並排（右側）`)
  - `relY < 0.20`: Top edge split (`↑ 垂直並排（上方）`)
  - `relY > 0.80`: Bottom edge split (`↓ 垂直並排（下方）`)
- Smooth animated reflows execute via a coordinated FLIP (First, Last, Invert, Play) spring animation.

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

1. **Virtual Keyboard Stability (`--dashboard-vv-h`)**:
   Tracks `window.visualViewport.height` dynamically via `--dashboard-vv-h`. When the iPadOS virtual keyboard appears, the dashboard shrinks predictably without triggering body scroll jumps or dismissing the keyboard prematurely.
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

Dashboard is available from the phone top bar and session drawer. Use a session's
44px tile button to add/remove a pane; adding closes the overlay drawer. Phone
session rows retain native vertical scrolling rather than initiating tile drags.

Below 768px (or short coarse-pointer viewports), panes are presented as a vertically
scrollable stack, with a single pane filling the available grid. Desktop splitters
are hidden in this presentation. The underlying groups, direction and weights
remain unchanged: resizing/rotating the viewport alone never overwrites the shared
layout. The existing layout API continues to persist deliberate membership/preset
changes. Keyboard viewport sizing uses the existing visualViewport integration.

Regression coverage: `test/e2e/session-dashboard-mobile.spec.ts` checks entry,
drawer/add interaction, two panes, horizontal overflow, rotation, preservation of
saved desktop geometry and single-pane fill after closing a pane. These checks
use Chromium touch emulation, not physical iOS Safari.


### Mobile overlap and landscape regression

Jump-to-present occupies its own flow row above BTW/keywords/composer rather than
using a fixed bottom offset. This avoids covering variable-height keyword or quote
rows. Phone landscape (coarse pointer below 500px tall) uses the overlay drawer,
not the >=768px desktop rail. `app.js`, the dashboard and drawer CSS share that
breakpoint policy. Dashboard phone styling also respects top/bottom safe areas.
The mobile regression spec checks jump/keyword geometry, landscape drawer open/
close and full workspace width, plus 320px and 708px document overflow.
