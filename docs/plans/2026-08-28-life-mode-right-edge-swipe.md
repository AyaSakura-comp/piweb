# Life Mode Right-Edge Swipe Implementation Plan

> **For Hermes:** Implement task-by-task with strict RED → GREEN → REFACTOR cycles. Do not reset, stage, commit, or overwrite unrelated work.

**Goal:** Add a persistent singleton Life chat that always follows Pi's default model and opens by swiping left from the phone's right edge.

**Architecture:** Add an explicit `channels.kind` discriminator (`standard | life`) and an idempotent authenticated `POST /api/life-session`. Standard session lists/trash exclude the Life channel. The frontend stores only the presentation mode (`piweb.mode`), uses the existing transcript/composer and integration pipeline for the Life channel, renders simplified Life chrome with a dedicated New-pi-session header pencil and a Search/Media overflow, and recognizes a velocity-aware right-edge horizontal swipe without stealing vertical scrolling. The 44×64 px edge leaf is also an accessible button that auto-settles through the same transition. `pi new` rotates the internal Pi context but preserves the protected Life channel/transcript. A return or rollback with no standard destination must clear all Life selection/stream/search ownership and render an empty standard shell.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, Node HTTP server, framework-free browser JavaScript/CSS, Vitest, Playwright mobile Chromium.

**Final architecture:** [`../life-mode.md`](../life-mode.md) documents the implemented user workflow, process boundaries, turn sequence, persistence model, race guards, and verification graph. It supersedes any implementation detail in this original plan that changed during review.

---

### Task 1: Persist one Life channel and keep it out of session management

**Files:**

- Modify: `src/types.ts`
- Modify: `src/db.ts`
- Create: `test/life-session-db.test.ts`

**Step 1 — RED:** Write database tests proving a legacy database gains `channels.kind`, `getOrCreateLifeChannel()` is idempotent, only one `kind='life'` row exists, re-entry clears model/thinking overrides and restores a trashed Life row, standard/trash lists omit Life, and an unrelated standard row at the reserved `web:life` JID fails closed without inheriting its folder/history.

**Step 2 — Verify RED:**

```bash
npm test -- --run test/life-session-db.test.ts
```

Expected: FAIL because `kind` and `getOrCreateLifeChannel` do not exist.

**Step 3 — GREEN:** Add `ChannelKind`, migrate `channels.kind` with default `standard`, add a partial unique Life index, map `kind` through `RegisteredChannel`, and implement an atomic get-or-create function returning `{ channel, created }`. Atomically reserve a new empty Life folder while skipping orphaned filesystem candidates, reject reserved-JID collisions with standard sessions, and filter standard list/trash queries by `kind='standard'`.

**Step 4 — Verify GREEN:** Run the focused test and existing DB/session-title tests.

---

### Task 2: Expose an idempotent Life API and enforce defaults

**Files:**

- Modify: `src/web/server.ts`
- Test: `test/life-session-api.test.ts`

**Step 1 — RED:** Add a route-level contract test proving `POST /api/life-session` exists before the ordinary session matcher, returns `kind: 'life'`, creates the singleton in a unique empty folder without enqueueing an asynchronous `pi new`, blocks rename/delete/clear/model/thinking/cwd management for Life, and permits an explicit `pi new` to start a fresh internal Pi context.

**Step 2 — Verify RED:**

```bash
npm test -- --run test/life-session-api.test.ts
```

Expected: FAIL because the endpoint is missing.

**Step 3 — GREEN:** Call `getOrCreateLifeChannel()`, rely on its unique empty folder for a race-free first context, serialize the Life channel, and reject management mutations with HTTP 409. Leave messages/events/search/stream and the deliberate `pi new` context rotation available.

**Step 4 — Verify GREEN:** Run focused API and DB tests.

---

### Task 3: Add the right-edge Life gesture and simplified mode

**Files:**

- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/app.css`
- Modify: `test/session-ui.test.ts`
- Create: `test/e2e/life-mode.spec.ts`

**Step 1 — RED:** Add source/UI tests and Playwright mobile tests that start within 56 px of the right edge, prove a slow shallow drag cancels, prove a shorter fast flick commits through projected velocity, prove tapping the edge leaf auto-settles the panel, observe the preview continue moving after release, and land in Life mode after one `POST /api/life-session`. Assert a vertical edge gesture does nothing and the Life header pencil can issue `pi new` to `web:life`.

**Step 2 — Verify RED:**

```bash
npm test -- --run test/session-ui.test.ts
npx playwright test test/e2e/life-mode.spec.ts
```

Expected: FAIL because Life chrome/gesture/API call are absent.

**Step 3 — GREEN:** Add a 44×64 px accessible right-edge leaf button and full-height swipe preview that follows the finger; tapping the leaf auto-settles through the same transition. Axis-lock after 8 px; claim only horizontal motion; commit after 22% or a velocity-projected short flick, require the release direction to remain leftward, then animate the remaining travel with a release-speed-scaled ease. During post-release settlement, make the underlying main/drawer inert, block competing drawer gestures, and expose Cancel; cancellation or any newer navigation invalidates preview ownership even if Life API/history remains delayed. Fade only after Life is ready. On entry, remember `piweb.mode=life`, open the singleton Life channel, and render `Sessions / Life / DEFAULT` chrome while hiding drawer, rename/delete/clear, model, thinking, status, and usage controls. Keep a dedicated New pi session pencil immediately before ⋯ and a Life-safe overflow containing Search and Media, plus the composer and attachment integrations. Add a `Sessions` back action and remember the last standard session. If no standard target exists on return or failed entry, invalidate selection/search generations, close SSE, clear Life transcript/partial/busy state and active JID, and render the empty standard shell.

**Step 4 — Verify GREEN:** Assert default badge, hidden management rows, a working New-pi-session header pencil plus Search/Media overflow actions, slow-drag cancellation, short-flick inertia, persistent reload entry, back navigation with and without standard sessions, failed-history rollback with no standard sessions, no horizontal overflow, visual viewport containment, pointer reachability, and message POST isolation from the Life JID after empty fallback.

---

### Task 3A: Bound ephemeral runtime-probe teardown

**Files:**

- Modify: `src/agent/channel-settings.ts`
- Test: `test/life-default-settings.test.ts`

**RED:** Run a SIGTERM-resistant fake `PI_BIN`, abort with short test-only timeout
and grace options, and prove the probe promise currently rejects while its child
is still alive.

**GREEN:** Record the probe outcome, send SIGTERM, escalate to SIGKILL after the
bounded grace, and resolve/reject only from the child's close path. Verify the
fake received SIGTERM and no process remains alive when the promise completes.

---

### Task 4: Documentation, regression, visual evidence, and deployment

**Files:**

- Modify: `CLAUDE.md`
- Modify: `README.piweb.md`
- Evidence: `artifacts/playwright/test-results/`

**Steps:**

1. Document Life's singleton/default-model invariant and right-edge gesture.
2. Run unit tests, Life E2E, lint, TypeScript, formatting, build, and `git diff --check`.
3. Inspect 390×844 screenshots for idle edge affordance, partial swipe, Life mode, composer use, reload persistence, and return to Sessions.
4. Build/deploy the complete current Piweb tree only after confirming no concurrent uncommitted feature was dropped; use `docker compose build app && docker compose up -d`.
5. Verify public HTTP 200 and inspect the live mobile UI.
