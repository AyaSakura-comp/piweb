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

```
src/agent/       pi core, inherited from piscord — avoid editing
src/session/     session dirs, media, archive cleanup — inherited
src/db.ts        schema + queries (piweb tables added at the bottom)
src/transport/   index.ts = interface; web.ts = persist to web_events
src/commands/    catalog.ts = pure data; index.ts = implementations (worker-only)
src/web/         server.ts (node:http, no framework), auth.ts
src/worker/      index.ts (startup), control.ts (control queue loop)
src/cli/piweb.ts entrypoint: worker | web | all
public/          index.html, app.css, app.js — no build step, no framework
scripts/history.py  read-only history query CLI
deploy/          piweb-worker.service
```

### How a turn flows

1. `POST /api/sessions/:jid/messages` → web appends a `user` row to `web_events`
   (so the phone echoes instantly) and enqueues into `message_queue`.
2. Worker's queue loop claims it, runs pi, and streams events through the
   installed transport → more `web_events` rows.
3. Web tails `web_events` by rowid and pushes them over SSE.

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

**Funnel is deliberately OFF.** This endpoint can run arbitrary commands on the
host — unlike fuji-camera (photos), the blast radius is the whole machine. Do not
enable it without an explicit decision.

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

Recreating the `app` container also breaks the sidecar's shared netns — restart
(`docker compose up -d tailscale`) afterwards.

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

## 6. Known gaps

Not bugs that block anything, but they will surprise someone eventually:

1. **Every attachment is permanently copied to `/tmp/pi-discord-files/<date>/`**
   and never cleaned up — inherited from piscord (the name is now wrong too).
   Each photo sent from the phone leaves a second copy there indefinitely.
2. **Backups must include the WAL.** `gateway.db` can be a few KB while
   `gateway.db-wal` holds most of the data. Copy `-wal`/`-shm` too, or use
   `sqlite3 .backup` / `VACUUM INTO`.
3. **`message_log`** is still written by the queue (piscord legacy) and
   duplicates what `web_events` records.

## 7. This deployment

| | |
|---|---|
| URL | `https://piweb.crayfish-monitor.ts.net/` (tailnet only, no Funnel) |
| repo | `AyaSakura-comp/piweb` (**private**), remote `ayasakura`; `upstream` = piscord |
| worker | `systemctl --user status piweb-worker` |
| containers | `piweb-app` (web) + `piweb-ts` (tailscale sidecar) |
| data | `~/.local/share/piweb/` |
| worker config | `~/.config/piweb/config.env` (chmod 600) |
| compose env | `~/src/piweb/.env` (chmod 600, gitignored) |

Auth is Tailscale identity, so the UI opens with nothing to type; the token in
`WEB_AUTH_TOKEN` remains as the fallback path.
