# Current-parent Subagents viewer

Install the local extension with `pi install /home/chihmin/src/pi-subagents`.
The tested fork is v0.70.0, b72714de, with Pi 0.84.1. Fresh Pi processes load
installed packages; an already-running agent is not reloaded by installation.

## AGY status and related command viewer

AGY child snapshots are read-only evidence, not native Pi sessions or proof of
runner completion. AGY snapshot watchers are now tied to the invoking turn,
abort signal and queue ownership; acknowledgements do not end observation.
See [observability status](agy-observability-status.md) for verification scope.
These qualifications do not replace the native Pi running-state rules below.

Shell commands have a separate **⋯ → 背景命令 · AGY** viewer, documented in
[AGY command manager](agy-command-manager.md). It reuses this viewer's theme and
header/body styles in an edge-to-edge layout but tracks commands, not children.

## UI and scope

Open **⋯ → Subagents**. This read-only modal lists all **persisted native child
sessions in the current Pi parent's default session tree** plus channel-owned
snapshots of AGY children disclosed by structured `subagent` events. Native
entries include completed foreground/background children and forks; AGY entries
are explicitly labelled `AGY` and are never presented as native Pi children.
It is not the capped active fleet widget. Select a child to view tools, thinking
and Markdown through the **same `buildEventNode` renderer** as normal chat.
Forked history is explicitly marked as inherited context. Older history is
paged; updates use stable entry/block cursors to fill reconnect gaps.

The UI uses numbered cards, short display names (generated UUIDs remain in
native tooltips), two-line task previews, a model label and recorded-response
status. `Response ready` describes the last persisted model response, **not**
process exit, gate success, or runner completion. `Recorded activity` never
claims that an abandoned/crashed tool tail is still running. Updates appear at
message boundaries. Header hints retain the persisted-history qualification.

Open/close and list/detail transitions are horizontal slides lasting 140–220ms
and respect `prefers-reduced-motion`. Open/select enters from the right moving
left; return/close moves right. **Swipe right in a child transcript to return to
the list; swipe right in the list to close to main chat.** Back and Close buttons
remain available. Polling retains DOM nodes/focus; Back (including swipe Back)
restores the list position once, without overriding subsequent navigation.

Right-drag navigation follows the finger in real time after a 12px horizontal
lock (1.5× vertical dominance), with no hold timeout. Child detail reveals an
inert saved-list preview; the list reveals main chat. Release at 28% width, or
with a qualifying rightward flick from at least 60px, completes the return.
Otherwise the surface settles back from its current position. Cancelled and
multi-touch gestures also snap back; completion takes 120–280ms (instant with
reduced motion). Code blocks, horizontal scrollers, toolbar controls and active
text selections retain their native interactions. See [DESIGN.md](../DESIGN.md) for the complete
motion, accessibility and gesture contract. Global Life/drawer edge gestures
are disabled while a native dialog is open, preventing a Subagents exit swipe
from navigating the underlying chat into Life.

### iPhone touch compatibility

Claim a clearly rightward `touchmove` immediately, even before the 12px visual
movement threshold. Waiting for that threshold can allow Safari to claim native
scrolling, leaving the custom drag unresponsive. Do not cancel vertical-first
movement: native scrolling must continue to work.

The regression test covers a 4px initial horizontal move, untouched vertical
motion, held dragging, cancellation and return navigation. The user gave positive
feedback after the fix was deployed for the reported iPhone issue. This is
user-reported confirmation; it does not replace automated real-device coverage
across iOS versions or Safari/PWA modes. Refresh the page (or reopen the home-screen
app) after a frontend update before comparing behavior.

### Recorded activity

Confirmed running native async children appear first, then each group sorts by
transcript modification time (newest first). A `Running` spinner requires an
owner-matching host status snapshot, running step/run and live runner PID;
transcript age alone never starts it. The host publishes only bounded relative
child names into its expiring parent marker; Docker does not read global `/tmp`.
Discovery prefers the extension's `.active-runs` index so retained old jobs do
not consume its budget. Unknown/expired status, cold parents and foreground
runs without that async status proof retain recorded-response labels without
spinners. Reduced-motion users get a static ring. A fresh host worker is needed
for activity publication; changing Web CSS alone cannot enable it.

Limitations:

- Queued/pre-first-response/failed-before-persistence children have no native
  session file yet and cannot appear in this artifact inventory.
- Custom external `sessionDir`, external CLI/jobs without native transcripts,
  and deleted artifacts are not reconstructed or traversed. AGY is the narrow
  exception: the worker validates the child conversation ID against AGY's
  structured `log_uri` and copies that transcript into the channel directory;
  the Docker web tier reads only the copy. The asynchronous watcher checks
  queue ownership and channel directory identity before refreshing, stops on
  cancellation, and is retired before the invoking turn releases its lease.
- Updates occur at persisted message boundaries, not every text token or tool
  stdout byte. No new media-path authority is granted: binary child attachments
  and local-file outbox markers are not staged by this read-only viewer.
- Selected native histories are bounded to 16 MiB and 20,000 JSONL entries;
  oversized children remain listed but cannot be opened. Inventory reads have
  an aggregate 2 MiB budget, 10,000-entry traversal cap and depth 16. Limit
  failures are explicit HTTP 413, never silent list truncation. Two inspections
  per web process may run concurrently; excess requests receive HTTP 429.
- Inventory metadata is reused for up to one second (32 parent inventories).
  Two selected histories are cached by parent/file identity and stat version.
  Reconnect pages reuse the event index; ordinary native append-only growth
  reads/parses only the new bytes, then recomputes bounded active ancestry.
  Replacement, truncation and same-size rewrites rebuild the cache. Arbitrary
  in-place edits of an old prefix combined with growth are not supported by
  this append-log cache; native logs must retain their append-only contract.
- Linux `/proc/self/fd` is required for descriptor-relative safe traversal.

## Ownership and architecture

The existing authenticated HTTP session router exposes
`GET /api/sessions/:jid/subagents`. A list response provides an opaque parent
`scope`. Detail requests require that exact scope plus an opaque `child` ID;
`before` pages older events and `after` is a stable native event cursor.
Life also requires its existing `generation` parameter. There are no path
parameters and no arbitrary artifact-file endpoint.

Persistent RPC publishes `.piweb-current-parent.json` inside its existing
channel storage directory using the **actual `get_state` selected session**.
The marker is bound to immutable owner token/folder/ownership epoch and an
individual publisher token. Startup publishes a pending selection rather than
exposing an older parent's children; RPC refreshes from `get_state` at startup
and turn boundaries. One-shot JSON execution publishes its actual session
header ID, resolved only against that matching file. Normal process exit
retires only its own marker; an old owner cannot remove a replacement marker.
Publications heartbeat every second and expire after five seconds if the
worker crashes; abrupt worker death may therefore leave up to five seconds of
stale selection. Cold fallback matches Pi's resolved effective cwd, skips
blank/malformed header lines, accepts an EOF header without a newline, and
uses newest modification time with filename order for ties. Its header scan
has Pi's 1 MiB ceiling plus the aggregate inventory budget. Legacy/expired
markers are ignored.
The web process asynchronously reads the shared default parent subtree, refuses
symlinks/hard links/nonregular files, reads bounded list previews with metadata
caching, and rechecks parent scope and channel ownership before responding.
The container never imports Pi or accesses the host's global `/tmp` artifacts.

The extension's public `PI_SUBAGENT_ASYNC_JSON` widget supplies conservative
RPC liveness even outside a parent turn. Overflow cannot evict live work.
Autonomous completion wakes use a fresh transport streamer and the **RPC's own
renewed durable lease**, not an expired message-queue callback. Its delivery
chain waits for the original queue's final response/file publication **and**
typing/live-buffer/lease cleanup before taking over that generation's output.
This preserves final transcript order even when autonomous inference settles
before a slow original media send. Pending user
messages wait while an autonomous turn is streaming. Life retains an owner
with live children; its normal retirement remains for child-free turns.
Incompatible settings/one-shot switches refuse to kill live children silently.
Ambiguous/overflowed widget state conservatively retains the owner; explicit
session stop/delete and normal ownership revocation remain authoritative.

## Maintained tests

```sh
npx vitest run test/subagents.test.ts test/subagents-api.test.ts \
  test/rpc-subagent-liveness.test.ts test/rpc-subagent-completion.test.ts \
  test/queue-subagent-handoff.test.ts test/subagents-budget.test.ts
PIWEB_E2E_PORT=4184 npx playwright test \
  test/e2e/subagents.spec.ts test/e2e/subagents-reconnect.spec.ts \
  test/e2e/subagents-ux.spec.ts
```

The alternate fixture port avoids interfering with an existing shared fixture
server. Both specs use the production HTML/CSS/JS and renderer. They cover
navigation/isolation, expanded tool preservation, safe text rendering, pointer
reachability, containment, and catch-up bursts exceeding a page. The UX spec
adds 12 long-name cards, dark/light themes, reduced motion, focus/scroll
preservation across status polls and delayed Back responses. It records a
continuous walkthrough plus card/detail/theme screenshots.

Real cloud verification is explicitly opt-in and requires a **disposable**
PiWeb worker/web database and a project `luna-web` test agent. Supply environment
variables (never embed credentials): `PIWEB_SUBAGENTS_LIVE_URL`,
`PIWEB_SUBAGENTS_LIVE_TOKEN`, `PIWEB_SUBAGENTS_FIXTURE`. The parent and child must
use `openai-codex/gpt-5.6-luna:low`; no local inference is used.

```sh
PIWEB_E2E_PORT=4184 npx playwright test test/e2e/subagents-live.spec.ts
```

The live spec creates disposable channels, submits the actual tool delegation
through PiWeb, opens a live child, observes tool/text updates and final Markdown,
returns to the two-child history list, reconnects via the exact parent deep
link, then switches channels and verifies cross-parent rejection. It records
one continuous 390×844 WebM plus milestone PNGs and metrics. Network tracing is
disabled for this authenticated spec to keep tokens out of evidence. Transcode
with the visual-testing skill's `webm-to-mp4.sh`, verify H.264/yuv420p with
ffprobe, and inspect both snapshots and temporal frames. Generated evidence
belongs under ignored `artifacts/`, not Git.

## Five-child production regression (reported empty-list case)

`test/e2e/subagents-five-live.spec.ts` exercises the deployed Docker Web and
host worker, not an in-process fixture. It first opens an existing five-child
witness session and browses every history. Set `PIWEB_SUBAGENTS_FIVE_LAUNCH=1`
to additionally create a dedicated session, select GPT Luna, submit one async
`runs.all` workflow with five native children through the composer, and inspect
each child's tools and assistant answer. Five distinct assistant-only tokens,
rendered headings, response-ready state and reload persistence are required;
a token in a user prompt is NOT success evidence.

Required environment: `PIWEB_SUBAGENTS_LIVE_URL`,
`PIWEB_SUBAGENTS_LIVE_TOKEN`, `PIWEB_SUBAGENTS_EXISTING_SESSION`.
This opt-in uses real inference and leaves the dedicated session as an
inspectable witness. Use a trusted test account, no network trace, and never
record credentials. Command:

```sh
npx playwright test test/e2e/subagents-five-live.spec.ts
```

The original production failure was a configuration mismatch: Docker defaulted
`PI_CWD` to `/home/node`, whereas the worker wrote parent headers with
`/home/chihmin`. The strict cwd filter correctly rejected the wrong environment,
but yielded an empty list. Compose now REQUIRES explicit `PI_CWD`; copy the
host worker's exact effective value to `.env`. Do not widen cwd filtering or
mount unrelated host directories to work around this. Presence is enforced;
operators must verify equality when changing the worker's cwd. The source
contract is protected by `test/subagents-deployment.test.ts`.

## Background completion lifecycle regression

`test/e2e/subagents-completion-live.spec.ts` verifies more than child browsing:
parent acknowledges and settles, three real Luna children execute sequentially,
and the parent autonomously returns a fixture codeword after their completion.
It checks child models, actual read/sleep tools, three distinct batch keys,
sequential completion timestamps, one non-partial main answer, and persisted
reply after reload. It does not accept text from the user's prompt as proof.

Opt-in environment: `PIWEB_COMPLETION_URL`, `PIWEB_COMPLETION_TOKEN`,
`PIWEB_COMPLETION_FIXTURE`, `PIWEB_COMPLETION_EXPECTED`. Credentials remain
outside test files/traces. In an isolated worker, set `RPC_IDLE_TIMEOUT_MS=2000`
and run three children with a 10-second tool delay each, proving that a settled
parent stays alive well beyond its idle deadline and is retired only after the
completion response. Production tests use the normal production idle policy.

```sh
npx playwright test test/e2e/subagents-completion-live.spec.ts
```

A built or committed worker is not a running deployment: confirm the service's
actual PID is replaced after a safe drain. Restarting an old worker can stop
in-process workflow controllers even when children were described as detached.
Do not replay finance/other mutating batches automatically after interruption.

## Deployment

No commit or push is required by the implementation. Do not run a deployment
flow that resets a dirty checkout. Follow the canonical restart-service hub,
check active message work first, and do not restart the worker owning the
implementation turn. A frontend-only Docker update is insufficient for the new
endpoint and RPC lifetime behavior: deploy the built web image and host worker
together at a safe handoff. Isolated loopback testing does not certify production
Funnel/container integration.
