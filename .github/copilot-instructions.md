<!-- recall:managed:memory:begin v1 -->
## Recall (managed by `recall setup` — do not edit by hand)

Recall is the single source of truth for durable memory across agents and sessions. It is wired into GitHub Copilot through the `recall` MCP server.

- GitHub Copilot has no lifecycle hooks, so capture is **manual**: when the user corrects you, states a durable preference, or says "remember this", call `capture_correction` on the `recall` MCP server. Phrase it as `always X` / `never Y`.
- Before non-trivial work in a repo, call `query` to pull relevant memories. Do it again when you move to an unfamiliar area.
- A memory that turns out to be wrong or outdated: `reject` it. One that proves right: `confirm` it.
- Do not keep a second memory store (scratch note files, tool-native memory) — it drifts from Recall.

Reinstall: `recall setup`. Remove: `recall setup --uninstall-hooks`.
<!-- recall:managed:memory:end -->
