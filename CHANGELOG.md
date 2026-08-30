# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Recently deleted now supports Select-button or touch/mouse long-press multi-selection, one-confirmation permanent deletion, Select all, and Delete all in responsive phone and desktop layouts
- Life mode's New action now saves the current conversation into the ordinary Sessions list, including its transcript, media, and Pi context, before opening a fresh empty Life session
- Syntax highlighting for fenced code blocks, including automatic language detection when the language tag is omitted or unknown
- Persisted dark/light appearance switching from the Sessions drawer, with a Japanese-minimal daytime palette
- Playwright mobile E2E coverage with WebM recording, reviewed screenshot baselines, traces, and an HTML evidence report
- Deterministic Playwright behavior and visual regression coverage for theme persistence and drawer/sheet layering

### Changed

- Move the **pi status** header shortcut from standard sessions into Life mode and bind it to the confirmed Life generation
- Replace the overflow menu's **Clean session** action with the same restorable **Delete session** flow used by the Sessions drawer

### Fixed

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
