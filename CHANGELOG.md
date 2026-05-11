# Changelog

## 0.6.1 - 2026-05-11

### Fixed

- Capture hook's `/dispatch/wake` ping used the wrong daemon port (`RECALL_DAEMON_PORT` default `47649`) instead of `RECALL_PORT` (default `7890`), so every wake silently failed and freshly captured prompts only got picked up on the timer-based dispatcher cycle. Fixed to use the canonical `RECALL_PORT` / `7890`.

## 0.6.0 - 2026-05-11

### Added

- LLM-primary capture path. When an LLM provider is configured, the user-prompt hook now hands the raw prompt to an `extract_rules_from_prompt` task instead of running the regex extractor. The LLM judges in any natural language (en/es/fr/de/it/pt/ru/zh/ja/sq/tr supported by the pre-screen) and returns one canonical English rule per durable directive, with confidence and scope. Empty list is a valid answer. The regex extractor stays as the fallback when no provider is configured or `RECALL_LLM_CAPTURE_DISABLED=true`.
- Multi-language pre-screen (`isPromptWorthLLM`) filters out pure code-request prompts before the LLM call, keeping costs negligible at observed volumes.
- `POST /dispatch/wake` daemon endpoint, debounced 3 s. The capture hook pings it on every enqueue so fresh captures get an LLM verdict within seconds instead of waiting for the next timer tick. The existing daily timer-based cadence remains as a backstop.
- Managed CLAUDE.md memory-override block, installed by `recall setup` and repaired by `recall doctor --fix`. The block tells Claude Code's harness to defer all memorize/forget intents to Recall instead of writing to `~/.claude/projects/*/memory/MEMORY.md`, which previously produced a dual-write between Claude's built-in auto-memory and Recall. New flags `--no-claude-md` on `recall setup` and `recall setup local`, opt-out env `RECALL_SETUP_SKIP_CLAUDE_MD=1`. `recall doctor` now reports `claude.md:ok|STALE|MISSING|ABSENT_NO_FILE`.

### Changed

- `qualityReasons` fragment filter tightened to catch garbage that previously slipped through: removed modals (`always`, `never`, `must`, `should`, `don't`) from `VERB_HINTS` so the `no_verb` check actually fires on bare-modal scraps; bumped `MIN_RULE_LENGTH` from 14 to 20; added `trailing_dash` and `embedded_question` reasons. The expanded `VERB_HINTS` now covers `update`, `create`, `delete`, `rename`, `validate`, `verify`, `check`, `follow`, `read`, `write`, `open`, `close`, `send`, `receive`, `configure`, `enable`, `disable`.
- Dispatcher task priority: `extract_rules_from_prompt` runs at priority 14, ahead of `verify_capture` (12), because under LLM-primary capture it IS the candidate creation path — without it, real rules never reach the queue.

### Capture env

- `RECALL_LLM_CAPTURE_DISABLED` (default `false`) — set to `true` to force the regex fallback path even when an LLM provider is configured. Useful for offline/airgapped runs or benchmarking.
- `RECALL_SETUP_SKIP_CLAUDE_MD` — set to `1` to skip the managed CLAUDE.md block install during `recall setup`.

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
