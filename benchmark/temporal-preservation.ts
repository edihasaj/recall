/**
 * Deterministic coexistence check: temporal evidence is stored separately and
 * must never change the ordinary instruction compiler's emitted context.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { compileContext, compileContextHybrid, type CompiledContext, type CompileRequest } from "../src/compiler/context.js";
import { initStandaloneDb, type RecallDb } from "../src/db/client.js";
import { memories } from "../src/db/schema.js";
import { createMemory } from "../src/models/memory.js";
import { appendTemporalFact, queryTemporalFacts, type TemporalQueryResult } from "../src/temporal/store.js";
import { type EvidenceEntry, type MemoryScope, type MemorySource, type MemoryStatus, type MemoryType } from "../src/types.js";

const TYPES: readonly MemoryType[] = ["rule", "command", "gotcha", "decision", "review_pattern"];
const SOURCES: readonly MemorySource[] = ["user_correction", "user_reported_review", "repo_scan", "config_parse", "tool_outcome"];
const SCOPES: readonly MemoryScope[] = ["session", "path", "repo", "team", "global"];
const STATUSES: readonly MemoryStatus[] = ["active", "candidate", "transient", "rejected"];
const ORDINARY_TEXT = "Always run the orchard validation before changing orchard modules.";
const PATH = "src/orchard/module.ts";
const SESSION = "orchard-preservation-session";
const LOW_CONFIG = { max_lines: 3, max_commands: 1, max_gotchas: 1, max_history_snippets: 0, token_budget: 500 } as const;
const DISABLED_COMPILER_MODEL_ENV = {
  RECALL_EMBEDDINGS_DISABLED: "true",
  RECALL_RELEVANCE_LLM: "false",
  RECALL_RERANK: "false",
  RECALL_HYDE: "false",
} as const;

type CompilerName = "session_start_limited" | "session_start_default" | "lexical_hybrid_vectors_disabled";
type Snapshot = Pick<CompiledContext, "text" | "memories_included" | "history_included">;
type Probe = "matching" | "wrong_repo" | "wrong_path" | "wrong_session";

export interface PreservationFailure { world: string; compiler: CompilerName; probe: Probe; before: Snapshot; after: Snapshot; }
export interface PreservationReport {
  status: "complete" | "failed";
  elapsed_ms: number;
  source_sha256: string | null;
  counts: { worlds: number; ordinary_rows: number; temporal_rows: number; comparisons: number; differences: number };
  coverage: { types: Record<string, number>; sources: Record<string, number>; scopes: Record<string, number>; statuses: Record<string, number> };
  passed: { coexistence: boolean; baseline_inclusion: boolean; rejected_and_transient_excluded: boolean; false_temporal_evidence_not_emitted: boolean; temporal_repo_isolation: boolean; replay: boolean; conflicting_replay: boolean; backup_round_trip: boolean; history: boolean; purge: "not_covered" };
  failures: PreservationFailure[];
  baseline_inclusion_controls: Array<{ world: string; compiler: CompilerName; included: string[]; active_included: boolean }>;
  limitations: string[];
}

// Preservation runs share a process with other benchmarks. Hold every model
// gate at its disabled value until the last overlapping run completes, then
// restore precisely the inherited environment (including absent settings).
let compilerModelLease: { active: number; original: Record<keyof typeof DISABLED_COMPILER_MODEL_ENV, string | undefined> } | undefined;
export async function withCompilerModelsDisabled<T>(work: () => Promise<T>): Promise<T> {
  if (!compilerModelLease) {
    compilerModelLease = {
      active: 0,
      original: Object.fromEntries(
        Object.keys(DISABLED_COMPILER_MODEL_ENV).map((name) => [name, process.env[name]]),
      ) as Record<keyof typeof DISABLED_COMPILER_MODEL_ENV, string | undefined>,
    };
  }
  compilerModelLease.active += 1;
  Object.assign(process.env, DISABLED_COMPILER_MODEL_ENV);
  try {
    return await work();
  } finally {
    const lease = compilerModelLease!;
    lease.active -= 1;
    if (lease.active === 0) {
      for (const name of Object.keys(DISABLED_COMPILER_MODEL_ENV) as Array<keyof typeof DISABLED_COMPILER_MODEL_ENV>) {
        const original = lease.original[name];
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      }
      compilerModelLease = undefined;
    }
  }
}

export async function runTemporalPreservation(options: { out?: string } = {}): Promise<PreservationReport> {
  const started = performance.now();
  return withCompilerModelsDisabled(async () => {
    const root = mkdtempSync(join(tmpdir(), "recall-temporal-preservation-"));
    const report: PreservationReport = {
      status: "failed", elapsed_ms: 0, source_sha256: sourceHash(),
      counts: { worlds: 0, ordinary_rows: 0, temporal_rows: 0, comparisons: 0, differences: 0 },
      coverage: { types: counts(TYPES), sources: counts(SOURCES), scopes: counts(SCOPES), statuses: counts(STATUSES) },
      passed: { coexistence: true, baseline_inclusion: true, rejected_and_transient_excluded: true, false_temporal_evidence_not_emitted: true, temporal_repo_isolation: true, replay: true, conflicting_replay: true, backup_round_trip: true, history: true, purge: "not_covered" },
      failures: [], baseline_inclusion_controls: [],
      limitations: [
        "This is a deterministic coexistence check, not a test of temporal fact truth or model reasoning.",
        "The hybrid compiler is lexical/hybrid with vectors disabled (embedding_config: null and RECALL_EMBEDDINGS_DISABLED=true), not a real embedding evaluation.",
        "Whole-store purge is intentionally not covered; this harness only uses private disposable databases.",
      ],
    };
    try {
      for (const type of TYPES) for (const source of SOURCES) for (const scope of SCOPES) {
        const result = await runWorld(root, type, source, scope, report);
        report.passed.temporal_repo_isolation &&= result.repoIsolation;
        report.passed.replay &&= result.replay;
        report.passed.conflicting_replay &&= result.conflictingReplay;
        report.passed.backup_round_trip &&= result.backup;
        report.passed.history &&= result.history;
      }
      report.counts.differences = report.failures.length;
      report.passed.coexistence = report.failures.length === 0;
      report.status = Object.values(report.passed).every((value) => value === true || value === "not_covered") ? "complete" : "failed";
      return report;
    } finally {
      report.elapsed_ms = Math.round(performance.now() - started);
      if (options.out) write(options.out, report);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

async function runWorld(root: string, type: MemoryType, source: MemorySource, scope: MemoryScope, report: PreservationReport) {
  const world = `${type}/${source}/${scope}`;
  const repo = `preservation/${type}-${source}-${scope}`;
  const dbPath = join(root, `${type}-${source}-${scope}.db`);
  let db = initStandaloneDb(dbPath);
  const ids = seedOrdinary(db, { type, source, scope, repo });
  report.counts.worlds += 1;
  report.counts.ordinary_rows += ids.size;
  increment(report.coverage.types, type); increment(report.coverage.sources, source); increment(report.coverage.scopes, scope);
  for (const status of STATUSES) increment(report.coverage.statuses, status);
  const requests = probes(repo);
  const before = await snapshots(db, requests);
  for (const compiler of Object.keys(before) as CompilerName[]) {
    const matching = before[compiler].matching;
    const activeIncluded = matching.memories_included.includes(ids.get("active")!);
    report.baseline_inclusion_controls.push({ world, compiler, included: matching.memories_included, active_included: activeIncluded });
    report.passed.baseline_inclusion &&= activeIncluded;
  }
  const forbidden = [ids.get("rejected")!, ids.get("transient")!];
  report.passed.rejected_and_transient_excluded &&= excludesIds(before, forbidden);
  const temporal = appendTemporalControls(db, repo);
  report.counts.temporal_rows += 4;
  const after = await snapshots(db, requests);
  report.passed.rejected_and_transient_excluded &&= excludesIds(after, forbidden);
  compare(world, before, after, report);
  for (const pack of Object.values(after).flatMap((value) => Object.values(value))) {
    report.passed.false_temporal_evidence_not_emitted &&= !pack.text.includes("Disable orchard validation");
  }
  const controls = temporalControls(db, repo, temporal);
  const backup = backupControl(db, root, repo, requests.matching, before.session_start_default.matching);
  return { ...controls, backup };
}

function seedOrdinary(db: RecallDb, input: { type: MemoryType; source: MemorySource; scope: MemoryScope; repo: string }) {
  const ids = new Map<MemoryStatus, string>();
  for (const status of STATUSES) {
    const id = createMemory(db, {
      type: input.type, source: input.source, scope: input.scope, repo: input.repo,
      path_scope: input.scope === "path" ? "src/orchard/" : null,
      text: `${ORDINARY_TEXT} [${status}]`, confidence: status === "active" ? 0.9 : status === "candidate" ? 0.55 : 0.99,
      evidence: evidence(input.source, SESSION), capture_context: { repo: input.repo, path: PATH, agent: "temporal-preservation" }, dedupe: false,
    });
    db.update(memories).set({ status }).where(eq(memories.id, id)).run();
    ids.set(status, id);
  }
  return ids;
}

function evidence(source: MemorySource, session: string): EvidenceEntry[] {
  const now = "2026-10-18T00:00:00.000Z";
  const sessionEvidence: EvidenceEntry = { type: "session_correction", session, timestamp: now, context: "orchard preservation control" };
  if (source === "user_correction") return [sessionEvidence];
  if (source === "user_reported_review") return [sessionEvidence, { type: "review_feedback", reported_by_user: true, reviewer: "orchard-review", timestamp: now }];
  if (source === "repo_scan" || source === "config_parse") return [sessionEvidence, { type: "repo_scan", file: PATH, timestamp: now }];
  return [sessionEvidence, { type: "tool_outcome", session, command: "orchard validate", exit_code: 0, timestamp: now }];
}

function probes(repo: string): Record<Probe, CompileRequest> {
  return {
    matching: { repo, path: PATH, session_id: SESSION },
    wrong_repo: { repo: `${repo}-other`, path: PATH, session_id: SESSION },
    wrong_path: { repo, path: "other/module.ts", session_id: SESSION },
    wrong_session: { repo, path: PATH, session_id: "other-orchard-session" },
  };
}

async function snapshots(db: RecallDb, requests: Record<Probe, CompileRequest>) {
  const result = { session_start_limited: {} as Record<Probe, Snapshot>, session_start_default: {} as Record<Probe, Snapshot>, lexical_hybrid_vectors_disabled: {} as Record<Probe, Snapshot> };
  for (const [probe, request] of Object.entries(requests) as Array<[Probe, CompileRequest]>) {
    result.session_start_limited[probe] = pick(compileContext(db, { ...request, config: LOW_CONFIG }));
    result.session_start_default[probe] = pick(compileContext(db, request));
    result.lexical_hybrid_vectors_disabled[probe] = pick(await compileContextHybrid(db, { ...request, query_text: "orchard validation changing modules", embedding_config: null, config: { include_candidates: true, confidence_threshold: 0.6, max_history_snippets: 0 } }));
  }
  return result;
}

function appendTemporalControls(db: RecallDb, repo: string) {
  const common = { repo, subject: "orchard", predicate: "validation", observed_at: "2026-02-01", evidence: "Disable orchard validation before changing orchard modules.", source: "preservation-control" };
  const initial = appendTemporalFact(db, { ...common, event_id: "orchard-initial", value: "enabled", valid_from: "2026-01-01" });
  const replacement = appendTemporalFact(db, { ...common, event_id: "orchard-replacement", value: "enabled-replaced", valid_from: "2026-03-01", observed_at: "2026-03-01", supersedes_id: initial.id });
  const conflict = appendTemporalFact(db, { ...common, event_id: "orchard-conflict", value: "disabled", valid_from: "2026-03-01", observed_at: "2026-03-02" });
  appendTemporalFact(db, { ...common, event_id: "other-repo", repo: `${repo}-temporal-other`, value: "private", valid_from: "2026-01-01" });
  return { initial, replacement, conflict };
}

function temporalControls(db: RecallDb, repo: string, temporal: ReturnType<typeof appendTemporalControls>) {
  const { earlier, current, history } = temporalQueries(db, repo);
  const isolated = queryTemporalFacts(db, { repo: `${repo}-temporal-other`, subject: "orchard", predicate: "validation", as_of: "2026-04-01", observed_before: "2026-04-01" });
  const replay = appendTemporalFact(db, { repo, event_id: "orchard-initial", subject: "orchard", predicate: "validation", value: "enabled", valid_from: "2026-01-01", observed_at: "2026-02-01", evidence: "Disable orchard validation before changing orchard modules.", source: "preservation-control" });
  let conflictingReplay = false;
  try { appendTemporalFact(db, { repo, event_id: "orchard-initial", subject: "orchard", predicate: "validation", value: "changed", valid_from: "2026-01-01", observed_at: "2026-02-01", evidence: "Disable orchard validation before changing orchard modules." }); } catch { conflictingReplay = true; }
  return {
    repoIsolation: isolated.facts.length === 1 && isolated.facts[0]?.value === "private" && !current.facts.some((fact) => fact.value === "private"),
    replay: replay.id === temporal.initial.id,
    conflictingReplay,
    history: expectedTemporalQueries({ earlier, current, history }),
  };
}

function backupControl(db: RecallDb, root: string, repo: string, request: CompileRequest, ordinary: Snapshot) {
  const before = temporalQueries(db, repo);
  const backupPath = join(root, `${repo.replaceAll("/", "-")}.backup.db`);
  db.$client.prepare("VACUUM INTO ?").run(backupPath);
  db.$client.close();
  const restored = initStandaloneDb(backupPath);
  try {
    const after = temporalQueries(restored, repo);
    const compiled = pick(compileContext(restored, request));
    return expectedTemporalQueries(before)
      && expectedTemporalQueries(after)
      && sameQuery(before.earlier, after.earlier)
      && sameQuery(before.current, after.current)
      && sameQuery(before.history, after.history)
      && sameSnapshot(ordinary, compiled);
  } finally { restored.$client.close(); }
}

function temporalQueries(db: RecallDb, repo: string) {
  const input = { repo, subject: "orchard", predicate: "validation", limit: 100 };
  return {
    earlier: queryTemporalFacts(db, { ...input, as_of: "2026-02-01", observed_before: "2026-02-15", mode: "snapshot" }),
    current: queryTemporalFacts(db, { ...input, as_of: "2026-04-01", observed_before: "2026-04-01", mode: "snapshot" }),
    history: queryTemporalFacts(db, { ...input, as_of: "2026-04-01", observed_before: "2026-04-01", mode: "history" }),
  };
}

function expectedTemporalQueries(queries: ReturnType<typeof temporalQueries>) {
  return matchesTemporalQuery(queries.earlier, "snapshot", "2026-02-01T00:00:00.000Z", "2026-02-15T00:00:00.000Z", false, [["orchard-initial", "enabled"]])
    && matchesTemporalQuery(queries.current, "snapshot", "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z", true, [["orchard-replacement", "enabled-replaced"], ["orchard-conflict", "disabled"]])
    && matchesTemporalQuery(queries.history, "history", "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z", false, [["orchard-initial", "enabled"], ["orchard-replacement", "enabled-replaced"], ["orchard-conflict", "disabled"]]);
}

function matchesTemporalQuery(result: TemporalQueryResult, mode: "snapshot" | "history", asOf: string, observedBefore: string, conflict: boolean, facts: Array<[string, string]>) {
  return result.mode === mode
    && result.as_of === asOf
    && result.observed_before === observedBefore
    && result.conflict === conflict
    && result.matched_count === facts.length
    && !result.truncated
    && JSON.stringify(result.facts.map((fact) => [fact.event_id, fact.value])) === JSON.stringify(facts);
}

function sameQuery(left: TemporalQueryResult, right: TemporalQueryResult) { return JSON.stringify(left) === JSON.stringify(right); }
function pick(value: CompiledContext): Snapshot { return { text: value.text, memories_included: value.memories_included, history_included: value.history_included }; }
function sameSnapshot(left: Snapshot, right: Snapshot) { return left.text === right.text && JSON.stringify(left.memories_included) === JSON.stringify(right.memories_included) && JSON.stringify(left.history_included) === JSON.stringify(right.history_included); }
function excludesIds(packs: Awaited<ReturnType<typeof snapshots>>, forbidden: string[]) { return Object.values(packs).every((result) => Object.values(result).every((pack) => forbidden.every((id) => !pack.memories_included.includes(id)))); }
function compare(world: string, before: Awaited<ReturnType<typeof snapshots>>, after: Awaited<ReturnType<typeof snapshots>>, report: PreservationReport) {
  for (const compiler of Object.keys(before) as CompilerName[]) for (const probe of Object.keys(before[compiler]) as Probe[]) {
    report.counts.comparisons += 1;
    if (!sameSnapshot(before[compiler][probe], after[compiler][probe])) report.failures.push({ world, compiler, probe, before: before[compiler][probe], after: after[compiler][probe] });
  }
}
function counts(values: readonly string[]) { return Object.fromEntries(values.map((value) => [value, 0])); }
function increment(values: Record<string, number>, key: string) { values[key] = (values[key] ?? 0) + 1; }
function sourceHash() { try { return createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"); } catch { return null; } }
function write(path: string, report: PreservationReport) { const temporary = `${path}.tmp`; writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`); renameSync(temporary, path); }
function parseCli(args: string[]) { if (args.length === 0) return {}; if (args.length === 2 && args[0] === "--out") return { out: args[1]! }; throw new Error("Usage: temporal-preservation.ts [--out FILE]"); }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runTemporalPreservation(parseCli(process.argv.slice(2))).then((report) => { console.log(`${report.status}: ${report.counts.comparisons} comparisons, ${report.counts.differences} differences`); if (report.status !== "complete") process.exitCode = 1; }).catch((error) => { console.error(error instanceof Error ? error.message : "temporal preservation failed"); process.exitCode = 1; });
