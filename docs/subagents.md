# Current-parent Subagents viewer

Install the local extension with `pi install /home/chihmin/src/pi-subagents`.
The tested fork is v0.70.0, b72714de, with Pi 0.84.1. Fresh Pi processes load
installed packages; an already-running agent is not reloaded by installation.

## UI and scope

Open **⋯ → Subagents**. This read-only modal lists all **persisted native child
sessions in the current Pi parent's default session tree**, including completed
foreground/background children and native forks. It is not the capped active
fleet widget. Select a child to view its current branch, tools, thinking and
Markdown through the **same `buildEventNode` renderer** as normal chat. Forked
history is explicitly marked as inherited context. Older history is paged;
updates use stable native entry/block cursors to fill reconnect gaps.

The UI uses numbered cards, short display names (generated UUIDs remain in
native tooltips), two-line task previews, a model label and recorded-response
status. `Response ready` describes the last persisted model response, **not**
process exit, gate success, or runner completion. `Recorded activity` never
claims that an abandoned/crashed tool tail is still running. Updates appear at
message boundaries. Header hints retain the persisted-history qualification.

Open/close and list/detail transitions last 140–220ms and respect
`prefers-reduced-motion`. Polling retains DOM nodes/focus; Back restores the
list position once, without overriding subsequent keyboard navigation.

Limitations:

- Queued/pre-first-response/failed-before-persistence children have no native
  session file yet and cannot appear in this artifact inventory.
- Custom external `sessionDir`, external CLI/jobs without native transcripts,
  and deleted artifacts are not reconstructed or traversed.
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

## Deployment

No commit or push is required by the implementation. Do not run a deployment
flow that resets a dirty checkout. Follow the canonical restart-service hub,
check active message work first, and do not restart the worker owning the
implementation turn. A frontend-only Docker update is insufficient for the new
endpoint and RPC lifetime behavior: deploy the built web image and host worker
together at a safe handoff. Isolated loopback testing does not certify production
Funnel/container integration.
