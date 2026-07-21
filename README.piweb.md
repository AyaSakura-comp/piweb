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

| Path | Why |
|---|---|
| Chat message | web writes `message_queue` → worker runs pi → appends to `web_events` → SSE |
| Command | web writes `control_queue` → worker runs it → appends to `web_events` → SSE |
| Model list | worker publishes to `meta` (listing models spawns pi) → web reads for autocomplete |

`/pi status` spawns pi over RPC, `/pi stop` needs the worker's in-memory
`AbortController`, and `/pi new` must not race an in-flight run — none of which
the web tier can do itself, hence the control queue.

## Commands

Full parity with piscord. Type `/` in the composer for autocomplete (command
names, then values for the argument — models come from pi's live list).

`/pi status` · `/pi model <model>` · `/pi reset-model` · `/pi thinking <level>` ·
`/pi new` · `/pi stop` · `/pi cwd <path>` · `/pi reset-cwd` · `/pi gpt-usage` ·
`/until goal <text>` · `/until status` · `/until stop` · `/gpt-usage`

Sessions are created and deleted from the drawer. The 🗑 button in the header is
**clean session**: it clears the transcript *and* rotates pi's session directory,
so the agent's context is genuinely reset rather than just visually cleared.

## Authentication

This endpoint can make pi run arbitrary commands on the host, so it always
authenticates. Being on the tailnet is *not* sufficient on its own: any website
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
stamps the device's identity onto *every* request the browser makes, including
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

### 3. Web tier (Docker)

```bash
# .env next to docker-compose.yml
echo "PIWEB_DATA=$HOME/.local/share/piweb" >> .env
echo "WEB_AUTH_TOKEN=<the same token>"     >> .env

docker compose up -d --build
```

Then expose it on the tailnet, either with the bundled sidecar
(`docker compose --profile tailscale up -d`) or the host's own
`tailscale serve https / http://127.0.0.1:8099`.

> **Path gotcha:** `PIWEB_DATA` is mounted at the *same absolute path* inside the
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

## Notes

- **Live updates** use SSE, resumed by event id, so a phone that slept through a
  long run replays exactly what it missed instead of losing it. Every message,
  thinking block, tool call and command result is persisted in `web_events` —
  the transcript survives reconnects and restarts.
- **Attachments** are staged by the web tier and picked up by the worker through
  the same pipeline as Discord attachments, so WEBP/HEIC → PNG transcoding and
  Breeze ASR voice transcription still apply.
- **Uploads** are capped by `MAX_ATTACHMENT_BYTES`; they are sent base64 in JSON
  rather than multipart to keep the container dependency-free.
