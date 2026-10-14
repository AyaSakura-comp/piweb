# Hot keywords

Standard sessions show up to ten chips above the composer: the words the user
typed most in the last 7 days. They are multi-select: a tap toggles a chip and
adds or removes its word in the message box (appended after any draft); nothing
is sent. A tap leaves the iPhone keyboard as it was — open stays open, closed
stays closed: the chip acts on `touchend` and cancels its default, so focus
never moves to the chip, and the box is never focused. A finger that moved
more than 10px is a sideways scroll of the row, not a tap. A chip is released when its word leaves the box — edited away, or the
box emptied by sending. More chips than fit scroll sideways in the same row.
Life keeps its own quick tags in that spot, and BTW hides the row.

## How the ranking works

No language model. `src/agent/hot-keywords.ts` (pure, unit-tested):

1. Take the user messages of standard sessions from the last 7 days
   (`web_events`), drop slash commands and quoted text (`↪ 引用：「…」`).
2. Split into words with `Intl.Segmenter('zh-Hant', { granularity: 'word' })`
   (ICU's dictionary segmentation handles Chinese; no dependency).
3. Drop filler (a stop list of function words and chat filler tuned on the
   user's own prompts: 有沒有, 可以, 直接, 還是, the, please…), numbers, one-character
   Chinese words and English words under 3 letters.
4. Count each word once per message, keep words used in at least 2 messages,
   rank by count (ties alphabetical, so chips do not shuffle), take ten.

`src/worker/hot-keywords-job.ts` recounts whenever a web event was added
(checked every 30 s; a week of prompts takes ~35 ms) and publishes
`{generatedAt, windowDays, items:[{word, count}]}` to
`<WEB_MEDIA_DIR>/piweb-shared/hot-keywords.json` (atomic rename). The web tier
already serves that directory at `/media/` behind the same auth, so the feature
needs no web route and no image rebuild.

`public/hot-keywords.js` fetches the file when the page loads, every time it
becomes visible again (iOS suspends background tabs, so that is a reconnect),
and when the browser comes back online.

## Tests

- `test/hot-keywords.test.ts`: segmentation, filler/quote/command/number
  filtering, once-per-message counting, ranking, the ten-word cap.
- `test/e2e/hot-keywords.spec.ts`: chips above the composer, sideways scroll,
  multi-select add/remove, release on edit and on send, never sends by itself,
  hidden in Life, no empty row without a file, refetch on visibility.
