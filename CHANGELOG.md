# Changelog

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
