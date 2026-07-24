# Security Policy

Recall stores local repo memory, activity history, and embeddings on the user's machine. Treat bugs that leak, corrupt, or unexpectedly publish local memory as security-sensitive.

## Supported Versions

Security fixes target the latest release.

## Supply-chain controls

GitHub Actions are pinned to immutable commits, checkout credentials are not
persisted into build worktrees, release inputs must select an existing semantic
version tag, and pull requests run dependency review at moderate severity.

## Reporting

Email security reports to Edi Hasaj at edihasaj@gmail.com. Please include:

- affected version or commit
- operating system
- reproduction steps
- expected and actual behavior
- whether local data, hooks, MCP config, or launchd state is affected

Do not open a public issue for a private data exposure report.
