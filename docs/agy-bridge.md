# Proposal: Gemini models via the Antigravity (`agy`) CLI

**Status:** prototype, verified end to end on branch `gemini`.

## The proposal

Offer Google's Gemini models in Piweb by bridging to the `agy` CLI rather than
adding a Gemini provider to pi.

`agy` is already a complete agent: it owns its tools (shell, file edit, browser,
web search, subagents), its permission model, and its own conversation store.
Reimplementing any of that inside Piweb would be redundant and would drift.
So the bridge does the minimum that makes agy look like a Piweb model, and
**delegates every action to the agy CLI**:

1. `agy models` is published as synthetic `agy/<id>` catalog entries, so the
   existing model picker, `/model` command, per-session override, badge, and
   thinking picker all work with no UI change.
2. A turn on an `agy/*` model spawns
   `agy --output-format stream-json --print <prompt>` and translates its event
   stream into the pi-shaped events the transports already render.

Nothing in Piweb drives a model, chooses a tool, or stores agy history.

## Why a CLI bridge instead of a pi provider

| | CLI bridge | pi provider |
|---|---|---|
| Tools | agy's own (browser, subagents, image gen, web search) | pi's, reimplemented against the Gemini API |
| Auth / quota | agy's existing Google login | new credential path |
| Conversation state | agy's store, resumed by id | pi session files |
| Piweb code | one module + one routing branch | provider, auth, tool plumbing |

The tradeoff is that an agy turn does not share pi's session file, so `/pi
status` token accounting and `--until-done` do not apply to it. That is inherent
to delegating the whole turn, and is the price of getting agy's toolchain for
free.

## How it works

```
queue.ts ── model ref is agy/* ? ──▶ invokeAgy()  ──spawn──▶ agy --output-format stream-json
                 │                        │
                 │                        └── translate events ──▶ onEvent (same pi shapes)
                 └── otherwise ──▶ RPC session / invokeAgent (pi, unchanged)
```

`src/agent/agy.ts` is the whole bridge:

| concern | how |
|---|---|
| catalog | `listAgyModels()` runs `agy models`, cached 5 min; merged into `listAvailableModels()` |
| routing | `isAgyModelRef(ref)` — a single branch in `queue.ts`, placed **before** the RPC branch because agy has no RPC/steer mode |
| conversation | agy's `conversation_id` from the `init` event, stored per channel in `<session dir>/agy-conversation.json`, replayed as `--conversation <id>` |
| thinking | Piweb's six levels fold onto agy's `--effort low\|medium\|high`; `supportsXhigh: false` makes `resolveThinkingForModel` downgrade xhigh to high |
| tools | `step_type: "tool"` → `toolcall_end` (ACTIVE) and a `role=tool` `message_end` (DONE), so tool calls and outputs render exactly like pi's |
| text | `agent_response` deltas accumulate; the `result` event's `response` is authoritative |
| attachments | staged by `downloadAttachments` and handed over by absolute path — agy has its own file tools, so nothing is inlined into the prompt |
| errors | `formatAgyError()` turns the common 429 into "quota exhausted — resets in 4h5m58s" |
| abort | the signal SIGTERMs agy and returns `aborted`, matching the pi path |

### Three things that will bite anyone editing this

- **agy model ids already encode the reasoning effort.** `gemini-3.5-flash-low`
  plus `--effort medium` is rejected outright with
  `invalid model selection … conflicts with --effort=medium`, and the turn fails
  before `init`. `modelIdEncodesEffort()` suppresses the flag for any id ending
  in `-low`/`-medium`/`-high`, so the id wins; only ids without a suffix
  (`claude-sonnet-4-6`) actually take `--effort`. This only reproduces with a
  thinking level set, which is why it survived the first round of testing and
  was caught by the deployed end-to-end run.
- **agy blocks on an open stdin.** `agy models` produces no output at all and
  eventually times out if stdin is a pipe that never closes. `runAgy()` spawns
  with `stdio: ['ignore', …]` for exactly this reason; an `execFile`-style call
  will look like a hung binary. (`agy models` also writes its
  "Fetching available models..." status line to **stderr**, not stdout.)
- **agy blocks on permission prompts.** Piweb has no UI to answer them, so
  `AGY_SKIP_PERMISSIONS` defaults to true. Turning it off makes any tool-using
  turn hang until `--print-timeout`.

## Configuration

| variable | default | meaning |
|---|---|---|
| `AGY_ENABLED` | `true` | offer agy models at all |
| `AGY_BIN` | `agy` | binary path |
| `AGY_MODELS_TIMEOUT_MS` | `20000` | catalog probe timeout |
| `AGY_PRINT_TIMEOUT` | `15m` | passed as `--print-timeout` (agy's own default is 5m) |
| `AGY_SKIP_PERMISSIONS` | `true` | `--dangerously-skip-permissions`; see above |

With `AGY_ENABLED=false` (or no `agy` binary) the catalog probe fails soft, no
`agy/*` refs are offered, and nothing else changes.

## Verification

Unit (`npm test`, 144 passing — 22 new):

- `test/agy-bridge.test.ts` — ref detection, catalog parsing, every event
  translation, quota/error formatting, conversation-id round trip and corrupt-store handling.
- `test/queue-agy-routing.test.ts` — an `agy/*` model reaches `invokeAgy` and
  **not** `invokeAgent`; every other model stays on the pi path; `RPC_STEER=true`
  does not divert an agy turn.

End to end against the real `agy` binary and real Gemini:

| check | result |
|---|---|
| catalog merge | 14 agy entries (11 Gemini) inside an 87-model catalog |
| resolution | bare `gemini-3.1-pro-high` and full `agy/gemini-3.7-flash-low` both resolve |
| thinking fold | `xhigh` → `high`, `adjusted: true`, reason `xhigh_to_high` |
| tool use | `echo AGY_BRIDGE_E2E` ran; `toolcall_end` + `tool` events emitted; output reported |
| conversation persistence | id written to the channel's session dir |
| **memory across turns** | codeword seeded in turn 1, returned verbatim in turn 2, same conversation id |

Deployed, through the real HTTPS UI at a 390x844 phone viewport:

| check | result |
|---|---|
| picker | `agy/gemini-3.5-flash-low` listed, `AGY` badge, `reasoning` tag |
| badge adjacency | AGY (grey) sits directly above LOCAL (green) and GEM (blue) and stays tellable apart |
| selection | `/pi model` round-trips; topbar badge switches to AGY |
| tool streaming | `run_command` call and its `PIWEB_E2E_OK` result render as tool / tool_result rows |
| reply | markdown code block renders; no horizontal page scroll (390 == 390) |
| **continuity** | second turn in the same session returned `SILVER_HERON` |

## Follow-ups not done here

- **Provider badge colour.** `agy` falls through `providerBadge()`'s default and
  renders a neutral `AGY`. A dedicated colour needs a client-side mirror in
  `providerBadgeFor()` plus a visual check against its neighbours in the real
  list (see CLAUDE.md §5) — not something to pick blind.
- **`/pi status`** reports pi's context and does not describe an agy session.
- **`--until-done`** has no agy equivalent; such a message would need to fall
  back to pi or be refused.
- **Steering** (`RPC_STEER`) does not apply — a running agy turn can be aborted
  but not steered.
