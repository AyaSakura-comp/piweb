# AGY command manager

**Status:** implemented in the working tree; fixture and isolated real-stack
walkthroughs passed. Not deployed by this change. See
[verification status and remaining work](agy-observability-status.md).

Open **⋯ → 背景命令 · AGY**. The viewer reuses the Subagents header, theme and internally scrolling body in an edge-to-edge full-screen layout (no floating-sheet margins or rounded outer frame). This is an evidence viewer, not a shell or task-control API.

The worker assigns a unique turn/step identity to each observed `run_command`.
Updates are persisted through the existing fenced web event transport. The authenticated
`commands-running` session endpoint projects the latest known state from the most recent
1000 session events (the UI warns when this history window is full). Life reads require
the selected generation. Polling stops and outstanding responses are discarded when the
viewer closes or its session changes.

States:

- Running: observed ACTIVE, or an explicit background-task acknowledgement. Spinner shown.
- Returned: output arrived, but AGY supplied no explicit exit code. This is NOT success.
- Succeeded / failed: a status tool or verified transcript envelope supplied an explicit exit code.
- Cancelled: `manage_task` reported CANCELED; partial output remains available.
- Unknown: the CLI exited without completion, or a previously Running record
  belongs to an idle session or has received no update for more than 120 seconds.
  Staleness is loss of evidence, not proof that the process stopped.

Agent progress is separate: no completion output observed; output returned through a tool;
or a subsequent tool/assistant event was observed. The last state proves later activity,
not that the model correctly understood the output or that it was caused by this command.

## Important limitation

The bridge now uses stream-json input as well as output to keep the CLI available
for background results. If a result leaves explicitly disclosed tasks unfinished,
it can submit up to two status-reconciliation messages to that same CLI, without
replaying the original command. Input is closed after reconciliation; shutdown,
missing metadata or exhausted recovery still becomes Unknown. An already cancelled
process is not resurrected. Historical commands are not reconstructed from prose.

A real 15-second command, parent continuation and reload persistence were verified
in the isolated stack. This is not an unlimited background scheduler or a guarantee
that every AGY task survives process/server failure.

## Data flow and implementation

```text
AGY stream-json
  → src/agent/agy-commands.ts (unique turn UUID + step index)
  → src/agent/agy.ts (agy_command_update)
  → src/transport/web.ts (generation-fenced web_events)
  → GET /api/sessions/:jid/commands-running
  → public/commands-running.js + commands-running.css
```

The endpoint returns `{ commands, limited }`. Each command carries `id`,
`command`, `state`, `agent`, `output`, `startedAt` and `updatedAt`; `taskId`,
`exitCode` and `nextAction` are optional. Timestamps are epoch milliseconds.
States are `running`, `returned`, `succeeded`, `failed`, `cancelled`, `unknown`; agent states
are `not-observed`, `output-received`, `continued`. `command_status` output must
match the recorded task ID before it updates that command.

The open viewer polls once per second. Output expansion and scroll position
survive refreshes. The spinner respects reduced motion. Closing the viewer or
changing session invalidates pending responses and stops scheduled polling.
Commands are capped at 4000 characters and output retains its last 12000
characters; this is not an unlimited log archive. Rendering uses text nodes,
not command execution or HTML injection. There is no stop/retry/resume button.

## Verification

- Unit: `npx vitest run test/agy-commands.test.ts`
- Fixture UI: `PIWEB_E2E_PORT=4191 npx playwright test test/e2e/agy-commands.spec.ts`
- Real isolated end-to-end: `PIWEB_E2E_PORT=4191 PIWEB_AGY_COMMANDS_LIVE=1 npx playwright test test/e2e/agy-commands-live.spec.ts`

The opt-in live spec starts the actual PiWeb server and queue on loopback with a disposable
database, generated authentication token and real AGY inference. It sends via the composer,
observes the spinner and command output, then returns to main chat to verify subsequent
file reading and final response. It does not mock API responses, restart production, or
prove detached-process completion after CLI shutdown. Trace recording is disabled to avoid
capturing authentication. Video and screenshots are under ignored `artifacts/`.
