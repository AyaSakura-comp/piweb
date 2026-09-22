# Claude Subagents bridge implementation plan

**Goal:** Extend the existing read-only Pi/AGY Subagents viewer to Claude Code model sessions, preserving generation isolation, streaming child history and parent continuation.

**Architecture:** Worker-only projection reads only `<parent-transcript-dir>/<parent-UUID>/subagents/agent-<id>.jsonl`, validates identity and safe filesystem descriptors, and writes atomic Pi-shaped snapshots under the channel's `.claude-subagents/`. Docker reads these snapshots through the existing protected API. A short-lived activity manifest drives running indicators; it is not proof of child exit. Claude pending-background counts and task notifications prevent premature parent completion.

**Scope:** No change to AGY behavior, no API to send arbitrary child commands, no global Claude transcript crawl, no production service restart. Implementation is direct, not delegated. Live validation spawns only bounded fixture children to exercise the requested feature.

## Verification status

Implemented and verified. The 2026-09-22 working-tree validation passed 565 unit
tests (1 opt-in skipped) and 120 E2E tests (14 opt-in skipped), plus lint/build.
Isolated real Opus parent + two Haiku children passes, including automatic
parent continuation and reloaded child history. A follow-up all-Opus run on
2026-09-23 also passes: the parent and both children record `claude-opus-5-5`.
The live harness checks actual model identifiers and accepts
`PIWEB_CLAUDE_CHILD_MODEL=haiku|sonnet|opus` (default Haiku).
The scoped commit was additionally validated from a clean export on 2026-09-23:
559 unit tests passed (1 opt-in skipped), 120 E2E passed (13 opt-in skipped),
with repository lint/build passing. Unrelated uncommitted tests/UI changes
were excluded from that export.

Continuous video and exact limitations are in the ignored local evidence
bundles `artifacts/claude-subagents/` and
`artifacts/claude-subagents-opus-20260923/`. These are isolated integration
results, not proof of deployment. Committing/pushing this feature does not
restart the worker or update the Docker web tier; deploy separately.

## 1. Reproduce / capture schema

- Inspect `src/agent/agy-subagents.ts`, `src/session/subagents.ts`, `public/subagents.js` and current adapter/tests.
- Probe an isolated Claude parent with one requested fixture child; inspect only owned logs.
- Observed CLI 2.1.278: `toolUseResult.agentId/isAsync/status`, child `isSidechain/agentId/sessionId`, parent `turn_duration.pendingBackgroundAgentCount`, origin `task-notification` with task id/status.

## 2. Worker projection (RED → GREEN)

- Create `src/agent/claude-subagents.ts`, `test/claude-subagents.test.ts`.
- Test parent-specific discovery, user/thinking/tool/results/final mapping, partial lines and UTF-8, actual child models, ignored attachments/system prompt snapshots, multiple children, resume/status notifications.
- Reject symlink/hardlink/oversized sources, foreign parent/agent identities, malicious paths, expired ownership and replaced generation directories.
- Derive paths from validated identities; never follow `outputFile` supplied in transcript content.

## 3. Adapter lifecycle (RED → GREEN)

- Modify `src/agent/claude-tmux.ts`, `src/agent/queue.ts`, adapter/routing tests.
- Instantiate scoped tracker, refresh snapshots within the owned turn, feed observed parent records, bootstrap on recovery, expire running metadata in finally.
- Do not finish on an acknowledgement while background children remain. Wait for the subsequent parent final turn; keep Stop/timeout applicable.

## 4. API and UI (RED → GREEN)

- Extend `src/session/subagents.ts` and `test/subagents.test.ts` for source `claude-code`, current Claude parent identity, safe snapshot reads, short-lived activity and stale scopes.
- Update `public/subagents.js` source labels and read-only explanatory text; retain existing layout/routes and opaque child ids.
- Add deterministic mobile E2E coverage using real projection files and production UI.

## 5. Live / regression verification

- Add opt-in `test/e2e/claude-subagents-live.spec.ts`: isolated real web + worker + Claude parent/fixture children, visible child list/history/final output and automatic parent continuation; continuous 390×844 video.
- Run focused and full unit/E2E suites, lint, typecheck/build and diff checks.
- Inspect screenshot/video samples, document exact coverage and limitations, preserve unrelated working-tree edits. No deployment without a separate instruction.
