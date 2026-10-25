# Replies owned by Pi extensions

Pi extensions can consume a prompt or publish a displayed custom message without
producing an ordinary assistant text reply. Piweb now uses that displayed text as
the reply fallback rather than returning `(empty response)`.

## Completion and message selection

- Print and persistent RPC adapters collect text from `message_end` events whose
  message has `role: "custom"` and a truthy `display` flag. String content and
  text content blocks are supported; multiple displayed messages are joined
  with blank lines.
- Hidden custom messages are not included. Tool calls and non-text blocks are
  not turned into an assistant response.
- An ordinary assistant text reply remains authoritative when present; displayed
  extension text is a fallback, not a replacement or a duplicated extra answer.
- In persistent RPC, `input_handled` finishes an extension-consumed prompt when
  no `agent_start` has occurred. Such a turn may never emit `agent_settled`, so
  waiting only for that event would leave the message queue stuck.
- Normal agent runs still complete on the existing `agent_settled` boundary.
  Existing abort, ownership and transport error checks remain in place.

This is transport/display behavior, not an implementation of a finance workflow.
Extension-specific preview/confirmation commands remain owned by the installed
extension. The bridge adds no generic `/confirm` command and does not execute a
displayed receipt as an instruction; the only confirmation it relays is pi's own
blocking `confirm()` dialog, below.

## Extension confirm dialogs (2026-10-22)

A blocking extension `confirm()` (for example a tool such as `line_gui` asking to
act) used to be auto-cancelled, so it could never be approved from Piweb. In a
persistent RPC session the worker now answers it from the chat:

- `rpc-session.ts` posts the dialog as a notice in the session — `🔐 <title>`, its
  message, and 回覆「yes／批准」執行，「no／拒絕」取消, plus the time limit when pi
  gives one — and keeps it as the session's one pending confirm. A newer dialog
  supersedes (denies) the older one.
- Each queue tick, `answerPendingConfirms()` (`queue.ts`) peeks at the next pending
  message of a session with an open dialog. A text-only reply matching yes (`y`,
  `yes`, `ok`, `approve`, `confirm`, 批准, 同意, 確認, 可以, 好, 是, 對 …) or no (`n`,
  `no`, `deny`, `reject`, `cancel`, 拒絕, 不要, 不, 否, 取消 …), trailing punctuation
  ignored, is consumed as the answer and marked done; it is not sent to the model.
- **Anything else denies the dialog (fail closed)** and stays queued, so it is then
  dispatched normally (interrupting or following the run as usual). Attachments
  never count as an answer.
- Pi resolves a dialog to "no" on its own timeout; the worker mirrors that timer, so
  a late reply is not consumed as an answer (`⌛ 「<title>」逾時，視為拒絕。`).
- Every resolution is echoed: ✅ 已批准 / 🚫 已拒絕 / 🚫 收到其他訊息，已拒絕.
- `select`, `input` and `editor` dialogs have no web equivalent and are still
  cancelled, as is a confirm with no channel to post to.

## Verification commands

```bash
npx vitest run test/rpc-session-handled.test.ts test/rpc-session.test.ts \
  test/rpc-confirm-bridge.test.ts \
  test/invoke-attachment-path.test.ts
npx tsc --noEmit
```

Fake RPC tests cover an extension-consumed prompt, displayed receipt fallback
without assistant text, exclusion of hidden custom text and precedence of a
normal assistant answer. The existing print-adapter tests protect attachment
handling; they are not a live extension/ledger integration test. Deploy the host
worker adapter to activate this behavior; pushing Git alone does not restart it.
