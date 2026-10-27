# Opening the app: one round trip after the page

On the phone every request is a tailnet round trip. Measured 2026-10-27 the
iPhone was reached over a DERP relay (Hong Kong) at 130 ms to 1.9 s per ping,
while the server answered every boot endpoint in under 70 ms. A recording of
opening the Home Screen app showed ~10 s before the transcript appeared: black,
white, `no session` for ~3 s, then the session's name over an empty transcript
for ~3.5 s.

The cause was the number of requests boot awaited one after another, not any
one of them:

```
page → app.js → its imports → their imports → /api/me → /api/commands + /api/models
     → /api/sessions → /api/sessions/deleted → /api/sessions/<jid>/events
```

Nine round trips after the page. With every response delayed 0.9 s, a
read-only replay of the live site reproduced the recording's shape (app shown
at 4.7 s, title at 7.5 s, transcript at 8.5 s in Chromium; 9.0 s in WebKit).

## What the page does now

```
page ─┬─ stylesheets, katex/highlight
      ├─ app.js and its whole import graph      (modulepreload)
      └─ /api/me, /api/commands, /api/models,    (head script)
         /api/sessions, /api/sessions/deleted,
         /api/sessions/<predicted jid>/events?limit=50
```

- **`<link rel="modulepreload">` for the static import graph** in
  `index.html`, so the modules download with app.js instead of one import
  level per round trip. The URLs must match the imports exactly, `?v=`
  included; `test/boot-prefetch.test.ts` computes the graph from the sources
  and fails when the list and the graph differ. Dynamic imports (the Komorebi
  SDK) are not preloaded.
- **A head script starts boot's GETs** before the stylesheets (a pending
  stylesheet holds an inline script back) and stores the promises in
  `window.piwebBootPrefetch`. `api()` in `app.js` hands each one to the first
  call for that exact path with no options; a failed prefetch falls back to a
  normal fetch.
- **The session boot will open is predicted.** Boot opens the most recently
  active session (`standardFallbackJid()`); every `loadSessions()` stores that
  jid as `localStorage['piweb.bootJid']`, and the next page load prefetches its
  newest page. Life mode skips it.
- **Leftovers are dropped, never served later.** When boot ends, and when the
  login gate shows, `bootPrefetch.clear()` drops whatever boot did not take: a
  predicted session that boot did not open must not be shown from a stale
  response when it is opened minutes later, and after logging in, boot must not
  take the 401s fetched before it.

Replaying the live site with every response delayed 0.9 s, the transcript now
appears at 2.1 s in Chromium (from 8.5 s) and 2.9 s in WebKit (from 9.0 s).
The real phone's latency varies with the relay, so its times will differ; the
number of waits is what changed.

## Verification

```bash
npx vitest run test/boot-prefetch.test.ts
PIWEB_E2E_PORT=4193 npx playwright test test/e2e/boot-prefetch.spec.ts
```

`boot-prefetch.spec.ts` delays every response by 500 ms. It checks that after
the page arrives, the leaf modules and every boot GET start within half a
round trip and each goes out once, and that the transcript shows within four
round trips (the old chain needed nine). It also checks that a prediction boot
did not use is fetched again when the session is opened later (`answer #2`),
and that logging in after the gate fetches afresh. Without the change the
first two fail; without either `clear()` the matching test fails.
