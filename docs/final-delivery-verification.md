# Thinking, scrolling and durable final-delivery verification

## Behavior and implementation

| Case                  | Contract                                                                                                                                                                                                                                                               | Implementation / regressions                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Submitted question    | Match the acknowledged saved event ID, raise that turn, and reserve unused viewport space; reader gestures release re-pinning.                                                                                                                                         | `public/prompt-turn-scroll.js`, `test/prompt-turn-scroll.test.ts`, prompt-turn browser tests.                                |
| Thinking disclosure   | Toggle and remeasure synchronously; preserve the current scroll offset without reclaiming a released prompt pin or another session's offset.                                                                                                                           | Delegated summary handling and `preserveLayout` in `public/app.js`.                                                          |
| Thinking order        | Insert late reasoning before the current answer; replace a finalized preview in its existing slot, preserving body identity and expanded state.                                                                                                                        | `renderPartialThinking`, `appendEvent`; thinking-order browser tests.                                                        |
| Native EOF            | Keep the answer visible until durable delivery, even while files await publication; cancellation/empty cleanup still clears it.                                                                                                                                        | `src/transport/web.ts`, `test/thinking-stream.test.ts`, `test/web-reply-handoff.test.ts`.                                    |
| Durable handoff       | Commit the final event and preview clear atomically; SSE reads rows/live/busy from one WAL snapshot and drains pending durable batches before clearing a preview.                                                                                                      | `src/db.ts`, `src/web/server.ts`, `test/live-output.test.ts`.                                                                |
| Delivery whitespace   | Normalize repeated assistant blank lines before rendering, as the reply publisher does. Thinking is not normalized by that transport rule.                                                                                                                             | `renderPartial`, streaming/final compatibility browser tests.                                                                |
| Local media markers   | Transport-owned `[[image: ...]]`, `[[video: ...]]` and `[[file: ...]]` markers become fixed-length `[[media:N]]` tokens (`public/outbox-stream.js`). An unpublished one renders nothing and the text after it keeps streaming; publication fills in its URL without moving block offsets, so no DOM is replaced or re-faded. Ordinary Markdown images still stream. | `public/streaming-rich.js`, boundary unit tests and real-outbox-transform browser tests.                                     |
| Finalization geometry | Working-indicator visibility and the full live preview-to-final wrapper/caret transfer run inside a synchronous layout transaction.                                                                                                                                    | `setBusy`, `appendEvent`; continuous-video RAF measurements.                                                                 |
| Life New session      | Retire an idle Life RPC lease after a short grace and queue-delivery cleanup; never rotate across active streaming, compaction or children. Standard RPC idle policy is retained.                                                                                      | `src/agent/rpc-session.ts`, ownership tests; [Life ownership details](life-mode.md#idle-rpc-ownership-and-new-life-session). |

These changes do not promise zero DOM painting: animation legitimately paints new
content. The contract is that already-read, compatible rich content is not
cleared, recreated or made hidden again. Substantive source-prefix rewrites still
invalidate incompatible bodies. Buffering an unresolved local media marker can
delay text after that marker; this is intentional, not a network error.

## What the continuous recording found

The initial recording detected a 26px heading jump when hiding `pi is working…`
enlarged the transcript viewport. After fixing that, a 4px shift remained during
the final wrapper/caret handoff. Native scroll clamping happened before asynchronous
reservation remeasurement, including after a reader had released the prompt pin.
Both changes now use the same synchronous layout transaction. The test retained
its strict maximum 0.2px heading-drift assertion; it was not weakened to pass.

The successful deployed-variant fixture records one uninterrupted 390×844 journey:
Send → text prefix → whitespace-normalized final delivery → second Send → open
thinking → finalize reasoning → unresolved media tail → publish image/following
text → settled reply. It clicks production UI controls rather than replacing the
interface with a demo. API/SSE arrivals are deterministic fixtures.

Evidence from that recorded run:

- H.264/yuv420p MP4: 9.24 seconds, 25fps, 231 decoded frames.
- All 231 frames extracted; 224 distinct consecutive images represented in 25
  chronological sheets, with adjacent duplicates mapped in a frame index.
- Every distinct consecutive frame and all eight milestone screenshots inspected
  as FFmpeg-decoded pixels, not merely sampled once per second or direct playback.
- 272 watched RAF samples; maximum watched heading drift **0px**; original body,
  heading and read paragraph nodes retained; reveal frontier did not rewind.
- No recorded visible error alerts/toasts, dialogs, horizontal overflow, page/
  console errors or failed requests. New-Send navigation intentionally moves
  history; the stationary handoff measurements apply to the watched intervals.

One earlier attempt crashed the Chromium target before the walkthrough ran. The
same test passed on an unchanged retry; the crash cause was not established and
is not counted as successful evidence.

Artifacts are local and ignored by Git under `artifacts/final-video/evidence/`:
`full-workflow.mp4`, `metrics.json`, `video-metadata.json`, `frame-index.json`,
`all-frame-sheets/`, milestone `screenshots/`, `contact-sheet.png` and `report.md`.
The report records exact static-asset hashes and rollback paths. See also
[render-first architecture and tests](render-reveal.md).

## Commit-candidate verification

The isolated single-row commit candidate passed the full Vitest suite:
**717 passed, 1 skipped** across 121 files. All **56** cases in
`test/e2e/render-reveal.spec.ts` passed; after formatting-only cleanup, the
19-case scroll/thinking/finalization subset and all 717 unit tests passed again.
Targeted ESLint, TypeScript typechecking
and patch whitespace checks passed. The independent review's compaction finding
was reproduced before the fix and covered by Life success/failure and standard
warm-session regressions; the follow-up review accepted that fix. These counts
describe the selected candidate, not the unrelated dirty worktree or every
browser suite.

The repository-wide formatting gate already fails on **81 files at the baseline**.
The selected candidate retains exactly those 81 failures, with **no new failing
paths**; unrelated baseline formatting was not rewritten. Full ESLint passes.
This existing formatting gate can still make GitHub CI red.

## Reproduce the targeted checks

```sh
npx vitest run test/prompt-turn-scroll.test.ts test/streaming-rich.test.ts \
  test/thinking-stream.test.ts test/transcript-scroll.test.ts \
  test/live-output.test.ts test/web-reply-handoff.test.ts \
  test/rpc-session-ownership.test.ts test/life-session-api.test.ts

PIWEB_E2E_PORT=4255 npx playwright test test/e2e/render-reveal.spec.ts \
  --grep 'final delivery|thinking order|prompt turn|auto-scroll|transport whitespace' \
  --workers=1 --reporter=list --output=artifacts/final-video/recheck

npx eslint public/app.js public/prompt-turn-scroll.js public/streaming-rich.js \
  public/session-ui.js src/db.ts src/web/server.ts src/transport/web.ts \
  src/agent/rpc-session.ts test/e2e/render-reveal.spec.ts
npx tsc --noEmit
git diff --check
```

Use a free fixture port. For deployment-variant recording, copy the deployed
public directory into an isolated fixture and apply only the candidate hot patch;
verify asset hashes before claiming it represents the deployed renderer.

## Deployment boundaries and limitations

The browser fixes were hot-patched as static files without worker restart, and
served bytes / HTTP 200 / `Cache-Control: no-cache` were verified. Refresh an open
client. The recorded deployed renderer is the single-active-row variant, not the
separate pending staggered-row experiment. Recreating an older Docker image loses
a hot patch: rebuild the image from the intended source before its next rollout.

A pre-commit independent review also found a Life compaction edge: its retirement
check could expire while compacting and never be rearmed. Completion now rearms
Life retirement on both success and failure, with held-compaction regressions;
standard sessions retain their warm timeout. Those regressions first reproduced
the blocked lease on the unfixed candidate.

Backend source changes (including Life retirement) are not proof of a running
worker rollout. Use the approved restart-service deployment procedure only when
safe; do not interrupt an active conversation to deploy them. This documentation
and recording do not claim that such a restart occurred.

Coverage is Chromium plus deterministic transport fixtures, not physical
Safari/iPad, provider-generation cadence, unreliable real-network behavior, or
sub-frame device behavior beyond the recorded 25fps and RAF instrumentation.
