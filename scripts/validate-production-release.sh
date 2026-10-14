#!/usr/bin/env bash
set -euo pipefail

# Run on Linux before any native runner is allocated. Input is data, not code.
if [[ "${GITHUB_REF:-}" != refs/heads/production ]]; then
  echo "::error::Release dispatch must select the production branch."
  exit 1
fi
if [[ ! "${RELEASE_TAG:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "::error::An existing version tag is required."
  exit 1
fi
tag_sha="$(git rev-parse --verify "refs/tags/${RELEASE_TAG}^{commit}")"
production_sha="$(git rev-parse --verify 'refs/remotes/origin/production^{commit}')"
if [[ "$tag_sha" != "$production_sha" || "$tag_sha" != "${GITHUB_SHA:-}" ]]; then
  echo "::error::Tag must match both the exact dispatch SHA and current production."
  exit 1
fi
printf 'tag=%s\nsha=%s\n' "$RELEASE_TAG" "$tag_sha" >> "$GITHUB_OUTPUT"
