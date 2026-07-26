# CLAUDE.md — piweb

Guidance for working in this repo. piweb is a **mobile web front end for the pi
coding agent**, forked from [piscord](https://github.com/Crokily/pi-discord-gateway):
the agent core is kept as-is and the Discord transport was replaced with a web one.

Read the "Invariants" section before changing anything — most of the entries there
exist because breaking them produced a confusing half-failure rather than an
obvious error.

---

## 1. Project design

### The split, and why it exists

```
  iPhone ──HTTPS──▶  piweb web  (Docker, NO pi binary)
                          │
                          │  SQLite (WAL): web_events / control_queue /
                          │               message_queue / channels / meta
                          ▼
                     piweb worker (HOST, systemd --user)  ──spawns──▶  pi
```

The worker runs **on the host, not in the container**, deliberately. pi is only
useful here if it keeps host access: `systemctl --user`, docker, the ROCm GPU,
and the project checkouts under `~/src`. Containerising pi would silently reduce
it to a sandboxed code editor. The web tier therefore has no pi binary and never
spawns one; the two halves communicate **only** through SQLite.

Both halves ship from one codebase (`dist/cli/piweb.js`):

| mode | runs | used for |
|---|---|---|
| `worker` | message loop + control loop + scheduler | host systemd unit |
| `web` | HTTP/SSE server | container |
| `all` | both in one process | dev, or an all-in-one container |

`WEB_EMBEDDED_WORKER=true` makes `web` also run the worker.

### Layout

Inherited from piscord (avoid editing unless the change is transport-agnostic):

```
src/agent/       pi core: invoke.ts (spawns pi), queue.ts (message loop),
                 rpc-session.ts, model-catalog.ts, channel-settings.ts, scheduler.ts
src/session/     path.ts (session dirs + rotation), media.ts (attachment staging),
                 archive-cleanup.ts, model-info.ts (reads pi's model_change)
src/discord/     the ORIGINAL transport — unused by piweb but still compiled;
                 attachments.ts's AttachmentMeta is reused (local-file variant)
src/db.ts        schema + queries; piweb tables + helpers at the bottom
```

piweb's own code:

```
src/transport/   index.ts  = Transport interface + setTransport/getTransport
                 web.ts    = the web transport: agent output → web_events (+ media)
src/commands/    catalog.ts = COMMANDS, pure data, safe for the web tier to import
                 index.ts   = runCommand() implementations (WORKER-only; pulls in pi deps)
src/web/         server.ts = node:http router (no framework): API + SSE + static
                 auth.ts   = token cookie, Tailscale identity, CSRF, login throttle
                 push.ts   = Web Push sender (tails web_events → APNs/FCM)
src/worker/      index.ts  = worker startup (loops + model-catalog + trash sweep)
                 control.ts = control_queue drain loop
src/media-path.ts  ONE spelling of a media dir/URL (invariant 9)
src/cli/piweb.ts   entrypoint: worker | web | all
public/          index.html, app.css, app.js — no framework, no build step
                 markdown.js = markdown + KaTeX renderer (DOM nodes only)
                 sw.js       = service worker (Web Push receive only)
                 vendor/katex/ = KaTeX vendored locally (no CDN)
                 icons/piweb/  = home-screen icon set; manifest.webmanifest
scripts/history.py  read-only history query CLI (stdlib only)
deploy/          piweb-worker.service
```

### How a turn flows

The two processes never call each other; every interaction is a row in SQLite
that the other side polls. `web_events.rowid` is the one monotonic clock the
whole UI is built on — SSE cursor, unread marks, push cursor, and paging all key
off it.

```
 phone ──POST /messages──▶ web server
                              │  append web_events(user)      ← instant echo
                              │  insert message_queue(pending)
                              ▼
                    (SQLite, WAL, shared)
                              ▲
   worker queue loop ─claimNextMessage─┘  (per-channel serial, global cap 3)
        │ spawn pi --session-dir <dir> --continue --mode json
        │ stream stdout events ─▶ getTransport().createEventStreamer(jid)
        │                          └─▶ append web_events(thinking/tool/tool_result)
        │ setChannelBusy(jid,true) … clearTyping on finish
        ▼ final reply → parseOutboxMarkers → append web_events(assistant [+files])
                              │
 phone ◀──SSE /stream?after=N─┘  web tails web_events by rowid, pushes each
```

Reply text flows through the transport's `sendResponse`/`sendFilesResponse`; the
streamed thinking/tool events flow through `createEventStreamer`. Both end up as
`web_events` rows, so the transcript is complete and replayable — the phone can
disconnect at any point and resume from its last rowid.

### Why commands go through `control_queue`

The web tier *cannot* execute them:

- `/pi status` spawns pi over RPC for token stats
- `/pi stop` needs the worker's in-memory `AbortController`
- `/pi new` must not race an in-flight run (`isChannelProcessing`)
- `/gpt-usage` shells out on the host

So web validates against `COMMANDS` and writes an intent row; the worker executes
it and appends the result as a `system`/`error` event. Command output therefore
travels the same SSE path as chat and survives reconnects. Adding a command means
touching `src/commands/catalog.ts` (data) **and** `runCommand()` (implementation).

### The data model

Every piweb table is at the bottom of `src/db.ts`. The ones that carry state
between the two processes use an autoincrement `rowid` as a cursor.

| table | role | who writes | who reads |
|---|---|---|---|
| `channels` | one row per session (`web:<uuid8>` jid, folder, per-session model/thinking/cwd overrides, `deleted_at`) | both | both |
| `web_events` | the transcript AND the live stream: user turns, assistant replies, thinking, tool, tool_result, system, error | worker (agent output), web (user turn, command echo) | web (SSE/paging), push |
| `message_queue` | pending user messages for the worker | web | worker |
| `control_queue` | command intents the web tier can't run itself | web | worker |
| `channel_state` | transient `busy` flag per session (typing/spinner) | worker | web |
| `meta` | key/value the web tier needs but can't compute: `models` (pi's catalog), `auth.signingKey`, `push.vapid`, `push.cursor` | worker (models), web (auth/push) | web |
| `push_subscriptions` | one row per opted-in device | web | push |
| `message_log`, `scheduled_tasks` | inherited from piscord; `message_log` duplicates web_events (gap) | worker | — |

`web_events.kind` is the discriminator the UI switches on: `message` (with
`role` user/assistant) renders a bubble; `thinking`/`tool`/`tool_result` render
collapsed event blocks; `system`/`error` render open. Only
`message(assistant)`/`system`/`error` count as "a reply" for unread and push —
never the user's own turns or the streamed chatter.

### The HTTP API

All under `src/web/server.ts`, one flat router. Everything except login/logout/
me and the static shell requires auth; state-changing methods also pass the CSRF
origin check.

| route | method | purpose |
|---|---|---|
| `/api/login` `/logout` `/me` | POST/POST/GET | token→cookie; `/me` also reports `via` (token/tailscale) and `funnel` |
| `/api/push/key` `/subscribe` `/unsubscribe` | GET/POST/POST | VAPID public key; save/drop a subscription |
| `/api/commands` | GET | the `COMMANDS` catalog for autocomplete |
| `/api/models` | GET | pi's model list (from `meta`, published by the worker) |
| `/api/sessions` | GET/POST | list live sessions (with badge, busy, `lastReplyId`); create |
| `/api/sessions/deleted` | GET | the trash (must precede the `:jid` matcher) |
| `/api/sessions/:jid` | PATCH/DELETE | rename; soft-delete (or `?permanent=1`) |
| `/api/sessions/:jid/restore` | POST | un-trash |
| `/api/sessions/:jid/events` | GET | `?after` (SSE catch-up) `?before` (page up) `?around` (jump) or newest page |
| `/api/sessions/:jid/stream` | GET | SSE tail (polls web_events every 400ms) |
| `/api/sessions/:jid/search` | GET | `?q=` substring search within the session |
| `/api/sessions/:jid/messages` | POST | text + base64 attachments → queue |
| `/api/sessions/:jid/commands` | POST | a `COMMANDS` name → control_queue |
| `/api/sessions/:jid/clear` | POST | wipe web_events + enqueue `pi new` |
| `/media/...` | GET | served attachment/output files |

### Feature → code map

| feature | where |
|---|---|
| markdown + LaTeX | `public/markdown.js` (`renderRich`), KaTeX in `vendor/` |
| search + jump-to-message | `/search` + `/events?around=`; client `state.atLive` gates SSE while detached |
| image lightbox (swipe) | `public/app.js` `openLightbox`, filmstrip, pointer gestures |
| Recently deleted | `deleted_at` soft delete; bottom sheet; worker `sweepTrash` purges after `WEB_TRASH_RETENTION_DAYS` |
| push notifications | `src/web/push.ts` + `public/sw.js`; VAPID + cursor in `meta` |
| provider badges | `src/session/model-info.ts` `providerBadge()`; NV/LOCAL/GEM/… plus TERRA/SOL/LUNA for the Codex GPT-5.6 variants. Mirrored client-side by `providerBadgeFor()` for the model-picker rows — change both or the two views disagree |
| unread dot / busy spinner | `channel_state.busy` + `lastReplyId` vs localStorage `piweb.seen` |
| session ordering | `activityKey()` + `sessionsForDisplay()` in `public/app.js` (recency) |
| rename / model sheet / edge-swipe drawer | `public/app.js` (all client-side) |
| stay signed in | persisted `auth.signingKey` + localStorage `piweb.token` auto-login |

### Which model a badge shows

The badge must track the model the session **is set to**, so picking one in the
sheet is reflected immediately. Two sources disagree, and the precedence matters:

- **`channels.model_override`** — passed to pi as `--model` on *every* run
  (`channel-settings.ts` → `queue.ts`), so when set it **is** the session's
  model. It **wins**.
- **pi's session file** (`model_change` lines, read by `getSessionModel()`) —
  only records what the *last run happened to use*. It goes stale the moment the
  model changes and no message has been sent yet. It is the fallback, used for
  sessions following the gateway default, where it is the only honest source.

Getting this backwards was a real bug: a session set to `gpt-5.6-sol` kept
showing TERRA until a message was sent. `pending` on the API means "chosen but
not yet exercised by a run" — compare `modelIdFromRef(override)` against the
session file's bare `modelId`.

`pi model` round-trips through `control_queue`, so the override lands some
unpredictable moment after the tap. The client polls (`awaitOverride()`) until
it matches instead of guessing a single delay.

### Reading history: paged, newest-first

The transcript is **not** loaded in full. A fresh open fetches the newest page
(`PAGE_SIZE = 50`); scrolling within 300px of the top pulls the previous page and
prepends it, Discord-style, until `hasMore` is false.

`GET /api/sessions/:jid/events` has three modes, all served by the single
`(channel_jid, rowid)` index as bounded range scans — cost tracks page size, not
transcript length:

| query | returns | used for |
|---|---|---|
| *(none)* | newest `limit` | first open |
| `?before=<id>` | `limit` older than id | scroll-up paging |
| `?after=<id>` | newer than id | SSE catch-up / reconnect |

`limit` is clamped to 200. Adding a filter on any non-indexed column would turn
these into table scans — don't.

**Prepending must not move the viewport.** `loadOlder()` records `scrollHeight`
and `scrollTop`, inserts the page as a single `DocumentFragment`, then sets
`scrollTop += (scrollHeight - heightBefore)`. Verified by measuring a reference
element's viewport offset across a load: it must shift by exactly the amount
scrolled and not by the height of the inserted rows (measured drift: 0px).

Careful when testing: assigning `element.scrollTop` fires a real scroll event, so
it can trigger a load during your own measurement and make two post-load states
look like a passing comparison.

### Deleting is soft

`DELETE /api/sessions/:jid` sets `channels.deleted_at` and clears only the
pending queue. The transcript, settings and pi session directory are untouched,
so `POST /:jid/restore` brings the session back exactly as it was. The trash is
listed by `GET /api/sessions/deleted` and previewed read-only (writes to a
trashed session are refused with 409).

`?permanent=1` is the only destructive path: it drops every row **and** removes
pi's session directory plus the session's media/uploads. The worker sweeps the
trash hourly and purges anything older than `WEB_TRASH_RETENTION_DAYS` (30).

This also closed the old gap where deleting a session stranded its `.jsonl` on
disk forever — now it is either restorable or genuinely purged.

### Storage: two histories, not one

| store | what | cleared by |
|---|---|---|
| `web_events` table | what the UI shows | "clean session" / delete |
| `sessions/<folder>/*.jsonl` | what pi actually remembers | `/pi new` (rotates to archive) |

Clearing one does **not** clear the other, which is why the header 🗑 button does
both (`deleteWebEvents` + enqueue `pi new`). Query either with
`scripts/history.py show|context`.

### Search and jump

`GET /api/sessions/:jid/search?q=` does a substring match within one session and
returns snippets cut around the hit. Clicking a result calls
`/events?around=<id>`, which returns a window centred on that event; the client
replaces the transcript with it, scrolls the target into view and flashes it.

Jumping **detaches the view from the live tail**, which is why `state.atLive`
exists: while detached, incoming SSE events must not be appended (they belong
after history the user cannot see yet). They set `hasMoreNewer` and reveal
"Jump to present" instead, and scrolling down pages forward until the tail is
reached, at which point live appends resume.

`like '%x%'` cannot use an index, so search scans that session's rows — bounded
by `(channel_jid, rowid)` to one session. Fine at personal scale; the upgrade
path is FTS5 with sync triggers, not another b-tree index (no index can serve a
leading wildcard).

### Querying history

`scripts/history.py` — stdlib only (this host has no `sqlite3` binary) and opens
the database **read-only**, so it is safe against a running worker.

```bash
./scripts/history.py sessions            # list sessions + last activity
./scripts/history.py show <name> -n 30   # transcript (web_events)
./scripts/history.py search <text>       # across all sessions
./scripts/history.py search x --kind error system
./scripts/history.py context <name>      # pi's own .jsonl (what it remembers)
./scripts/history.py stats               # row counts + disk usage
```

Sessions resolve by fuzzy name, not just jid. Note the pi session format nests a
turn under `event["message"]` and its `content` is a list of typed parts
(text / thinking / toolCall / toolResult), **not** a string.

---

## 2. Invariants (break these and it fails confusingly)

1. **`PIWEB_DATA` must be mounted at the same absolute path inside and outside
   the container.** The web tier stages uploads and records their *absolute*
   paths in SQLite; the host worker opens those exact paths. A different mount
   point (e.g. `/data`) leaves text messages working while every attachment dies
   with ENOENT.

2. **The web tier must not import `src/commands/index.ts`** (or anything else
   reaching `agent/model-catalog`). Those pull in `@earendil-works/pi-*` peer
   deps that do not exist in the container — the image dies at startup with
   `ERR_MODULE_NOT_FOUND`. Import `src/commands/catalog.ts` instead. For the same
   reason `cli/piweb.ts` imports the worker **dynamically**, only in worker modes.

3. **`WEB_HOST` stays `127.0.0.1` while `WEB_TRUST_TAILSCALE_IDENTITY` is on.**
   Identity comes from a plain HTTP header injected by `tailscale serve`; anything
   that can reach the port directly could set it itself. The sidecar shares the
   app's network namespace, so loopback is sufficient. `tailscaleIdentity()` also
   rejects non-loopback per request.

4. **Identity headers do not prevent CSRF.** serve stamps the *device's* identity
   onto every request the browser makes, including one a hostile page triggers.
   Every state-changing request is separately checked against `WEB_PUBLIC_ORIGIN`
   via `Origin`/`Sec-Fetch-Site`. Keep that check when adding routes.

5. **New sessions auto-issue `pi new`** (silently, via `control_queue`) so a
   session can never inherit an agent context. It is a no-op for a fresh folder;
   it exists as a guarantee, and because deleted sessions currently leave their
   session directory on disk.

6. **`[hidden] { display: none !important }` must stay at the top of app.css.**
   Author rules that set `display` (`.login{display:grid}`, `.app{display:flex}`,
   `.typing`, `.autocomplete`) beat the UA stylesheet's `[hidden]` rule regardless
   of specificity. Without it the login overlay renders permanently on top of a
   fully working app — and `el.hidden` still reads `true`, so no JS check catches it.

7. **SSE is resumed by event id.** `EventSource` auto-reconnect would replay from
   the original `?after=` and duplicate everything, so the client closes and
   reopens with the current cursor. Keep `web_events.rowid` monotonic.

8. **`ts-state/` must stay in `.dockerignore`.** It is root-owned; including it
   breaks `docker build` with `can't stat ts-state/certs`.

9. **Media paths have exactly ONE spelling** — `src/media-path.ts`. The first
   cut built directories with `encodeURIComponent(jid)`, so `web:abc` became a
   directory literally named `web%3Aabc`, while the server decoded the URL back
   to `web:abc` and looked for a directory that never existed. Every generated
   image and upload 404'd into a broken-image icon with the file sitting on
   disk. Sanitising to `[A-Za-z0-9._-]` makes encoding a no-op both ways — never
   reintroduce an encode on one side and a decode on the other.

10. **Attachments use the local-file `AttachmentMeta` variant** (`filePath` set,
   `url` empty). `session/media.ts` copies instead of fetching, so uploads still
   get PNG transcoding and Breeze ASR voice transcription.

---

## 3. Deployment

### Configuration

Config is read from `PIDG_CONFIG` (default `~/.config/pi-discord-gateway/config.env`),
inherited from piscord. On this host the worker uses `~/.config/piweb/config.env`
and the container gets the same values from `~/src/piweb/.env` via compose.

**The two must agree** on every path variable — see invariant 1.

| variable | side | notes |
|---|---|---|
| `DB_PATH`, `SESSIONS_DIR` | both | the shared state; identical paths |
| `WEB_MEDIA_DIR`, `WEB_UPLOAD_DIR` | both | uploads staged by web, read by worker |
| `WEB_AUTH_TOKEN` | both | token login; may be empty if identity auth is on |
| `WEB_PORT`, `WEB_HOST` | web | `WEB_HOST` stays loopback (invariant 3) |
| `WEB_TRUST_TAILSCALE_IDENTITY` | web | default true |
| `WEB_ALLOWED_LOGINS` | web | comma-separated; empty = any tailnet identity |
| `WEB_PUBLIC_ORIGIN` | web | CSRF origin check (invariant 4) |
| `WEB_SESSION_TTL_SEC` | web | cookie lifetime |
| `WEB_EMBEDDED_WORKER` | web | run the worker in-process (all-in-one) |
| `PI_BIN`, `PI_CWD`, `PI_MODEL`, `PI_THINKING` | worker | pi invocation |
| `STREAM_THINKING`, `STREAM_TOOLS`, `MAX_EVENT_CHARS` | worker | what gets streamed |
| `RPC_STEER`, `INTERRUPT_ON_NEW_MESSAGE` | worker | mid-run steering / pre-emption |
| `MAX_CONCURRENCY`, `POLL_INTERVAL_MS` | worker | queue behaviour |
| `ARCHIVE_RETENTION_DAYS` | worker | archived session cleanup (default 30) |
| `MAX_ATTACHMENT_BYTES` | both | upload cap |

`DISCORD_*`, `CHANNEL_POLICY`, `AUTO_THREAD`, `TRIGGER_NAME` etc. are inherited
from piscord and unused by the web transport.

### Host worker

```bash
npm install && npm run build
cp deploy/piweb-worker.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now piweb-worker
```

Config: `~/.config/piweb/config.env` (chmod 600). Paths **must** match the
compose `.env`.

### Web tier + Tailscale

```bash
cp .env.example .env      # PIWEB_DATA, WEB_AUTH_TOKEN, WEB_PUBLIC_ORIGIN
docker compose up -d --build
```

The sidecar registers its own tailnet node (`TS_HOSTNAME=piweb`) so the UI gets
its own subdomain, e.g. `https://piweb.<tailnet>.ts.net/`. State lives in
`./ts-state`; once authenticated no key is needed again.

**Funnel is ON** (`AllowFunnel` in ts-serve.json), so the UI is reachable from
the public internet. That was an explicit decision, and it changes the threat
model: the shared token is now the ONLY thing in front of host command
execution.

What that required:

- **Identity auth is refused on Funnel requests.** serve overwrites the
  `Tailscale-User-*` headers for tailnet traffic (verified: a forged header
  from a tailnet client still reports the real login), but a Funnel request has
  no identity to overwrite with. Rather than stake host RCE on serve stripping
  them, `tailscaleIdentity()` returns undefined whenever
  `Tailscale-Funnel-Request` is present. Public visitors must use the token.
- **`/api/login` is rate limited** (8 failures → 60s lockout) because it now
  faces the internet. Buckets are keyed on the forwarded client address, and
  that was verified to be per-client: locking out the public path leaves the
  tailnet path answering 401, so an attacker cannot lock the owner out.
- `WEB_ALLOWED_LOGINS` does **not** apply to Funnel traffic — there is no
  identity to match. It only restricts tailnet users.

**Enabling Funnel needs a tailscaled restart.** `tailscale funnel status` reports
"Funnel on" as soon as the serve config is applied, but the node does not
actually accept public traffic until it re-establishes its ingress connection.
Symptom: the public path fails TLS ("unexpected eof") while the tailnet path is
fine. `docker restart piweb-ts` fixes it. Test the public path with
`curl --resolve <host>:443:<public-A-record>` — MagicDNS otherwise routes you
over the tailnet and you never exercise Funnel at all. Use a known-working
Funnel host on the same tailnet as a control.

#### Registration gotcha

`containerboot` runs `tailscale up` with a **60-second timeout**. Interactive
login cannot finish in human time: the container is SIGTERMed, restarts, and
generates a *new* node key, so the URL the user clicked is already stale. Symptom:
`failed to auth tailscale: tailscale up failed: signal: killed`, restart count
climbing, `tailscale serve status` → "No serve config".

Two working options:

- **auth key** in `TS_AUTHKEY` (what the other services here use), or
- **authenticate outside containerboot**: run `tailscaled` directly with the same
  state dir, `tailscale up --hostname=piweb`, let the user click at leisure,
  verify `ts-state/tailscaled.state` grew (~2.5 KB, not ~119 B), then start the
  compose sidecar, which comes up from state.

**Always redeploy with plain `docker compose up -d`, never `up -d app`.** The
sidecar is `network_mode: service:app`, so recreating `app` alone orphans its
netns and the Funnel goes dead — and the sidecar cannot even be restarted back
into it (`docker restart piweb-ts` → *"joining network namespace of container:
No such container"*). Only recreating the sidecar too fixes it. `up -d` does
that for you; targeting `app` does not. Verify after every deploy:

```bash
docker compose build app && docker compose up -d
curl -s -o /dev/null -w '%{http_code}\n' https://piweb.<tailnet>.ts.net/   # expect 200
```

Note `public/` is **COPY**ed into the image, not bind-mounted, so a frontend-only
change still needs `docker compose build app`. Static files are served
`cache-control: no-cache`, so phones pick up new JS/CSS on reload with no
cache-busting.

### Auth

Two paths; the server refuses to start with neither:

1. **Tailscale identity** — nothing to type; optionally restrict with
   `WEB_ALLOWED_LOGINS`.
2. **Shared token** (`WEB_AUTH_TOKEN`) → HttpOnly cookie; for local/dev or any
   deployment not behind serve.

---

## 4. Verification approach

The bugs in this project were mostly *invisible to the checks that looked
sufficient*. Verify accordingly.

### Look at the UI. Do not trust DOM assertions.

The worst bug here reported perfectly healthy state — `login.hidden === true`,
app populated, 14 messages rendered — while the screenshot showed the login
overlay covering everything. It was a CSS specificity problem; no amount of JS
introspection would have found it.

So: **screenshot at a phone viewport (390×844) and actually look**, for every
state — login, empty, populated, drawer open, autocomplete open, long code block.
Also assert `document.documentElement.scrollWidth === clientWidth` (the page must
never scroll sideways; wide content scrolls inside its own box).

A second class of bug survives *both* DOM assertions and a glance at the code:
the TERRA badge rendered exactly the label it was asked to and was still
unusable, because it sat one row away from a near-identical green. Colour,
contrast and adjacency only fail in the picture — compare elements **against
their real neighbours**, in the real list, at the real size.

Screenshots land in `~/` (not the repo) when driving the deployed URL through
Playwright; `find /home/chihmin -maxdepth 2 -name '<file>.png'` if a relative
path appears to vanish.

### Control both directions

A detector that only ever reports failure is worthless. When adding a check,
prove it can also say "ok":

- history-query staleness: fed it a conversation that *does* exist → `ok`
- side-panel matching: injected a matching row → `ok (side panel row)`
- CSRF: `Origin: https://evil.example` → 403 **and** correct origin → 200
- identity forgery: from another container → connection refused **and** the
  legitimate path → `via: tailscale`

### Test the real deployment, not just localhost

Container↔host-worker integration is where the path/import assumptions break.
The useful end-to-end is: create a session through the **container**, send a
message, confirm the **host worker** ran pi and the reply came back — over the
real HTTPS URL, not `127.0.0.1`.

### Commands

```bash
npm test                      # 47 tests; keep them passing
./node_modules/.bin/tsc --noEmit
npm run build
./scripts/history.py stats    # read-only; safe against a live worker
docker compose logs -f app
journalctl --user -u piweb-worker -f
```

`test/queue-cwd.test.ts` installs a stub transport via `setTransport()` — the
queue no longer imports the Discord client, so module-mocking it does nothing.

---

## 5. UI / UX conventions

Discord-flavoured dark theme, phone first, no framework and no build step —
`public/` is served as-is.

- **iOS specifics**: `100dvh` (not `100vh`, which hides the composer when the URL
  bar collapses); `env(safe-area-inset-*)` padding; inputs at **16px** minimum
  (smaller makes iOS zoom on focus); `viewport-fit=cover`.
- **Layout**: drawer overlays below 768px and becomes a fixed sidebar above it.
  Long content (code, tool output) scrolls inside `overflow-x: auto`; the page
  body never scrolls horizontally.
- **Message rendering**: minimal markdown (fenced code, inline code, bold) built
  from **text nodes only** — never `innerHTML` on model output.
- **Streamed events** (thinking / tool / result) are collapsed `<details>` with a
  one-line peek; `system`/`error` open by default and omit the peek so the text
  is not shown twice.
- **The drawer is ordered by recency: newest activity first.** The key is
  `lastActivity` (`max(web_events.created_at)` for the channel), so anything that
  touches a session — your message, pi's reply, command output — moves it up,
  and a session with a new message lands on top for free
  (`activityKey()` / `sessionsForDisplay()`). Recomputed on **every** render, and
  `lastActivity` arrives fresh from the 5s `loadSessions()` poll (SSE only
  carries the *open* session), so a reply in a background session moves it up
  while the drawer is open.
  - Those timestamps are SQLite `'YYYY-MM-DD HH:MM:SS'` UTC — fixed-width and
    zero-padded, so a **string** compare is already chronological. Do not reach
    for `Date` here; that would also need the `Z` fix (see Timestamps below).
  - A session with no events yet was only just created, so it sorts newest.
  - History: this replaced a state ranking (unread → busy → rest), which itself
    replaced a settle-on-open order. Recency subsumes the "new message on top"
    goal without the ranking's downside of rows jumping between state buckets.
- **Badge colours must survive being next to each other.** TERRA was first shipped
  mint green and was indistinguishable from the LOCAL/GPT greens one row away —
  the label was "correct" and the UI still failed. It is terracotta now (Sol
  amber, Luna slate). Check a new badge colour against its *neighbours in situ*,
  not on its own.
- **Timestamps**: SQLite returns `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker.
  Append `Z` before parsing or Safari reads it as local time and every stamp is
  hours off.
- **The on-screen keyboard changes only the VISUAL viewport.** `vh`/`dvh` track
  the *layout* viewport, which iOS does not shrink for the keyboard. A popover
  sized in `vh` above the composer therefore runs off the top of the screen and
  is clipped rather than scrolling. The autocomplete is a normal flex item
  (not absolutely positioned) so the column bounds it, and `--ac-max` is kept in
  sync with `window.visualViewport` by `syncAutocompleteHeight()`. Test this by
  resizing the viewport short (390×420), not just at 390×844.
- **`highlight()` must never be called with an empty needle.** `indexOf('')`
  returns the search position rather than -1, so its loop never advances — an
  infinite loop that freezes the tab. It is guarded now; the model filter hit
  this because it renders the list before anything has been typed.
- **Session indicators mean two different things.** A spinner = pi is working
  in that session right now; a green dot = it finished and you have not opened
  it since. Different shapes on purpose, so they are tellable apart without
  relying on motion or colour. Unread is tracked client-side in localStorage
  (`piweb.seen`, jid → last read reply id), because "not yet read" is per
  device. `lastReplyId` deliberately counts only assistant/system/error events,
  never the user's own turns or streamed thinking/tool chatter.
  The SSE stream carries only the OPEN session, so the drawer polls
  `/api/sessions` every 5s or every other session's state freezes at page load.
- **Edge swipe opens the drawer**: a drag starting within 28px of the left edge
  pulls the session drawer out, tracking the finger so it is reversible; a
  leftward drag anywhere puts it back. The axis is locked after 8px and a
  vertical lock abandons the gesture entirely, so scrolling is never stolen —
  `preventDefault` is only called once horizontal has won. Disabled above 768px
  (permanent sidebar) and while the lightbox or a sheet is open.
  **Never recover a drag position with `getComputedStyle`** — it depends on a
  style flush, so a fast burst of events reads the stale CSS value and silently
  drops the gesture. Keep the offset in the drag state.
- **Image lightbox**: tapping an image opens an in-app viewer (`openLightbox`)
  rather than a new tab, collecting every image in the transcript so swiping
  pages through them. The overlay sets `touch-action: none` and handles its own
  gestures: the axis is locked by whichever displacement is larger, horizontal
  pages, downward dismisses. Small images are shown at native size rather than
  upscaled — an icon blown up to fill the screen just looks blurry.
- **Selection fires on pointerUP with a movement guard**, never on pointerdown.
  pointerdown selects the moment a finger lands, so dragging the list to scroll
  it picks whatever was underneath. `bindAutocompleteTaps()` treats <10px of
  movement as a tap and anything more as a scroll, and bails on `pointercancel`
  (the browser taking over the gesture). `touch-action: pan-y` leaves vertical
  panning to the browser. Test both directions: a drag must select nothing.
- **Slash commands**: `/` opens command autocomplete; once a command with an
  argument is complete it switches to value suggestions (models come from the
  `meta` table, published by the worker). Selection uses `pointerdown`, since the
  textarea losing focus on `click` would close the list first.
- **Enter** sends on a physical keyboard only (`hover:none and pointer:coarse`
  detects touch); on a phone Return inserts a newline.
- **Reduced motion** is respected for the typing dots and drawer transition.

When changing the UI, re-screenshot every affected state at 390px before claiming
it works.

---

### Push notifications

`src/web/push.ts` tails `web_events` from a cursor in `meta` and sends Web Push
for **assistant replies and errors only** — thinking/tool events would turn one
answer into dozens of buzzes, and `system` events echo a command the user just
issued on that device.

- **iOS only delivers Web Push to a Home Screen app.** Permission cannot even be
  requested from a normal Safari tab, which is why the manifest, the
  apple-touch-icons and `sw.js` all matter.
- VAPID keys live in `meta`, not an env var: regenerating them silently
  invalidates every existing subscription.
- The cursor starts at the current end of the log, so enabling notifications
  never replays history as a burst, and it advances **before** sending so a
  failing endpoint cannot re-notify the same reply every tick.
- 404/410 from a push service means the browser discarded the subscription —
  delete it rather than retrying forever.
- It runs in the web tier because that is where the subscriptions are and the
  half that has a reason to reach the public internet.

### Staying logged in

The cookie-signing key lives in `meta` (`auth.signingKey`), resolved lazily on
first use. It used to be `randomBytes(32)` at module load, so every restart or
redeploy regenerated it and silently invalidated every session cookie —
the reason logins didn't stick across deploys. Persisting it is what makes the
30-day session cookie actually last.

Separately, a successful login stores the token in localStorage
(`piweb.token`) when "Stay signed in" is checked, and boot auto-submits it if
there is no valid session cookie. Logout clears it; a token the server no
longer accepts is dropped rather than retried. This does put the token in
JS-readable storage — a deliberate tradeoff for a personal PIN, not something
to copy for a secret that matters.

## 6. Known gaps

0. **`/pi reset-model` does not take effect until `/pi new`.** Setting a model
   passes `--model` on every spawn, so it applies at once; resetting merely
   stops passing it, and `--continue` then reuses whatever model the session
   file already recorded. Symptom: a session stays on a model you thought you
   reverted (and if that model is broken, every turn fails — seen as
   "Context overflow recovery failed: Summarization failed: 400"). Rotate the
   session to actually clear it.


Not bugs that block anything, but they will surprise someone eventually:

1. **Every attachment is permanently copied to `/tmp/pi-discord-files/<date>/`**
   and never cleaned up — inherited from piscord (the name is now wrong too).
   Each photo sent from the phone leaves a second copy there indefinitely.
2. **Backups must include the WAL.** `gateway.db` can be a few KB while
   `gateway.db-wal` holds most of the data. Copy `-wal`/`-shm` too, or use
   `sqlite3 .backup` / `VACUUM INTO`.
3. **`message_log`** is still written by the queue (piscord legacy) and
   duplicates what `web_events` records.

## 7. The local model backend (port 8001)

piweb doesn't run models; pi does, and pi's `local-llama` provider points every
local model at `http://localhost:8001`. Two llama.cpp MTP services are mutually
exclusive on that port (`Conflicts=`), toggled by the `llama-mtp-service-switcher`
skill:

- `qwen-mtp.service` — Qwen 3.6 35B, loads `--mmproj mmproj.gguf`, so it **can see
  images**.
- `gemma-mtp.service` — Gemma 4, MTP, **no mmproj**, text-only.

Consequences worth knowing:

- **The LOCAL badge can lie about vision.** The badge (and pi's `model_change`)
  records the *alias pi requested* (`qwen3.6-35b-q4`), but llama-server serves
  whatever it actually loaded on 8001. If gemma is up while pi asks for qwen, an
  image gets `500 image input is not supported … mmproj` even though the badge
  says qwen. The queue appends a plain-language hint for that specific error.
- pi's default is already `local-llama/qwen3.6-35b-q4` (`~/.pi/agent/settings.json`),
  and piweb leaves `PI_MODEL` unset so it follows that default.
- To send images to a local model, `qwen-mtp` must be the one running. It is
  `enable`d for boot; `gemma-mtp` is disabled. Switch with the skill, never a
  standalone `llama-server` on 8001.
- Cloud vision models (Gemini, GPT/openai-codex) work regardless of what is on
  8001.

## 8. Session lifecycle (what `/pi new` and delete actually do)

- **`/pi new`** rotates the pi session directory to `<folder>__archived_<ts>` and
  the next message starts a fresh pi session (new UUID). Past context is NOT
  re-injected — verified: a codeword remembered before `/pi new` returns "NONE"
  after. It does **not** clear `web_events`, so the on-screen transcript stays
  while pi's memory resets. The 🗑 header button does both (clear + `pi new`).
- **New session** auto-issues a silent `pi new` with `keepQueue` (invariant 5).
- **Delete** is soft (`deleted_at`); the pi session dir survives until the trash
  is purged. See "Deleting is soft".
- pi holds the context itself via `--session-dir <dir> --continue`; piweb never
  replays history into the prompt, it only points pi at the right directory.
- **A message sent mid-run interrupts it.** piscord did this in its Discord
  message handler (fires before enqueue); piweb's web tier only enqueues and is
  a different process from the worker, so the trigger moved into the worker's
  poll loop: `interruptSupersededRuns()` aborts any channel that is both actively
  processing and has a `pending` message (a `pending` row while active = a
  message sent after the current run started). Gated by `INTERRUPT_ON_NEW_MESSAGE`.
  Without this the new message just queued behind the running one — the spinner
  kept going and nothing interrupted. The interrupt is a Ctrl+C, not a reset:
  the aborted run is SIGTERMed and the new message continues the *same* session
  (`--continue`, context preserved — verified a codeword survives an interrupt),
  with a visible `system`/`interrupt` marker appended via the transport's
  optional `sendNotice`.
- **Interrupted runs self-heal.** A run killed mid-tool-loop (INTERRUPT_ON_NEW_MESSAGE,
  OOM, crash) leaves the session ending on an assistant `toolCall`/`toolResult`
  with no closing reply; pi then refuses the *next* `--continue` with
  "Cannot continue from message role: assistant" and the session is stuck.
  `repairSessionForContinue()` (session/path.ts) runs before every spawn and
  truncates the file back to the last complete assistant reply (text, no pending
  toolCall), keeping a `.prerepair.bak`. Safe because the per-channel serial lock
  means no pi is writing the file at spawn time. This keeps INTERRUPT_ON_NEW_MESSAGE
  usable: interrupt the old run, the new message heals and continues.
- **A killed run resumes; it is not lost.** Exit code **143 = SIGTERM**, i.e. pi
  was *killed*, not crashed — a worker restart (deploys!), a shutdown, or an OOM
  kill. Surfacing the raw "pi exited with code 143" reads as a scary failure, and
  marking the message failed threw away a request the user never got an answer
  to. The 143 branch in `queue.ts` instead calls `requeueMessage(rowid)`: the row
  goes back to `pending`, the next poll re-dispatches it, and because
  `repairSessionForContinue()` drops only the aborted turn's partial work, pi
  `--continue`s the **same session** and re-runs the original message with its
  context intact.
  - Capped at `MAX_SIGTERM_RETRIES` (2) via an in-memory `Map` keyed by message
    rowid, so a message that *reliably* kills pi (deterministic OOM) cannot loop
    forever; past the cap it falls back to `markMessageFailed` + a notice. A
    worker restart resets that counter, which is correct — a restart is a
    one-off, not a loop.
  - The user-interrupt path (`signal.aborted`) is handled *earlier* and must
    never re-queue: there the old message is deliberately abandoned.
  - Two layers: this covers a killed pi child; `recoverStuckMessages()` at
    startup covers a killed *worker* (rows stranded in `processing`).
- **Do not restart the worker while a run is in flight** — it SIGTERMs the user's
  pi and (before the above) silently dropped their message. Check first:
  `select rowid, channel_jid, status from message_queue where status in
  ('processing','pending')`. There is no `sqlite3` CLI on this box; use the
  bundled `better-sqlite3` from `node`.

## 9. This deployment

| | |
|---|---|
| URL | `https://piweb.crayfish-monitor.ts.net/` (**Funnel ON** — public internet) |
| repo | `AyaSakura-comp/piweb` (**private**), remote `ayasakura`; `upstream` = piscord |
| worker | `systemctl --user status piweb-worker` |
| containers | `piweb-app` (web) + `piweb-ts` (tailscale sidecar) |
| data | `~/.local/share/piweb/` |
| worker config | `~/.config/piweb/config.env` (chmod 600) |
| compose env | `~/src/piweb/.env` (chmod 600, gitignored) |

On the **tailnet** the UI opens with nothing to type (Tailscale identity). Over
**Funnel** there is no identity, so `WEB_AUTH_TOKEN` is the only thing in front
of host command execution — keep it long. A short numeric token is brute-forceable
in about a day against the rate limiter; that trade-off was accepted knowingly,
so do not "fix" it unasked, but do not weaken it further either.

Redeploy quick reference:

```bash
# frontend / web tier (public/ is COPYed into the image)
docker compose build app && docker compose up -d     # NOT `up -d app` — see §3
curl -s -o /dev/null -w '%{http_code}\n' https://piweb.crayfish-monitor.ts.net/

# worker (src/agent, src/db, …) — check nothing is in flight first
npm run build && systemctl --user restart piweb-worker
```
