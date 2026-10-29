# Claude Code tmux bridge

Opt-in worker adapter for `claude-code/haiku`, `claude-code/sonnet`,
`claude-code/opus` and `claude-code/fable`. It drives an interactive Claude Code TUI in a persistent tmux
session. The web container still never launches an agent; queue, uploads, SQLite
web events and SSE use the existing transport.

## Setup and trust boundary

Install tmux and Claude Code on the **worker host**, then log in to Claude Code
interactively as the worker user. Verify `tmux -V` and `claude --version`.
Use absolute binary paths when systemd's PATH does not include the installation.
Set these in the worker's `config.env`:

```dotenv
CLAUDE_TMUX_ENABLED=true
CLAUDE_TMUX_BIN=/absolute/path/to/claude
CLAUDE_TMUX_TMUX_BIN=/usr/bin/tmux
CLAUDE_TMUX_POLL_MS=150
CLAUDE_TMUX_STARTUP_TIMEOUT_MS=30000
CLAUDE_TMUX_TURN_TIMEOUT_MS=3600000
```

Default is **disabled**. A disabled worker explicitly rejects stale Claude model
selections instead of silently falling back to Pi. Enable/restart only using the
normal reviewed, idle-worker deployment process. No production configuration is
changed by the tests below.

**Host-access warning:** this launches `--permission-mode bypassPermissions`,
automatically accepts workspace trust, disables `AskUserQuestion`, and requests
autonomous execution. Anyone able to submit a Piweb prompt can run commands with
the worker user's host privileges. This is not a sandbox. Keep authentication and
CSRF protections enabled. Missing credentials/startup dialogs require manual host
setup; the bridge does not type secrets or accept arbitrary prompts.

Piweb launches and resumes Claude with
`--settings '{"remoteControlAtStartup":false}'` and `--no-chrome`.
Remote Control is **off by default for this bridge**, independently of inherited
user/project startup preferences; other Claude settings still load normally.
This is a per-launch override, not a global settings edit. It does not stop
existing sessions, remove old remote-session records, or change a separate
Discord Claude launcher's explicit `--remote-control`. An already-loaded worker
needs its next approved safe restart to pick up a changed launch policy.

## Lifecycle and data

- Each channel gets a stable hashed tmux name and a `claude-tmux-session.json`
  pointer under its Piweb session directory. Claude owns the actual transcript
  under `~/.claude/projects/`; back it up separately if required.
- Switching between Pi, AGY and Claude does **not migrate native agent memory**.
  On the next cross-harness turn PiWeb supplies bounded, quoted visible
  user/assistant dialogue as context; tools, permissions and native transcripts
  remain separate. See [cross-harness continuity](cross-harness-context.md).
  Claude model/effort/cwd changes restart the TUI with the same Claude
  conversation id.
- Input uses a tmux buffer with bracketed paste for multiline safety, preceded by
  a literal typed request. Claude Code 2.1.278 wraps bracketed pastes in
  `pasted_content`; without that external request, it can treat the whole task
  as quoted data and ask what to do instead of executing it. Before Enter, the
  bridge waits for the editable request text or a new numbered paste marker.
  Marker whitespace is canonicalized to support terminal-wrapped forms such as
  `[Pasted\n  text #1 +6 lines]`; reflow of an existing marker in the editable
  prompt or pane history does not acknowledge a new paste. This does not change
  the startup deadline, pane size, or retry policy.
- Output comes exclusively from complete JSONL records, not scraped screen text.
  Thinking, tool calls and results become streamed Pi-shaped events; text in a
  record that ends in `tool_use` becomes `narration_end` (plain text in the UI,
  not a thinking card). A
  `turn_duration` closes the parent turn only after pending child agents and
  tracked background Bash/Monitor commands have finished. Partial UTF-8 writes
  are retained as bytes.
- Uploads are staged through Piweb and provided as absolute paths. Local markdown
  media links are converted to outbox markers before delivery.
- `CLAUDE_TMUX_TURN_TIMEOUT_MS` is an **inactivity** budget (default one hour),
  not a wall-clock limit for the entire turn. New structured thinking/text/tool
  events, tool results (including empty results), completion records, and changed
  tracked background-command output renew the budget. A long benchmark with
  continuing progress can exceed one hour without being interrupted. Unrecognized
  records, invalid JSON, unchanged output and pane spinner/timer repainting do not
  renew it. Pending transcript/output is read before checking the idle deadline.
  A genuine idle timeout still sends Escape/Ctrl-C and reports the idle duration;
  it does not retry or resubmit the prompt. Silent work exceeding the inactivity
  budget can still time out while Claude is mid-turn; merely retaining a
  running-task flag is not progress. Once Claude has **replied** and only its
  background commands hold the turn open, a command whose processes still run
  renews the budget (see "Replied, still waiting" below).
- Stop sends Ctrl-C, including for a running turn recovered after worker restart.
  The tmux session/context remains available for the next message. A dead pane
  fails promptly instead of waiting for the inactivity timeout. As with other
  bridge code changes, an already-running worker needs an approved safe restart
  to load the new timeout behavior; compiling it does not hot-patch active turns.
- Bypass mode still asks about some commands ("This shell -c script runs rm and
  could not be checked", "Dangerous rm operation on working directory…"),
  background subagents' included. While a turn is open the bridge answers them:
  a catastrophic one (`isCatastrophicPrompt`: rm of `/`, `~`, `$HOME`, `/home`, `/root`,
  the workspace or an ancestor, mkfs, dd onto a device) gets Escape and stops
  the turn naming the operation; anything else is approved. One still up when
  the next message arrives is cancelled with Escape. A dialog is "Do you want to
  proceed?" above a footer starting "Esc to cancel", which gains more "· hint"
  items as they apply and may wrap in the 80-column pane. On 2026-10-28 the
  "· ctrl+x ctrl+k twice to stop background agents" hint hid one from the
  matcher, and Torch NPU's subagent waited on it for ten hours.
- `/pi new` closes the matching Claude session **after** ownership/idle checks,
  before rotating the pointer directory. Next use gets a new Claude UUID.
  Archived Claude transcripts are not deleted by resetting Piweb.
- Deleting (trashing) or purging a Piweb session closes its Claude TUI within
  a minute: the worker reconciles `piweb-cc-*` tmux sessions against SQLite
  (`src/agent/claude-tmux-reaper.ts`), because the Docker web tier cannot reach
  host tmux. Only the TUI process ends — the Claude transcript and pointer stay,
  so restoring from the trash resumes the same conversation. Ownership is
  proven by a channel row in this DB, then stamped as `@piweb_owner=<DB_PATH>`
  so a purged row is still recognised; sessions of other instances (disposable
  live tests) and non-Piweb tmux sessions are never touched.
- Stable queue row ids and start offsets allow worker recovery to tail a surviving
  turn without resending it. This is not a transactional exactly-once guarantee:
  Claude's external TUI/transcript and SQLite cannot commit atomically.
- `/pi status`, Pi compaction, Pi subagent controls and Pi extension commands are
  not Claude-native controls. Do not interpret their output as Claude usage.

## Background replies and commands

A parent may yield an acknowledgement before background work finishes. The bridge
keeps its queue lease and transcript tail alive while child agents or tracked
commands remain running; Bash/Monitor work is tracked even when Claude omits
`pendingBackgroundAgentCount`.

Each yielded reply is delivered through the ordinary transport (including local
media/outbox conversion), appended to visible history and recorded for cross-harness
continuity. A later distinct final reply is delivered normally. If the turn ends
without another text record, the last yielded text is retained as the result but
the queue does not send that identical already-published reply again. This is
per-turn duplicate suppression, not a crash-safe exactly-once guarantee.

A tracked command ends on its `<task-notification>` (completed, failed, stopped), with
one exception: when the model stops its own task with **TaskStop** (KillShell in older
Claude Code builds), Claude Code sends no notification. A successful TaskStop/KillShell
tool result therefore marks the task named by its `task_id`/`shell_id` cancelled, with
the output file's tail as its output (`src/agent/claude-commands.ts`). Without that the
task stayed "running" forever and the turn never completed: replies kept arriving as
background replies while the session spun until stopped by hand (2026-10-24). A failed
stop (`is_error`) leaves the task running.

**Replied, still waiting (2026-10-27).** While Piweb holds a turn open only for
background commands after Claude's reply, the typing line reads **等待背景命令…**
instead of "pi is working…" (`isWaitingOnBackgroundCommands()` in
`public/session-ui.js`: a command row whose latest state is running, and the
reply as the newest row; tool or thinking rows after it read as working again).
**Stop** in that state also ends those commands: it SIGTERMs every process
writing to the command's output file (`stopCommandProcesses()`; Claude Code
starts a background command, and so its children, with stdout/stderr on that
file). Escape/C-c alone reach an idle prompt and stop nothing. The case that
prompted it: a foreground `until` loop hit its 600 s timeout, Claude Code moved
it to the background, the file it polled was later deleted, and the loop could
never end; its error output kept renewing the inactivity budget, so the session
showed "pi is working…" under a finished reply for as long as the TUI lived.

**Long silent waits; only Stop ends them (2026-10-29).** In the LFM session
Claude replied "I'll send the comparison table when it's done" and left
`until grep -q "VLCHAIN DONE" …; do sleep 60; done` watching a benchmark of
several hours. The loop prints nothing, so after one hour the finished reply got
"⚠️ Agent error: Claude Code tmux turn timed out" under it (twice that day), and
the bridge stopped tailing the transcript. Now, at the inactivity deadline of a
replied turn, the bridge asks whether any running tracked command still has a
process writing to its output file (`commandProcessIds()`, the same `/proc` fd
match Stop uses); if so it renews the budget and keeps waiting. If none does and
no `<task-notification>` arrived, the turn ends quietly under the reply already
delivered: no error, no Escape/C-c, and those commands are published as
`unknown` so their rows stop reading as running.

Since a wait can now last hours, ending its commands is reserved for **Stop**:
`stopChannelTask()`/`abortChannelTask()` abort with `STOP_REQUESTED`, and only
that reason SIGTERMs them. A newer message (`interruptChannelTask()`), a worker
restart or a lost lease abort without it, so "how far along is it?" releases the
turn but leaves the benchmark running; Claude Code still delivers its
notification to the conversation.

Use the existing **Stop** control to interrupt work or **⋯ → 背景命令**
to inspect the tracked command view. This change adds no new slash command and
does not turn Pi-only controls into Claude-native controls.

Regression commands:

```bash
npx vitest run test/claude-tmux.test.ts test/queue-claude-routing.test.ts \
  test/claude-commands.test.ts
```

Fake transcript/queue tests cover monitor/background-command continuation,
publication before completion, identical-final suppression and distinct-final
publication. Virtual-clock regressions cover multi-budget thinking/tool activity,
empty tool results, growing background output, completion at the poll boundary,
genuine idle/noise timeouts, a silent background command whose real process
outlives several budgets, and a vanished one ending quietly. Stop vs a newer
message is covered both at the bridge (a real looping process is or is not
SIGTERMed) and at the queue (the abort reason each path passes). They do not consume Claude quota or prove
live-provider timing.

## BTW side questions

**⋯ → BTW** works in a Claude session: each side question goes to Claude Code's
own `/btw` through a headless `claude -p` that resumes this conversation as an
unsaved fork, beside the TUI rather than in it. See
[BTW workspace](btw-workspace.md#claude-code-sessions-claude-codes-own-btw-2026-10-27).

## Subagents

Open **⋯ → Subagents** to browse this Claude session's child transcripts. The
worker projects validated child JSONL into channel-owned snapshots; cards are
labelled `CLAUDE`. Background launch acknowledgements no longer end the parent
turn before its real completion response. See [scope, status semantics and
live tests](subagents.md#claude-code-child-bridge). This does not add child
steering controls or grant Docker access to the host's Claude transcript store.

## Verification

```bash
npx vitest run test/claude-tmux.test.ts test/queue-claude-routing.test.ts \
  test/model-catalog-claude.test.ts test/provider-badge.test.ts \
  test/config.test.ts test/pi-new-rpc.test.ts test/thinking-level-ui.test.ts
npx playwright test test/e2e/claude-tmux.spec.ts
# Explicit opt-in: consumes Claude quota using the host's existing login.
PIWEB_CLAUDE_LIVE=1 npx vitest run test/claude-tmux-live.test.ts
# Real browser → web API → queues → Claude → SSE, recorded continuously:
PIWEB_CLAUDE_E2E_LIVE=1 npx playwright test test/e2e/claude-tmux-live.spec.ts
# Select a real model (haiku default; sonnet/opus/fable use medium effort).
# The test's tmux runs `claude` from PATH unless CLAUDE_TMUX_BIN says where it is:
PATH=$HOME/.local/bin:$PATH CLAUDE_TMUX_BIN=$HOME/.local/bin/claude \
  PIWEB_CLAUDE_E2E_LIVE=1 PIWEB_CLAUDE_E2E_MODEL=fable \
  npx playwright test test/e2e/claude-tmux-live.spec.ts
PIWEB_CLAUDE_E2E_LIVE=1 PIWEB_CLAUDE_E2E_MODEL=opus \
  npx playwright test test/e2e/claude-tmux-live.spec.ts
```

The live test uses disposable config/session/workspace paths (not the production
DB), closes only its own tmux session, and verifies tools, uploaded text, memory
across turns and pane restart, interruption, post-Stop reuse, and fresh context.
Claude may retain its ordinary CLI transcript after temporary test data is removed.

The real-browser live test starts a loopback server plus real message/control
loops with disposable SQLite/config/workspace paths and no API interception.
It verifies a Chinese file through Bash/Read, Stop during a bounded computation,
conversation memory after Stop and pane restart, and persisted UI events after
reload. Credentials are provided to the API before page navigation and are not
shown in video; traces are disabled for this opt-in test. It closes only its own
tmux session/server and removes temporary test state. This is a real integration
test, not a production Docker/Tailscale deployment test.

The deterministic 390×844 production-shell E2E covers dark/light themes, model and effort pickers,
HAIKU/SONNET/OPUS/FABLE badges, streamed tools/final reply, pointer-reachable Send/Stop,
Stop completion, session drawer containment and horizontal overflow. Screenshots
and native video land in `artifacts/playwright/test-results/`; the focused review
bundle is `artifacts/claude-bridge-video-20260922/` (separate `live/` and `fixture/`
continuous recordings, screenshots and sampled timeline sheets). Switching to a
model that does not support the configured effort now shows an explicit
unavailable-setting note instead of claiming that effort is in use. These tests
do not prove deployed container→host connectivity. Real Haiku and Opus have
passed the live workflow; Sonnet has only picker coverage. The live test also
asserts the actual assistant model identifiers in Claude's transcript and saves
them in `metrics.json`, rather than trusting only the UI badge. The Opus run
requested `claude-code/opus` with medium effort and reported `claude-opus-5`;
its evidence is under `artifacts/claude-opus-video-20260922/`.

**Fable (2026-10-26).** `claude-code/fable` passes Claude Code's `fable` alias,
which resolves to `claude-fable-5-1` (Claude Code 2.1.310; `--effort low` and
`max` both accepted). The real-browser live test passed with it at medium
effort: 3 tool calls, the file verified, Stop, memory after Stop, the same
session resumed after the pane restart, and reload; the transcript reported
`claude-fable-5-1`. The badge reads FABLE. The live test now seeds an empty
`media/piweb-shared/hot-keywords.json` in its disposable media directory (a
deployment publishes one; without it every load logged a 404 and the
no-console-errors check failed for every model), and records the status and
URL of any failed response next to the console errors.
