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

This is transport/display behavior, not an implementation of a finance workflow
or a new confirmation mechanism. Extension-specific preview/confirmation commands
remain owned by the installed extension. The bridge adds no generic `/confirm`
command and does not execute a displayed receipt as an instruction.

## Verification commands

```bash
npx vitest run test/rpc-session-handled.test.ts test/rpc-session.test.ts \
  test/invoke-attachment-path.test.ts
npx tsc --noEmit
```

Fake RPC tests cover an extension-consumed prompt, displayed receipt fallback
without assistant text, exclusion of hidden custom text and precedence of a
normal assistant answer. The existing print-adapter tests protect attachment
handling; they are not a live extension/ledger integration test. Deploy the host
worker adapter to activate this behavior; pushing Git alone does not restart it.
