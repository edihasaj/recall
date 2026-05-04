# Submitting Recall to homebrew-cask

Goal: enable `brew install --cask recall` (no namespace), by getting Recall accepted into [Homebrew/homebrew-cask](https://github.com/Homebrew/homebrew-cask).

## What Homebrew requires

From [`docs/Acceptable-Casks`](https://docs.brew.sh/Acceptable-Casks) and the cask cookbook, the cask must:

1. **Be notable.** Heuristics they use (judgment call, not a gate they automate):
   - GitHub stars roughly in the hundreds, or
   - Real downloads/users, or
   - Press / a mature project page.
   - Brand-new projects are rejected with "not yet notable enough."

2. **Be code-signed and notarized.** The macOS app must:
   - Be signed with a Developer ID Application certificate.
   - Be notarized via Apple's notary service (`xcrun notarytool submit`) and stapled (`xcrun stapler staple`).
   - Currently `Recall.app` ships **unsigned ad-hoc**. Gatekeeper blocks it on first open without right-click → Open. This is the single biggest blocker for core acceptance.

3. **Have a stable artifact URL pattern.** Our `https://github.com/edihasaj/recall/releases/download/v#{version}/Recall.app.zip` works.

4. **Pass `brew audit --new-cask recall`** locally. The audit checks: required stanzas (`version`, `sha256`, `url`, `name`, `desc`, `homepage`, `app`), formatting (`brew style --fix`), `livecheck` block (recommended), reproducible URL.

5. **Not duplicate existing casks** in core or other taps with the same name. `recall` is not currently taken in homebrew-cask.

## Prereqs we need to satisfy first

| Prereq                          | Status            | Action                                                                                                                                                                          |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer ID Application cert   | not in repo       | Apple Developer Program ($99/yr) → create Developer ID Application cert in Xcode → export `.p12`, store in repo secret `MACOS_SIGN_CERT_P12_BASE64` + password.                  |
| Notarization API key            | not in repo       | App Store Connect → Users and Access → Keys → create one with role "Developer". Store `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_BASE64` as secrets.             |
| Sign + notarize in CI           | not in workflow   | Add `codesign --deep --options runtime --sign "Developer ID Application: ..."` step + `xcrun notarytool submit ... --wait` + `xcrun stapler staple` before zipping.             |
| `livecheck` block in cask       | missing           | Add a `livecheck` block pointing at the GitHub releases atom feed.                                                                                                              |
| Notability                      | early             | Track stars / Hacker News / Show HN / Twitter coverage. Aim for ~200+ stars before submitting; otherwise expect "not notable enough yet" and a polite close.                    |
| `brew audit --new-cask recall`  | not yet run       | Once signed/notarized, render the cask, run `brew audit` and `brew style --fix` locally.                                                                                        |

## Submission steps (after prereqs)

```bash
# 1. Fork homebrew/homebrew-cask
gh repo fork Homebrew/homebrew-cask --clone --remote

# 2. Create branch
cd homebrew-cask
git checkout -b add-recall

# 3. Add the cask (note: core uses Casks/r/recall.rb, sharded by first letter)
mkdir -p Casks/r
cp /path/to/rendered/recall.rb Casks/r/recall.rb
# Add a livecheck block:
#   livecheck do
#     url :url
#     strategy :github_latest
#   end

# 4. Audit + style locally
brew audit --new --online --strict Casks/r/recall.rb
brew style --fix Casks/r/recall.rb
brew install --cask --no-quarantine Casks/r/recall.rb  # smoke install
brew uninstall --cask recall

# 5. Commit + PR
git add Casks/r/recall.rb
git commit -m "Add recall"
git push -u origin add-recall
gh pr create --repo Homebrew/homebrew-cask --title "Add recall" --body "..."
```

PR template body should mention:
- What Recall is, one-liner.
- Link to homepage and source.
- Confirmation it's signed + notarized (`spctl --assess --type execute --verbose Recall.app` should print `accepted`).
- Confirmation `brew audit` passes clean.

## Realistic timeline

- Sign + notarize wired in CI: **1 evening** (Developer Program signup is the bottleneck — paperwork can take 24h).
- Notability: **months**, organic.
- PR review: usually a few days; reviewers may ask for tweaks (livecheck shape, description wording).

Until all of that lands, `brew install --cask edihasaj/recall` (our own tap) is the right install.
