# Releasing Recall

Release artifacts are produced from tags named `vX.Y.Z`.

## Prerequisites

- GitHub Pages enabled for the repository.
- `edihasaj/homebrew-tap` and `edihasaj/homebrew-recall` taps created before the first Homebrew publish (the workflow keeps both in sync).
- `HOMEBREW_TAP_GITHUB_TOKEN` secret with write access to both taps if Homebrew publishing should run.
- XcodeGen available in CI through `brew install xcodegen` (handled by the release workflow).

## Automatic Release

On pushes to `main`, `.github/workflows/auto-release.yml` watches `CHANGELOG.md`, `package.json`, and `package-lock.json`.

When the current `package.json` version has no matching `vX.Y.Z` tag and `CHANGELOG.md` contains a matching `## X.Y.Z` section, the workflow creates the tag and dispatches `.github/workflows/release.yml` plus `.github/workflows/windows-tray.yml`.

All workflow actions are pinned to immutable commits. Checkouts do not persist
GitHub credentials, native prebuilds have read-only repository permission, and
manual release dispatches fail unless the requested tag is an existing
`vX.Y.Z` tag. Keep those controls intact when changing release automation.

## Checklist

1. Update `package.json` version.
2. Update `CHANGELOG.md`.
3. Run the local gate:

```bash
npm ci
npm run docs:check
npm run typecheck
npm test
npm run build
```

4. Push to `main`; the auto-release workflow creates the tag and dispatches `.github/workflows/release.yml`.

## What CI Publishes

The release workflows publish the npm package, build `Recall.app`, package it as `Recall.app.zip`, write `Recall.app.zip.sha256`, build both Windows tray architectures, create a GitHub Release if needed, and upload all platform assets.

If `HOMEBREW_TAP_GITHUB_TOKEN` is configured, the workflow renders `Casks/recall.rb` with the real release SHA and pushes it to every tap listed in the workflow's `HOMEBREW_TAP_REPOS` env var (currently `edihasaj/homebrew-tap` and `edihasaj/homebrew-recall`). Inaccessible taps are skipped with a warning so a missing repo never fails the release. The cask source template lives in [packaging/homebrew/Casks/recall.rb.template](../packaging/homebrew/Casks/recall.rb.template), and the renderer is [scripts/render-homebrew-cask.mjs](../scripts/render-homebrew-cask.mjs).

## Website

The landing page is static HTML/CSS in [docs/](../docs/). `.github/workflows/pages.yml` deploys that directory to GitHub Pages on pushes to `main`.

Run the local docs check before changing the page:

```bash
npm run docs:check
```
