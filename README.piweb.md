# piweb

A mobile web front end for the **pi** coding agent — a Discord-style chat UI you
open from an iPhone browser instead of Discord.

Forked from [piscord](https://github.com/Crokily/pi-discord-gateway). The agent
core (SQLite queue, `agent/*`, `session/*`) is unchanged; Discord was replaced
with a web transport.

## Architecture: two processes, one database

```
  iPhone ──HTTPS──▶  piweb web  (Docker, no pi)
                          │
                          │  SQLite  (web_events / control_queue / message_queue)
                          ▼
                     piweb worker (HOST, systemd)  ──spawns──▶  pi
```

The worker deliberately runs **on the host, not in the container**, so pi keeps
the access that makes it useful here: `systemctl --user`, docker, the ROCm GPU,
and the project checkouts under `~/src`. The web tier has no pi binary and never
spawns one. The two halves communicate only through SQLite (WAL mode).

That split is why commands take the route they do:

| Path         | Why                                                                                |
| ------------ | ---------------------------------------------------------------------------------- |
| Chat message | web writes `message_queue` → worker runs pi → appends to `web_events` → SSE        |
| Command      | web writes `control_queue` → worker runs it → appends to `web_events` → SSE        |
| Model list   | worker publishes to `meta` (listing models spawns pi) → web reads for autocomplete |

`/pi status` spawns pi over RPC, `/pi stop` needs the worker's in-memory
`AbortController`, and `/pi new` must not race an in-flight run — none of which
the web tier can do itself, hence the control queue.

## Design and interaction

See [DESIGN.md](DESIGN.md) for viewer layout, theme tokens, horizontal motion
and Subagents gestures. Swipe right in a child transcript to return to the list;
swipe right again to return to main chat. Pages follow the finger while held;
release completes the return or snaps back based on distance and velocity.
Buttons remain available, and scrolling,
code blocks and text selection are excluded from the navigation gesture.

## Live reply rendering

Assistant replies and thinking use a browser-owned render-first pipeline:
SSE source snapshots → stable Markdown boundary → detached rich render and asset
readiness → hidden font/layout preparation → cached visual rows → one adaptive
left-to-right, row-by-row gradient. Final events reuse compatible partial bodies,
so old text does not replay. Reduced motion shows prepared content immediately;
history paging/reload renders statically. Native EOF retains the preview until
an atomic durable reply/preview transaction and consistent SSE snapshot hand it
off; cancellation still clears unpublished output. Source arrival rate is not
model decode TPS. Submitted-prompt reservation and synchronous layout transactions
keep thinking toggles and finalization from clamping a reader's scroll position.

See [reply reveal software architecture and workflow](docs/render-reveal.md) for
component boundaries, state ownership, sequence/geometry, pacing, cancellation,
scroll/accessibility tradeoffs, deployment and verification limits. The
[final-delivery verification](docs/final-delivery-verification.md) documents the
continuous recording, regression coverage and the frontend/backend deployment split.

## AGY activity viewers

AGY models delegate execution to the Antigravity CLI; PiWeb displays its
observed events rather than replacing its tools or scheduler.

- **⋯ → Subagents** shows explicitly labelled AGY child transcript snapshots
  alongside native Pi children. See [Subagents](docs/subagents.md).
- **⋯ → 背景命令 · AGY** shows commands, a running spinner, output and separately
  observed AGY follow-up activity. It uses an edge-to-edge full-screen layout
  with the Subagents theme, not a floating window. See the
  [command manager](docs/agy-command-manager.md).

The command manager is implemented and tested in an isolated real PiWeb/AGY
stack but **has not been deployed as part of this work**. CLI exit without a
completion event is **Unknown**, not success. Stream-input reconciliation and
child watcher lifecycle guards now have regression coverage; successful
walkthroughs are not proof that every detached task survives process failure.

See [recent AGY changes and verification status](docs/agy-observability-status.md)
for test commands, evidence, known blockers and deployment scope.

## Extension-owned replies

Displayed Pi extension receipts/previews are used when no assistant text is returned.
In persistent RPC, an extension-consumed prompt completes on `input_handled` without
waiting for an agent run that never starts. Hidden custom messages stay hidden;
ordinary assistant text takes precedence. No new confirmation command is introduced.
See [extension reply semantics and verification commands](docs/extension-replies.md).

## Claude Code bridge

An opt-in `claude-code/*` provider runs a persistent Claude Code TUI in tmux on
the worker host, with HAIKU / SONNET / OPUS model badges. It uses autonomous
host permissions and separate Claude memory. Background Bash/Monitor work keeps the
parent turn alive; yielded replies are published to history without repeating the final
already-delivered reply. See [setup, security, lifecycle and
verification](docs/claude-tmux-bridge.md) before enabling `CLAUDE_TMUX_ENABLED`.

## Conversation continuity across harnesses

PiWeb can switch a single visible chat between native Pi (`openai-codex/*`,
`local-llama/*`, etc.), Antigravity (`agy/*`) and Claude Code (`claude-code/*`).
The **next actual message** after a cross-harness switch receives a bounded,
source-labelled excerpt of previously completed PiWeb user/assistant dialogue
and recorded tool calls/results, plus a private read-only history snapshot path.
Tool records are bounded, possibly truncated UI summaries, quoted as evidence
rather than executable calls. Each harness still owns its
original session, tools and permissions: this is context handoff, not native
state migration. Failed/aborted turns can retry without consuming the target's
cursor. `/pi new` starts fresh without reimporting the old visible chat.

**Switching models within Pi does not invoke this handoff.** It continues Pi's
own session and therefore keeps Pi's native history. See
[architecture, exact workflow, limits, reset rules and tests](docs/cross-harness-context.md).

## Commands

Full parity with piscord. Type `/` in the composer for autocomplete (command
names, then values for the argument — models come from pi's live list).

`/pi status` · `/pi model <model>` · `/pi reset-model` · `/pi thinking <level>` ·
`/pi new` · `/pi stop` · `/pi cwd <path>` · `/pi reset-cwd` · `/pi gpt-usage` ·
`/until goal <text>` · `/until status` · `/until stop` · `/gpt-usage`

For Claude Code **Opus / Sonnet / Haiku**, the header usage button runs
`/claude-usage` and displays the host Claude subscription's current five-hour
and weekly utilization with reset times. AGY-hosted Claude continues to use
Antigravity quota. See [Claude usage](docs/claude-usage.md) for authentication,
caching and verification scope.

GPT usage is self-contained in this repository (`src/gpt-usage.ts`): it reads
pi's `~/.pi/agent/auth.json`, refreshes the `openai-codex` OAuth token when
needed, and aborts its minimal Codex request after receiving the rate-limit
headers. The same implementation powers the web command, inherited Discord
slash command, and bundled CLI:

```bash
npm run build
node dist/cli/gpt-usage.js          # Traditional Chinese report
node dist/cli/gpt-usage.js --json   # machine-readable output
```

Sessions are created instantly from the drawer—there is no naming dialog. As
soon as the first normal prompt is accepted, an in-process statistical ranker
replaces **New session** with an extractive title of at most 10 visible characters. It
preserves the prompt's original writing system and uses no language model,
network call, or model context. Sessions can be moved to **Recently deleted**
from either the drawer row or **Delete session** in the ⋯ menu; both use the
same restorable soft-delete flow. In **Recently deleted**, tap **Select** or
long-press a row to choose several sessions, then permanently delete the
selection with one confirmation; **Delete all** deletes every session currently
shown without catching unseen concurrent changes. The same controls appear in
a centered desktop dialog, where holding the mouse button also enters selection
mode. Use **New pi session** (`/pi new`) when the goal is to rotate the agent
context without deleting the Piweb session.

### Life mode

On a phone, start within 56 px of the **right edge** and swipe left, or tap the
48×64 px water-drop leaf to open automatically. Its rounded body sits inside
`.main` while its pointed tip meets the page's right edge, so the drop inherits
one page transform instead of being animated separately. They follow the finger,
progressively revealing Life underneath, then use release velocity to settle
after 22% of the viewport or a shorter projected fast flick. A balanced 150–320ms
page ease keeps part of the source page visible during travel. Destination
navigation starts only after the source is fully covered, so a fast response
cannot replace it mid-motion; once ready, the underlay crossfades into the real
transcript instead of cutting.
During settlement it blocks the underlying session and offers **Cancel**, so a
delayed load cannot receive accidental input. Life reuses one
protected channel, resolves Pi's exact runtime-default model and effective
thinking level before every turn, and hides channel/model management. Its header
shows **Sessions / Life / DEFAULT**, puts the generation-bound **pi status** shortcut
beside a dedicated **New Life session** pencil and the ⋯ button, and keeps
**Search** and **Media** in that menu. New
Life session promotes the current transcript, media, and Pi folder into the
ordinary Sessions list under an extractive title, then opens a brand-new empty
Life session. Tap **Sessions**, or swipe right from the phone's left edge, to
settle the Life page right over a Sessions underlay, crossfade, and return to the
last standard session. If there is
no standard session, returning or rolling back a failed Life load clears the Life
stream and composer destination and shows `no session`. The selected presentation
mode survives reloads on that device.

See [`docs/life-mode.md`](docs/life-mode.md) for the user workflow, software
architecture, per-turn sequence, persistence model, race guards, and verification
graph.

## Settings

Open **Sessions → Settings** to manage Recently deleted sessions, notifications,
appearance, Pi subscriptions, and the current Piweb login. On phones Settings is a
full-height page with a native-feeling horizontal transition; on wider screens it
opens as a centered dialog. On phones, **Recently deleted** is a separate
full-height page that slides in from the right over Settings; Back reveals the
unchanged Settings page and restores keyboard focus. Wider screens retain a
contained dialog while using the same list and selection workflow.

### Notifications

Notifications use a switch in Settings. Web Push on iOS/iPadOS requires Piweb to be
installed with **Share → Add to Home Screen** and opened from that icon. The
permission request runs directly from the switch tap, before any asynchronous
service-worker setup, because WebKit requires notification permission to be
requested during the original user activation. If permission was previously
denied, re-enable Piweb under **iOS Settings → Notifications**.

The service worker is intentionally push-only and does not cache the app shell.
VAPID keys persist in the shared database, while browser subscriptions are stored
in `push_subscriptions`; expired Apple Push Service subscriptions are removed after
a 404 or 410 response.

### Appearance

Piweb starts in dark mode. Use **Settings → Appearance** to switch themes. The
choice is saved in `localStorage` under `piweb.theme` and applied before the
stylesheet loads, so a saved light theme does not flash dark during startup.

The light appearance uses a Japanese-minimal palette: a white main canvas, warm
washi-toned secondary surfaces, sumi-like text, fine stone-coloured separators,
and a restrained aizome blue-grey accent. Tool cards are flat in light mode, with
semantic colour limited to quiet edge markers and controls. Fenced code and command
output also use a warm paper surface with a dedicated low-saturation syntax palette;
dark mode keeps its original dark code canvas. If browser storage is unavailable or
contains an invalid value, Piweb safely falls back to dark mode.

### Pi agent subscriptions

**OpenAI Codex** connects Pi to a ChatGPT Plus/Pro subscription through OpenAI's
device-code flow. Piweb displays only the temporary verification URL, user code,
and public job status. The web container queues login/logout work in
`subscription_jobs`; the host worker performs it through Pi's `ModelRuntime` and
stores credentials only in Pi's host-side `auth.json`. OAuth access and refresh
tokens are never written to the Piweb database.

The Settings client polls `GET /api/subscriptions/openai-codex` while a login is
active, starts one with `POST`, and disconnects with `DELETE`. Closing Settings
stops polling without cancelling the host-side login job.

## Authentication

This endpoint can make pi run arbitrary commands on the host, so it always
authenticates. Being on the tailnet is _not_ sufficient on its own: any website
open in a browser on any tailnet device can issue POSTs to a tailnet URL — the
same-origin policy blocks reading the reply, not sending the request.

Two ways in:

1. **Tailscale identity (default behind `tailscale serve`).** serve injects
   `Tailscale-User-Login`; piweb trusts it **only for loopback connections**,
   which is why `WEB_HOST` defaults to `127.0.0.1` — anything able to open the
   port directly could otherwise just set the header itself. Restrict further
   with `WEB_ALLOWED_LOGINS`. Nothing to type on the phone.
2. **Shared token** (`WEB_AUTH_TOKEN`) exchanged for an HttpOnly cookie. Used
   for local/dev access or any deployment not behind serve.

The server refuses to start unless at least one of the two is configured.

**CSRF is handled separately, and identity headers do not solve it**: serve
stamps the device's identity onto _every_ request the browser makes, including
one triggered by a hostile page. Every state-changing request is therefore also
checked against `WEB_PUBLIC_ORIGIN` (`Origin` / `Sec-Fetch-Site`) and rejected
with 403 if it comes from elsewhere.

## Setup

### 1. Prerequisites and source checkout

The split deployment below targets **Linux with systemd user services**. Install
Git, **Node.js >=22.19.0** with npm, OpenSSL, Docker Engine and Docker Compose v2
(`docker compose`, not the older `docker-compose`). Your normal user must be able
to run Docker. Native `better-sqlite3` compilation may also require Python 3,
Make and a C/C++ compiler if a prebuilt binary is unavailable. You need a
Tailscale account, a usable model/provider, and permission to execute agent tools
on this host. A GPU, ROCm, llama.cpp, KV-cache extensions, Claude Code, AGY and
Breeze ASR are **optional**, not installation prerequisites.

```bash
mkdir -p "$HOME/src"
git clone https://github.com/AyaSakura-comp/piweb.git "$HOME/src/piweb"
cd "$HOME/src/piweb"
node --version
docker compose version
npm ci
npm run build
./node_modules/.bin/pi
```

In Pi, use `/login` for subscription/OAuth providers and `/model` to select a
working model, then exit. API-key or local-model providers can use their normal
Pi configuration instead. Run this as the **same user** who will run the worker. `npm ci` installs the
repository's pinned Pi packages (currently 0.84.1) and the local `pi` executable;
you do not need an unrelated globally installed/latest Pi. Credentials stay in
that user's Pi configuration, normally `~/.pi/agent/auth.json`, not in the web
container. `npm run build` compiles TypeScript **and** builds the pinned LobeHub
reply-renderer browser bundle; running `tsc` alone is insufficient.

**Do not use `piscord setup` or `npx piscord@latest setup` to install PiWeb.**
Those commands configure the optional Discord gateway, not this web/worker split.

### 2. Shared configuration (fresh installation only)

The following blocks assume Bash and one shell session in the checkout. Replace
the example hostname with the actual PiWeb node hostname for your tailnet. Do not
run these file-generation steps over an existing installation: keep its token,
paths, provider settings and data, and follow the update section instead.

```bash
REPO_DIR=$(pwd -P)
PIWEB_DATA="$HOME/.local/share/piweb"
PI_CWD="$HOME/src"
PIWEB_FQDN=piweb.YOUR-TAILNET.ts.net  # replace before continuing
NODE_BIN=$(command -v node)

# Refuse to overwrite an existing installation's configuration.
if [ -e .env ] || [ -e "$HOME/.config/piweb/config.env" ]; then
  echo 'Existing installation: use the update instructions instead.'
  exit 1
fi
umask 077
mkdir -p "$HOME/.config/piweb" "$HOME/.config/systemd/user" \
  "$PIWEB_DATA/sessions" "$PIWEB_DATA/web-media" "$PIWEB_DATA/web-uploads"
WEB_AUTH_TOKEN=$(openssl rand -hex 24)

cat > "$HOME/.config/piweb/config.env" <<EOF
PIWEB_DATA=$PIWEB_DATA
DB_PATH=$PIWEB_DATA/gateway.db
SESSIONS_DIR=$PIWEB_DATA/sessions
WEB_MEDIA_DIR=$PIWEB_DATA/web-media
WEB_UPLOAD_DIR=$PIWEB_DATA/web-uploads
PI_BIN=$REPO_DIR/node_modules/.bin/pi
PI_CWD=$PI_CWD
WEB_AUTH_TOKEN=$WEB_AUTH_TOKEN
WEB_PUBLIC_ORIGIN=https://$PIWEB_FQDN
STREAM_THINKING=true
STREAM_TOOLS=true
CLAUDE_TMUX_ENABLED=false
AGY_ENABLED=false
VOICE_ASR_ENABLED=false
LOG_LEVEL=info
EOF

cat > .env <<EOF
PIWEB_DATA=$PIWEB_DATA
PI_CWD=$PI_CWD
WEB_AUTH_TOKEN=$WEB_AUTH_TOKEN
WEB_PUBLIC_ORIGIN=https://$PIWEB_FQDN
WEB_ALLOWED_LOGINS=
TS_AUTHKEY=
LOG_LEVEL=info
EOF
chmod 600 .env "$HOME/.config/piweb/config.env"
```

Set `TS_AUTHKEY` in `.env` to a suitable Tailscale node-registration key for the
first start; once `ts-state/` contains the authenticated node, it can be cleared.
Never commit either configuration file or share token-bearing command output.
Optionally restrict tailnet identity access with `WEB_ALLOWED_LOGINS` in `.env`.
The supplied `.env.example` and `.env.piweb.example` list more options, but their
`/home/chihmin/...` paths are examples, **not portable defaults**.

The host reads `~/.config/piweb/config.env` by default (`PIDG_CONFIG` can select
another file). Config precedence is checkout `.env` → config file → process
environment, with later values winning. Docker Compose reads the checkout `.env`
and passes the web-tier settings explicitly. Keep `PI_CWD` identical on both
sides, and keep the database, sessions, media and upload paths under the same
absolute `PIWEB_DATA` path. Do not replace the container mount with `/data`:
attachments contain absolute paths that the host worker must be able to open.

Compose runs the app as `1000:1000`. If your user/group IDs differ, create a local
`docker-compose.override.yml` before starting containers (do not commit it):

```bash
# Only needed when id -u / id -g are not both 1000.
cat > docker-compose.override.yml <<EOF
services:
  app:
    user: "$(id -u):$(id -g)"
EOF
```

### 3. Tailscale HTTPS: private by default

**Before the first container start**, replace the checkout's `ts-serve.json` with
your own hostname and no `AllowFunnel`. The bundled file contains a deployment-
specific hostname **and enables public Funnel**, so do not deploy it unchanged.

```bash
cat > ts-serve.json <<EOF
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "$PIWEB_FQDN:443": {
      "Handlers": { "/": { "Proxy": "http://127.0.0.1:8099" } }
    }
  }
}
EOF
```

This keeps access on the tailnet. Tailscale identity is accepted only from the
loopback Serve proxy; tagged devices without a user identity need the shared
token. Do not publish port 8099 or widen `WEB_HOST` while trusting identity headers.
For **explicitly requested public access**, add an `AllowFunnel` object mapping
`"<your-actual-hostname>:443"` to `true`, and allow Funnel in your tailnet policy.
Public visitors must log in with the shared token; Funnel requests do not receive
trusted tailnet identity. Both modes enforce same-origin checks for browser
writes. `WEB_PUBLIC_ORIGIN` must match the URL actually used, without a trailing
slash. This interface gives authenticated users agent access to your host.

### 4. Host worker and Docker web tier

Install the worker unit and a local drop-in. The drop-in uses your actual Node
and checkout paths, so nvm/custom installs do not rely on `/usr/bin/node` or on
an interactive shell's PATH. The copied unit runs from your home directory;
`PI_CWD` controls the agent's default project directory.

```bash
cp deploy/piweb-worker.service "$HOME/.config/systemd/user/"
mkdir -p "$HOME/.config/systemd/user/piweb-worker.service.d"
cat > "$HOME/.config/systemd/user/piweb-worker.service.d/paths.conf" <<EOF
[Service]
ExecStart=
ExecStart="$NODE_BIN" "$REPO_DIR/dist/cli/piweb.js" worker
Environment="PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:$HOME/bin:$REPO_DIR/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
EOF
systemctl --user daemon-reload
systemctl --user enable --now piweb-worker.service

# Validates interpolation without printing the shared token.
docker compose config --quiet
docker compose up -d --build
```

For a headless server, an administrator can run
`sudo loginctl enable-linger "$USER"` so the user service survives logout.
The worker must run on the host; do not set `WEB_EMBEDDED_WORKER=true` in this
split deployment. No Discord token or Discord daemon is required.

### 5. Verify and open the app

```bash
systemctl --user status piweb-worker.service --no-pager
journalctl --user -u piweb-worker.service -n 50 --no-pager
docker compose ps
docker compose logs --tail=50 app tailscale
docker compose exec tailscale tailscale status
docker compose exec tailscale tailscale serve status
docker compose exec tailscale wget -q -O /dev/null http://127.0.0.1:8099/
curl --fail --silent --show-error -o /dev/null "https://$PIWEB_FQDN/"
```

If Tailscale assigned a different node name because `piweb` already exists, use
the actual DNS name from `tailscale status` in `ts-serve.json` and
`WEB_PUBLIC_ORIGIN`, then recreate app **followed by** tailscale as below.
Open the HTTPS URL from a tailnet device. If a token login is shown, retrieve the
shared token privately from your config file. Create a disposable session and send
one short prompt to verify a **completed agent reply**, then try an attachment;
an HTTP 200 alone does not prove the worker, provider or upload paths work.
For iOS notifications, use **Share → Add to Home Screen** and launch from that icon.

### Updating an existing installation

Use a clean checkout; do not discard local changes or overwrite configuration,
`ts-state/`, shared data or Pi credentials. Back up the database with a SQLite-
aware backup (WAL is enabled), plus sessions/media and configuration. From an
**external administrator terminal**, wait until all agent turns and background
work are idle before stopping or restarting the worker. Never synchronously
restart the worker from an agent turn running inside its own service.

```bash
set -e  # stop this update sequence if any build/install command fails
systemctl --user stop piweb-worker.service
# In the checkout; resolve any local changes before pulling.
git pull --ff-only
npm ci
npm run build
# Rebuild before recreating either container; do not proceed if it fails.
docker compose build app
systemctl --user start piweb-worker.service
docker compose up -d --no-build --force-recreate app
docker compose up -d --no-build --force-recreate tailscale
```

Recreating app changes its network namespace: recreate the Tailscale sidecar
**after app** or it can retain the old namespace and return HTTP 502. Repeat the
verification steps and refresh open browser tabs. A frontend-only update does
not by itself require restarting the host worker. Do not run the optional
Discord daemon commands below to manage `piweb-worker.service`.

Common setup failures:

| Symptom                           | Check                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Compose rejects an unset variable | Both `PIWEB_DATA` and `PI_CWD`, plus a nonempty `WEB_AUTH_TOKEN`, must be in `.env`.                  |
| SQLite/upload permission error    | Container UID/GID must own or have access to the shared directory; use the local user override above. |
| Agent executable not found        | Verify absolute `PI_BIN`, local Pi install and the systemd drop-in's Node/PATH settings.              |
| UI loads but no reply/model list  | Check worker logs, provider credentials and whether a valid model is configured.                      |
| Text works but attachments fail   | Check identical absolute storage paths and directory ownership in both tiers.                         |
| HTTP 403 on writes                | Check the actual HTTPS origin against `WEB_PUBLIC_ORIGIN`; do not disable CSRF checks.                |
| Tailscale HTTPS fails / HTTP 502  | Check registration, actual hostname, Serve config and app-then-sidecar recreation order.              |

Automatic first-prompt titles are computed in-process; no separate title model,
provider credential, network service or GPU setup is required. Optional Claude
Code, AGY, KV-cache and ASR integrations have separate requirements and should be
enabled only after the basic Pi installation works.

## Running it all in one process

For development, or a container that also runs pi (giving up host access):

```bash
node dist/cli/piweb.js all      # worker + web
node dist/cli/piweb.js worker   # worker only
node dist/cli/piweb.js web      # web only
```

`WEB_EMBEDDED_WORKER=true` makes `web` mode run the worker in-process.

## Browser E2E, video, and visual regression tests

For the **real pi-btw bridge** (not the mocked UI fixture), start a disposable
loopback-only PiWeb `all` process using a separate `DB_PATH`, `SESSIONS_DIR`,
`WEB_MEDIA_DIR`, `WEB_UPLOAD_DIR`, `PI_CWD`, and `WEB_AUTH_TOKEN`, with
`RPC_STEER=true`, Pi >=0.85.1, and the pi-btw extension installed. Never point
this test at a normal PiWeb database or publish its token. Then run:

```bash
PIWEB_BTW_LIVE_URL=http://127.0.0.1:<isolated-port> \
PIWEB_BTW_LIVE_TOKEN=<isolated-token> \
npx playwright test --config=playwright.btw-live.config.ts --workers=1
```

`test/e2e/btw-live-video.spec.ts` verifies a real busy main Pi turn, BTW reply
through the shared composer without main-stream contamination, page navigation
recovery, and another session's isolation. It records one mobile WebM; transcode
with `~/.pi/agent/skills/software-development/playwright-e2e-visual-testing/scripts/webm-to-mp4.sh`.
Evidence stays in ignored `artifacts/playwright/btw-live-results/`. This test
uses the configured model, so enable it explicitly only in a disposable
workspace; it does not cover real-device keyboards or BTW-specific Stop.

BTW uses a slim **BTW 側聊** header with back/clear icons and horizontal swipe
navigation. While a side answer is pending, **BTW 回答中 ›** opens its transcript;
the main composer and other session controls remain usable. Reloading or switching
sessions restores pending side questions from the worker snapshot.
**清除 BTW** confirms before clearing the native side thread, without deleting main
messages; it is disabled while answering. See [BTW workspace](docs/btw-workspace.md)
for API/generation safeguards, tests and the coordinated web/worker deployment requirement.

The Playwright suite runs end to end against deterministic local fixtures at the
production phone viewport (390×844). Every test records a WebM video; visual tests
also compare rendered pixels with reviewed PNG baselines. Current coverage includes
syntax highlighting, persisted light/dark switching, the Japanese-minimal light
palette, drawer/sheet foreground layering, click-to-expand YouTube embeds with
external fallback, the in-app video/audio player with real download actions,
touch transcript selection without Safari's document-wide native selection,
Recently deleted touch/mouse long-press and button multi-selection, Delete all,
Settings navigation and the OpenAI device-code connect/copy/complete/disconnect workflow,
phone containment, and a centered desktop dialog, plus a 500-message continuous
upward history stress run across all nine older-page
boundaries without a jump:

```bash
npm run test:e2e                                      # full behavior + visual suite
npx playwright test test/e2e/media-player.spec.ts    # video/audio player + downloads
npx playwright test test/e2e/markdown-links.spec.ts  # inline YouTube open/replace/close workflow
npx playwright test test/e2e/text-selection.spec.ts  # touch selection + quote preview
npx playwright test test/e2e/history-scroll.spec.ts  # 500 rows + nine delayed, partially loaded touch boundaries
npx playwright test test/e2e/settings-subscription-vision.spec.ts # Settings + OpenAI device-code state machine
npx playwright test test/e2e/life-mode.spec.ts --grep "Recently deleted|purging the active"
npm run test:e2e:update                               # accept pixels only after review
```

The inline-player URL allowlist, lifecycle, security, mobile geometry, and video
verification contract are documented in [`docs/youtube-inline-player.md`](docs/youtube-inline-player.md).

Videos, failure screenshots, traces, and the HTML evidence report are written to
`artifacts/playwright/` (gitignored). Reviewed baselines live under
`test/e2e/__screenshots__/` and are committed. The report can be opened at
`artifacts/playwright/report/index.html`. To inspect a recorded run directly:

```bash
find artifacts/playwright/test-results -name '*.webm'
ffprobe -v error -show_entries stream=codec_name,width,height \
  -show_entries format=duration,size <video.webm>
```

Do not commit generated WebM videos, traces, or reports, and do not update a
baseline until its pixels have been inspected.

Live-account scroll checks are opt-in so normal tests never send messages to a
real session. Point them at a disposable test session: command output and the
quoted-reply probe remain in its transcript.

```bash
PIWEB_E2E_LIVE_URL=https://piweb.example/ \
PIWEB_E2E_TOKEN=... npm run test:e2e
```

## Notes

- **Live updates** use SSE, resumed by event id, so a phone that slept through a
  long run replays exactly what it missed instead of losing it. Every message,
  thinking block, tool call and command result is persisted in `web_events` —
  the transcript survives reconnects and restarts.
- **Thinking & Tool Accordions**: Streamed reasoning and tool executions render inside
  smooth, physics-animated collapsible cards (`grid-template-rows: 0fr -> 1fr`) with animated chevrons
  and pop-in slide-up inertia, keeping intermediate chatter neatly contained.
- **Apple-Style Text Selection & Quoting**: Custom selection overlays with iOS lollipop handles
  and a frosted glass floating action toolbar (`Quote`, `Copy`, `Dismiss`).
- **Camera & Photo Batches**: Drag Send upward for a bottom camera pane that follows the finger and settles to a
  2:3 portrait preview. A separate shutter stages removable photos; the Send button beside it uploads the batch
  and text. Send immediately rebounds the camera closed; photos clear only on success and remain retryable on failure. Fuji-style simulated
  focus/aperture and pinch zoom are available; simulated blur is off by default. See
  [camera controls, privacy, retry behavior and verification limits](docs/camera-composer.md).
- **Multimedia & Attachments**: Clipboard paste (`btn-paste` and `Ctrl+V`/`Cmd+V`) and file upload support
  images (PNG, JPEG, WebP, GIF, SVG), audio (MP3, WAV, M4A, AAC, OGG, FLAC), video (MP4, MOV, WebM, MKV), and documents (PDF).
  Voice notes and audio files receive automatic Breeze ASR transcription. Tapping an image or video opens a shared
  session album at that item, including attachments outside the loaded transcript page. Videos use poster cards in chat
  and native playback controls in the album; leaving a video or closing the viewer unloads it. Audio keeps its separate
  in-app player. Image prefetch is limited to a sliding window, not the whole album.
  See [image/video album behavior and verification](docs/media-album.md).
  Static JPEG/PNG uploads are resized in the browser by default (at most 541,200 total
  pixels, equivalent to 528×1025; aspect ratio preserved, no upscaling). Uncheck **壓縮圖片** beside pending images to send
  original bytes; the choice is remembered. Animated/unsupported formats remain original.
  See [image compression behavior and verification](docs/image-compression.md).
- **Markdown & List Rendering**: Rich typography supporting secure clickable links nested inside bold/italic/strike text, loose ordered and unordered lists (preserving continuous numbering across blank lines and custom `<ol start="N">` offsets), indented multi-line item continuations, and deeply nested sub-bullets, rendered safely from text nodes without raw HTML injection. YouTube watch, short, Shorts, live, and embed links get a 44px play affordance; a normal click lazily opens one privacy-enhanced inline player per message with `playsinline=1`, **Open in YouTube**, and **Close** controls. The standard assistant card is 16:9; narrower user/event columns keep YouTube's 200px minimum player height instead of clipping controls. Modified clicks keep normal external navigation, channel/lookalike URLs never embed, and replacing or closing a player destroys its iframe so playback stops. See [`docs/youtube-inline-player.md`](docs/youtube-inline-player.md) for the complete validation, security, lifecycle, accessibility, and verification contract.
- **Syntax-highlighted Code Blocks**: Fenced code uses the declared language when available and highlight.js auto-detection when the language tag is omitted or unknown. The browser build is vendored, so highlighting works without a CDN.
- **Mermaid Diagram Rendering & Touch Gestures**: Markdown code blocks with `mermaid` (`flowchart`, `pie`, `sequenceDiagram`, `stateDiagram`, `classDiagram`, `gantt`, `gitGraph`, `mindmap`, etc.)
  automatically render into crisp vector SVG diagrams using one restrained 12-color Japanese palette (moss, blue-grey, rust, tea, pine, muted violet, celadon, walnut, olive, indigo, adzuki, and warm slate) across every chart type. Wide Gantt charts use a readable 1000px canvas with expanded label spacing and horizontal scrolling instead of compressing labels into the phone viewport. Includes two-finger pinch-to-zoom (0.2x–5x), single-finger pan, double-tap zoom toggle, fullscreen zoom modal, diagram-type labels, and one-click code copying.
- **Recency-First Session Management**: Session list and initial home page load automatically default to the most recently updated session (`lastActivity DESC`).
- **iPadOS Window Multitasking Clearance**: Topbar layout incorporates dynamic safe area padding (`padding-left: max(60px, ...)`) to prevent obstruction by iPadOS system multitasking pills (`•••`).
- **Self-Healing & OOM Auto-Resume**: Interrupted runs (SIGTERM / SIGKILL code 143/137) during heavy local inference
  automatically requeue and resume with session context preserved.
- **Uploads** are capped by `MAX_ATTACHMENT_BYTES`; they are sent base64 in JSON
  rather than multipart to keep the container dependency-free. Browser-reported size, upload time and response time
  are logged as `Upload metrics`, without filenames or content. Timings are not yet displayed in the UI;
  refresh the page after deployment to enable recording. Attachment requests have an explicit
  five-minute browser/server receive deadline; expiry reports an error without automatically
  retrying the message. See [upload diagnostics and deadlines](docs/upload-metrics.md).
