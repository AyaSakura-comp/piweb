# Login details (🔑)

Asked for on 2026-11-12: 「做一個輸入帳號密碼的加密…放在 disk 的時候至少是被加密過的，
丟到 agent 的時候才解開，至少不要 read session data 的時候就有帳號密碼 leak」, and
「只是我不確定 pi agent 那邊該怎麼處理因為他那邊 jsonl 應該也會放類似的東西」.

The key button in the composer (after 貼上) opens an inline card: 名稱, 帳號, 密碼.
加入 turns it into a `🔑 <name>` chip; Send carries it with the message. Nothing
piweb stores holds the values in plain text, and the agent's own record (Pi's
session JSONL) holds only variable names.

## Where the values are, step by step

```
phone ──HTTPS──▶ web tier ──sealed──▶ SQLite ──▶ worker ──names──▶ agent
  memory only     seals at once        channel_secrets   opens for   prompt says
  (never          with the worker's    (blob), queue     the turn    $PIWEB_SECRET_GITHUB_PASS
  localStorage)   PUBLIC key           row (names only)  only
```

| place                                   | what it holds                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| browser                                 | page memory until Send (`public/composer-secrets.js`); never storage or draft |
| `web_events` (the transcript)           | `🔑 GitHub` under the message text                                            |
| `message_queue.secrets`                 | `[{"name":"GitHub","base":"PIWEB_SECRET_GITHUB"}]`                            |
| `channel_secrets.blob`                  | `pws1.<ephemeral key>.<iv>.<AES-GCM ciphertext+tag>`                          |
| agent prompt                            | names and how to use them, never values                                      |
| `$XDG_RUNTIME_DIR/piweb-secrets/<folder>.{json,env}` | the opened values, 0600, tmpfs (RAM), only while a turn runs     |
| Pi's session JSONL                      | names (`$PIWEB_SECRET_GITHUB_PASS`); tool results scrubbed                    |
| what streams back to `web_events`       | any value swapped for its name before it is written                           |

## Sealing (src/secrets.ts)

X25519 + HKDF-SHA256 + AES-256-GCM to one host key pair. The worker owns the
private key (`SECRET_KEY_PATH`, default `secret-key.pem` beside `config.env`:
`~/.config/piweb/` on Linux — outside `PIWEB_DATA`, the only directory the web
container mounts) and publishes the public half as `meta.secrets.public_key`
at startup. The web tier seals with the public key, so even the process that
received a detail cannot open what it stored. The AAD binds a blob to its
variable stem, so a blob moved to another name does not open.

`/api/me` reports `secrets: true` once the key is published; until then the
composer does not show the key and `POST …/messages` with `secrets` answers 503.

Same name again (case-insensitive, same stem) replaces the earlier detail.
`POST /clear` and permanent deletion drop a session's details; a Life archive
takes them with the conversation. Details typed for one conversation never
follow you to another (switching sessions empties the chips).

## Opening (src/agent/secret-handoff.ts)

At each turn the worker opens the session's details and writes the runtime
files; they are removed when the turn ends (and at worker start, and by the
hourly trash sweep for sessions cleared mid-turn), so between turns no file
holds a value. The Pi extension keeps what it read last in its process memory,
so a turn Pi starts by itself (a subagent finishing) still has them. The prompt gets, for the details that
came with this message (all of them after a switch to another agent):

```
[Login details from the user (🔑). The values are hidden from you and are never stored in plain text.]
- GitHub: account $PIWEB_SECRET_GITHUB_USER, password $PIWEB_SECRET_GITHUB_PASS
```

Names: ASCII names read as themselves (GitHub → `PIWEB_SECRET_GITHUB`); a name
with no ASCII letters or digits (公司信箱) gets `PIWEB_SECRET_LOGIN_<6 hex>`,
the same every time.

Every event the agent streams and every reply is run through a redactor
before `web_events`: values of 4+ characters become `$NAME`.

## Pi (pi-extensions/piweb-secrets.ts)

piweb starts Pi with `--extension pi-extensions/piweb-secrets.ts` and
`PIWEB_SECRETS_FILE=<runtime json>`. On each tool call the extension:

- sets the values as environment variables of the Pi process (bash inherits
  them, so `"$PIWEB_SECRET_GITHUB_PASS"` expands in the shell; the command Pi
  stores keeps the name). The shell expands them itself — pasting values into
  command text could break quoting or inject;
- for any other tool (write, a browser action…) fills `$NAME` / `${NAME}` into
  the arguments just before the tool runs. Pi hands `tool_call` a
  `structuredClone` of the arguments (`validateToolArguments`), so the
  assistant message in the JSONL keeps the names;
- on `tool_result`, swaps any value for its name in the content and details
  before Pi stores the result or shows it to the model.

So neither the JSONL nor any request to the model contains a value.
`test/pi-secrets-extension.test.ts` proves it with the real Pi CLI against a
scripted OpenAI-compatible model: bash and write get the real values, the
JSONL and all three model requests contain only names.

Extensions loaded with `--extension` run before discovered ones, so another
extension's `tool_call` handler sees a non-bash tool's filled-in arguments.
The installed ones (nodriver-browser, perf-optimization) only inspect tool
names and paths.

## Claude Code and agy

They have no extension hook. Their prompt says to load the values in the same
shell command: `. '<runtime>.env' && curl -u "$PIWEB_SECRET_GITHUB_USER:…"`.
Their own transcripts (`~/.claude/projects/…`, agy's store) then hold only
names — unless the agent prints a value, which the prompt forbids; what they
stream to piweb is scrubbed either way. Browser/MCP tools there cannot read
the variables.

## What this does not protect against

Programs running as this host user — the agents included — can read the key
file and the runtime files, as they can read anything else of the user's.
The guarantee is about reading the session data: the database, the transcript,
Pi's JSONL, the model's context, backups of the data directory. On macOS the
runtime files go to `$TMPDIR` (disk, 0600) because there is no tmpfs runtime
dir. A subagent Pi started by `pi-subagents` inherits the variables but not
the extension, so its tool results are not scrubbed.
