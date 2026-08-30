# Recently Deleted Bulk Delete Implementation Plan

> **For Hermes:** Implement this plan task-by-task with strict RED–GREEN–REFACTOR cycles.

**Goal:** Let users permanently delete every recently deleted session or select several sessions for one confirmed permanent deletion, entering selection mode either from a button or by long-pressing a row.

**Architecture:** Add one authenticated batch-purge endpoint that accepts only the exact deleted-session JIDs the user reviewed. Claim the complete idle/deleted set atomically in a durable SQLite journal, fence restore/worker/request/scheduler/RPC writes, propagate archive-discovery errors, and atomically detach owner roots into symlink/hard-link-safe batch-unique tombstones. Persist each directory source's `dev:ino` before rename, revalidate that exact identity after rename, quarantine unknown payloads, and replace cleaned endpoints with path-specific journal-token seals created via `O_EXCL|O_NOFOLLOW`; competing runners verify seals read-only, clean stale-upload endpoints with child removal plus type-safe `rmdir`, and never unlink a concurrently published regular guard. Reserve the root-level `.piweb-purge` tombstone namespace, reject segment-aware nested, archive-prefixed, or sanitized-media aliases belonging to another channel, and serialize channel registration/Life ownership changes with pending claims so no alias can appear after the ownership snapshot. Await every child/path/target operation, fsync both sides of every rename plus seals and cleaned directories before committing all DB ownership; startup and hourly recovery retry pending intents while durable completion receipts make concurrent recovery authoritative. Stage standard uploads in immutable random channel-generation and operation-unique namespaces, then leave durable guards at purged operation-owner roots so expired requests cannot recreate data while exact owner reuse gets a new namespace. Lease standard RPC processes until confirmed exit, bind every request/worker/transport fence to folder, immutable storage token, and monotonic delete/restore ownership epoch, recheck control ownership after RPC retirement, and retire Life RPC after each turn before response delivery. Keep tokenized transient selection state in `public/app.js`; render accessible checkboxes and a bottom action bar inside a native responsive phone/desktop dialog, and reuse the scroll-safe touch/mouse `bindLongPress` gesture helper.

**Tech Stack:** Node HTTP server, SQLite/better-sqlite3, vanilla JavaScript/CSS, Vitest, Playwright Chromium at phone and desktop viewports.

---

### Task 1: Define the batch-purge API contract

**Objective:** Prove selected and all-session purges only destroy sessions that are currently in Recently deleted.

**Files:**

- Create: `test/trash-session-api.test.ts`
- Modify: `src/web/server.ts`

**Step 1: Write failing integration tests**

Create deleted and live standard channels, call `POST /api/sessions/deleted/purge` with exact aligned `{ jids, storageTokens, deletionTokens, deletedAts }` selections, and assert selected/all-visible deleted rows and owned files disappear while live sessions remain. Add malformed/live/active-target, filesystem-failure/recovery, and owned-row assertions proving validation and durable claiming happen before irreversible mutation.

**Step 2: Verify RED**

Run: `npx vitest run test/trash-session-api.test.ts`

Expected: FAIL because `/api/sessions/deleted/purge` returns 404.

**Step 3: Implement the endpoint**

Before the generic `/:jid` matcher, accept exactly one body shape:

```ts
{
  jids: ['web:deleted-a', 'web:deleted-b'],
  storageTokens: ['opaque-generation-a', 'opaque-generation-b'],
  deletionTokens: ['opaque-deletion-a', 'opaque-deletion-b'],
  deletedAts: ['2026-08-29 10:00:00', '2026-08-29 11:00:00']
}
```

Reject unknown keys, malformed/duplicate identities, live/missing owners, quarantine, active queues/controls, HTTP/worker leases, and warm RPC ownership before mutation. Acquire message/command generation leases before reading request bodies so a slow sender cannot cross owner replacement. Atomically journal the complete batch; triggers fence owner writes while ownership validation rejects cross-channel path aliases and idempotent cleanup lstat-checks managed paths, safely unlinks top-level non-directories, persists and verifies directory inode identities across detach, authenticates immutable terminal seals and stale-upload source guards, awaits all child/path/target operations, and fsyncs namespace changes. Return success only after every target's session/media/upload files are durably gone and every channel-owned table plus `channels` commits in one transaction; otherwise return a recoverable pending error.

**Step 4: Verify GREEN**

Run: `npx vitest run test/trash-session-api.test.ts`

Expected: PASS.

### Task 2: Define the mobile selection workflow

**Objective:** Prove button entry, long-press entry, multi-selection, selected deletion, and delete-all through real phone-sized pointer interactions.

**Files:**

- Modify: `test/e2e/life-mode.spec.ts`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/app.css`

**Step 1: Write failing UI/E2E tests**

Extend the deterministic API fixture with the batch endpoint. Add one 390×844 workflow that opens Recently deleted, long-presses a row, selects another row, confirms Delete selected, enters selection mode from the Select button, exits with Cancel, confirms Delete all, and captures milestones. Add a 1280×800 workflow for mouse long-press and the centered dialog. Assert the badge, selected count, checkbox state, pointer reachability, responsive containment, and empty state after deletion.

**Step 2: Verify RED**

Run the focused Vitest/source contract and Playwright test. Expected: FAIL because the new controls and batch calls do not exist.

**Step 3: Implement minimal production UI**

Add:

```html
<button id="btn-trash-select">Select</button>
<button id="btn-trash-delete-all">Delete all</button>
<div id="trash-selection-tools">
  <button id="btn-trash-select-all">Select all</button>
  <span id="trash-selected-count" aria-live="polite">0 selected</span>
  <button id="btn-trash-delete-selected">Delete selected</button>
</div>
```

Maintain a set of selected JIDs, render one labelled checkbox per list item, enter selection mode from Select or `bindLongPress`, toggle rows on normal clicks while selecting, confirm once per batch, disable destructive controls during requests, and apply the committed exact target set before best-effort reconciliation. Delete all submits the exact currently rendered JIDs with aligned immutable channel/deletion tokens and timestamps, never a wildcard. Use `dialog.showModal()` for native focus/background isolation and stacked-modal ownership, restore focus on close, and generation-token every trash GET so an older response cannot resurrect deleted rows. If the active read-only preview is purged, fall back to a live standard session instead of leaving a dead preview selected.

**Step 4: Verify GREEN**

Run focused Vitest and Playwright. Expected: PASS with no page or console errors.

### Task 3: Document, visually inspect, and verify

**Objective:** Make the behavior maintainable and prove the rendered workflow.

**Files:**

- Modify: `README.piweb.md`
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

**Step 1: Update documentation**

Document the batch endpoint, Select/Cancel behavior, long-press gesture, Delete selected/Delete all confirmation, and the maintained Playwright command/evidence location.

**Step 2: Run all gates**

Run:

```bash
npm test
npm run test:e2e
npm run lint
./node_modules/.bin/tsc --noEmit
npm run build
git diff --check
```

**Step 3: Inspect visual evidence**

Transcode the focused workflow WebM to H.264 MP4, build a contact sheet from ordered milestone PNGs, inspect every image and the video directly, and record viewport/overflow/hit-test/error results in an artifact report.

**Step 4: Independent review**

Run the staged-diff review. Resolve all security or logic findings and rerun affected gates before committing or pushing.
