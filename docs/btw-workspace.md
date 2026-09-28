# BTW workspace switching and clearing

Once a BTW thread has been opened, the main/BTW switcher stays visible. A side
request does not disable the main recipient's send button. Each recipient keeps
its own draft and scroll position. Switching back during a side send uses the
in-memory transcript instead of queuing another snapshot behind that send.
The side tab shows its answering state even while main is selected. Re-entering
from the menu while idle still refreshes the native snapshot; direct tabs use the
current owned view. Session reset fences pending UI completions.

The **清除 BTW** button asks for confirmation and clears the actual native side
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

## Verification and deployment

- `test/e2e/btw-shared-composer.spec.ts`: 11 fixture UI tests, including a held
  side send, main send while side is pending, return without an extra snapshot,
  confirmation/clear, and main history preservation.
- `test/btw-api.test.ts`: real HTTP auth/generation validation and private control
  dispatch, with a fixture control completion (not a real provider).
- `test/rpc-session-btw.test.ts`: fake RPC executable verifies native clear plus
  empty snapshot; missing clear command is refused. Existing long-running side
  completion test remains covered.
- BTW-only branch full unit suite: 616 passed, 1 skipped. The local baseline
  including the separate image-compression change passed 623 tests. BTW + Life E2E: 108 passed.
  TypeScript and targeted ESLint passed. Mobile Chromium is not an iPhone test.

Frontend, web route and host worker must be deployed together. Do not activate
only the clear UI against an old worker that rejects the new action. Wait for
active worker/agent tasks to drain before safely restarting the host worker.
This implementation has not yet been deployed. A Git push alone does not activate
it in the running web container or host worker.
