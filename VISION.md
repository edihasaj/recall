# Vision

Recall is a **local repo-memory compiler for coding agents**. It learns durable
rules from corrections, review feedback, repo scans, and session outcomes, then
re-injects compact, trusted instructions each session through the CLI, MCP,
daemon endpoints, and lifecycle hooks. It should stay **local-first, fast, and
trustworthy** — a memory layer that never leaks or injects noise — not grow into a
general cloud knowledge base.

## In Scope

- Capturing durable rules from corrections/review/scans/outcomes and compiling
  them into compact, high-signal injected instructions.
- Delivery surfaces: CLI, MCP server, daemon endpoints, and agent lifecycle hooks.
- Retrieval quality: relevance, scoping (per repo/global), dedup, contradiction
  handling, and keeping injected context small and trusted.
- Local-first storage and privacy (no cloud or API keys required for the common
  path).
- Tests, benchmarks, docs, and dependency maintenance.

## Out of Scope

- A cloud-only or account-required core path (cloud stays optional/opt-in).
- Injecting large, low-signal, or unverified context.
- Becoming a general-purpose vector database or note-taking product.

## Merge by Default

- Bug fixes with a clear cause and bounded risk.
- Retrieval/compilation quality improvements backed by the benchmark/tests.
- New or improved delivery hooks/integrations that don't change stored semantics.
- Docs, examples, type hints, tests, and green dependency bumps.

## Needs Sign-Off

- Changes to the memory storage format or on-disk schema (needs a migration).
- Anything that sends memory off-device by default, or new telemetry.
- Changes to what counts as a "trusted" rule or the injection policy.
- Breaking CLI/MCP/daemon API changes, major version bumps, or release/packaging
  changes.

## Roadmap

### Short-term

- Improve rule extraction precision (fewer false rules) and retrieval relevance.
- Keep injected context compact and keep CI/benchmarks green.
- Harden the MCP/daemon/hook surfaces and their lifecycle behavior.

### Long-term

- Stronger contradiction/decay handling as memory grows.
- Optional, privacy-preserving cloud sync (`recall-cloud`) behind a clear opt-in.
- Broader tool/agent integrations without weakening the local-first guarantee.
