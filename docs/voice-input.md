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
  an inset 1–2px `box-shadow` ring on its edge and a soft glow outside it, both
  following the microphone level (`--voice-level`, 0–1, from the SDK's ~10 Hz
  RMS, mapped by `glowLevel` so room noise stays dark). Until 2026-11-01 the
  glow was inset (pane composers clip their overflow), reaching 18px in over
  the text; once the dB map made it move for real speech the user said it got
  in the way of what they were writing (「不要擋到我現在輸入的內容」). Now only
  the ring is inside (it sits on the edge, over the box's 4px padding), the
  e2e test checks a pixel inside the box is the same as with voice off, and in
  a pane the outside glow is cut at the top (the wrap has no top padding).
  While nothing is heard the frame gets `.voice-quiet` with the mic and the
  ring breathes (accent 45% → 12%, 1.6 s).
- **The mic shows what it hears** (2026-11-01; the user: 「至少讓我知道說他有在
  收音，而且還是有收到的」). While listening the mic glyph becomes five bars
  (`.voice-meter`, `meterBars`): the newest level in the middle, the two before
  it outside, so speech moves them; with two silent readings in a row the
  button gets `.voice-quiet` and the bars are dots that breathe (the mic is
  open, just quiet). No chunks for 3 s still stops listening (the stall rule
  below), and the glyph comes back. `glowLevel` was linear from RMS 0.012, but
  a real iPhone capture (Komorebi, 2026-10-31, call processing on) had speech
  at 0.0031 median / 0.0065 p90 per 100 ms and 0.0006 in pauses, so the ring
  never moved for the user's speech. It is now dB: −58 dBFS → 0, −32 dBFS → 1
  (that speech: 0.30 median, 0.55 p90; the pauses: 0). The ring is brighter while a sentence is being
  heard (`.voice-hearing`). Inset because pane composers clip their overflow;
  the composer's size never changes (the e2e test checks the height).
- **The placeholder says what is happening**: 語音輸入開啟中… while it connects
  and opens the microphone, 說話即可輸入… while listening, 點一下畫面開始收音…
  while waiting for a tap, 語音輸入：<error> after a failure, and what Komorebi
  says about its services (below). No toasts.
- **Komorebi's services** (2026-10-31). The user: 「怎麼講都沒有用」, as if
  switching voice input on had not started the service behind it. Komorebi
  (`app/backends.py`, its commit `46d49cd`) now checks the speech recognizer
  (TEA since 2026-11-01, SenseVoice before) and the clean-up model (Gemma E2B on the NPU; the CPU until 2026-11-03) each session uses
  when the session starts, starts a systemd unit that is down, and sends
  `komorebi.backends` (`{state, backends: [{role: asr|refine, name, state,
  reason}]}`). The box reads 語音服務啟動中… while the recognizer starts (the
  mic stays on and Komorebi transcribes what was said once it is up), 可說話，
  整理模型啟動中 while only the clean-up model starts (sentences go in as heard
  meanwhile), and 語音辨識無法啟動（<reason>） with the mic in `--danger` when the
  recognizer cannot start (服務已停用 / 主機記憶體不足 / 服務啟動失敗 / 服務沒有回應);
  a clean-up model that cannot start only shows in the mic's title. Until a new
  session's first event the box still says 語音輸入開啟中… (it arrives with the
  `session.updated`; without it 說話即可輸入… flashed before 語音服務啟動中…), and
  a server without the event reads as ready after 1.5 s (`CHECK_WAIT_MS`).
  Measured in Chromium against the real server with SenseVoice stopped:
  開啟中 → 啟動中 at 0.3 s → 說話即可輸入… at 1.4 s, the first sentence in the box
  at 1.8 s; with it up, 說話即可輸入… at 0.08 s. `voiceStatus()` makes the text; the state
  is dropped when the connection closes, since a new session checks again. A
  phone shows about 11 characters of the one-line placeholder, so the failure
  leads and the reason may be cut (the title has it all).
  What the captures showed (`~/.cache/komorebi-capture`, Komorebi's
  `KOMOREBI_CAPTURE_DIR`): the piweb sessions that heard nothing that day
  (19:34 and 20:05, Safari on an iPad or Mac) had the server and SenseVoice up;
  their microphone audio was almost silent (RMS 0.001–0.002 while speaking,
  about −55 dBFS, against 0.07 for the test recording), so DeepFilterNet and
  the VAD took it for room noise. The service check does not change that case. The placeholder stays on one line (`white-space: nowrap`, the full
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
`Intl.Segmenter`), with no long press. Up and down still scrolls the box. The circle is the
quote selection's bubble (`selection-bubble.js`, in a fixed `.voice-lasso-layer`
over the box) and a 刪除／取消 pill (`.selection-actions`, above the words, and
above any control it would cover: the hot keyword chips sit right over the box,
and a pill on them took the tap meant for a chip, iPhone 2026-11-01).

- Letting go sends the span (`Dictation.select(start, end)` →
  `komorebi.selection.set`). The **next sentence replaces it**: with 整理草稿 on
  Gemma rewrites only that span from what was said (a new word replaces it,
  「刪掉」「正式一點」 do that); off, what was said goes in as heard. The
  server answers `komorebi.selection.replaced`; the box shows what changed as
  for any rewrite, and the circle goes. Once that sentence is heard (a partial
  with words, or a transcript) the pill hides and the circle cannot be
  dismissed; a sentence that heard nothing leaves the words circled and the pill
  where it is. Until 2026-11-01 the pill hid at every `speech_started`: on the
  iPad a room's noise started and ended empty "sentences" about every half
  second, and the pill hid and popped back each time (screen recording).
- **The box takes the finger itself** while voice input is on (2026-11-01:
  「選擇功能是壞掉的」). iOS answered a finger on the focused box with its edit
  menu (貼上／選取／全選), a loupe on a long press and a moved caret, in the middle
  of circling. Now `touchstart` on the box is cancelled: a tap places the caret
  where the finger is (measured on the layer, `placeCaret`) and focuses the box
  (no keyboard: `inputmode="none"`), up and down scrolls it (`scrollTop`, no
  momentum), sideways circles. Native selection, copy and the edit menu in the
  box come back with voice input off; paste has the composer's 貼上 button.
- **A stroke stays on its line** until the finger is a full line away from the
  first word's line. On the iPad the touch point sat a few pixels above where
  the finger seemed to be, so a stroke along line 2 circled from line 2 into
  line 1.
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

The recognizer is not a setting: finished sentences are recognized by **TEA-ASR-1.1-mini**
(`komorebi-tea*`; 2026-11-01, the user: 「Piweb 也一起調整」 after Komorebi's IME page made it the
default). On Taiwanese speech it makes about half SenseVoice's errors and takes ~0.4 s more a
sentence; the live text while speaking still comes from SenseVoice. When the host cannot start
TEA (memory), the box says 語音辨識無法啟動（…）.

| field | default | meaning |
|---|---|---|
| 語音伺服器 | `wss://komorebi.crayfish-monitor.ts.net/v1/realtime` | the Komorebi realtime endpoint |
| 整理草稿 (switch) | on | off = the SDK's `refine: false` (the Komorebi IME page's 整理全文 switch): sentences go in as heard, nothing is rewritten, fastest and unaffected by a busy host; the clean-up API fields grey out. `setRefine` applies it from the next sentence |
| 通話模式收音 (switch) | on | the SDK's `processing`: the browser's echo cancellation, noise suppression and auto gain (`getUserMedia`). On an iPhone that is the voice processing used for calls; off records the microphone as is and leaves the cleaning to Komorebi's DeepFilterNet 3. A change reopens the microphone |
| 整理草稿用的 API URL | empty | empty = Komorebi's **Gemma 4 E2B on the NPU** (`model: komorebi-tea-npu-e2b`, `refine: 'npu-e2b'`; the CPU E2B was turned off 2026-11-03); a URL = any OpenAI-compatible API (`model: komorebi-tea`, `refine: {provider: 'openai', base_url, model, api_key}`) |
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
