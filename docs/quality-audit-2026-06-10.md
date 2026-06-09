---
status: active
read_when: "Working on capture/recall quality, codex parity, or UMP bridge fidelity"
---

# Quality audit — 2026-06-10

Save/recall quality sweep across Claude Code, Codex, and the UMP bridge.
Shipped fixes are listed first; deferred findings are ranked and kept here so
the next pass can pick them up cold.

## Shipped in this pass

- **DB-locked hook drops** — `initDb()` ran `migrate()` + a `user_version`
  write pragma on every hook invocation; under daemon write contention hooks
  died with `SqliteError: database is locked` and silently dropped
  capture/recall events (see `~/.recall/logs/hook-errors.log`). Now skipped
  when `user_version` is current; `test/db-init-fastpath.test.ts` also pins
  `RECALL_DB_USER_VERSION === drizzle journal length` so a migration can't
  land without bumping the constant.
- **Codex feature-flag rename** — Codex ≥ 0.137 renamed `[features].codex_hooks`
  to `hooks` (legacy alias still parses) and rewrites config.toml with the
  canonical name, which dropped our managed comment and made doctor
  false-positive "hooks missing". Doctor + installer now accept either
  spelling.
- **Codex session-end never fired** — hooks.json had no Stop/SessionEnd entry
  (3 session_ended events vs 1,198 session_starts in `hook_calls`). Codex has
  no SessionEnd event, so the installer now registers `hook session-end` on
  `Stop` (per-turn; safe because the resolver only marks observably-followed
  injections and leaves the rest pending).
- **Global scope outcome blind spot** — `pathMatchesMemory` /
  `toolCallTouchesMemory` predated `scope='global'`, so global rules could
  never resolve as followed/relevant after injection (demotion bias). Now
  aligned with `compiler/context.ts pathMatches`.
- **UMP capture fidelity** — the UMP backend hardcoded `sessionId: "ump"`
  (so `stablePromptId` deduped identical rule text *forever* across UMP
  sessions) and passed no `agent`. Now a per-process session id + `agent: "ump"`.
- **Hermetic tests** — session-start bootstrap walked `~/Projects` during
  tests, found the real checkout matching the test's repo slug, and seeded
  scan memories into "fresh" test DBs (local-only failures). `vitest.config.ts`
  now pins `RECALL_REPO_ROOTS` to a nonexistent path.

## Deferred findings (ranked)

1. **Contradicted-outcome detection is fragile** (`src/cli/hook.ts`
   `resolvePendingInjectionOutcomesOnPrompt`): 0.7 word-Jaccard between a
   correction and memory text misses paraphrases ("Use ES2022 modules" vs
   "Use modern ES modules") and ignores explicit negation markers
   ("don't/never/stop"). Consider semantic similarity when embeddings are on,
   or a negation pre-check + lower fallback threshold. Tune against
   `recall maintenance quality --history` so the followed-rate doesn't regress.
2. **Retrieval floor / query weighting** (`src/compiler/context.ts`):
   `QUERY_VECTOR_RELEVANCE_FLOOR = 0.7` plus heavy query-score weighting can
   shadow high-confidence repo conventions phrased differently from the
   prompt. Don't hand-tune — run `recall eval retrieval` (fixtures in
   `docs/retrieval-eval.*.json`) before/after any change.
3. **UMP capture context is interface-limited**: `RecallBackend.capture` in
   `@universalmemoryprotocol/core` only carries `{text, type, repo, path}` —
   no agent name, session id, prev turn, or recent tool calls, so UMP-driven
   capture gets weaker scope inference than native hooks. Needs an upstream
   interface extension in `../universal-memory-protocol` (optional `context`
   field), then thread it through `src/ump/backend.ts`.
4. **Transcript filter can eat real rules** (`looksLikePastedTranscript`):
   2+ markers anywhere in >1200 chars drops the whole prompt; a rule embedded
   in annotated pasted output is lost. Consider line-level marker density.
5. **No audit trail for skipped captures**: `processCorrection` drop points
   (transcript filter, rejected-fragment similarity, qualityReasons) leave no
   record, so "why wasn't this captured?" is undebuggable. A verbose/audit
   mode would make filter regressions visible. (Today's garbled "Use grinding
   on it tests…" candidate shows the speech-to-text fragment filter still
   leaks — one more signal for this.)
6. **PostToolUse matcher is Bash-only for codex** (`buildCodexManagedGroups`):
   claude-code observes more tools; codex outcome detection only sees shell
   commands. Check which codex tool names are worth matching before widening.
