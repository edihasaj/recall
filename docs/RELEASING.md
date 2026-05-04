# Releasing Recall

Release artifacts are produced from tags named `vX.Y.Z`.

## Prerequisites

- GitHub Pages enabled for the repository.
- `edihasaj/homebrew-tap` created before the first Homebrew publish.
- `HOMEBREW_TAP_GITHUB_TOKEN` secret with write access to `edihasaj/homebrew-tap` if Homebrew publishing should run.
- XcodeGen available in CI through `brew install xcodegen` (handled by the release workflow).

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

4. Create and push a tag:

```bash
git tag v0.5.0
git push origin v0.5.0
```

5. Watch `.github/workflows/release.yml`.

## What CI Publishes

The release workflow builds `Recall.app`, packages it as `Recall.app.zip`, writes `Recall.app.zip.sha256`, creates a GitHub Release if needed, and uploads both files.

If `HOMEBREW_TAP_GITHUB_TOKEN` is configured and can access `edihasaj/homebrew-tap`, the workflow renders `Casks/recall.rb` with the real release SHA and pushes it to the tap. The cask source template lives in [packaging/homebrew/Casks/recall.rb.template](../packaging/homebrew/Casks/recall.rb.template), and the renderer is [scripts/render-homebrew-cask.mjs](../scripts/render-homebrew-cask.mjs).

## Website

The landing page is static HTML/CSS in [docs/](../docs/). `.github/workflows/pages.yml` deploys that directory to GitHub Pages on pushes to `main`.

Run the local docs check before changing the page:

```bash
npm run docs:check
```
