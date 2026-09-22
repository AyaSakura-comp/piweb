# Claude Code tmux bridge

Opt-in worker adapter for `claude-code/haiku`, `claude-code/sonnet`, and
`claude-code/opus`. It drives an interactive Claude Code TUI in a persistent tmux
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

## Lifecycle and data

- Each channel gets a stable hashed tmux name and a `claude-tmux-session.json`
  pointer under its Piweb session directory. Claude owns the actual transcript
  under `~/.claude/projects/`; back it up separately if required.
- Switching between Pi, Agy and Claude **does not transfer agent memory**, even
  though Piweb's visible chat is continuous. Claude model/effort/cwd changes
  restart the TUI with the same Claude conversation id.
- Input uses a tmux buffer with bracketed paste for multiline safety, preceded by
  a literal typed request. Claude Code 2.1.278 wraps bracketed pastes in
  `pasted_content`; without that external request, it can treat the whole task
  as quoted data and ask what to do instead of executing it.
- Output comes exclusively from complete JSONL records, not scraped screen text.
  Thinking, tool calls and results become streamed Pi-shaped events; final output
  is delivered after `turn_duration`. Partial UTF-8 writes are retained as bytes.
- Uploads are staged through Piweb and provided as absolute paths. Local markdown
  media links are converted to outbox markers before delivery.
- Stop sends Ctrl-C, including for a running turn recovered after worker restart.
  The tmux session/context remains available for the next message. A dead pane
  fails promptly instead of waiting for the full turn timeout.
- `/pi new` closes the matching Claude session **after** ownership/idle checks,
  before rotating the pointer directory. Next use gets a new Claude UUID.
  Archived Claude transcripts are not deleted by resetting Piweb.
- Stable queue row ids and start offsets allow worker recovery to tail a surviving
  turn without resending it. This is not a transactional exactly-once guarantee:
  Claude's external TUI/transcript and SQLite cannot commit atomically.
- `/pi status`, Pi compaction, Pi subagent controls and Pi extension commands are
  not Claude-native controls. Do not interpret their output as Claude usage.

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
# Select a real model (haiku default; sonnet/opus use medium effort):
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
HAIKU/SONNET/OPUS badges, streamed tools/final reply, pointer-reachable Send/Stop,
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
