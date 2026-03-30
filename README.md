# pi-discord-gateway

`pi-discord-gateway` connects Discord channels to your locally installed `pi` agent. It listens for Discord messages, queues them in SQLite, runs `pi` as a subprocess, and sends the result back to Discord while keeping a separate persistent session directory per channel.

This project is intended for people who already use `pi` and want a practical Discord front end without changing their existing `pi` install, login, or model setup.

## Features

- Runs your existing `pi` binary instead of bundling a separate agent runtime
- Reuses your existing `pi` login and model access
- Keeps one persistent `pi` session per registered Discord channel
- Stores the queue in SQLite so work survives restarts
- Serializes work per channel and supports configurable global concurrency
- Supports mention-only channels or always-on channels
- Auto-registers DMs by default
- Handles reply context and Discord attachments with per-file and total-size limits
- Splits long responses to fit Discord's message length limit
- Provides setup, status, channel registration, and daemon management commands
- Registers `/pi` slash commands for model, thinking, status, and session reset actions

## How It Connects To `pi`

`pi-discord-gateway` does not replace `pi`. It shells out to the `pi` executable from `PATH` or `PI_BIN`, and it expects your normal `pi` authentication to already exist.

- `pi` binary: resolved from `PI_BIN` or the `pi` command in `PATH`
- `pi` auth: expected at `~/.pi/agent/auth.json`
- Session storage: one folder under `SESSIONS_DIR` per Discord channel
- Gateway state: SQLite database at `DB_PATH`

In practice, the gateway is a thin bridge:

```text
Discord -> discord.js -> pi-discord-gateway -> pi subprocess
                           |                  |
                           -> SQLite queue    -> per-channel session dirs
```

## Prerequisites

- Node.js 20 or newer
- A working `pi` installation
- A completed `pi login`
- A Discord bot token
- If you want background service management: `systemd --user`

You also need a Discord application with a bot user that has:

- `View Channels`
- `Send Messages`
- `Read Message History`
- Message Content Intent enabled in the Discord developer portal

## Installation

### npm global install

```bash
npm install -g pi-discord-gateway
pi-discord help
```

### npx quick trial

```bash
npx pi-discord-gateway@latest help
npx pi-discord-gateway@latest setup
```

This is useful for a quick test. For long-term use, prefer a normal global install so `pi-discord` is always available.

### Source install

```bash
git clone https://github.com/Crokily/pi-discord-gateway.git
cd pi-discord-gateway
npm install
npm run build
node dist/cli.js help
```

## Setup Flow

### 1. Install `pi`

Install `pi` using the upstream instructions for your platform, then confirm it is on `PATH`:

```bash
pi --version
```

### 2. Log in to `pi`

```bash
pi login
```

Successful login should create `~/.pi/agent/auth.json`.

### 3. Run the setup wizard

If you installed globally:

```bash
pi-discord setup
```

If you are running from source:

```bash
node dist/cli.js setup
```

The setup wizard writes a config file and creates the default storage directories:

- Config: `~/.config/pi-discord-gateway/config.env`
- Sessions: `~/.local/share/pi-discord-gateway/sessions`
- Database: `~/.local/share/pi-discord-gateway/gateway.db`

You can also provide the Discord bot token non-interactively:

```bash
pi-discord setup "$DISCORD_BOT_TOKEN"
```

### 4. Register a Discord channel

Enable Developer Mode in Discord, copy the channel ID, then register it:

```bash
pi-discord register 123456789012345678 "My Server #general"
```

Useful options:

- `--no-trigger`: respond to all messages in that channel
- `--main`: mark the channel as main and also disable trigger-only mode
- `--folder <name>`: choose a custom relative session folder under `SESSIONS_DIR`

Example:

```bash
pi-discord register 123456789012345678 "Ops" --main --folder servers/ops
```

### 5. Start the gateway

Foreground mode:

```bash
pi-discord start
```

Install and start the user service:

```bash
pi-discord daemon install
pi-discord daemon start
```

### 6. Check local status

```bash
pi-discord status
pi-discord channels
```

## Configuration

The primary config file is:

```text
~/.config/pi-discord-gateway/config.env
```

You can override the config location by setting `PIDG_CONFIG` before running the CLI or service:

```bash
export PIDG_CONFIG=/path/to/config.env
pi-discord status
```

### Config variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | required | Discord bot token |
| `PI_BIN` | `pi` | Path to the `pi` executable |
| `PI_MODEL` | empty | Optional default model override |
| `PI_THINKING` | empty | Optional default thinking override |
| `PI_CWD` | `$HOME` | Working directory used when starting `pi` |
| `PI_EXTRA_FLAGS` | empty | Extra arguments appended to each `pi` invocation |
| `TRIGGER_NAME` | `Andy` | Trigger prefix inserted after Discord mentions |
| `MAX_CONCURRENCY` | `3` | Maximum concurrent `pi` subprocesses |
| `POLL_INTERVAL_MS` | `1000` | Queue polling interval |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Graceful shutdown timeout |
| `AUTO_REGISTER_DMS` | `true` | Automatically register direct-message channels |
| `MAX_ATTACHMENT_BYTES` | `26214400` | Max size for one Discord attachment, `0` disables the limit |
| `MAX_TOTAL_ATTACHMENT_BYTES` | `52428800` | Max combined attachment size per Discord message, `0` disables the limit |
| `SESSIONS_DIR` | `~/.local/share/pi-discord-gateway/sessions` | Base directory for per-channel `pi` sessions |
| `DB_PATH` | `~/.local/share/pi-discord-gateway/gateway.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Pino log level |

## Data Locations

By default the gateway uses XDG-style locations under your home directory:

| Item | Default path |
| --- | --- |
| Config file | `~/.config/pi-discord-gateway/config.env` |
| Database | `~/.local/share/pi-discord-gateway/gateway.db` |
| Sessions root | `~/.local/share/pi-discord-gateway/sessions` |
| `pi` auth | `~/.pi/agent/auth.json` |

Each registered channel gets its own session folder. For example, a default registration for channel `1234` uses:

```text
~/.local/share/pi-discord-gateway/sessions/ch_1234
```

## CLI Reference

```bash
pi-discord setup [token]
pi-discord start
pi-discord status
pi-discord channels
pi-discord register <channel-id> <name> [--folder <name>] [--no-trigger] [--main]
pi-discord unregister <channel-id>
pi-discord daemon <install|uninstall|start|stop|status|logs>
pi-discord help
```

Command notes:

- `setup`: interactive wizard that writes `config.env`
- `start`: runs the gateway in the foreground
- `status`: shows local diagnostics for `pi`, config, systemd, database, and sessions
- `channels`: lists registered channels from the local database
- `register`: adds or updates a channel registration
- `unregister`: removes a registration
- `daemon`: manages the `systemd --user` service

## systemd Service Management

The recommended service flow is to let the CLI generate and install the user service:

```bash
pi-discord daemon install
pi-discord daemon start
pi-discord daemon status
pi-discord daemon logs
```

To stop or remove it:

```bash
pi-discord daemon stop
pi-discord daemon uninstall
```

The generated service uses:

- `ExecStart=<node> <resolved-cli-path> start`
- `Environment=PIDG_CONFIG=<resolved-config-path>`
- `WorkingDirectory=$HOME`

That means the service follows the same config file you used during setup, including custom `PIDG_CONFIG` paths.

## Troubleshooting

### `pi` not found in `PATH`

Symptoms:

- `pi-discord status` shows `Pi binary: not found`
- `pi-discord setup` reports `Pi binary: not found in PATH`

Fixes:

- Verify `pi --version` works in the same shell
- Set `PI_BIN` in `config.env` to the full path to `pi`
- Restart the user service after changing config: `pi-discord daemon restart` is not implemented, so use `stop` then `start`

### Missing `auth.json`

Symptoms:

- `pi-discord status` shows `Pi auth: missing`
- Model discovery during setup or slash commands is unavailable

Fixes:

- Run `pi login`
- Confirm `~/.pi/agent/auth.json` exists for the same user that runs `pi-discord`
- If using `systemd --user`, make sure you installed and started the service as that same user

### `systemd --user` service issues

Symptoms:

- `pi-discord daemon install` succeeds but `start` or `status` fails
- The service stops immediately after launch

Fixes:

- Check `pi-discord daemon status`
- Check `pi-discord daemon logs`
- Confirm `systemctl --user` works in your environment
- If your machine does not keep user services running after logout, enable lingering for your user with the normal system administration workflow

### No registered channels

Symptoms:

- The bot appears online but does not answer in server channels
- `pi-discord channels` prints `No registered channels.`

Fixes:

- Register at least one server channel with `pi-discord register <channel-id> "<name>"`
- If the channel requires mentions, start messages with `@<trigger name>` or mention the bot directly
- DMs can auto-register when `AUTO_REGISTER_DMS=true`

## Architecture

- `src/cli.ts`: packaged CLI entrypoint and command dispatch
- `src/setup.ts`: setup wizard and generated config file content
- `src/status.ts`: local environment and service diagnostics
- `src/daemon.ts`: `systemd --user` service installation and control
- `src/discord.ts`: Discord client, message intake, attachments, replies, slash commands, outbound replies
- `src/db.ts`: SQLite schema and queue/channel persistence
- `src/queue.ts`: polling loop, channel serialization, and concurrency control
- `src/agent.ts`: `pi` subprocess execution
- `src/session-path.ts`: safe session-folder validation and resolution

The processing model is intentionally simple:

1. Discord message arrives.
2. The gateway validates the channel and trigger rules.
3. The message is written to SQLite.
4. The queue worker claims the message.
5. The worker runs `pi` in the channel's session directory.
6. The response is posted back to Discord.

## Security Note

This gateway runs arbitrary prompts through your locally authenticated `pi` account and stores conversation state on disk.

- Protect the Discord bot token in `config.env`
- Restrict who can post in registered channels
- Assume anyone who can talk to the registered bot channel can spend your `pi` usage
- Review attachment limits before exposing the bot to untrusted users
- Keep the service running as a normal user account, not as `root`

## License

MIT
