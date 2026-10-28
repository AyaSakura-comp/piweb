# BTW workspace switching and clearing

BTW opens a slim header directly under the topbar (see DESIGN.md “BTW side
conversation”): `‹` back on the left, “BTW 側聊” plus a one-line status in the
centre, and a trash icon for clear on the right — borderless 44px icon buttons.
The main view has no persistent recipient row; while a side answer is pending a
quiet “BTW 回答中 ›” link on the typing line opens BTW. A visually hidden
`#btw-context-label` (`Main agent` / `BTW`) keeps the polite announcement.
A side request does not disable the main recipient's send button. Each recipient keeps
its own draft and scroll position. Switching back during a side send uses the
in-memory transcript instead of queuing another snapshot behind that send.
Recipient switches slide the two real transcripts horizontally (220ms in,
140ms ease-in back, no rebound). After opening BTW once, a horizontal drag in the
transcript follows the finger; crossing 28% of its width, or a qualifying flick,
commits the switch, otherwise it returns. Vertical scrolling,
selected text, controls/media, attachment/quote drafts and edge gestures are
excluded. Reduced motion skips automatic transition animation. Session reset
cancels transitions so an old animation cannot change a new session's view. Re-entering
from the menu while idle still refreshes the native snapshot; swipes use the
current owned view. Session reset fences pending UI completions.

The **清除 BTW** trash icon asks for confirmation and clears the actual native side
thread, not main messages. It is disabled while answering/opening/clearing.
`POST /api/sessions/:jid/btw` accepts `{ action: "clear", generation }`, with the
existing authentication, CSRF, standard/Pi-harness and generation checks. The
private worker control uses `rpc.btw('clear')`; that validates the installed
`pi-btw` extension's `/btw:clear` command before invoking it, then requests and
verifies an empty snapshot. There is no fallback to ordinary model prompts.
A failed clear preserves the displayed history and reports the error.

Scope: visible BTW history and native side context. Main chat, main context,
attachments and other sessions are not deleted. Unsent side draft text is retained.
This change does not rewrite pi-btw or share native sessions between harnesses.

## Pending answers and control concurrency

The host worker runs `btw:web` controls beside the serial control loop. A long
side answer must not hold later snapshots or another session's Stop behind it.
Every control still renews and checks its channel generation/ownership; a stale
completion cannot update a replacement session. Worker shutdown waits for active
BTW controls rather than closing the database beneath them.

RPC snapshots add `pending`, an array of questions whose side send is still
running. The client restores these on reload/session return and polls snapshots
until completion; it does not resend the question. This pending tracker is
in-memory: recovery after a host worker/RPC process restart is not guaranteed.
An ordinary side answer does not grant BTW support to AGY; Claude Code sessions
have their own backend (below).

## Streaming answers

A side answer streams while it is written. The installed `pi-btw` (local branch
`piweb-bridge` of `~/src/pi-btw`) watches the BTW sub-session during a Web send
and keeps the latest assistant message per request; every `/btw:web snapshot`
reports it as `streaming: [{ question, answer, thinking }]`. The worker passes
that field through the private control result, and the web route already
forwards the whole result as `thread`, so **no web-tier change or image
rebuild** is involved.

While its own send is in flight (or a pending answer was restored), the BTW view
re-reads the snapshot one request at a time, about every 0.7 s. The reasoning
grows in a folded `💭 Thinking…` card and the answer below it, through the same
streaming renderer as the main reply. When the send's POST returns, the
streamed answer node is finished in place rather than rebuilt; the thinking card
goes away because the settled thread holds only questions and answers, exactly
what a reopen shows. A snapshot requested before the send settled is ignored.
An older `pi-btw` without `streaming` just shows the waiting dots as before.

## Claude Code sessions: Claude Code's own /btw (2026-10-27)

A session on a `claude-code/*` model uses the same BTW view, endpoint and thread
shape; the worker answers it with Claude Code's side question instead of pi-btw
(`src/agent/claude-btw.ts`). AGY sessions still have no BTW (entry hidden, web
and worker refuse).

- **How Claude is asked.** The TUI's `/btw` shows its answer in a panel that is
  never written to the transcript, and `claude -p "/btw …"` answers "/btw isn't
  available in this environment". The form that works headless is the Agent
  SDK's `askSideQuestion()`: a `claude -p --input-format stream-json
  --output-format stream-json` process gets a `control_request` with
  `{ subtype: "side_question", question, history }` and replies with a
  `control_response` `{ response, synthetic }`. Piweb starts that process per
  question with `--resume <the TUI's conversation> --fork-session
  --no-session-persistence`, the session's model and effort, no MCP servers
  (`--strict-mcp-config`) and no hooks (`disableAllHooks`), in the TUI's cwd
  (Claude finds a conversation by its project directory). Before the first turn
  there is no conversation and it asks without `--resume`.
- **The TUI is never touched.** Nothing is typed into the tmux pane, so a side
  question works while a main turn is running, and the main transcript does not
  change (the live test compares it before and after).
- **The side thread is Piweb's.** Claude keeps nothing between processes, so the
  worker keeps `{ sessionId, entries: [{ question, response }] }` in
  `claude-btw.json` in the session directory and sends the entries back as
  `history`; a follow-up sees the earlier side answers. The entries belong to
  one Claude conversation id: `/pi new` (new directory, new id) starts empty.
  A thread asked before the first turn is stored with no id and carries into
  the conversation that turn starts (it used to vanish from the view then).
  Clear empties the file and is refused while a question is pending, as for Pi.
- **One question at a time per session**, in order, each seeing the one before.
  `pending` lists the questions in flight (in memory, like Pi's); there is no
  `streaming` text, so the view shows the waiting dots until the answer.
- A `synthetic` reply is a stand-in, not the model's answer: it is reported as
  the error and not kept. A question unanswered after 600 s is given up (the web
  route waits 610 s).

```bash
npx vitest run test/claude-btw.test.ts test/control-btw-routing.test.ts
# Explicit opt-in, real Claude quota (Haiku): a side question beside a running
# TUI turn sees the conversation and the running command, a follow-up sees the
# first answer, the main turn finishes and its transcript never sees the side chat.
PATH=$HOME/.local/bin:$PATH CLAUDE_TMUX_BIN=$HOME/.local/bin/claude \
  PIWEB_CLAUDE_LIVE=1 npx vitest run test/claude-btw-live.test.ts
# The same through a real phone-size browser, recorded (isolated web + worker
# loops, disposable DB): BTW before the first turn, beside a running turn, a
# follow-up, back to main at its newest message, reload, clear. Haiku by
# default; PIWEB_CLAUDE_E2E_MODEL=opus PIWEB_CLAUDE_E2E_THINKING=xhigh matches
# the sessions in use. Its tmux can run on a private server
# (CLAUDE_TMUX_TMUX_BIN=a wrapper running `tmux -L <name> "$@"`).
PATH=$HOME/.local/bin:$PATH CLAUDE_TMUX_BIN=$HOME/.local/bin/claude \
  PIWEB_CLAUDE_E2E_LIVE=1 npx playwright test test/e2e/claude-btw-live.spec.ts
```

Live check 2026-10-29 (Opus, xhigh): side answers in 1.8–4.5 s, the main
turn untouched. It found and fixed two view bugs: the pre-first-turn thread
vanishing once the conversation existed, and the main view coming back from
BTW short of its end with "Jump to present" showing — while the transcript was
hidden, the prompt-turn hold measured it as zero and dropped its reserved
space (`public/prompt-turn-scroll.js` now skips a hidden transcript). The one
production failure before it ("Claude BTW timed out" after 26 min on
2026-10-29 00:22) was the host out of memory (swap full, every process
stalled until the kernel OOM-killed a 4.5 GB python at 00:48), not BTW: the
same question on that 182 MB conversation now answers in 4.5 s, 326 MB peak.

## Commands and verification

- Open **⋯ → BTW**, or use the pending-answer link to return to its side transcript.
- **回主對話** or a committed horizontal swipe changes the shared composer's recipient.
- **清除 BTW** confirms first; its native bridge validates `/btw:clear`, then
  obtains an empty snapshot. This is not `/pi new` or a main-session reset.

```bash
npx vitest run test/btw-api.test.ts test/rpc-session-btw.test.ts \
  test/control-btw-concurrency.test.ts
npx playwright test test/e2e/btw-shared-composer.spec.ts
```

The mobile fixture covers held side answers, main Send while pending, return
without overlapping snapshots, streamed thinking/answer that finish in place,
restored pending snapshots that stream, confirmation/clear,
horizontal gestures, header geometry, reduced motion and main-history preservation.
The API test checks authentication/generation with fixture control completion.
Fake RPC tests exercise native clear, missing-command rejection, long-running
completion and pending snapshots. The control-loop test holds one BTW request
while proving later controls complete. These are not physical-iPhone or real
provider/restart recovery tests.

## Deployment

Frontend, web route and host worker must be deployed together. Do not activate
only the clear UI against an old worker that rejects the new action. Wait for
active worker/agent tasks to drain before safely restarting the host worker.
This implementation has not yet been deployed. A Git push alone does not activate
it in the running web container or host worker.
