---
summary: "Explicit production-only native CI and paused release workflows to bound Actions spend."
read_when:
  - Changing GitHub Actions runners or release triggers.
  - Requesting a production native build or investigating Actions charges.
---

# CI cost policy

Mac-capable workflows were manually disabled on October 14, 2026. Keep them
paused until Edi explicitly requests a production build. This includes mixed
workflows containing a Mac job: their Linux lanes are also paused while the
workflow is disabled. Unaffected portable workflows remain unchanged.

A branch push, tag push, production PR, schedule, or ordinary dispatch must not
allocate a paid Mac. Native job guards require an explicit dispatch of
`production` with the typed native opt-in enabled. The opt-in defaults to false.
Publication additionally requires its own affirmative publish input where
present; a diagnostic is never a substitute for release verification.

Promote the reviewed workflow changes to `production` before requesting a
build. Do not dispatch historical tags that contain old workflow definitions,
rerun old paid jobs, or enable a workflow merely to check its configuration.
Release/package workflows remain disabled after this change. Explicit native
builds still incur normal GitHub charges; this is not a zero-dollar account cap.

Auto Release is now a manual production tag-preparation action, not a main-push trigger, and cannot dispatch native workflows. Native prebuilds are manual-only and dry-run by default. An explicit native matrix still builds all supported ABI combinations; do not launch it for unrelated changes. npm publication also requires explicit `publish=true`.

## Local verification

Run `ruby scripts/test-ci-cost-policy.rb`. It parses the actual workflow YAML,
rejects automatic/default or nonproduction native allocation, and exercises
existing production-tag identity checks when present. Keep the existing
repository-specific CI/signing contracts as well. Configuration verification
must not dispatch paid hosted jobs.
