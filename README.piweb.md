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

## Commands

Full parity with piscord. Type `/` in the composer for autocomplete (command
names, then values for the argument — models come from pi's live list).

`/pi status` · `/pi model <model>` · `/pi reset-model` · `/pi thinking <level>` ·
`/pi new` · `/pi stop` · `/pi cwd <path>` · `/pi reset-cwd` · `/pi gpt-usage` ·
`/until goal <text>` · `/until status` · `/until stop` · `/gpt-usage`

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
network call, or model context. Sessions are deleted from the drawer. The 🗑
button in the header is **clean session**: it clears the transcript _and_ rotates
pi's session directory, so the agent's context is genuinely reset rather than
just visually cleared.

### Life mode

On a phone, start at the **right edge** and swipe left. The preview follows the
finger and opens after crossing one-third of the viewport. Life reuses one
persistent conversation, resolves Pi's exact runtime-default model and effective
thinking level before every turn, and hides session/model management. Its header
shows **Sessions / Life / DEFAULT** with a ⋯ menu limited to **Search** and
**Media**; tap **Sessions** to return to the last standard session. If there is
no standard session, returning or rolling back a failed Life load clears the Life
stream and composer destination and shows `no session`. The selected presentation
mode survives reloads on that device.

See [`docs/life-mode.md`](docs/life-mode.md) for the user workflow, software
architecture, per-turn sequence, persistence model, race guards, and verification
graph.

## Appearance

Piweb starts in dark mode. Open **Sessions** and use the appearance action below
**Notifications** to switch themes. The choice is saved in `localStorage` under
`piweb.theme` and applied before the stylesheet loads, so a saved light theme does
not flash dark during startup.

The light appearance uses a Japanese-minimal palette: a white main canvas, warm
washi-toned secondary surfaces, sumi-like text, fine stone-coloured separators,
and a restrained aizome blue-grey accent. Tool cards are flat in light mode, with
semantic colour limited to quiet edge markers and controls. Fenced code and command
output also use a warm paper surface with a dedicated low-saturation syntax palette;
dark mode keeps its original dark code canvas. If browser storage is unavailable or
contains an invalid value, Piweb safely falls back to dark mode.

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

### 1. Configuration

```bash
cp .env.piweb.example ~/.config/piweb/config.env
openssl rand -hex 24                     # put this in WEB_AUTH_TOKEN
mkdir -p ~/.local/share/piweb
```

### 2. Worker (host)

```bash
npm install && npm run build
cp deploy/piweb-worker.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now piweb-worker
```

### 3. Lightweight session-title ranker

Automatic names never call the conversation model. The web tier segments the
first prompt with built-in `Intl.Segmenter`, generates short candidate spans,
and scores them before the message response returns. The worker retains the same
path only as a crash-recovery fallback. Features cover content,
request/stop words, position, length, skipped words, technical identifiers, and
filenames. Generic text can fall back to quoted context or an attachment name.

The ranker runs in-process without a model file, native binary, provider
credential, network request, GPU allocation, or KV cache. It does not translate
or run OpenCC: Traditional Chinese, Simplified Chinese, Japanese, and English
characters remain as typed. No title-specific environment variables are needed.

### 4. Web tier (Docker)

```bash
# .env next to docker-compose.yml
echo "PIWEB_DATA=$HOME/.local/share/piweb" >> .env
echo "WEB_AUTH_TOKEN=<the same token>"     >> .env

docker compose up -d --build
```

Then expose it with the bundled Tailscale sidecar. `ts-serve.json` sets
`AllowFunnel`, which publishes it to the **public internet**; drop that key to
keep it tailnet-only.

With Funnel on, the shared token is the only thing protecting an endpoint that
runs commands on your host: use a long random one, and note that Tailscale
identity auth is deliberately refused for public requests.

> **Path gotcha:** `PIWEB_DATA` is mounted at the _same absolute path_ inside the
> container as on the host. The web tier records absolute upload paths in SQLite
> and the host worker opens them directly, so mounting it elsewhere breaks
> attachments while text messages keep working — a confusing half-failure.

## Running it all in one process

For development, or a container that also runs pi (giving up host access):

```bash
node dist/cli/piweb.js all      # worker + web
node dist/cli/piweb.js worker   # worker only
node dist/cli/piweb.js web      # web only
```

`WEB_EMBEDDED_WORKER=true` makes `web` mode run the worker in-process.

## Browser E2E, video, and visual regression tests

The Playwright suite runs end to end against deterministic local fixtures at the
production phone viewport (390×844). Every test records a WebM video; visual tests
also compare rendered pixels with reviewed PNG baselines. Current coverage includes
syntax highlighting, persisted light/dark switching, the Japanese-minimal light
palette, drawer/sheet foreground layering, the in-app video/audio player with real
download actions, touch transcript selection without Safari's document-wide
native selection, and a 500-message continuous upward history stress run across
all nine older-page boundaries without a jump:

```bash
npm run test:e2e                                      # full behavior + visual suite
npx playwright test test/e2e/media-player.spec.ts    # video/audio player + downloads
npx playwright test test/e2e/text-selection.spec.ts  # touch selection + quote preview
npx playwright test test/e2e/history-scroll.spec.ts  # 500 rows + nine delayed, partially loaded touch boundaries
npm run test:e2e:update                               # accept pixels only after review
```

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
- **Multimedia & Attachments**: Clipboard paste (`btn-paste` and `Ctrl+V`/`Cmd+V`) and file upload support
  images (PNG, JPEG, WebP, GIF, SVG), audio (MP3, WAV, M4A, AAC, OGG, FLAC), video (MP4, MOV, WebM, MKV), and documents (PDF).
  Voice notes and audio files receive automatic Breeze ASR transcription. Media gallery video and audio tiles open in a
  responsive in-app player instead of navigating to the raw file; its top bar provides a 44px download icon and close action.
  The image lightbox features numbered placeholder thumbnails and dynamic +/-2 sliding-window background prefetching.
- **Markdown & List Rendering**: Rich typography supporting loose ordered and unordered lists (preserving continuous numbering across blank lines and custom `<ol start="N">` offsets), indented multi-line item continuations, and deeply nested sub-bullets, rendered safely from text nodes without raw HTML injection.
- **Syntax-highlighted Code Blocks**: Fenced code uses the declared language when available and highlight.js auto-detection when the language tag is omitted or unknown. The browser build is vendored, so highlighting works without a CDN.
- **Mermaid Diagram Rendering & Touch Gestures**: Markdown code blocks with `mermaid` (`flowchart`, `pie`, `sequenceDiagram`, `stateDiagram`, `classDiagram`, `gantt`, `gitGraph`, `mindmap`, etc.)
  automatically render into crisp vector SVG diagrams using one restrained 12-color Japanese palette (moss, blue-grey, rust, tea, pine, muted violet, celadon, walnut, olive, indigo, adzuki, and warm slate) across every chart type. Wide Gantt charts use a readable 1000px canvas with expanded label spacing and horizontal scrolling instead of compressing labels into the phone viewport. Includes two-finger pinch-to-zoom (0.2x–5x), single-finger pan, double-tap zoom toggle, fullscreen zoom modal, diagram-type labels, and one-click code copying.
- **Recency-First Session Management**: Session list and initial home page load automatically default to the most recently updated session (`lastActivity DESC`).
- **iPadOS Window Multitasking Clearance**: Topbar layout incorporates dynamic safe area padding (`padding-left: max(60px, ...)`) to prevent obstruction by iPadOS system multitasking pills (`•••`).
- **Self-Healing & OOM Auto-Resume**: Interrupted runs (SIGTERM / SIGKILL code 143/137) during heavy local inference
  automatically requeue and resume with session context preserved.
- **Uploads** are capped by `MAX_ATTACHMENT_BYTES`; they are sent base64 in JSON
  rather than multipart to keep the container dependency-free.
