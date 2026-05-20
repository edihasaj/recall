# Configuration

Everything Recall reads at runtime from the environment, plus how to wire up LLM-assisted memory maintenance.

## Hook injection

Once `recall setup --yes` has installed hooks for supported detected runtimes, the daemon injects a compact repo memory pack on `SessionStart` (once per session). Startup injection is capped at three memory lines and does not emit history-only context, so stale session summaries do not flood new agent sessions. `UserPromptSubmit` also runs per-prompt relevance injection by default — hybrid retrieval scores the prompt against repo memory and only emits matches above the relevance floor (with per-session dedup so already-delivered memories don't repeat). Set `RECALL_HOOK_INJECT_PROMPT=false` to opt out and keep prompts silent after SessionStart.

Routine app launch, daemon start, and daemon restart do not restore removed hooks or repo instruction files. Reinstalling agent integrations is explicit: run `recall setup --yes`, `recall doctor --fix`, or use the app's Install + Start action.

You can tune that with these env vars (read fresh on each hook invocation — no daemon restart needed):

| Variable | Default | Effect |
|---|---|---|
| `RECALL_HOOK_INJECT_CONTEXT` | `true` | Set to `false` to disable all hook-driven memory injection (SessionStart + UserPromptSubmit). Hooks still fire for telemetry and correction capture. |
| `RECALL_HOOK_INJECT_PROMPT` | `true` | Per-prompt memory injection on `UserPromptSubmit`. Uses hybrid retrieval with your prompt as the query — if nothing scores above the relevance floor, nothing is injected (no fall-through to a full-repo dump). Per-session dedup also applies: memories already delivered in this session are not re-emitted. Set to `false` to opt out. |
| `RECALL_HOOK_INJECT_STYLE` | `minimal` | Set to `verbose` to restore the historical format (`Recall memory for this repo:\n# Recall: <slug>\n\n...`). `minimal` strips the prefix and repo header — the section bullets are all that lands in context. |
| `RECALL_SURFACE_PENDING_CONFIRMATIONS` | `false` | Set to `true` to include high-risk pending candidate confirmations at SessionStart. By default they stay out of injected context so stale destructive candidates do not interrupt unrelated work. |
| `RECALL_CODEX_HOOKS_MIN_VERSION` | `0.115.0` | Minimum CLI version eligible for that runtime's `hooks.json` install path. Below this, `recall setup --yes` / `recall doctor --fix` fall back to the legacy `notify` bridge so memory capture still works. Override if you've forked/patched that runtime. |

Where to set them:

- **Per-machine**: edit `~/.zshrc` / `~/.bashrc`.
- **Per-CLI session** (takes effect immediately; no daemon round-trip):
  ```bash
  RECALL_HOOK_INJECT_PROMPT=false claude
  ```
- **At install time**: pass `--no-prompt-injection` to `recall setup` (or `recall setup local`) and the opt-out is written inline into the agent hook command — survives shell rc edits.
- **Daemon-wide** (affects hooks invoked through the daemon transport only): edit `~/Library/LaunchAgents/com.recall.daemon.plist` under `EnvironmentVariables`, then `recall daemon restart`.

## Capture path (LLM-primary)

When a user prompt arrives on `UserPromptSubmit`, Recall has to decide whether anything in it is a durable rule worth saving. There are two paths, and the right one is picked automatically.

### Path A — LLM-primary (default when a provider is configured)

The hook does **not** try to extract rules with regex. Instead:

1. A cheap **multi-language pre-screen** asks "is this prompt worth showing to the LLM at all?" It looks for imperative/save-intent markers in en/es/fr/de/it/pt/ru/zh/ja/sq/tr (e.g. `always`/`never`/`remember`, `siempre`, `toujours`, `immer`, `всегда`, `总是`, `常に`, `gjithmonë`). Pure code-request prompts with no rule signal are skipped — no LLM call, no cost.
2. Prompts that pass the screen enqueue an `extract_rules_from_prompt` task (priority 14, top of queue).
3. The hook calls `POST /dispatch/wake` on the local daemon (debounced 3 s) so the dispatcher fires within seconds instead of waiting for its scheduled tick.
4. The LLM extracts zero or more durable rules from the prompt, in any language, and returns one canonical English sentence per rule with confidence and scope. Empty list is a valid answer ("nothing worth saving here").
5. The applier creates one candidate memory per rule with semantic dedup against existing same-repo memories. Duplicate hook deliveries for the same prompt share one extraction task, and near-identical high-risk candidates are deduped even when the LLM varies the rule type. Promotion still flows through repetition or explicit confirm — the LLM judges, never auto-activates.
6. History snippets can supplement prompt-time memory only when they have a lexical match or clear vector relevance. Weak semantic matches are dropped so stale summaries do not steer unrelated turns.

### Path B — Regex fallback (no provider configured, or LLM explicitly disabled)

Same regex extractor + `qualityReasons` filter as before. Captures `always|never|must|don't VERB OBJECT` shapes in English only, with a deterministic quality gate. Use this path when:

- You haven't set an LLM credential yet.
- You're running tests (vitest pins this path on automatically).
- You explicitly want the cheap zero-cost path on a particular shell.

### Capture env vars

| Variable | Default | Effect |
|---|---|---|
| `RECALL_LLM_CAPTURE_DISABLED` | `false` (i.e. LLM path enabled when a provider is configured) | Set to `true` to force the regex fallback path even when a key is present. Useful for offline/airgapped runs or for benchmarking. |
| `RECALL_SETUP_SKIP_CLAUDE_MD` | unset | Set to `1` to skip installing the managed CLAUDE.md memory-override block during `recall setup`. See below for what the block does. |

### Claude Code memory-override block

Claude Code's harness ships a built-in "auto memory" feature that writes user-requested memories into `~/.claude/projects/<encoded-path>/memory/MEMORY.md`. That competes with Recall: the user says "remember X", the harness writes a file AND the Recall hook captures the same correction — two stores, one drift.

`recall setup` writes a fenced block into `~/.claude/CLAUDE.md` that overrides the harness instruction, telling Claude Code to route all memorize/forget intents back through Recall (the hook handles capture; explicit `mcp__recall__capture_correction` / `mcp__recall__reject` / `mcp__recall__confirm` for forced operations). The block is delimited by `<!-- recall:managed:claude-md:begin vN -->` / `<!-- recall:managed:claude-md:end -->` so subsequent `recall setup` / `recall doctor --fix` runs update just that section, leaving the rest of the user's CLAUDE.md untouched.

`recall doctor` reports the block status as `claude.md:ok` / `STALE` / `MISSING` / `ABSENT_NO_FILE`. `recall doctor --fix` installs or repairs.

Opt out:
- `recall setup --no-claude-md` (one-shot)
- `RECALL_SETUP_SKIP_CLAUDE_MD=1` (persistent in `~/.zshrc` / `~/.bashrc`)

### Tuning the dispatcher for LLM-primary capture

The dispatcher's default `RECALL_DISPATCHER_INTERVAL_SECONDS=86400` (daily) made sense for batch maintenance, but it's too slow for capture: a rule captured today wouldn't be judged until tomorrow. The `/dispatch/wake` endpoint fixes the common case (hook fires it on every enqueue, debounced), but you can also lower the timer-based interval if you frequently work offline from the daemon:

```bash
RECALL_DISPATCHER_INTERVAL_SECONDS=900  # 15 min — captures land within 15m even if the wake endpoint is unreachable
```

The dispatcher continues to honor `RECALL_DISPATCHER_MAX_TASKS_PER_RUN` (default 5) per tick — burst protection.

## LLM-assisted memory maintenance

Recall enqueues maintenance tasks (refine candidates, merge near-duplicates, summarize histories, etc.) as you use it. There are two ways those tasks get executed:

### Path 1 — Daemon-owned dispatcher (recommended)

Give Recall an API key and it will run maintenance itself on a schedule, with no live agent session required.

1. Store credentials in the macOS Keychain under service `com.recall.llm`:
   ```bash
   recall maintenance credentials set openai sk-...
   # or:
   recall maintenance credentials set anthropic sk-ant-...
   # or Azure OpenAI (deployment-scoped):
   recall maintenance credentials set azure \
     --endpoint https://myresource.openai.azure.com \
     --deployment gpt-4o-mini \
     --api-version 2024-10-21 \
     az-...
   ```
   Non-macOS platforms fall back to env vars:
   `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or the Azure quartet
   `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`,
   `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_API_KEY`.
2. Verify:
   ```bash
   recall maintenance credentials
   # openai     keychain sk-p…abcd
   ```
3. Trigger once manually to sanity-check (uses the configured key, calls the LLM):
   ```bash
   recall maintenance dispatch --dry-run                   # lists what would run
   recall maintenance dispatch --max 3                     # runs up to 3 tasks
   recall maintenance dispatch --provider azure-openai     # force a specific provider
   ```
4. Let the daemon take over. It runs the dispatcher on the cadence below (default: daily).

Provider auto-selection order when multiple are configured and you don't pass `--provider`: **anthropic → azure-openai → openai**. For Azure, the deployment name stored at setup time is used as the model (unless you pass `--model` to override). If the deployment name matches a known base model (`gpt-4o-mini`, `gpt-4o`, etc.), Recall applies the same per-token cost estimate as direct OpenAI; if it doesn't match, `llm_usage.cost_usd` is left null (tokens still tracked).

### Path 2 — Delegated fallback (no API key)

If no key is configured, the daemon still enqueues tasks and dispatches them to zero. Instead, the pending backlog surfaces in the SessionStart context of the next agent session. The active agent can pick a task up and run it against its own LLM — no extra cost because that agent was already running.

The dispatcher handles all LLM-needing task kinds: `extract_rules_from_prompt` (capture, priority 14), `verify_capture` (priority 12), `refine_candidate`, `merge_duplicates`, `summarize_history`, `summarize_session`, `synthesize_repo`. Capture tasks are top-priority so the user sees fresh memories within seconds of a `/dispatch/wake` ping (see the Capture path section above).

### Dispatcher env vars

| Variable | Default | Effect |
|---|---|---|
| `RECALL_DISPATCHER_ENABLED` | `true` | Set to `false` to disable the daemon-owned dispatcher (delegated path still works). |
| `RECALL_DISPATCHER_INTERVAL_SECONDS` | `86400` | Seconds between timer-driven dispatcher ticks. Daily by default. `POST /dispatch/wake` (called by the capture hook) bypasses the timer, debounced 3 s — so capture latency stays low regardless. Lower this to 900 (15 min) if you frequently work without the daemon reachable. |
| `RECALL_DISPATCHER_MAX_TASKS_PER_RUN` | `5` | Max tasks per tick. Floor on memory_maintenance_tasks churn. |
| `OPENAI_API_KEY` | — | Fallback when Keychain is unavailable or `recall maintenance credentials set openai` hasn't been run. |
| `ANTHROPIC_API_KEY` | — | Same, for Anthropic. |
| `AZURE_OPENAI_ENDPOINT` | — | Azure resource URL (e.g. `https://myresource.openai.azure.com`). |
| `AZURE_OPENAI_DEPLOYMENT` | — | Azure deployment name (acts as the model). |
| `AZURE_OPENAI_API_VERSION` | — | Azure API version (e.g. `2024-10-21`). |
| `AZURE_OPENAI_API_KEY` | — | Azure API key. All four `AZURE_OPENAI_*` must be set together to count as configured. |

### Cleanup env vars

The deterministic cleanup loop (no LLM required) merges exact-text duplicates,
rejects voice/typing fragments captured as user_correction candidates, and
auto-promotes high-signal corrections. Every action lands in
`maintenance_cleanup_log` with before/after snapshots.

Fragment-rejection signals: `too_short` (<20 chars), `too_long` (>300 chars), `bare_modal`, `trailing_question`, `trailing_double_dot`, `trailing_dash`, `dangling_connector`, `filler_prefix`, `embedded_question`, `no_verb`. The list is intentionally strict — under the regex-fallback path it's the only quality gate; under the LLM-primary path the LLM is the real judge and these signals just keep obvious garbage out of the candidate pool when the LLM is unavailable.

| Variable | Default | Effect |
|---|---|---|
| `RECALL_CLEANUP_ENABLED` | `true` | Set to `false` to disable the deterministic cleanup loop. |
| `RECALL_CLEANUP_INTERVAL_SECONDS` | `86400` | Seconds between cleanup ticks. Daily by default. |

Run on demand: `recall maintenance cleanup` (dry-run) or `recall maintenance cleanup --apply`.

### Quality snapshot env vars

The daemon records a `quality_snapshots` row weekly so trends in injection
followed-rate, active-rule count, and candidate backlog become visible via
`recall maintenance quality --history` over time.

| Variable | Default | Effect |
|---|---|---|
| `RECALL_QUALITY_SNAPSHOT_ENABLED` | `true` | Set to `false` to disable automatic snapshots. |
| `RECALL_QUALITY_SNAPSHOT_INTERVAL_SECONDS` | `604800` | Minimum age before a new snapshot is recorded. Daemon checks hourly. |

### Observability

```bash
recall maintenance usage                       # tokens + $ estimate, last 30 days
recall maintenance usage --since 2026-04-01    # custom window
recall maintenance usage --json                # machine-readable
recall maintenance stats                       # task backlog counts
recall maintenance list                        # pending tasks
```

Every LLM call the dispatcher makes lands in the `llm_usage` table with provider, model, task kind, tokens, cost estimate, duration, and ok/error. No row is written when the dispatcher has nothing to run or no API key is configured.

### Clearing a key

```bash
recall maintenance credentials clear openai
```

## General daemon env vars

Set under `EnvironmentVariables` in `~/Library/LaunchAgents/com.recall.daemon.plist`, then `recall daemon restart`.

| Variable | Default | Effect |
|---|---|---|
| `RECALL_PORT` | `7890` | HTTP port the daemon listens on. |
| `RECALL_DATA_DIR` | `~/.recall` | Where the SQLite DB, models cache, and logs live. |
| `RECALL_MAINTENANCE_ENABLED` | `true` | Set to `false` to stop the non-LLM maintenance loop (prune, compact, promote-candidates, SQLite housekeeping). |
| `RECALL_MAINTENANCE_INTERVAL_SECONDS` | `300` | Interval for the non-LLM maintenance loop. |
| `RECALL_MAINTENANCE_LLM_DISABLED` | `false` | Set to `true` to stop enqueuing LLM-needing tasks. |
| `RECALL_EMBEDDINGS_DISABLED` | `false` | Set to `true` to skip embedding generation entirely (hybrid retrieval still works with FTS-only ranking). |
| `RECALL_SQLITE_WAL_TRUNCATE_BYTES` | `33554432` (32 MiB) | WAL size at which the maintenance loop escalates `wal_checkpoint(PASSIVE)` to `TRUNCATE` to keep `recall.db-wal` from growing unbounded under concurrent writers. Set `0` to never truncate. |
| `RECALL_SQLITE_STARTUP_WAL_TRUNCATE_BYTES` | `33554432` (32 MiB) | If the WAL file exceeds this size when the DB is opened, run `wal_checkpoint(TRUNCATE)` once during startup. Heals existing installs after upgrade. Set `0` to disable. |
| `RECALL_HOOK_LOG_MAX_BYTES` | `1048576` (1 MiB) | Rotates `~/.recall/logs/hook-errors.log` to `hook-errors.log.1` once it reaches this size. Set `0` to keep appending forever. |

## Retrieval tuning

The hybrid search path (FTS5 + sqlite-vec) is opinionated for short
coding-rule corpora by default, but every knob is exposed for benchmarks
and conversational-haystack workloads.

| Variable | Default | Effect |
|---|---|---|
| `RECALL_FUSION` | `rrf` | `weighted` falls back to the legacy weighted-sum mix of BM25 + cosine. |
| `RECALL_RRF_K` | `60` | RRF dampening constant. Larger k flattens the top-of-list contribution. |
| `RECALL_RRF_LEX_WEIGHT` | `1` | Multiplier on the FTS arm's RRF contribution. |
| `RECALL_RRF_VEC_WEIGHT` | `1` | Multiplier on the vec arm's RRF contribution. |
| `RECALL_LEX_WEIGHT` | `0.35` | Weighted-sum mode only. |
| `RECALL_VEC_WEIGHT` | `0.65` | Weighted-sum mode only. |
| `RECALL_FTS_MODE` | `and` | `or` switches the FTS query joiner — better for natural-language queries where AND-of-terms is too strict. |
| `RECALL_FTS_PREFIX` | `true` | Set to `false` to disable FTS5 prefix matching on tokens ≥4 chars. |
| `RECALL_SYNONYMS` | `true` | Set to `false` to skip query-time synonym expansion. |
| `RECALL_SYNONYMS_PATH` | unset | Optional path to a JSON file with `{ "groups": [["a","b",...], ...] }` to extend the bundled English dictionary. |
| `RECALL_HYDE` | `false` | Set to `true` to embed a LLM-generated hypothetical answer instead of the question for chat-style queries. Requires a configured provider. |
| `RECALL_HYDE_MODEL` | provider default | Override the HyDE model (e.g. `gpt-4o-mini`, `claude-haiku-4-5-20251001`). |
| `RECALL_HYDE_CACHE_PATH` | unset | Persist HyDE results to a JSON file for reproducible benchmarks. |
| `RECALL_RERANK` | `false` | Set to `true` to cross-encoder re-rank the top-50 hybrid candidates. |
| `RECALL_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Re-ranker model. |
| `RECALL_RERANK_TOP_K` | `50` | Window pulled into the re-rank stage. |

For chat-haystack benchmarks (e.g. LongMemEval-S) the recommended
combination is `RECALL_HYDE=true RECALL_RERANK=true`, on top of the
defaults — see `benchmark/COMPARISON.md` for measured numbers.

## Verification

```bash
recall doctor              # full state snapshot (DB, embeddings, launchd, installed hooks per agent)
recall doctor --fix        # install missing MCP/hooks for detected supported runtimes
recall doctor --json       # machine-readable; contains `upgrade.available` for app launch probes
```

A healthy setup shows all detected agents as `mcp:ok hooks:ok` and — if you've set an API key — at least one successful entry under `recall maintenance usage`.
