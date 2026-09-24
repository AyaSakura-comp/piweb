# Claude Code account usage

The header usage button follows the session's execution provider:

| Session provider                                              | Command         | Account                                  |
| ------------------------------------------------------------- | --------------- | ---------------------------------------- |
| `claude-code/opus`, `claude-code/sonnet`, `claude-code/haiku` | `/claude-usage` | Host Claude Code OAuth subscription      |
| `agy/*`, including Claude models hosted by AGY                | `/agy-usage`    | Antigravity                              |
| Other existing routes                                         | `/gpt-usage`    | Existing ChatGPT/Codex usage integration |

With no explicit session model, the runtime provider is used. The accessible
label and tooltip update with model/provider changes. `/claude-usage` can also
be invoked explicitly.

Already-open clients may still submit `gpt-usage` from the old header button.
The web command endpoint maps unmarked legacy/toolbar `gpt-usage` requests to
`claude-usage` when the session's configured model is `claude-code/*`. New
composer requests carry `source: composer` and retain the explicitly typed
command. `/pi gpt-usage` is always an explicit GPT query, including on old clients.
Refresh the page to update the button's tooltip/accessibility label as well as
its handler. Backend compatibility does not require the old tab to reload.

This does not implement a new usage integration for
arbitrary third-party providers or native Pi Anthropic credentials.

## Output

Reports the account's current five-hour utilization and weekly utilization,
reset times and query timestamp. Optional Sonnet/Opus weekly limits appear only
when supplied. Percentages mean **used**, not remaining. Missing data is not
reported as zero. Times are explicitly labelled Asia/Taipei. This is account
quota, not the selected conversation's token count or cost estimate.

## Worker-only implementation

`src/claude-usage.ts` reads `${CLAUDE_CONFIG_DIR}/.credentials.json` (default
`~/.claude/.credentials.json`), using `claudeAiOauth.accessToken` for the fixed
`https://api.anthropic.com/api/oauth/usage` endpoint. It is an internal Claude
Code endpoint, not a guaranteed stable public API.

The request has a ten-second timeout and rejects redirects. Tokens stay on the
host and are never returned in reports or copied to PiWeb events. Only recognised
numeric quota fields and validated timestamps are rendered; raw remote error
bodies are not exposed. API-key-only login cannot provide subscription usage.

Concurrent requests share one promise. Responses and failures are cached for
60 seconds keyed by a hash of the current access token; changing the login/token
invalidates that cache. No automatic retries or credential refresh/write occur.
401/403 asks the user to sign in again, 429 reports rate limiting, and other
network/service errors produce a generic message. This avoids interfering with
active Claude tmux sessions or sending `/usage` into a conversation prompt.

The browser posts the normal command intent. The host control loop executes it
and delivers the formatted report through the existing system-event stream.
Both web catalog/assets and worker code must be updated before enabling it.

## Verification

```sh
npx vitest run test/claude-usage.test.ts test/claude-usage-command.test.ts
PIWEB_E2E_PORT=4191 npx playwright test test/e2e/claude-usage.spec.ts
```

Unit tests cover formatting, absent credentials, credential changes, concurrent
requests, rate limiting and sanitised failures. The mobile fixture verifies
actual usage-button clicks across Opus/Sonnet/Haiku, AGY-hosted Claude, GPT and
runtime-default Claude routing. Its API is mocked; it is not a live quota test.
A separate host read-only smoke query returned HTTP 200 and current five-hour /
weekly usage using the local Claude login, without invoking model inference.

### Deployed video verification

`test/e2e/claude-usage-live.spec.ts` is opt-in with `PIWEB_USAGE_LIVE_URL` and
`PIWEB_USAGE_LIVE_TOKEN`. It creates a dedicated witness session, selects Opus,
Sonnet and Haiku through the real model picker, and clicks the real usage button
for each. It requires three distinct persisted `/claude-usage` reports containing
five-hour/weekly utilization and reset times, then reloads to verify persistence.
No API interception or model inference is used; normal 60-second quota caching
still applies. Authentication traces are disabled. The witness session is kept
for inspection rather than modifying an existing conversation.

```sh
PIWEB_E2E_PORT=4191 npx playwright test test/e2e/claude-usage-live.spec.ts
```

A deployed run passed after the worker/web update. Local ignored evidence is
under `artifacts/claude-usage-live/`: continuous H.264 `workflow.mp4`, milestone
screenshots, sampled `contact.jpg` and `metrics.json`. This uses Chromium's
390×844 mobile viewport; it is not a physical iPhone Safari test.

References:

- [Claude usage limits](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)
- [Upstream usage endpoint rate-limit issue](https://github.com/anthropics/claude-code/issues/31021)
