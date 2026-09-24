# Cross-harness conversation context implementation plan

**Goal:** On the first message after switching between Pi, AGY and Claude Code, transfer the channel's existing user/assistant dialogue to the destination without copying or overwriting native session databases; Pi-to-Pi model switches must not transfer anything.

**Architecture:** PiWeb's host-worker reads its own `web_events` under the channel's ownership fence. A per-channel/per-harness cursor records the last dialogue row consumed by each destination. A cross-harness turn receives a provenance-labelled, bounded excerpt plus an owner-private snapshot file of the selected dialogue. Target native histories remain untouched. Never insert tool output, credentials, thinking, or local attachment bytes into this bridge. The transition is committed only after a successful delivered turn. Existing sessions without cursor state are bootstrapped conservatively.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, PiWeb worker.

---

### Task 1: Classifier and excerpt (TDD)

**Files:** `src/agent/harness-handoff.ts`, `test/harness-handoff.test.ts`.

1. Write tests asserting `openai-codex/*` and `local-llama/*` are both `pi`; `agy/*` is `agy`; `claude-code/*` is `claude`. Assert only cross-harness destinations receive a handoff and only user/assistant message rows are serialized.
2. Run `npx vitest run test/harness-handoff.test.ts` and observe RED.
3. Implement the classifier and bounded JSON-quoted excerpt (record row ids and omission count). Never turn source text into system instructions.
4. Run the test again and observe GREEN.

### Task 2: Durable cursors (TDD)

**Files:** `src/db.ts`, `test/harness-handoff-db.test.ts`.

1. Test owner generation isolation, target-specific cursors, and read-only history selection up to a fixed row-id boundary.
2. Run RED; add a minimal `harness_context` table and fenced update transaction; run GREEN.
3. Verify reset/delete cannot reuse the old generation's cursors.

### Task 3: Worker integration (TDD)

**Files:** `src/agent/queue.ts`, `test/queue-harness-handoff.test.ts`.

1. Test Pi→Pi (no transfer), Pi→AGY→Claude→Pi (each target gets only unseen dialogue), and failed/aborted turns (cursor not committed).
2. Run RED; construct the handoff after effective model resolution and before the selected harness receives the prompt. Commit only after response delivery, under the existing ownership fence.
3. Run GREEN; run `npx tsc --noEmit` and full `npx vitest run`.

### Task 4: Documentation and deployment verification

**Files:** `docs/cross-harness-context.md`.

Document what is and is not transferred, snapshot limits, existing sessions, native DB non-mutation, replay limitations and safe worker activation. Verify by switching a disposable channel across all three harnesses; never claim a real production run based on a fixture.
