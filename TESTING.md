# Testing Plan

This document describes the verification strategy for `pi-discord-gateway` before release.

## 1. Automated tests

Run:

```bash
npm install --include=dev
npm run build
npm test
```

Current automated coverage includes:

- attachment limit selection logic
- session folder validation
- config path/config precedence behavior
- generated setup config content
- CLI help text surface

## 2. CLI smoke tests

Verify the packaged CLI works:

```bash
node dist/cli.js help
node dist/cli.js status
node dist/cli.js channels
```

Expected:

- `help` prints the command list
- `status` prints pi/config/database/session diagnostics
- `channels` lists registered channels or reports none

## 3. Clean-environment setup smoke test

Use a temporary HOME and config path so the test does not depend on the developer machine state.

```bash
TMP_HOME=$(mktemp -d)
TMP_CONFIG="$TMP_HOME/config.env"

env -i PATH="$PATH" HOME="$TMP_HOME" PIDG_CONFIG="$TMP_CONFIG" \
  node dist/cli.js setup test-token

env -i PATH="$PATH" HOME="$TMP_HOME" PIDG_CONFIG="$TMP_CONFIG" \
  node dist/cli.js status
```

Expected:

- setup creates the config file
- status reports database and sessions under `$TMP_HOME/.local/share/pi-discord-gateway/`
- status respects `PIDG_CONFIG`

## 4. Packaging verification

Ensure npm tarball contents are clean and only include intended runtime files.

```bash
npm pack --dry-run
```

Expected:

- includes `dist/`, `README.md`, `.env.example`, `LICENSE`
- does not include tests, session data, SQLite files, or other local artifacts

## 5. Live integration test

On a real machine with `pi` installed and logged in:

1. Run `pi-discord setup`
2. Register a disposable Discord test channel
3. Start the gateway in foreground:
   ```bash
   pi-discord start
   ```
4. Send a basic message in Discord
5. Send a follow-up message in the same channel to verify session continuity
6. Send a small attachment to verify file relay
7. Use `/pi status` in Discord to verify slash commands are active

Expected:

- responses arrive in Discord
- follow-up messages preserve context
- attachment relay works within limits
- slash commands respond

## 6. systemd user service test

```bash
pi-discord daemon install
pi-discord daemon start
pi-discord daemon status
```

Then restart the machine or user session if needed and verify the service still works.

Check logs with:

```bash
pi-discord daemon logs
```

## 7. Release checklist

Before publishing:

- [ ] `npm install --include=dev`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm pack --dry-run`
- [ ] clean-environment setup smoke test passes
- [ ] live Discord integration test passes
- [ ] systemd user service test passes
- [ ] README matches actual CLI behavior
