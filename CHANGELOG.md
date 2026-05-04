# Changelog

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
