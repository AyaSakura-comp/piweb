# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- A place map opens full screen on a tap as a live map: drag it with a finger, pinch to zoom, swipe the cards to bring each place to the middle; ✕ or Escape closes it. In the transcript it stays a picture, so a finger on it still scrolls
- Places on a map: a Pi session ends a reply that names physical places (venues, shops, event sites, street addresses) with a ```map block, one `name | address` per line, and the transcript shows one still map in the app's light or dark colours with a numbered pin per place and, over its foot, a frosted card per place (number, name over address, a directions arrow): one card in view, a swipe or a pin tap for the next, the pins following. A card opens the place in Google Maps, its arrow directions to it. Places are found with OpenStreetMap's Nominatim (one request a second, kept in the browser) once the card is on screen, and the map is drawn by MapLibre from OpenFreeMap and kept as a picture. Pi is asked through a piweb Pi extension (`pi-extensions/piweb-reply-format.ts`), which adds to the system prompt and keeps `~/.pi/agent/APPEND_SYSTEM.md`; Claude Code and agy sessions are not asked
- ⏩ Continue in the chat composer, left of the mic: one tap sends "continue" to the session's agent. It shows only while the box is empty (typing, a quote, attachments or the mic listening put it away) and not in Life or BTW
- agy turns that Google's servers fail in passing (503 "No capacity available … try again in a minute", 502/504, an idle stream) run again by themselves after 15 s, 30 s, 1 min and 2 min, saying so in the transcript; a newer message stops the wait
- 🔑 Login details for the agent: a key in the composer takes a name, account and password; the web tier seals them to the host worker's key at once, so the database, the transcript and Pi's session file never hold them in plain text — the agent is told variable names (`$PIWEB_SECRET_GITHUB_PASS`), Pi's tools get the values when they run, and anything echoed back is scrubbed
- BTW in AGY sessions, answered by agy's own `/btw` (asked in agy's TUI beside the conversation; the main conversation never sees it)
- Recently deleted now supports Select-button or touch/mouse long-press multi-selection, one-confirmation permanent deletion, Select all, and Delete all in responsive phone and desktop layouts
- Life mode's New action now saves the current conversation into the ordinary Sessions list, including its transcript, media, and Pi context, before opening a fresh empty Life session
- Syntax highlighting for fenced code blocks, including automatic language detection when the language tag is omitted or unknown
- Persisted dark/light appearance switching from the Sessions drawer, with a Japanese-minimal daytime palette
- Playwright mobile E2E coverage with WebM recording, reviewed screenshot baselines, traces, and an HTML evidence report
- Deterministic Playwright behavior and visual regression coverage for theme persistence and drawer/sheet layering

### Changed

- A tapped Dashboard pane grows until 140px of its transcript are in sight (was 180px), still to an 80-column line and at least 1.5× its height, never past 60% of the stage: a bit bigger, not the most the others allow
- The image viewer gives the picture the whole screen: the top bar, arrows and filmstrip lie over it, and a tap on the picture fades them away (another tap brings them back); a double tap still zooms
- AGY and LOCAL session tags have their own colours: AGY in Google blue (it was the grey fallback), LOCAL green; in the light theme both (and GEM) take a tinted fill and rim like Claude's, so the three read apart in the drawer
- Use a slim BTW header with accessible back/clear icons, horizontal transcript switching and a pending-answer link; preserve independent composer drafts and restore pending questions from worker snapshots
- Set an explicit five-minute browser upload and server receive deadline, report timeout once and avoid automatic retries
- Restore the **/pi status** header shortcut to standard sessions while keeping it available in Life mode
- Replace the overflow menu's **Clean session** action with the same restorable **Delete session** flow used by the Sessions drawer

### Fixed

- Place maps take the app's colours and read at a glance: dark mode was OpenFreeMap's blue fiord with teal labels; now land, buildings and labels are the app's neutrals while water is blue, parks green, motorways amber and main roads brighter than side streets, in both themes
- A place map loads in about a second or three instead of eight to twelve: venue names go to Photon all at once while Nominatim (one request a second) looks up only the streets, and the map's code and style load meanwhile
- A place map's swipe now visibly moves to the next place: the other pins step back, places on neighbouring streets get two pins (zoom up to 17, not one pin on top of the other), a line with two addresses or a 鄰 is still found by its street, and a card whose place could not be found says so over the map instead of the map just not changing
- A Pi answer written from web research now gets its place map: research's closing instructions (read after Pi's system prompt) won over the map ask, so Life answered 「民雄附近哪裡有觀光工廠」 with street addresses and no map. research (pi-nodriver-browser) now asks for the ```map block in its own closing line, beside its image rule, when Pi was started by piweb
- With the iPhone turned sideways, text keeps the size the app sets: Safari no longer enlarges it in wide Dashboard panes only, which left wide and narrow panes at different sizes
- Dashboard on the iPhone: opening the keyboard no longer throws a pane's transcript back to older messages, and the input card rises straight to just above the keyboard instead of shooting up to the top of the pane and sinking back
- On an iPhone with an outer camera bump (Duo), the Dashboard no longer leaves a dead strip the whole height of the grid beside the rightmost pane: the phone rule only honoured the top safe area, so a reported side inset pushed the grid in from the edge; left and right insets are now 0 there and the grid runs to the physical edge (the regression emulates a 21px right inset and asserts it)
- An AGY session no longer fails with "model gemini-4-neon-high is not recognized as a known model" right after a reboot: agy could not load its model list yet, so the turn now waits and runs again (as long as `agy models` still has the model, or cannot answer yet); a model agy really dropped says so and points to /model
- Holding a session row sometimes opened Rename / Delete in the top-left corner, its title under the status bar: when the session list re-rendered during the hold (the 5 s poll, a session turning busy), the menu was placed against the replaced row; it now finds the row on screen, follows it when the list re-renders, and closes if the row is gone
- A Claude Code menu piweb has no rule for ("Resume this conversation?" when a long idle conversation is reopened, and any new one) no longer fails every message with "did not become ready": piweb shows the question and its options in the chat, holds the message, and the reply "1"/"2" picks the option and sends the held message; "Start a new conversation" starts one piweb can follow, pointing Claude at the old transcript
- A Claude Code session that a model's safeguards pause ("Session paused": Switch to Opus 4.8 / Edit prompt and retry with Opus 5.5) no longer shows "pi is working…" for an hour and then fails every later message: piweb picks retry on the same model, clears the prompt Claude Code puts back, and ends the turn with a message that says what happened
- Dragging a selection handle down through a formula no longer grows the selection up the screen: KaTeX's hidden MathML copy of the formula (which WebKit's caret lookup lands in) is never a selection point or quoted text, and a caret answer drawn more than a line from the finger is ignored; a quote across a formula holds it once
- A tool call's command (`KEY=$(…); … --auth-key="$KEY"`) is shown as written instead of being drawn as one TeX formula with its spaces gone

- A Claude Code session no longer dies when a command it ran is OOM-killed: systemd's default OOM policy stopped the pane's whole tmux scope ("can't find pane: %8"); each pane's scope now continues, and a pane that does vanish is reported in words
- agy turns on `gemini-4-hydrogen-xhigh` (new in agy 1.5.7) no longer fail with "conflicts with --effort=high": `-xhigh` (and `-minimal`/`-max`) count as an effort already in the id, and any other id agy says conflicts with `--effort` runs once more without it
- An agy turn no longer waits 2 s after agy exits: stdout had usually ended already, so the wait for its end never fired
- A selection no longer flickers while it is dragged: no dark slits or thin ledges flash through the bubble as lines pour in or drain away, and a mouse drag no longer shows the quote pill (and re-quotes, and scrolls a Dashboard pane) on every move — pill and quote come once on the release
- Dragging a long selection no longer lags: a motion of many lines is drawn frame by frame (moving every line's parts on the compositor cost 17ms a move on desktop), a drag moves the bubble once a frame, and parts in motion always start together so the outline no longer breaks into steps
- The selection bubble's 120Hz spring draws the exact outline on every frame: a line in motion no longer shows seams, loses its rim and glow where it was cut, squashes its rounded ends or keeps the corners of where it will rest, and a line draining away no longer leaves its shadow behind
- Send with the on-screen keyboard up is one upward motion while the keyboard goes down: the history no longer slides down with the keyboard, pauses and scrolls back up, and Jump to present no longer flashes up during a send
- Run BTW side controls beside the serial worker control loop so a long answer does not block later snapshots or unrelated controls, while retaining ownership fencing
- Keep Claude background Bash/Monitor work alive across yielded acknowledgements, publish intermediate replies to history and suppress an identical already-delivered final reply
- Complete extension-consumed RPC prompts on `input_handled` when no agent run starts, and use displayed custom receipt text when no assistant text is available
- Make permanent session purge recovery concurrency-safe with displayed channel-generation and deletion-episode purge tokens (including stale automatic-retention snapshots), generation-atomic command/title mutations with post-RPC cross-worker `/pi new` processing and durable-operation exclusion, reserved tombstone namespaces plus segment-aware cross-channel path-alias rejection with post-claim registration fencing, persisted directory inode identities, authenticated non-removable fsynced terminal seals and monotonic rmdir-only stale-upload guard publication, settled child/path/target cleanup, symlink/hard-link safety, missing-root creation, archive-discovery error propagation, confirmed-exit RPC ownership, pre-body request leases, post-retirement control fencing, atomic active-owner control claims, terminal cleanup of controls interrupted by trashing, frozen scheduled/message work plus folder-and-storage-token generation fencing for request leases, session-management mutations, and late worker cleanup on exactly reused owners, frozen transcript-safe clear handling plus stale live-output removal plus durable-worker plus monotonic-ownership-epoch restore-ABA exclusion for trashed sessions, delete/folder fences, completion receipts, and generation-specific guarded standard upload staging
- Prevent stale trash-list responses from resurrecting purged rows, and use native modal isolation so stacked dialogs preserve each other's ownership
- Fence suspended Life workers and controls after generation rotation, and prevent quarantined Life tasks from starving unrelated scheduled work
- Restore all message handling under pi 0.84, which replaced the synchronous model registry with an async `ModelRuntime` — the stale construction left every inbound message failing with `Internal error: this.runtime.refresh is not a function`
- Keep the Sessions drawer and its bottom actions above the composer and “Jump to present” control on mobile
- Render fenced code and command output on a warm, light syntax surface in the Japanese-minimal daytime appearance
- Open Media gallery videos and audio in a responsive in-app player with a top download action instead of navigating to the raw file
- Prevent iPhone Safari's native document-wide text selection from appearing underneath Piweb's transcript selection handles
- Prefetch older transcript pages before iPhone momentum scrolling reaches the hard top and anchor each prepend to the visible message, preventing page-boundary snap-back while reading history

## [1.5.3] - 2026-05-19

### Fixed

- Fix false `Required peer dependency @earendil-works/pi-ai is not installed` startup error when resolving ESM-only pi packages — thanks @kojira (#10), @hritique (#8)
- Fix cross-platform test failures: config path assertions now use platform-aware defaults instead of hardcoded Linux/XDG paths — thanks @hritique (#9)

## [1.5.2] - 2026-05-16

### Changed

- Refresh README presentation for npm/GitHub with banner, badges, and updated project summary

## [1.5.1] - 2026-05-15

### Added

- Startup check for legacy `@mariozechner/pi-ai` — users on the old package now get a clear upgrade message instead of a module-not-found crash

## [1.5.0] - 2026-05-15

### Added

- macOS launchd support for `piscord daemon` commands — thanks @that-yolanda (#6)
- Windows compatibility for pi subprocess spawning (dynamic .cmd shim resolution)
- Windows `SIGBREAK` signal handling for graceful shutdown
- Cross-platform executable lookup (`where` on Windows, `which` on Linux/macOS)

### Changed

- Migrate pi dependencies from `@mariozechner/*` to `@earendil-works/*` scope (pi v0.74.0+)
- Platform-aware default paths: XDG on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows
- Build script now works cross-platform (replaced `rm -rf` with Node.js `fs.rmSync`)
- Help text uses platform-neutral wording for daemon commands

### Fixed

- `piscord status` no longer crashes on macOS/Windows (removed unconditional systemctl dependency)
- `which` command replaced with cross-platform executable lookup in setup and status

## [1.4.3] - 2026-05-03

### Fixed

- Restore startup compatibility with @mariozechner/pi-ai 0.72.x thinking level APIs
- Keep legacy @mariozechner/pi-ai compatibility by falling back to the older `supportsXhigh` helper when available

## [1.4.2] - 2026-04-06

### Fixed

- Align default runtime XDG data directory with setup and docs to use `~/.local/share/piscord-gateway`
- Add regression coverage for default `DB_PATH` and `SESSIONS_DIR` resolution

## [1.4.1] - 2026-04-06

### Fixed

- Support text-only sends via `piscord send` without requiring file attachment

## [1.4.0] - 2026-04-06

### Added

- Per-channel working directories - override `PI_CWD` for specific channels without changing the global default

### Changed

- Group task and file relay tools documentation for pi users

## [1.3.0] - 2026-04-04

### Added

- Improved setup UX with faster install and default trigger

### Fixed

- Remove JSON.stringify quoting in systemd service file

## [1.2.0] - 2026-04-04

### Added

- Channel access policy (open / open-trigger / allowlist)
- `/pi stop` command to abort active task and clear queue
- Archived session auto-cleanup with configurable retention
- Scheduled tasks via CLI and scheduler engine
- Direct send-file CLI tool for Discord channels
- Per-channel model override via `/pi model`
- Thinking level control via `/pi thinking`
- Fresh session via `/pi new`

## [1.1.0] - 2026-03-31

### Changed

- Renamed package and CLI to piscord

## [1.0.0] - 2026-03-28

### Added

- Initial release
- Discord message to pi subprocess bridging
- Per-channel persistent sessions
- SQLite message queue
- Discord slash commands
- Attachment relay
- systemd integration
