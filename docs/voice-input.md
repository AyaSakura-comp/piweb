# Voice input (Komorebi)

Piweb's composers take speech through the Komorebi voice IME. Komorebi
(`AyaSakura-comp/komorebi-voice`) is a git submodule at
`third_party/komorebi-voice`; piweb uses its browser SDK (`sdk/js`, the
`Dictation` class) and talks to a Komorebi server over its OpenAI
Realtime-compatible WebSocket (`wss://komorebi.crayfish-monitor.ts.net/v1/realtime`
by default). Piweb's own server is not involved: the browser connects to
Komorebi directly.

## What the user sees

- **A mic button before Send** in the chat composer and in every Dashboard pane
  composer (`.voice-ime-btn`, borderless, 44px target on touch). It is one switch
  for the whole app: on stays on — across sends, pane switches and reloads
  (`localStorage` `piweb.voiceIme`) — until the button turns it off.
- **Speech streams into the box.** The box shows the draft so far plus the
  sentence still being spoken (`text + live`). After each sentence the clean-up
  model rewrites the *whole* draft (fillers out, punctuation, "不對，改成四點"
  applied to earlier sentences), as in the Komorebi IME, so the box is replaced
  each time, never appended to.
- **Before and after the clean-up** (2026-10-26, after the Komorebi IME page,
  `demo/voice-ime`): a sentence being spoken is dim and underlined with a
  blinking caret (the page's `.preedit.listening`). Once heard it reads as normal
  text with only a dotted accent underline while it waits for the rewrite (the
  page breathes it, `.refining`; on 2026-10-26 the CPU Gemma took 13 s per
  sentence on a saturated host and a breathing grey sentence that long read as
  stuck). When the rewritten draft lands,
  the page flashes the whole draft (`.fresh`); piweb diffs what was on screen (old
  draft + sentences as heard) against the new draft (`diffRuns`: common
  prefix/suffix, then a character LCS) and marks only the changes: what the
  clean-up put in is highlighted in `--accent` and fades over 1.2 s, what it took
  out stays struck through in `--danger`, fades and folds its width away; after
  1.4 s the marks go. A textarea cannot style parts of its text, so while there is
  something to show the same text is drawn in `.voice-mirror`, an absolutely
  positioned layer exactly over the box (its font, padding and size copied from
  the box, scrolled with it), and the box's own text goes transparent but keeps
  its caret. With nothing to show the layer is hidden and the box is a plain
  textarea again. Reduced motion keeps the marks steady until they go.
- **No on-screen keyboard while on.** Every registered composer gets
  `inputmode="none"`, and starting voice input blurs a focused composer, so the
  iPhone/iPad keyboard goes away and does not come back on taps. The box still
  takes a hardware keyboard, paste, hot-keyword chips and the caret; what is
  typed becomes the draft the next rewrite starts from (`Dictation.setText`).
- **A listening ring that takes no space.** While listening the composer gets
  an inset `box-shadow` ring plus an inner glow that follow the microphone
  level (`--voice-level`, 0–1, from the SDK's ~10 Hz RMS, mapped by `glowLevel`
  so room noise stays dark). The ring is brighter while a sentence is being
  heard (`.voice-hearing`). Inset because pane composers clip their overflow;
  the composer's size never changes (the e2e test checks the height).
- **The placeholder says what is happening**: 說話即可輸入… while listening,
  點一下畫面開始收音… while waiting for a tap, 語音輸入：<error> after a failure.
  No toasts. The placeholder stays on one line (`white-space: nowrap`, the full
  error is in the mic button's title), and the box measures itself again when
  the status changes: an empty textarea's `scrollHeight` counts its
  placeholder, so iOS's long microphone refusal grew the box to three lines,
  which stayed after voice input was turned off (iPhone screenshot 2026-10-27;
  220px instead of 40 in the e2e control run).
- **After a failure** the first tap on the mic retries and the next turns voice
  input off. Before 2026-10-27 every tap retried, so a refusal that failed at
  once on each retry left no way to turn it off.
- **Send** ends the sentence being spoken and waits for it and its clean-up at
  most 1.2 s (`take()`, `TAKE_TIMEOUT_MS`); what is not back by then is sent as
  heard. Those sentences' later events are dropped (`sentItems`) and their late
  rewrite, made of a draft already sent, is replaced by the current draft, so it
  never reappears in the next message. `take()` empties the box itself before it
  notifies, or the sentence still on screen would read as typed text. The mic
  keeps listening for the next message.

## Circling words (lasso, 2026-10-27)

As on the Komorebi IME page: while voice input is on, a finger stroked
**sideways** across the box's text circles the words it crosses (whole words,
`Intl.Segmenter`), with no long press. Up and down still scrolls the box
(`touch-action: pan-y` on the box while it has no keyboard). The circle is the
quote selection's bubble (`selection-bubble.js`, in a fixed `.voice-lasso-layer`
over the box) and a 刪除／取消 pill (`.selection-actions`, above the words).

- Letting go sends the span (`Dictation.select(start, end)` →
  `komorebi.selection.set`). The **next sentence replaces it**: with 整理草稿 on
  Gemma rewrites only that span from what was said (a new word replaces it,
  「刪掉」「正式一點」 do that); off, what was said goes in as heard. The
  server answers `komorebi.selection.replaced`; the box shows what changed as
  for any rewrite, and the circle goes. While that sentence is spoken the pill
  hides and the circle cannot be dismissed; a sentence that heard nothing leaves
  the words circled.
- **刪除** takes the words out at once (the draft is synced, the removal shows
  struck through and folds away); **取消**, a tap on the box or anywhere else,
  typing, Send, switching composers or turning voice off put the circle away and
  clear the server's selection. A finger on 刪除 / 取消 acts on `pointerup`
  (≤10px of movement) and the click after it is ignored: iOS Safari can withhold
  that click, and on the iPad the buttons often did nothing (2026-10-27).
- No circling while a sentence is still being heard or rewritten: its rewrite
  would move the offsets.
- A mouse selects in the box as usual; letting go circles the selection.
- Measuring: the box is a textarea, so while circling its text is drawn in the
  `.voice-mirror` layer as one text node and characters are hit-tested there
  (`charAtPoint`).
- The sentence being spoken still shows at the end of the box, not after the
  circled words as on the IME page.

## Where the text goes

One `Dictation` serves the visible composer (`resolveTarget` in `app.js`): the
Dashboard's composer-card pane when the Dashboard is open, else the chat's
`#input`. `retarget()` runs when the Dashboard opens or closes and when the card
moves to another pane; the new box's text becomes the draft.

Typing while a sentence is still being rewritten: that rewrite was made from
the draft before the typing, so when it lands the typed text wins and is sent to
the server again (`staleItems`); typing also syncs the draft at once instead of
after the SDK's 300 ms, so a sentence ending in between starts from it. (Found
by the e2e test: the rewrite used to overwrite what had just been typed.)

Places that write a box themselves either fire `input` (paste, hot keywords —
handled like typing) or call `voiceIme.sync(textarea)` (autocomplete, a failed
send restoring its draft). As a safety net, a render that finds the box changed
behind its back keeps that text and only appends a sentence the server appended
(`mergeOutsideEdit`).

Browsers start audio only from a user gesture, so after a reload, a return to a
backgrounded page or a dropped connection, voice input that is on starts again
on the next tap anywhere (a one-shot capture `pointerdown`/`keydown` listener).
The same happens when the browser stops the microphone under a page that is
still listening: iOS pauses a page's audio for the photo picker, a screen
recording or another app without telling it. The mic sends a chunk every
~100 ms, silent or not, so none for 3 s (`STALL_MS`) stops listening and waits
for that tap; before 2026-10-27 the page kept reading as listening and only
toggling the mic brought it back (two minutes of no audio after attaching a
video on the iPad).
Turning it off stops the mic; the connection closes 8 s later, after the last
sentence has landed. The SDK keeps the microphone stream for 5 minutes after a
stop so iOS does not ask for permission again.

## Settings → 語音輸入（Komorebi）

Per browser (`localStorage` `piweb.voiceIme.settings`; `tidy` added 2026-10-26, `callAudio` 2026-10-27):

| field | default | meaning |
|---|---|---|
| 語音伺服器 | `wss://komorebi.crayfish-monitor.ts.net/v1/realtime` | the Komorebi realtime endpoint |
| 整理草稿 (switch) | on | off = the SDK's `refine: false` (the Komorebi IME page's 整理全文 switch): sentences go in as heard, nothing is rewritten, fastest and unaffected by a busy host; the clean-up API fields grey out. `setRefine` applies it from the next sentence |
| 通話模式收音 (switch) | on | the SDK's `processing`: the browser's echo cancellation, noise suppression and auto gain (`getUserMedia`). On an iPhone that is the voice processing used for calls; off records the microphone as is and leaves the cleaning to Komorebi's DeepFilterNet 3. A change reopens the microphone |
| 整理草稿用的 API URL | empty | empty = Komorebi's **Gemma 4 E2B on the CPU** (`model: komorebi-smart-cpu-e2b`, `refine: 'cpu-e2b'`); a URL = any OpenAI-compatible API (`refine: {provider: 'openai', base_url, model, api_key}`) |
| 模型 / API key | — | shown only with a custom URL |

A change applies at once: a new server reconnects, a new clean-up model applies
from the next sentence (`setRefine`). Komorebi accepts only public `https`
clean-up URLs by default (`KOMOREBI_CLIENT_REFINE=public`); the key travels to
the Komorebi server with the session and is used only for that connection.

## Files

| file | role |
|---|---|
| `third_party/komorebi-voice/` | submodule; only `sdk/js/*.js` is used |
| `scripts/build-client.mjs` | copies `sdk/js/*.js` to `public/komorebi/` (gitignored); the SDK loads its audio worklet by a URL relative to itself, so it is served as files, not bundled |
| `public/voice-ime.js` | `createVoiceIme()`: buttons, target, render, take, settings; pure helpers unit-tested in `test/voice-ime.test.ts` |
| `public/app.js` | creates it, registers `#input`, resolves the target, takes before a send, settings fields |
| `public/session-dashboard.js` | registers each pane composer, takes before a pane send (BTW too), retargets on card moves |
| `public/app.css` | `.voice-ime-btn`, `.composer.voice-listening`, `.settings-field` / `.settings-input` |

The submodule URL is SSH to the private `AyaSakura-comp/komorebi-voice`
(`branch = main`). After a fresh clone: `git submodule update --init` (the
build fails with that hint otherwise); after `git pull`, run it again, since
pull does not move submodules. To move to a newer Komorebi SDK: **push the
Komorebi commit first** (piweb must only record commits that exist on GitHub,
or fresh clones cannot check the submodule out), then `git -C
third_party/komorebi-voice fetch && git -C third_party/komorebi-voice checkout
<commit>`, `npm run build:client`, commit the submodule pointer, hot-deploy
`public/komorebi/`. The full steps are in
[README.piweb.md](../README.piweb.md#komorebi-voice-sdk-submodule).

## Verification

```bash
npx vitest run test/voice-ime.test.ts
PIWEB_E2E_PORT=4193 npx playwright test test/e2e/voice-ime.spec.ts
# the real Komorebi server, with its two-sentence recording as the microphone:
PIWEB_E2E_KOMOREBI=1 PIWEB_E2E_PORT=4193 npx playwright test test/e2e/voice-ime-live.spec.ts
```

`voice-ime.spec.ts` fakes the Komorebi server on the WebSocket route (partial →
completed → `komorebi.draft.updated`) with Chromium's fake microphone: button
size and place, `inputmode`, ring without a height change, the heard sentence
as preedit then the clean-up's insertion (`。`) and removal (`嗯`) marked and gone
after the fade, the layer on the box's pixels and font, the session's model
and refine, typing into the draft, Send sending the draft and keeping the mic on,
resume after reload on a tap, off; Settings' custom API reaching the session; a
Dashboard pane receiving the text and sending it. The live spec (2026-10-26)
heard 明天早上要跟 PM 開一個 meeting。我明天要出去玩。 and sent exactly that (with
`PIWEB_E2E_KOMOREBI_TIDY=off` the same recording came back as heard:
明天早上要跟PM開一個meeting。我明天呃要出去玩。); a
second run captured the real clean-up's changes in the box (spaces put in around
PM and meeting). Real
iPhone/iPad behaviour (keyboard suppression, mic permission, WebKit audio) is
not covered by these Chromium runs.
