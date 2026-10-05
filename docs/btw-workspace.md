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
An ordinary side answer does not grant BTW support to AGY or Claude harnesses.

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
without another snapshot, restored pending snapshots, confirmation/clear,
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
