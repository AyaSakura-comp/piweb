# Claude Code tmux Bridge Implementation Plan

> **For Hermes:** Implement task-by-task with strict RED/GREEN TDD and keep the bridge feature-gated.

**Goal:** Add an opt-in `claude-code/*` provider that drives one persistent, fully autonomous Claude Code TUI in tmux per Piweb session while preserving every existing Pi/Agy/web path.

**Architecture:** The host worker alone owns tmux. A new adapter launches or reattaches an interactive Claude Code process with `bypassPermissions`, sends prompts through tmux buffers, and tails Claude's per-session JSONL transcript for structured thinking/tool/final events. The existing queue, transport, SQLite transcript, SSE, attachments, and UI remain unchanged except for a Claude provider badge and model choices.

**Tech Stack:** Node.js/TypeScript, tmux 3.5+, Claude Code CLI, Vitest, Playwright mobile Chromium, ffmpeg/ffprobe.

---

### Task 1: Define the bridge contract with failing unit tests

**Files:**

- Create: `test/claude-tmux.test.ts`
- Create: `src/agent/claude-tmux.ts`

1. Test synthetic `claude-code/haiku|sonnet|opus` model refs and model-id parsing.
2. Test stable safe tmux names derived from channel folders.
3. Test Claude launch arguments: interactive mode, session-id/resume, model, `bypassPermissions`, `AskUserQuestion` disabled, autonomous system prompt, no `-p` and no `--bare`.
4. Test transcript translation for thinking, tool calls, tool results, final text, and turn completion.
5. Run the focused test and observe failure because the module is absent.
6. Implement only the pure helpers needed to pass.

### Task 2: Implement persistent tmux invocation under tests

**Files:**

- Modify: `src/agent/claude-tmux.ts`
- Modify: `src/config.ts`
- Modify: `.env.piweb.example`
- Test: `test/claude-tmux.test.ts`, `test/config.test.ts`

1. Add failing tests for state persistence, new-vs-resume launch, workspace-trust acceptance, prompt delivery through a tmux buffer, transcript-offset correlation, AbortSignal → Ctrl-C, and dead-pane/timeout errors using injected process/filesystem collaborators.
2. Add feature-gated config: enabled, Claude binary, tmux binary, turn/startup/poll timeouts.
3. Implement one tmux session per Piweb channel; persist Claude session id/transcript path in the channel session directory.
4. Never scrape normal answer text from the pane; use capture only for readiness/trust/error diagnostics.
5. Convert local markdown files to Piweb outbox markers and process uploads as absolute paths.
6. Run focused tests and typecheck.

### Task 3: Route models without changing Pi/Agy behavior

**Files:**

- Modify: `src/agent/model-catalog.ts`
- Modify: `src/agent/queue.ts`
- Create: `test/queue-claude-routing.test.ts`

1. Write failing routing tests proving `claude-code/*` calls only the new adapter, including when Pi RPC steering is enabled.
2. Prove `agy/*` and ordinary Pi models remain on their existing branches.
3. Merge synthetic Claude models only when the feature flag is enabled.
4. Pass channel, model, thinking, cwd, signal, attachments, and event streamer to the adapter.
5. Run routing tests and all queue tests.

### Task 4: Close tmux sessions on reset and shutdown-safe interruption

**Files:**

- Modify: `src/commands/index.ts`
- Modify: `src/agent/queue.ts` only if required by tests
- Test: `test/pi-new-rpc.test.ts` or a new focused lifecycle test

1. Write a failing test that `/pi new` closes the matching Claude tmux session before rotating its state directory.
2. Implement idempotent close and call it from reset.
3. Verify a new turn after reset creates a fresh Claude session rather than reusing the archived one.

### Task 5: Add Claude badges and a deterministic mobile workflow

**Files:**

- Modify: `src/session/model-info.ts`
- Modify: `public/app.js`
- Modify: `public/app.css`
- Modify: `test/provider-badge.test.ts`
- Modify: `test/e2e/fixture-server.mjs`
- Create: `test/e2e/claude-tmux.spec.ts`

1. Write failing badge and Playwright contracts expecting `CLAUDE` in the header/session/model picker with a distinct violet/rose treatment in dark and light themes.
2. Add only the mirrored server/client badge mapping and CSS.
3. Build a deterministic API/SSE fixture using the production shell: select Claude Haiku, send a coding task, show thinking/tool/result/final output, Stop reachability, and session drawer state.
4. Assert 390×844 containment, document overflow, 44px critical controls, pointer hit tests, no page/console errors, and correlated post-click state.
5. Capture ordered PNG milestones and a single continuous video.

### Task 6: Documentation, live smoke, full gates, and evidence

**Files:**

- Modify: `README.piweb.md`
- Modify: `CLAUDE.md`
- Create under ignored artifacts: `artifacts/claude-tmux-video/{screenshots,videos,logs,metrics.json,report.md}`

1. Document install/config, autonomous host-access warning, separate agent memory, reset/stop behavior, and exact E2E command.
2. Run one opt-in live Haiku smoke in a disposable channel/directory to prove tmux launch, trust acceptance, transcript extraction, and Ctrl-C cleanup without touching production config.
3. Run unit tests, E2E focused test, full E2E, lint, typecheck, build, and `git diff --check`.
4. Convert the native WebM to one H.264/yuv420p MP4 and validate with ffprobe.
5. Build a contact sheet, inspect every PNG and the MP4 directly, and record findings.
6. Run independent code review and fix blocking findings before final verification.
7. Commit only Claude bridge changes; do not stage the pre-existing unrelated working-tree edits.
