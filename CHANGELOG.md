# Changelog

## 0.8.20 - 2026-07-24

### Fixed

- **Windows tray installs now start the Recall daemon.** The tray resolves the per-user global npm package installed by `install.ps1`, and database backups use the platform-native parent directory instead of treating Windows paths as relative.
- **Automatic releases now publish Windows binaries.** The release automation explicitly dispatches the Windows tray workflow after creating a tag, builds the tagged source, and creates the GitHub Release before attaching both `arm64` and `amd64` assets.

## 0.8.19 - 2026-07-23

### Added

- **Recall Cloud is visible in the native app.** The macOS sidebar and menu bar now expose cloud status, sign-in/management, hosted memories, and the automatic two-way sync model.

### Changed

- **Recall.app has a clearer modern status surface.** The overview now prioritizes daemon, cloud-sync, and dashboard health with a compact green-teal hero and single-scroll detail views.

### Fixed

- **Settings reliably opens from the menu bar.** The menu action now opens Recall's dashboard and selects Preferences instead of depending on an unavailable SwiftUI Settings selector.
- **Exact global memories remain retrievable with embeddings enabled.** Strong normalized lexical matches can pass the vector relevance floor, fixing global synced rules that FTS found but repo-filtered vector search could not.

## 0.8.18 - 2026-07-23

### Changed

- **All marketing imagery is now generated from a fictional dataset.** The published dashboard walkthrough and screenshots were captured against a real machine and showed live repository names, prompts, and file paths. Every asset is regenerated from a curated, entirely invented dataset (an imaginary "Northwind" company and its repos) via the new `scripts/seed-demo-dataset.mjs`, and the hero, OG card, and README samples use the same fictional rules. Assets that carried real data (`demo.gif`, `demo.mp4`, and the stale graph/session captures) are removed.

## 0.8.17 - 2026-07-23

### Fixed

- **Paginated lists no longer duplicate rows.** The load-more sentinel auto-fires via `IntersectionObserver` and could call `loadMore()` twice in the same tick; the in-flight guard read `isLoadingMore` state, which had not propagated yet, so both calls fetched the same offset and appended it twice — every row in Memories, Timeline, and Sessions rendered double. The guard is now a ref, and appended pages are de-duplicated by id.

### Changed

- **Landing page refresh.** Rewrote the hero and section copy to be shorter and plainer, dropped the stale version eyebrows, and replaced the dashboard screenshots with current dark-theme captures of the knowledge graph, timeline, and sessions views.

## 0.8.16 - 2026-07-23

### Changed

- **The knowledge graph is now a verified-only projection, and cleans itself.** Only *active* (verified) memories contribute entities — candidate/transient memories are skipped at capture time, and a memory is ingested the moment it is promoted to active. On daemon startup the graph auto-rebuilds once whenever the extractor rules have advanced (tracked by a `GRAPH_EXTRACTOR_VERSION` marker in the data dir), so existing installs shed junk entities (`pnpm build`, `node dist`, `pnpm as`, …) automatically on upgrade — no manual `graph backfill --rebuild` needed. That flag remains available for on-demand rebuilds.

## 0.8.15 - 2026-07-23

### Fixed

- **Knowledge-graph entities are no longer junk.** The heuristic extractor was minting entities from English filler after a tool name (`Use pnpm as …` → `pnpm as`, `npm install` → `npm in`), from generic package-script/runtime invocations (`pnpm build`, `pnpm test`, `node dist`), and from shell/language builtins in backticks (`echo`, `dict`). Package managers and runtimes (`npm`/`pnpm`/`yarn`/`bun`/`node`/`deno`) now record only the tool, not a `command` node; filler subcommands are dropped; and the library stop-list covers common builtins. `recall graph backfill --rebuild` clears and regenerates the graph under the new rules so existing junk entities are removed.
- **Graph labels now sit on top of their node bubble.** 3D node labels render in front of the node sphere (depth test/write off, raised render order) instead of being partly occluded by the bubble.
- **Graph nodes keep their colour at any zoom.** Removed the distance fog so nodes and labels no longer fade to grey/black when the camera pulls back — the full graph stays readable when zoomed out.

## 0.8.13 - 2026-07-23

### Fixed

- **Dashboard text is larger and more legible.** Bumped the WebUI type scale across the sidebar, page headers, memory rows, badges, toolbars, timeline, sessions, and graph panels so the dense metadata is comfortably readable instead of squinting-small.
- **Knowledge graph labels are readable on the dark canvas.** 3D node labels now render as bright, larger text on a near-opaque chip (kind identity moves to the coloured border and node sphere) instead of dim kind-tinted text that vanished into the background. Softened the depth fog and lifted the canvas gradient so labels no longer fade to black a short distance from the camera.
- **Daemon version no longer shows stale after an update.** When the app launches and finds the launchd daemon still running a previously-installed version (e.g. after `brew upgrade`), it now bounces the daemon once so the reported version and served UI match the installed bundle. Previously the healthy old daemon was left running and the dashboard kept showing the old version until a manual restart.

## 0.8.12 - 2026-07-23

### Fixed

- **Generic Makefile-target memory cleanup.** Scanner intake and deterministic cleanup now reject `Makefile targets: ...` facts that only enumerate standard build-lifecycle targets (`build`, `test`, `clean`, `install`, `run`, `lint`, `deploy`, …), which were previously promoted to active memory and injected into repos. Lines naming a custom target (e.g. `make migrate`, `make seed-db`) are preserved as candidates. Extends the 0.8.11 generic-tooling hygiene to close the Makefile gap.

## 0.8.11 - 2026-07-21

### Fixed

- **Generic package-script memory cleanup.** Scanner intake and deterministic cleanup now reject generic config-derived scripts/tooling facts such as `build: ...`, `typecheck: ...`, `lint: ...`, `check: ...`, and `Linting/formatting: ...`, keeping them out of durable memory while preserving real package-manager choices.

## 0.8.10 - 2026-07-21

### Added

- **Automatic completion-use value inference.** Session-end hooks can now record `used` value events from the last assistant message when the agent provides it, so Recall can learn which injected memories actually influenced completions without manual reporting.

### Fixed

- **Current top-saver quality reporting.** `recall maintenance quality` no longer lists rejected memories as top savers, so historical cleanup artifacts do not pollute the current value signal.

## 0.8.9 - 2026-07-21

### Added

- **Historical value ledger backfill.** `recall maintenance value-backfill --apply` now derives idempotent `injected` and outcome value events from existing `memory_injections`, so upgraded installs immediately get token value and top-saver reporting from their existing followed/ignored/overridden/contradicted injection history.

## 0.8.8 - 2026-07-21

### Fixed

- **Hybrid retrieval now recovers when FTS is too strict.** Query-time compilation falls back to Recall's normalized lexical matcher when neither FTS nor vector search returns a clearly matching memory, so paraphrases like "Ran pytest before handing off" can still retrieve a stored "always run pytest before handoff" rule. The value-retrieval eval now pins this regression.

## 0.8.7 - 2026-07-21

### Added

- **Assistant completions now become usefulness evidence.** `recall hook assistant`, daemon assistant hooks, and UMP feedback can record when an injected memory was actually used, adding conservative saved-token value without changing memory confidence.
- **Value telemetry can evaluate retrieval.** `recall eval value-retrieval` synthesizes retrieval eval cases from recent `retrieval_miss` and `used` events, then reports recall@k, MRR, override rate, and provider comparisons against Recall's hybrid retrieval.
- **Quality snapshots now track value-recall trends.** Weekly daemon snapshots and `recall eval value-retrieval --snapshot` persist generated value-eval cases, hybrid pass count, recall@k, MRR, override rate, and skipped events so `recall maintenance quality --history` shows whether Recall is finding valuable memories more reliably over time.
- **Memory-use matching is more forgiving.** Completion-use and retrieval-miss detection now share normalized lexical/paraphrase matching plus optional embedding-backed semantic matching, so small wording changes are less likely to hide repeated instructions.

## 0.8.6 - 2026-07-21

### Fixed

- **Older running daemons no longer downgrade newer DB metadata.** `initDb()` now migrates only when `PRAGMA user_version` is below the binary's target version, so an older still-running daemon cannot reopen a newer schema and set the version pragma backwards while the table layout remains new.

## 0.8.5 - 2026-07-21

### Added

- **Recall now tracks memory value.** New `memory_value_events` telemetry records injected memories, followed/overridden/ignored/contradicted outcomes, retrieval misses, conservative injected-token cost, conservative saved-token estimates, and top saver memories in `recall maintenance quality`.
- **Repeated corrections can expose retrieval misses.** When a prompt repeats a correction that matches an existing active or candidate memory that was not injected, Recall now records a `retrieval_miss`; matching candidates are promoted so the same instruction is more likely to appear next time.
- **UMP feedback feeds Recall's native learning loop.** `ump.feedback` now writes through the same feedback/value path as native MCP and hook outcomes, so UMP clients can improve rankings and value reporting.

### Fixed

- **`recall compile --session` now persists session-scoped injection evidence.** The CLI was recording a compile activity event with the requested session but not passing that session into the compiler, so `memory_injections` and value rows were skipped.

## 0.8.4 - 2026-07-21

### Fixed

- **Corpus cleanup is stricter without becoming broad.** Deterministic cleanup now rejects explicit Recall e2e smoke-test artifacts while leaving legitimate end-to-end verification rules alone, and reports those rejects separately.
- **Maintenance backlog stops surfacing dead work.** The non-LLM maintenance loop now abandons open tasks tied to invalid repo scopes (`Projects`, temp paths, test fixture repos) or memory targets that have already been rejected or disappeared.
- **Hook integration tests no longer write into the live Recall daemon.** In-process hook calls with an injected test DB now execute directly unless daemon transport is explicitly requested, preventing test fixture repo scans from leaking into the production memory store.

## 0.8.3 - 2026-07-07

### Changed

- **Knowledge graph 3D view reads with more depth.** The web UI's 3D graph now sits on a radial-gradient background with exponential scene fog, so distant nodes and links fade into the dark edge instead of staying crisp at every distance. An ambient auto-rotate idles the camera around the graph and pauses the moment you grab it, resuming a couple of seconds after you let go.

## 0.8.2 - 2026-06-10

### Fixed

- **Session-start no longer crashes under concurrent agents.** When two agents (e.g. Claude Code and Codex) opened sessions in the same repo at once, both bootstrap scans passed `createMemory`'s pre-check `SELECT` and then raced on the `INSERT`, so one threw `UNIQUE constraint failed: memories.dedupe_key` and the entire session-start hook aborted — no memory injection for that session. `createMemory` now inserts with `ON CONFLICT(dedupe_key) DO NOTHING` and returns the winning row's id, making capture idempotent and race-safe.

## 0.8.1 - 2026-06-10

### Fixed

- **Hooks no longer die with `database is locked` under daemon write contention.** `initDb()` ran `migrate()` plus a `user_version` write pragma on every hook invocation; both take a write lock, so hooks racing daemon maintenance (vec/FTS rebuilds) failed and silently dropped capture/recall events. Init is now read-only when the schema is already current, and a regression test pins `RECALL_DB_USER_VERSION` to the drizzle migration journal length.
- **Codex ≥ 0.137 flag rename no longer breaks doctor/setup.** Codex renamed `[features].codex_hooks` to `hooks` and rewrites config.toml with the canonical name, which dropped Recall's managed comment and made `recall doctor` report hooks as missing. Doctor and the installer now accept either spelling.
- **Codex sessions finally resolve injection outcomes.** Codex has no `SessionEnd` hook event, so `hook session-end` never fired (3 session_ended vs 1,198 session_started calls observed) and injected memories never earned `followed` signals. The installer now registers session-end on `Stop`; firing per turn is safe because the resolver only marks observably-followed injections and leaves the rest pending.
- **Global-scope memories can earn outcome signals.** `pathMatchesMemory`/`toolCallTouchesMemory` predated `scope='global'` and never matched global rules, so they could not resolve as followed/relevant after injection — a demotion bias. Now aligned with the compiler's `pathMatches`.
- **UMP capture no longer dedupes rules forever.** The UMP backend hardcoded `sessionId: "ump"`, so `stablePromptId` treated identical rule text as a duplicate across all future UMP sessions and silently skipped re-extraction; it also passed no agent context. Capture now uses a per-process session id and `agent: "ump"`.

## 0.8.0 - 2026-06-05

### Added

- **`recall ump` — serve the Universal Memory Protocol over Recall's engine.** Recall is now a conforming UMP provider: any MCP host (Claude Code, Codex, other agents) can `ump.recall` / `ump.remember` / `ump.get` / `ump.revise` / `ump.forget` / `ump.feedback` against Recall's SQLite + sqlite-vec store, over MCP (stdio) and an optional HTTP binding (`--http <port>`). Writes store directly as active memories (faithful, round-trip by id) and preserve all five UMP kinds; the server warms a local embedding model on startup so retrieval is real semantic search (RRF fusion of the sqlite-vec vector arm and a BM25 lexical arm), with a `--smart` flag to route writes through Recall's capture/judgement pipeline instead. Built on the published [`@universalmemoryprotocol/core`](https://www.npmjs.com/package/@universalmemoryprotocol/core).

## 0.7.3 - 2026-06-03

### Fixed

- **Capture no longer mines non-user or adversarial turns.** Running an agent-eval benchmark inside a repo poisoned that repo's memory: the benchmark's adversarial prompts (task specs aimed at the model under test, e.g. `required exact reply: ...`, `Required generated files: ...`, `use private/runtime state for this answer`) were captured as if they were durable user rules, then re-injected into unrelated sessions — a self-inflicted prompt-injection channel. The long-standing intent *"never extract memory from cron, subagent, compaction, flush, or system repair contexts"* existed only as an un-enforced memory. It is now enforced in code: a new `isNonUserCaptureContext` guard at the `processCorrection` chokepoint (and inside `detectCorrections`) quarantines turns carrying system-scaffolding markers (`<task-notification>`, `[correction_summary]`, hook-activity, `<system-reminder>`), non-user execution contexts (`subagent`, `compaction`, `system repair`), or prompt-injection artifacts before any capture path (regex, MCP `capture_correction`/`report_correction`, or LLM-primary) runs. The LLM capture-judge prompt gains a matching reject rule as defense-in-depth. Precision-tuned so legitimate rules ("always flush the cache", "the cron job runs nightly") are untouched.

## 0.7.2 - 2026-05-25

### Fixed

- `report_correction` / `capture_correction` MCP tools reported "No correction pattern detected" even when the LLM-primary capture path had successfully enqueued the prompt for background extraction. `processCorrection` discarded the enqueued task id and returned an empty array, so the MCP layer (and `recall correct` CLI, and daemon `/correct` endpoint) lied about the outcome whenever an LLM provider was configured. The function now returns `{ ids, pendingTaskId }`; callers surface a clear "Enqueued for LLM extraction" message and persist the task id on the activity event.

## 0.7.1 - 2026-05-23

### Added

- **Windows support.** New Go-based system-tray companion (`windows/tray`) supervises the recall daemon child, exposes Status / WebUI / Restart / Start at login / Quit menu items, and opens the dashboard in your default browser. PowerShell installer (`scripts/install.ps1`, mirrored at `https://recallmemory.dev/install.ps1`) installs the `@edihasaj/recall` CLI via npm, drops `recall-tray-<arch>.exe` into `%LOCALAPPDATA%\Programs\Recall`, registers per-user autostart, and launches the tray. CI workflow `windows-tray.yml` builds arm64 + amd64 binaries on every tag.
- macOS / Linux one-shot installer (`scripts/install.sh`, mirrored at `https://recallmemory.dev/install.sh`) — `curl -fsSL https://recallmemory.dev/install.sh | bash` installs the CLI globally and runs `recall setup --yes`.

### Fixed

- Daemon ESM import crashes on Windows when spawned from a non-elevated session. tsup now bundles `drizzle-orm` (`noExternal: [/^drizzle-orm(\/|$)/]`) so there's no runtime bare-specifier resolution to trip on pnpm symlinks.
- Windows tray "Open Dashboard" pointed at `:7890/ui` (which doesn't exist); it now ensures the webui sub-server is started and opens its real URL.
- Windows tray's `dashboard.Open` used `cmd /c start`, which allocated a console window the user had to close (closing it killed the tray). Replaced with `rundll32 url.dll,FileProtocolHandler` + `CREATE_NO_WINDOW`.

## 0.7.0 - 2026-05-20

### Added

- Web dashboard shell: the daemon now serves a full SPA at `/webui/start` with Memories, Graph, Timeline, Sessions, and Contradictions tabs. Recall.app's *Open Dashboard in Browser* hooks into this directly; `recall webui start` exposes the same surface for non-app installs.
- Knowledge graph (entities + relations) extracted from memories. New `/graph/stats`, `/graph/entities`, `/graph/relations`, `/graph/neighbors`, and `/graph/memory/:id` endpoints; CLI `recall graph stats|entities|backfill|query`. Heuristic extractor runs at capture time and is idempotent.
- Graph dashboard with two views: a 2D layered layout grouped by entity kind, and a 3D force-directed layout (`react-force-graph-3d` + `three.js`). Toggle in the toolbar. Click any node to drill into linked memories and neighbours.
- Paginated list endpoints. `/memories`, `/activity`, `/sessions`, and `/contradictions` now accept `offset` + `limit` and return `{ offset, limit, has_more }`. Memories and activity push LIMIT/OFFSET into SQL; sessions slice an aggregated window.
- Web dashboard pagination + URL-persisted filters across every list. 50 rows per page, auto-load on scroll via IntersectionObserver, "load more" button at the bottom. Memories supports `?focus=<id>` deep links so Timeline events can link straight to the underlying rule.
- Timeline page rebuild: filter dropdowns for repo/source/event_type, click-to-expand rows that reveal full request/result JSON and link out to memories, session_id chip filter, plus a one-line tool-summary preview for each event.
- Sessions page rebuild: repo filter, duration label, last-seen relative time, event-type colour chips, inline drilldown that lists the session's events oldest-first, and one-click hand-off into Timeline filtered by `session_id`.
- Modern macOS app shell. Sidebar navigation, persistent footer with daemon/WebUI status, dock-icon preference, login-item registration, and tabs for Overview / Daemon / Web Dashboard / Preferences.
- Benchmark harness (`benchmark/seed.ts`, `benchmark/load.ts`) and a Playwright + ffmpeg demo recorder (`scripts/record-demo.sh`, `scripts/record-demo.mjs`). New npm scripts: `bench:seed`, `bench:load`, `demo:record`.

### Fixed

- `LSUIElement=YES` launches Recall.app as a menu-bar agent, so SwiftUI's lazy Window scene never materialized at startup. Controllers and the window-open observer both lived inside that scene, leaving the status menu stuck on em-dashes and *Open Recall* / *Open Dashboard in Browser* as no-ops until the user manually opened the window. Moved `DaemonController`, `AppPreferences`, and `WebUIController` onto AppDelegate so they boot and are observable from launch, and added a cold-path that materializes the SwiftUI window via its registered Window-menu item.
- `/graph/entities?search=…` ran the contains-match filter after `SELECT … LIMIT`, so long-tail entities never surfaced unless they happened to sit in the top-N by mention_count. Pushed the LIKE into the SQL WHERE (both `normalized_name` and `LOWER(name)`) so the limit applies post-filter.

## 0.6.7 - 2026-05-14

### Fixed

- Dashboard content now scrolls vertically in the compact window, keeping the action buttons reachable while preserving the titlebar-safe top spacing.
- Tuned the shared titlebar inset for Dashboard and Settings content so it clears the toolbar without leaving a large blank band.

## 0.6.6 - 2026-05-14

### Fixed

- Dashboard and Settings content now share a larger titlebar top inset, keeping the app icon, status badge, and settings controls clear of the macOS window toolbar.

## 0.6.5 - 2026-05-14

### Fixed

- The dashboard close guard is now explicitly main-actor isolated, fixing the macOS app release build on Xcode 16.4 while keeping the 0.6.4 login-item and menu-bar lifecycle behavior.

## 0.6.4 - 2026-05-14

### Fixed

- Recall.app now registers the menu bar app itself as a login item by default, so reboot/login restores the status icon instead of only starting the background daemon. The dashboard and Settings panes expose the login-item status and a Start at Login toggle.
- Closing the dashboard window now hides it through an `NSWindowDelegate` guard instead of letting SwiftUI close the scene, keeping the menu bar status item alive until the user chooses Quit Recall.

## 0.6.3 - 2026-05-14

### Fixed

- Prompt-time history injection now requires a lexical match or clear vector relevance before adding history-only context. This prevents stale summaries, such as old demo or launch notes, from steering unrelated turns.
- Memory quality gates now dedupe duplicate LLM capture tasks, merge near-identical destructive candidates across varied LLM types, redact sensitive hook/activity telemetry before storage, and audit CLI/MCP/HTTP memory rejections.
- High-risk pending confirmations no longer surface at every SessionStart by default; set `RECALL_SURFACE_PENDING_CONFIRMATIONS=true` to restore that queue in startup context.

## 0.6.2 - 2026-05-11

### Fixed

- Daemon `/health` endpoint returned a hardcoded `version: "0.5.0"` regardless of the actual installed version. Now reads `version` from the bundled `package.json` at startup, so health probes report the real release.

## 0.6.1 - 2026-05-11

### Fixed

- Capture hook's `/dispatch/wake` ping used the wrong daemon port (`RECALL_DAEMON_PORT` default `47649`) instead of `RECALL_PORT` (default `7890`), so every wake silently failed and freshly captured prompts only got picked up on the timer-based dispatcher cycle. Fixed to use the canonical `RECALL_PORT` / `7890`.

## 0.6.0 - 2026-05-11

### Added

- LLM-primary capture path. When an LLM provider is configured, the user-prompt hook now hands the raw prompt to an `extract_rules_from_prompt` task instead of running the regex extractor. The LLM judges in any natural language (en/es/fr/de/it/pt/ru/zh/ja/sq/tr supported by the pre-screen) and returns one canonical English rule per durable directive, with confidence and scope. Empty list is a valid answer. The regex extractor stays as the fallback when no provider is configured or `RECALL_LLM_CAPTURE_DISABLED=true`.
- Multi-language pre-screen (`isPromptWorthLLM`) filters out pure code-request prompts before the LLM call, keeping costs negligible at observed volumes.
- `POST /dispatch/wake` daemon endpoint, debounced 3 s. The capture hook pings it on every enqueue so fresh captures get an LLM verdict within seconds instead of waiting for the next timer tick. The existing daily timer-based cadence remains as a backstop.
- Managed CLAUDE.md memory-override block, installed by `recall setup` and repaired by `recall doctor --fix`. The block tells Claude Code's harness to defer all memorize/forget intents to Recall instead of writing to `~/.claude/projects/*/memory/MEMORY.md`, which previously produced a dual-write between Claude's built-in auto-memory and Recall. New flags `--no-claude-md` on `recall setup` and `recall setup local`, opt-out env `RECALL_SETUP_SKIP_CLAUDE_MD=1`. `recall doctor` now reports `claude.md:ok|STALE|MISSING|ABSENT_NO_FILE`.

### Changed

- `qualityReasons` fragment filter tightened to catch garbage that previously slipped through: removed modals (`always`, `never`, `must`, `should`, `don't`) from `VERB_HINTS` so the `no_verb` check actually fires on bare-modal scraps; bumped `MIN_RULE_LENGTH` from 14 to 20; added `trailing_dash` and `embedded_question` reasons. The expanded `VERB_HINTS` now covers `update`, `create`, `delete`, `rename`, `validate`, `verify`, `check`, `follow`, `read`, `write`, `open`, `close`, `send`, `receive`, `configure`, `enable`, `disable`.
- Dispatcher task priority: `extract_rules_from_prompt` runs at priority 14, ahead of `verify_capture` (12), because under LLM-primary capture it IS the candidate creation path — without it, real rules never reach the queue.

### Capture env

- `RECALL_LLM_CAPTURE_DISABLED` (default `false`) — set to `true` to force the regex fallback path even when an LLM provider is configured. Useful for offline/airgapped runs or benchmarking.
- `RECALL_SETUP_SKIP_CLAUDE_MD` — set to `1` to skip the managed CLAUDE.md block install during `recall setup`.

## 0.5.8 - 2026-05-06

### Fixed

- The cask renderer (`scripts/render-homebrew-cask.mjs`) hardcoded the cask body and ignored the template file, so the quarantine-strip postflight added in 0.5.7 never reached the published cask. The renderer now emits the postflight directly so fresh `brew install --cask recall` no longer hits Gatekeeper relocating `/Applications/Recall.app`.

## 0.5.7 - 2026-05-06

### Fixed

- `scripts/build-app.sh` now passes `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` to `xcodebuild`, so the bundled `Info.plist` actually contains a `CFBundleShortVersionString` and the in-app version label introduced in 0.5.5 displays the right value (previously empty).
- Homebrew cask postflight strips the `com.apple.quarantine` xattr after install. The bundle is ad-hoc signed, and Gatekeeper was relocating `/Applications/Recall.app` to `~/Library/Application Support/com.apple.mobile.installation.removed` on first launch after `brew install --cask recall`. Manual installs of prior releases still need a one-time `xattr -dr com.apple.quarantine /Applications/Recall.app`.

## 0.5.6 - 2026-05-06

### Fixed

- Closing the Settings window with its red close button no longer terminates Recall.app and removes the menu bar icon. `applicationShouldTerminate` now cancels termination unless the user explicitly invoked "Quit Recall" from the menu bar dropdown, working around SwiftUI's Settings scene calling `NSApp.terminate` directly.

## 0.5.5 - 2026-05-06

### Added

- Recall.app now displays its version next to the dashboard title and in the menu bar dropdown header, so it's obvious which build is running after a Homebrew upgrade.

## 0.5.4 - 2026-05-06

### Fixed

- Recall.app now launches as a true menu-bar agent (`LSUIElement=YES`) instead of switching from `.regular` to `.accessory` after the dashboard view appears. This eliminates the regression where closing the dashboard window would also remove the menu bar status item on newer macOS versions.

## 0.5.3 - 2026-05-06

### Fixed

- Activity event and hook call inserts are now atomic via `INSERT … ON CONFLICT(dedupe_key) DO NOTHING`, eliminating the `UNIQUE constraint failed: activity_events.dedupe_key` errors that flooded `~/.recall/logs/hook-errors.log` when multiple agent processes wrote concurrently. Effectiveness telemetry (`recall eval`) now sees those tool-call events instead of dropping them.
- WAL maintenance escalates `wal_checkpoint(PASSIVE)` to `TRUNCATE` once `recall.db-wal` exceeds 32 MiB (configurable via `RECALL_SQLITE_WAL_TRUNCATE_BYTES`), preventing the WAL file from growing into the hundreds of megabytes under sustained concurrent writers.
- DB open performs a one-shot `wal_checkpoint(TRUNCATE)` if the existing WAL is already past the threshold (`RECALL_SQLITE_STARTUP_WAL_TRUNCATE_BYTES`), so installs that grew a large WAL before this release shrink on the next daemon start.
- `~/.recall/logs/hook-errors.log` rotates to `hook-errors.log.1` at 1 MiB (`RECALL_HOOK_LOG_MAX_BYTES`) instead of growing unbounded.

## 0.5.1 - 2026-05-04

### Fixed

- Capture pipeline now blocks auto-promotion of trigger-template rules ("when user says X, do Y") in addition to destructive-risky ones; both shapes surface in the SessionStart pending-confirmations queue with a per-item reason tag.
- SessionStart injection (minimal style) emits a compact `Recall (<repo>):` lead-in instead of stripping all attribution, so foreign agents can identify Recall-sourced context.
- Global-scope memories render with a `[global]` marker in `## Rules` / `## Commands` / `## Gotchas`, making cross-repo provenance unambiguous.

## 0.5.0 - 2026-05-04

### Added

- Static landing page in `docs/` for GitHub Pages.
- CI, Pages, and release workflows for open-source distribution.
- GitHub Release packaging for `Recall.app.zip` plus optional Homebrew cask publishing.
- Open-source project docs and templates for contributors, security reports, issues, and PRs.
- Streamable HTTP MCP endpoint on the daemon at `/mcp`, alongside the existing stdio MCP server.
- Local embeddings now ship default-on with `nomic` and optional `multilingual-e5`.
- `recall embeddings setup` and `recall embeddings info` for model cache management.
- Provider comparison in retrieval evals via `recall eval retrieval --provider ...`.
- macOS Recall.app now surfaces background setup progress while launchd and the daemon rebuild the local store.

### Changed

- Recall now performs a destructive local DB reset on first boot after the embeddings cutover and rebuilds memory from repo scans.

### Upgrade Note

- First launch after upgrading resets Recall's local memory store.
- Existing local memories are cleared, repos are rescanned, and local embeddings/indexes are rebuilt in the background.
- The macOS app and daemon logs surface setup progress during that one-time migration.
