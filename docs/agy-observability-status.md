# AGY observability status

Updated 2026-09-22 (Asia/Taipei). Source and tests are described here; deployment
must be checked separately from compilation or a successful local recording.

## Implemented

- Explicit AGY child transcript snapshots in **Subagents**, labelled separately
  from native Pi children.
- **背景命令 · AGY**: edge-to-edge Subagents-themed viewer, running spinner,
  output, cancellation/failure evidence and separately observed parent activity.
- Stream JSON **input and output** keep one CLI process available for background
  results. When a result leaves explicitly identified tasks unfinished, at most
  two reconciliation inputs query those existing tasks. The bridge never
  replays the original command; reconciliation prompts prohibit relaunching it.
- Task identifiers are recovered from a bounded, descriptor-validated local
  transcript for the disclosed conversation. No arbitrary log path is accepted.
- Child watchers no longer infer completion from text-only acknowledgements.
  They stop on abort, ownership loss, missing/replaced channel directory, timeout
  or parent turn exit. A final snapshot is attempted while the queue still owns
  the turn; watchers retire before the lease is released.
- The web command endpoint uses the session's fenced event history. Reloads
  preserve command evidence; missing/stale evidence is Unknown, not success.

Implementation: [bridge](agy-bridge.md), [Subagents](subagents.md),
[command manager](agy-command-manager.md).

## Verification

Latest full working-tree Vitest run: **550 passed, 1 skipped**. The skip is not
counted as verification. TypeScript passed. Full repository browser coverage is
not implied by these checks.

Tests include:
- `agy-subagents.test.ts`: acknowledgement followed by delayed final output,
  abort, owner invalidation, deleted/replaced directories and projection.
- `agy-commands.test.ts`: concurrent task isolation, nonzero exit, cancellation,
  explicit task correlation, unknown-on-exit and spoof-like stdout handling.
- `agy-stream-input.test.ts`: protocol test with an executable fake CLI proving
  same-process reconciliation, no original-command replay, and pre-aborted turns.
- `agy-task-transcript.test.ts`: bounded transcript parsing, invalid IDs and links.
- `subagents-api.test.ts`: authenticated command reads, session isolation and
  Life generation requirements, in addition to child API coverage.
- `agy-commands.spec.ts`: fixture UI state transitions and 390×844 full-screen geometry.
- `agy-commands-live.spec.ts`: real isolated PiWeb HTTP server, queue, transport
  and AGY inference. Long mode executes one 15-second command, observes output,
  then parent file reading and main-chat reply; reloads and verifies persisted
  history. It asserts exactly one original `run_command` execution.

```sh
npm test
npx tsc --noEmit
PIWEB_E2E_PORT=4191 npx playwright test test/e2e/agy-commands.spec.ts
PIWEB_E2E_PORT=4191 PIWEB_AGY_COMMANDS_LIVE=1 PIWEB_AGY_LONG_TEST=1 \
  npx playwright test test/e2e/agy-commands-live.spec.ts
```

Real inference requires host AGY authentication. The live test generates a
separate web login token and temporary DB, disables network tracing, and does
not restart production. The long run passed in approximately 43 seconds.

Ignored local evidence: `artifacts/agy-command-completion/workflow.mp4`,
`contact.jpg`, and `01-real-running.png` through `04-reconnected.png`.
Screenshots and sampled video frames were inspected; this is not an assertion
that every video frame was reviewed. These artifacts are not committed.

## Boundaries

- Already cancelled old processes are not resurrected or automatically rerun.
  A real recovery probe reported CANCELED and only partial output; cancellation
  is now distinct from success.
- Recovery is bounded, not an always-on external job scheduler. Worker shutdown,
  lost task metadata or exhausted reconciliation can still yield Unknown.
- Observing a later AGY action does not prove semantic comprehension of output.
- Child transcript persistence remains read-only and is not a native Pi runner.
- Long-command continuation was tested live. Parallel/failure/cancellation and
  lifecycle scenarios have deterministic regression coverage; they were not all
  independently exercised with real cloud inference.
- Original commands before event tracking are not automatically reconstructed.

## Release discipline

The working tree contains unrelated changes. Only the AGY feature, its tests,
UI and documentation should enter this commit. Deployment requires both the web
assets/API and host worker; a frontend-only rebuild is insufficient. The worker
owning the current agent session cannot be restarted synchronously without
interrupting that session. Report any outstanding release actions explicitly.
