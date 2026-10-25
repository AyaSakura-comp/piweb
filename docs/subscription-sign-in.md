# Subscription sign-in from Settings

Settings → Subscriptions has one card per provider subscription. The web tier
never holds a credential: it writes a `subscription_jobs` row, and the host
worker (`src/worker/subscriptions.ts`) runs the login or logout, because only
it can reach pi's `auth.json` and the host CLIs.

| card                 | provider key   | how it signs in                                                            | credential lands in                     |
| -------------------- | -------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| ChatGPT Plus / Pro   | `openai-codex` | device code: the card shows a code and a link to enter it on               | pi `auth.json`                          |
| Claude Pro / Max     | `anthropic`    | pasted code: **Open Claude** → Anthropic's code page → paste into the card | pi `auth.json` (via pi's `AuthStorage`) |
| Antigravity (Google) | `agy`          | pasted code: Google consent → paste into the card                          | the host `agy` CLI's own token file     |

## Flow

```
Settings ──POST /api/subscriptions/<p>──▶ subscription_jobs(pending)
                                              │ worker claims (500ms poll)
                                              ▼
                       device code / authorization link mirrored to the row
Settings polls GET /api/subscriptions/<p> ◀──┘   (card shows code or link)
Settings ──POST /api/subscriptions/<p>/code──▶ manual_code (taken and cleared once)
Settings ──POST /api/subscriptions/<p>/cancel─▶ job cancelled
DELETE /api/subscriptions/<p>  → logout job
```

- Only device codes and authorization links are mirrored into SQLite. Access
  and refresh tokens stay in `auth.json`; a pasted code passes through
  `manual_code` once and finishing a job clears it.
- One active job per provider (unique index). A second Connect while one is
  running answers 409 and the card reloads its state.
- Authorization links are checked against the provider's hosts before they are
  shown (`claude.ai`, `claude.com`, `console.anthropic.com`,
  `platform.claude.com`; `accounts.google.com`).

## Claude: Anthropic's code page, not localhost

pi's own Anthropic login redirects to `http://localhost:53692/callback`, which
loads only on the host; on a phone the browser lands on a dead page.
`src/claude-login.ts` runs the flow Claude Code uses for a sign-in on another
device instead: the same public client, redirected to
`https://platform.claude.com/oauth/code/callback`, which shows a code to copy.
The tokens are stored in pi's `auth.json` exactly as pi's login would store
them, and the `anthropic` provider is reloaded in place, so no worker restart
is needed. A reload that fails still counts as connected (the credential is
saved; only the model list is late).

### The host's Claude Code sign-in counts

`claude-code/*` sessions run the host Claude Code CLI, so its sign-in is a
working Claude subscription even when pi's `anthropic` credential is absent.
The card therefore reads **Connected** when either pi holds an OAuth credential
or Claude Code's `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`) has a
refresh token. Only the presence of the token is checked; nothing is copied.

**Disconnect never signs the host's Claude Code out**: that would end every
Claude Code session on the host, including Piweb's own. When only Claude Code is
signed in, the logout job fails with "Signed in through the host's Claude Code;
sign out there to disconnect." and the card stays connected, showing that line.

## Errors keep the sign-in alive where they can

Paste-code sign-ins (Claude, agy) share `src/subscription-login.ts`:

- **Recoverable** — a mistyped, expired or already-used code, a pasted sign-in
  link instead of a code, a declined consent, rate limiting, 5xx and network
  failures. The job keeps waiting and the reason shows under the field
  (`.is-error`); the same link can produce a new code. At most
  `MAX_CODE_ATTEMPTS` (5) tries per job.
- **Fatal** — agy missing (checked before its link is shown), the client secret
  refused, or a credential that could not be saved. The job ends with a
  specific message that never includes a secret.
- An API key in the environment does not read as a connected subscription.

## Status and polling

- The worker re-checks every provider's status every 30s (`STATUS_REFRESH_MS`),
  so a sign-in made outside Settings (pi `/login`, agy in a terminal, Claude
  Code on the host) or a token that went away shows up on the card.
- Settings keeps polling through dropped connections. A job the worker never
  claims turns the status into "The host worker is not answering — check that
  piweb-worker is running".
- A pasted-code job waits at most 10 minutes for the code.
- The card's action reads Connect / Cancel / Disconnect from the job state; the
  code or link panel scrolls into view when it appears (it opens under the fold
  on a phone).

## Verification

```bash
npx vitest run test/claude-login.test.ts test/agy-login.test.ts \
  test/subscription-auth.test.ts test/subscription-api.test.ts
```

Those tests use fake token endpoints and credential files; they do not sign a
real account in.
