# Changelog

## 0.5.8 - 2026-05-06

### Fixed

- The cask renderer (`scripts/render-homebrew-cask.mjs`) hardcoded the cask body and ignored the template file, so the quarantine-strip postflight added in 0.5.7 never reached the published cask. The renderer now emits the postflight directly so fresh `brew install --cask recall` no longer hits Gatekeeper relocating `/Applications/Recall.app`.

## 0.5.7 - 2026-05-06

### Fixed

- `scripts/build-app.sh` now passes `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` to `xcodebuild`, so the bundled `Info.plist` actually contains a `CFBundleShortVersionString` and the in-app version label introduced in 0.5.5 displays the right value (previously empty).
- Homebrew cask postflight strips the `com.apple.quarantine` xattr after install. The bundle is ad-hoc signed, and Gatekeeper was relocating `/Applications/Recall.app` to `~/Library/Application Support/com.apple.mobile.installation.removed` on first launch after `brew install --cask recall`. Manual installs of prior releases still need a one-time `xattr -dr com.apple.quarantine /Applications/Recall.app`.

## 0.5.6 - 2026-05-06

### Fixed

- Closing the Settings window with its red close button no longer terminates Recall.app and removes the menu bar icon. `applicationShouldTerminate` now cancels termination unless the user explicitly invoked "Quit Recall" from the menu bar dropdown, working around SwiftUI's Settings scene calling `NSApp.terminate` directly.

## 0.5.5 - 2026-05-06

### Added

- Recall.app now displays its version next to the dashboard title and in the menu bar dropdown header, so it's obvious which build is running after a Homebrew upgrade.

## 0.5.4 - 2026-05-06

### Fixed

- Recall.app now launches as a true menu-bar agent (`LSUIElement=YES`) instead of switching from `.regular` to `.accessory` after the dashboard view appears. This eliminates the regression where closing the dashboard window would also remove the menu bar status item on newer macOS versions.

## 0.5.3 - 2026-05-06

### Fixed

- Activity event and hook call inserts are now atomic via `INSERT … ON CONFLICT(dedupe_key) DO NOTHING`, eliminating the `UNIQUE constraint failed: activity_events.dedupe_key` errors that flooded `~/.recall/logs/hook-errors.log` when multiple agent processes wrote concurrently. Effectiveness telemetry (`recall eval`) now sees those tool-call events instead of dropping them.
- WAL maintenance escalates `wal_checkpoint(PASSIVE)` to `TRUNCATE` once `recall.db-wal` exceeds 32 MiB (configurable via `RECALL_SQLITE_WAL_TRUNCATE_BYTES`), preventing the WAL file from growing into the hundreds of megabytes under sustained concurrent writers.
- DB open performs a one-shot `wal_checkpoint(TRUNCATE)` if the existing WAL is already past the threshold (`RECALL_SQLITE_STARTUP_WAL_TRUNCATE_BYTES`), so installs that grew a large WAL before this release shrink on the next daemon start.
- `~/.recall/logs/hook-errors.log` rotates to `hook-errors.log.1` at 1 MiB (`RECALL_HOOK_LOG_MAX_BYTES`) instead of growing unbounded.

## 0.5.1 - 2026-05-04

### Fixed

- Capture pipeline now blocks auto-promotion of trigger-template rules ("when user says X, do Y") in addition to destructive-risky ones; both shapes surface in the SessionStart pending-confirmations queue with a per-item reason tag.
- SessionStart injection (minimal style) emits a compact `Recall (<repo>):` lead-in instead of stripping all attribution, so foreign agents can identify Recall-sourced context.
- Global-scope memories render with a `[global]` marker in `## Rules` / `## Commands` / `## Gotchas`, making cross-repo provenance unambiguous.

## 0.5.0 - 2026-05-04

### Added

- Static landing page in `docs/` for GitHub Pages.
- CI, Pages, and release workflows for open-source distribution.
- GitHub Release packaging for `Recall.app.zip` plus optional Homebrew cask publishing.
- Open-source project docs and templates for contributors, security reports, issues, and PRs.
- Streamable HTTP MCP endpoint on the daemon at `/mcp`, alongside the existing stdio MCP server.
- Local embeddings now ship default-on with `nomic` and optional `multilingual-e5`.
- `recall embeddings setup` and `recall embeddings info` for model cache management.
- Provider comparison in retrieval evals via `recall eval retrieval --provider ...`.
- macOS Recall.app now surfaces background setup progress while launchd and the daemon rebuild the local store.

### Changed

- Recall now performs a destructive local DB reset on first boot after the embeddings cutover and rebuilds memory from repo scans.

### Upgrade Note

- First launch after upgrading resets Recall's local memory store.
- Existing local memories are cleared, repos are rescanned, and local embeddings/indexes are rebuilt in the background.
- The macOS app and daemon logs surface setup progress during that one-time migration.
