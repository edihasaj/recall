import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import {
  feedbackEvents,
  maintenanceCleanupLog,
  memories,
  memoryInjections,
} from "../db/schema.js";
import { getMemory, queryMemories } from "../models/memory.js";
import { memoryDedupeKey } from "../models/dedupe.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";
import { checkContradiction } from "../contradictions/detector.js";
import { isDestructiveRisky } from "../capture/correction.js";

const SUPPRESS_INJECTION_FLOOR = 50;
const GLOBALIZE_REPO_FLOOR = 3;

// Phase-1 deterministic, LLM-free cleanup. Three actions:
//   * dedupeExact            — merge memories with identical normalized text within scope
//   * rejectFragmentCandidates — reject low-quality voice/typing-fragment captures
//   * promoteRepeatCorrections — auto-promote candidates with strong rule-shape text
//
// All actions write to maintenance_cleanup_log so they can be reviewed and
// reverted later. Dry-run produces the same plan without mutating the DB.

export interface CleanupOptions {
  dryRun: boolean;
  /** When set, only this action runs. */
  only?: CleanupActionKind;
}

export type CleanupActionKind =
  | "dedupe_exact_merge"
  | "reject_fragment_candidate"
  | "promote_repeat_correction"
  | "suppress_unproductive_command"
  | "globalize_cross_repo"
  | "reject_test_fixture_repo"
  | "reject_invalid_scope";

export interface DedupeExactPlan {
  kind: "dedupe_exact_merge";
  winner_id: string;
  winner_text: string;
  loser_ids: string[];
  scope_key: string;
  total_injection_count: number;
}

export interface RejectFragmentPlan {
  kind: "reject_fragment_candidate";
  memory_id: string;
  text: string;
  reasons: string[];
}

export interface PromoteRepeatPlan {
  kind: "promote_repeat_correction";
  memory_id: string;
  text: string;
  matched_pattern: "repetition" | "rule_shape";
}

export interface SuppressCommandPlan {
  kind: "suppress_unproductive_command";
  memory_id: string;
  text: string;
  injection_count: number;
  followed_count: number;
}

export interface GlobalizeCrossRepoPlan {
  kind: "globalize_cross_repo";
  winner_id: string;
  winner_text: string;
  loser_ids: string[];
  repos: string[];
  total_injection_count: number;
}

export interface RejectTestFixtureRepoPlan {
  kind: "reject_test_fixture_repo";
  memory_id: string;
  repo: string;
  text: string;
}

export interface RejectInvalidScopePlan {
  kind: "reject_invalid_scope";
  memory_id: string;
  scope: string;
  repo: string | null;
  path_scope: string | null;
  text: string;
  reasons: string[];
}

export type CleanupPlanItem =
  | DedupeExactPlan
  | RejectFragmentPlan
  | PromoteRepeatPlan
  | SuppressCommandPlan
  | GlobalizeCrossRepoPlan
  | RejectTestFixtureRepoPlan
  | RejectInvalidScopePlan;

export interface CleanupReport {
  run_id: string;
  dry_run: boolean;
  started_at: string;
  finished_at: string;
  counts: {
    dedupe_clusters: number;
    dedupe_losers: number;
    fragment_rejections: number;
    repeat_promotions: number;
    command_suppressions: number;
    globalizations: number;
    globalize_losers: number;
    test_fixture_rejections: number;
    invalid_scope_rejections: number;
    e2e_artifact_rejections: number;
  };
  plan: CleanupPlanItem[];
}

const DEFAULT_ACTOR = "maintenance:cleanup";

export function runDeterministicCleanup(
  db: RecallDb,
  opts: CleanupOptions = { dryRun: true },
): CleanupReport {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const plan: CleanupPlanItem[] = [];

  if (!opts.only || opts.only === "dedupe_exact_merge") {
    plan.push(...planDedupeExact(db));
  }
  if (!opts.only || opts.only === "reject_fragment_candidate") {
    plan.push(...planRejectFragments(db));
  }
  if (!opts.only || opts.only === "promote_repeat_correction") {
    plan.push(...planPromoteRepeats(db));
  }
  if (!opts.only || opts.only === "suppress_unproductive_command") {
    plan.push(...planSuppressCommands(db));
  }
  if (!opts.only || opts.only === "globalize_cross_repo") {
    plan.push(...planGlobalizeCrossRepo(db));
  }
  if (!opts.only || opts.only === "reject_test_fixture_repo") {
    plan.push(...planRejectTestFixtureRepos(db));
  }
  if (!opts.only || opts.only === "reject_invalid_scope") {
    plan.push(...planRejectInvalidScopes(db));
  }

  const counts = summarize(plan);

  if (!opts.dryRun) {
    for (const item of plan) {
      switch (item.kind) {
        case "dedupe_exact_merge":
          applyDedupeExact(db, runId, item);
          break;
        case "reject_fragment_candidate":
          applyRejectFragment(db, runId, item);
          break;
        case "promote_repeat_correction":
          applyPromoteRepeat(db, runId, item);
          break;
        case "suppress_unproductive_command":
          applySuppressCommand(db, runId, item);
          break;
        case "globalize_cross_repo":
          applyGlobalizeCrossRepo(db, runId, item);
          break;
        case "reject_test_fixture_repo":
          applyRejectTestFixtureRepo(db, runId, item);
          break;
        case "reject_invalid_scope":
          applyRejectInvalidScope(db, runId, item);
          break;
      }
    }
  }

  return {
    run_id: runId,
    dry_run: opts.dryRun,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    counts,
    plan,
  };
}

function summarize(plan: CleanupPlanItem[]): CleanupReport["counts"] {
  let dedupeClusters = 0;
  let dedupeLosers = 0;
  let fragmentRejections = 0;
  let repeatPromotions = 0;
  let commandSuppressions = 0;
  let globalizations = 0;
  let globalizeLosers = 0;
  let testFixtureRejections = 0;
  let invalidScopeRejections = 0;
  let e2eArtifactRejections = 0;
  for (const p of plan) {
    if (p.kind === "dedupe_exact_merge") {
      dedupeClusters += 1;
      dedupeLosers += p.loser_ids.length;
    } else if (p.kind === "reject_fragment_candidate") {
      fragmentRejections += 1;
    } else if (p.kind === "promote_repeat_correction") {
      repeatPromotions += 1;
    } else if (p.kind === "suppress_unproductive_command") {
      commandSuppressions += 1;
    } else if (p.kind === "globalize_cross_repo") {
      globalizations += 1;
      globalizeLosers += p.loser_ids.length;
    } else if (p.kind === "reject_test_fixture_repo") {
      testFixtureRejections += 1;
    } else {
      invalidScopeRejections += 1;
    }
    if (p.kind === "reject_fragment_candidate" && p.reasons.includes("e2e_verification_artifact")) {
      e2eArtifactRejections += 1;
    }
  }
  return {
    dedupe_clusters: dedupeClusters,
    dedupe_losers: dedupeLosers,
    fragment_rejections: fragmentRejections,
    repeat_promotions: repeatPromotions,
    command_suppressions: commandSuppressions,
    globalizations,
    globalize_losers: globalizeLosers,
    test_fixture_rejections: testFixtureRejections,
    invalid_scope_rejections: invalidScopeRejections,
    e2e_artifact_rejections: e2eArtifactRejections,
  };
}

// --- dedupeExact ----------------------------------------------------------

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.;:,!?`]+$/g, "")
    .trim();
}

function scopeKey(row: { type: string; scope: string; repo: string | null; path_scope: string | null; norm: string }) {
  return [row.type, row.scope, row.repo ?? "", row.path_scope ?? "", row.norm].join("\u0000");
}

export function planDedupeExact(db: RecallDb): DedupeExactPlan[] {
  // Look at active + candidate; rejected rows stay rejected.
  const rows = db.select({
    id: memories.id,
    type: memories.type,
    text: memories.text,
    scope: memories.scope,
    repo: memories.repo,
    path_scope: memories.path_scope,
    status: memories.status,
    injection_count: memories.injection_count,
    confidence: memories.confidence,
    created_at: memories.created_at,
  })
    .from(memories)
    .where(inArray(memories.status, ["active", "candidate"]))
    .all();

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const norm = normalizeText(row.text);
    if (!norm) continue;
    const key = scopeKey({ ...row, norm });
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const plans: DedupeExactPlan[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    // Prefer active over candidate, then highest injection_count, then highest
    // confidence, then earliest created_at (stable choice).
    const sorted = [...list].sort((a, b) => {
      const statusRank = (s: string) => (s === "active" ? 0 : 1);
      const dStatus = statusRank(a.status) - statusRank(b.status);
      if (dStatus !== 0) return dStatus;
      if (a.injection_count !== b.injection_count) return b.injection_count - a.injection_count;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return a.created_at.localeCompare(b.created_at);
    });
    const winner = sorted[0];
    const losers = sorted.slice(1);
    const total = list.reduce((acc, r) => acc + r.injection_count, 0);
    plans.push({
      kind: "dedupe_exact_merge",
      winner_id: winner.id,
      winner_text: winner.text,
      loser_ids: losers.map((l) => l.id),
      scope_key: key,
      total_injection_count: total,
    });
  }
  return plans;
}

function applyDedupeExact(db: RecallDb, runId: string, plan: DedupeExactPlan) {
  const winner = getMemory(db, plan.winner_id);
  if (!winner) return;

  const losers = plan.loser_ids
    .map((id) => getMemory(db, id))
    .filter((m): m is NonNullable<typeof m> => m != null);

  if (losers.length === 0) return;

  const sumCounts = losers.reduce(
    (acc, l) => ({
      injection: acc.injection + l.injection_count,
      override: acc.override + l.override_count,
      repetition: acc.repetition + l.repetition_count,
    }),
    { injection: 0, override: 0, repetition: 0 },
  );

  const now = new Date().toISOString();

  // Move feedback_events + memory_injections from losers to winner. The
  // memory_injections table has a (memory_id, session_id) unique constraint,
  // so we re-point only when the winner doesn't already have a row for the
  // same session.
  for (const loser of losers) {
    // Re-point feedback_events (no unique constraint).
    db.update(feedbackEvents)
      .set({ memory_id: winner.id })
      .where(eq(feedbackEvents.memory_id, loser.id))
      .run();

    // For memory_injections: move rows whose session has no winner row yet,
    // then drop the rest (the winner already represents that session).
    const loserInj = db.select().from(memoryInjections)
      .where(eq(memoryInjections.memory_id, loser.id))
      .all();
    for (const inj of loserInj) {
      const collision = db.select({ id: memoryInjections.id }).from(memoryInjections)
        .where(and(eq(memoryInjections.memory_id, winner.id), eq(memoryInjections.session_id, inj.session_id)))
        .get();
      if (collision) {
        db.delete(memoryInjections).where(eq(memoryInjections.id, inj.id)).run();
      } else {
        db.update(memoryInjections)
          .set({ memory_id: winner.id })
          .where(eq(memoryInjections.id, inj.id))
          .run();
      }
    }
  }

  // Bump winner counters with the merged sums.
  db.update(memories)
    .set({
      injection_count: winner.injection_count + sumCounts.injection,
      override_count: winner.override_count + sumCounts.override,
      repetition_count: winner.repetition_count + sumCounts.repetition,
      updated_at: now,
    })
    .where(eq(memories.id, winner.id))
    .run();

  // Reject losers, supersedes=winner.
  for (const loser of losers) {
    db.update(memories)
      .set({ status: "rejected", supersedes: winner.id, dedupe_key: null, updated_at: now })
      .where(eq(memories.id, loser.id))
      .run();

    const after = getMemory(db, loser.id);
    recordAuditWithSnapshot(
      db,
      loser.id,
      "rejected",
      DEFAULT_ACTOR,
      `dedupe_exact:merged_into:${winner.id}:run:${runId}`,
      loser,
      after ?? null,
    );

    db.insert(maintenanceCleanupLog).values({
      id: randomUUID(),
      run_id: runId,
      action: "dedupe_exact_merge",
      memory_id: loser.id,
      related_memory_id: winner.id,
      before_snapshot: loser as unknown as any,
      after_snapshot: after as unknown as any,
      details: { scope_key: plan.scope_key, transferred_injection_count: loser.injection_count } as any,
      reverted: false,
      reverted_at: null,
      created_at: now,
    }).run();
  }
}

// --- rejectFragmentCandidates --------------------------------------------

// Only real action verbs count. Modals (`must`, `never`, `always`, `should`,
// `don't`, `do not`) used to live here, which meant the "no_verb" check could
// never trigger on bare modal fragments like "always be used." or "must work
// end to end doesn't bring files here" — every rule-shaped scrap automatically
// passed because the modal itself satisfied the check.
const VERB_HINTS = [
  "use", "uses", "used", "run", "runs", "ran",
  "avoid", "prefer", "keep", "set", "add", "remove", "skip",
  "replace", "fix", "ensure", "require", "make",
  "build", "test", "deploy", "install", "import", "export",
  "commit", "push", "call", "wrap", "split", "merge", "store",
  "load", "save", "ignore", "accept", "reject", "update", "create",
  "delete", "rename", "move", "copy", "validate", "verify", "check",
  "follow", "read", "write", "open", "close", "send", "receive",
  "treat", "propose",
  "configure", "enable", "disable",
];

const BARE_MODAL_RE = /^\s*(must|never|always|do not|don't|required|prefer|should)\b[^\w]*(stay|do|stop|go|reply|reply\?)?\s*$/i;
const TRAILING_QUESTION_RE = /\?\s*$/;
const DANGLING_CONNECTOR_RE = /\b(?:and|or|but|with|without|to|from|for|of|as|because|instead|over|the|a|an|on|in|at|by)\s*$/i;
const TRAILING_DOUBLE_DOT_RE = /\.{2,}\s*$/;
// Trailing em/en-dash with nothing after — speech artifact ("never sends a
// banner —"). The speaker started a clause and never finished it.
const TRAILING_DASH_RE = /[—–-]\s*$/;
// Question pronouns embedded after a modal turn the "rule" into a question
// the speaker was asking, not a directive: "always can you find …",
// "never could you check …".
const EMBEDDED_QUESTION_RE =
  /^\s*(?:always|never|must|don't|do not|required|prefer|should)\s+(?:can|could|would|will|do|does|did|is|are|was|were|have|has|should|may|might)\s+(?:you|we|i|they|it|he|she)\b/i;
// "always just …", "never now …" etc. — voice-transcript filler word right
// after the modal almost always means the speaker is not stating a rule.
const RULE_FILLER_PREFIX_RE =
  /^\s*(?:always|never|must|don't|do not|prefer|required)\s+(?:just|now|uh|um|so|like|maybe|kinda|sort\s+of)\b/i;
const VAGUE_SPEECH_FRAGMENT_RE =
  /\b(?:or whatever|and stuff like that|stuff like that|something like that|things like that)\b/i;
const WORKSPACE_ONLY_RULE_RE =
  /^\s*(?:always\s+)?keep\s+(?:all\s+)?(?:edits|work|changes)\s+inside\s+(?:(?:the\s+)?current\s+|(?:the\s+)?specified\s+|the\s+)?workspace(?:\s+at\s+\S+)?\.?\s*$/i;
const BENCHMARK_ARTIFACT_RULE_RE =
  /\b(?:agent-scorecard|data\/agent-runs\.json|generated scorecard|benchmark tasks?|Oktapod and OpenClaw|OpenClaw and Oktapod|do not add Hermes)\b/i;
const TOOL_EMBARGO_TASK_RULE_RE =
  /^\s*do\s+not\s+(?:open\s+browser,\s+screenshot,\s+or\s+devtools\s+tools|open\s+browser,\s+take\s+screenshots,\s+or\s+use\s+devtools\s+tools)(?:\s+(?:during|for)\s+(?:this\s+|the\s+)?(?:task|benchmark(?:\s+run)?))?\.?\s*$/i;
const E2E_VERIFICATION_ARTIFACT_RE =
  /\b(?:recall\s+(?:e2e|end[- ]to[- ]end)\s+verification|(?:e2e|end[- ]to[- ]end)\s+verification\s+(?:smoke|fixture|artifact)|for\s+recall\s+(?:e2e|end[- ]to[- ]end)\s+verification)\b/i;
const ACTIVE_FRAGMENT_REASONS = new Set([
  "bare_modal",
  "trailing_question",
  "trailing_double_dot",
  "trailing_dash",
  "dangling_connector",
  "filler_prefix",
  "vague_speech_fragment",
  "workspace_only_runtime_rule",
  "benchmark_artifact_rule",
  "tool_embargo_task_rule",
  "e2e_verification_artifact",
  "embedded_question",
]);
// Anything past this length is almost certainly a voice ramble, not a rule.
// Real rules in the corpus stay well under this; long ones can still be
// re-captured as multiple smaller rules or saved via explicit confirm.
const MAX_RULE_LENGTH = 300;
// Minimum useful rule length. Bumped from 14: in production we saw a
// long tail of short fragments ("always be used." 15ch, "always can
// you find" 19ch) that were all incomplete thoughts. Real, durable
// rules are almost always longer. Trailing-dash/bare-modal catches
// catch the remaining 20-22 char garbage like "never sends a banner —".
const MIN_RULE_LENGTH = 20;

export function planRejectFragments(db: RecallDb): RejectFragmentPlan[] {
  const rows = db.select({
    id: memories.id,
    text: memories.text,
    source: memories.source,
    status: memories.status,
  })
    .from(memories)
    .where(and(inArray(memories.status, ["active", "candidate"]), eq(memories.source, "user_correction")))
    .all();

  const out: RejectFragmentPlan[] = [];
  for (const row of rows) {
    const reasons = qualityReasons(row.text);
    const actionableReasons = row.status === "active"
      ? reasons.filter((reason) => ACTIVE_FRAGMENT_REASONS.has(reason))
      : reasons;
    if (actionableReasons.length > 0) {
      out.push({
        kind: "reject_fragment_candidate",
        memory_id: row.id,
        text: row.text,
        reasons: actionableReasons,
      });
    }
  }
  return out;
}

export function qualityReasons(rawText: string): string[] {
  const text = rawText.trim();
  const reasons: string[] = [];
  if (text.length < MIN_RULE_LENGTH) reasons.push("too_short");
  if (text.length > MAX_RULE_LENGTH) reasons.push("too_long");
  if (TRAILING_QUESTION_RE.test(text)) reasons.push("trailing_question");
  if (BARE_MODAL_RE.test(text)) reasons.push("bare_modal");
  if (TRAILING_DOUBLE_DOT_RE.test(text)) reasons.push("trailing_double_dot");
  if (TRAILING_DASH_RE.test(text)) reasons.push("trailing_dash");
  if (DANGLING_CONNECTOR_RE.test(text)) reasons.push("dangling_connector");
  if (RULE_FILLER_PREFIX_RE.test(text)) reasons.push("filler_prefix");
  if (VAGUE_SPEECH_FRAGMENT_RE.test(text)) reasons.push("vague_speech_fragment");
  if (WORKSPACE_ONLY_RULE_RE.test(text)) reasons.push("workspace_only_runtime_rule");
  if (BENCHMARK_ARTIFACT_RULE_RE.test(text)) reasons.push("benchmark_artifact_rule");
  if (TOOL_EMBARGO_TASK_RULE_RE.test(text)) reasons.push("tool_embargo_task_rule");
  if (E2E_VERIFICATION_ARTIFACT_RE.test(text)) reasons.push("e2e_verification_artifact");
  if (EMBEDDED_QUESTION_RE.test(text)) reasons.push("embedded_question");

  // Verb check: strip punctuation and look for any verb hint as a token.
  const words = text.toLowerCase().replace(/[^\w' ]+/g, " ").split(/\s+/).filter(Boolean);
  const hasVerb = words.some((w) => VERB_HINTS.includes(w));
  if (!hasVerb) reasons.push("no_verb");

  return reasons;
}

function applyRejectFragment(db: RecallDb, runId: string, plan: RejectFragmentPlan) {
  const before = getMemory(db, plan.memory_id);
  if (!before || !["active", "candidate"].includes(before.status)) return;

  const now = new Date().toISOString();
  db.update(memories)
    .set({ status: "rejected", dedupe_key: null, updated_at: now })
    .where(eq(memories.id, plan.memory_id))
    .run();

  const after = getMemory(db, plan.memory_id);
  recordAuditWithSnapshot(
    db,
    plan.memory_id,
    "rejected",
    DEFAULT_ACTOR,
    `cleanup_fragment:${plan.reasons.join(",")}:run:${runId}`,
    before,
    after ?? null,
  );

  db.insert(maintenanceCleanupLog).values({
    id: randomUUID(),
    run_id: runId,
    action: "reject_fragment_candidate",
    memory_id: plan.memory_id,
    related_memory_id: null,
    before_snapshot: before as unknown as any,
    after_snapshot: after as unknown as any,
    details: { reasons: plan.reasons } as any,
    reverted: false,
    reverted_at: null,
    created_at: now,
  }).run();
}

// --- rejectTestFixtureRepos ----------------------------------------------

const TEST_FIXTURE_REPO_RE = /^test\/recall-[a-z0-9-]+-repo-[a-z0-9]+$/i;

export function planRejectTestFixtureRepos(db: RecallDb): RejectTestFixtureRepoPlan[] {
  const rows = db.select({
    id: memories.id,
    repo: memories.repo,
    text: memories.text,
    status: memories.status,
  })
    .from(memories)
    .where(inArray(memories.status, ["active", "candidate"]))
    .all();

  return rows
    .filter((row) => row.repo != null && TEST_FIXTURE_REPO_RE.test(row.repo))
    .map((row) => ({
      kind: "reject_test_fixture_repo",
      memory_id: row.id,
      repo: row.repo!,
      text: row.text,
    }));
}

function applyRejectTestFixtureRepo(db: RecallDb, runId: string, plan: RejectTestFixtureRepoPlan) {
  const before = getMemory(db, plan.memory_id);
  if (!before || !["active", "candidate"].includes(before.status)) return;

  const now = new Date().toISOString();
  db.update(memories)
    .set({ status: "rejected", dedupe_key: null, updated_at: now })
    .where(eq(memories.id, plan.memory_id))
    .run();

  const after = getMemory(db, plan.memory_id);
  recordAuditWithSnapshot(
    db,
    plan.memory_id,
    "rejected",
    DEFAULT_ACTOR,
    `cleanup_test_fixture_repo:${plan.repo}:run:${runId}`,
    before,
    after ?? null,
  );

  db.insert(maintenanceCleanupLog).values({
    id: randomUUID(),
    run_id: runId,
    action: "reject_test_fixture_repo",
    memory_id: plan.memory_id,
    related_memory_id: null,
    before_snapshot: before as unknown as any,
    after_snapshot: after as unknown as any,
    details: { repo: plan.repo } as any,
    reverted: false,
    reverted_at: null,
    created_at: now,
  }).run();
}

// --- rejectInvalidScopes --------------------------------------------------

function isTempPath(path: string | null): boolean {
  if (!path) return false;
  return path.startsWith("/tmp/") || path.startsWith("/private/tmp/") || path.includes("/tmp/");
}

function isWorkspaceRootAlias(repo: string | null): boolean {
  return repo === "Projects";
}

export function planRejectInvalidScopes(db: RecallDb): RejectInvalidScopePlan[] {
  const rows = db.select({
    id: memories.id,
    scope: memories.scope,
    repo: memories.repo,
    path_scope: memories.path_scope,
    text: memories.text,
    status: memories.status,
    source: memories.source,
  })
    .from(memories)
    .where(inArray(memories.status, ["active", "candidate"]))
    .all();

  const out: RejectInvalidScopePlan[] = [];
  for (const row of rows) {
    if (row.source !== "user_correction") continue;
    if (qualityReasons(row.text).length > 0) continue;
    const reasons: string[] = [];
    if (row.scope === "path" && !row.path_scope) reasons.push("path_scope_without_path");
    if (row.scope === "path" && isTempPath(row.path_scope)) reasons.push("temp_path_scope");
    if (row.scope === "repo" && isTempPath(row.path_scope)) reasons.push("temp_repo_path_scope");
    if (row.repo && isTempPath(row.repo)) reasons.push("repo_field_is_temp_path");
    if (isWorkspaceRootAlias(row.repo)) reasons.push("workspace_root_repo_alias");
    if (reasons.length === 0) continue;
    out.push({
      kind: "reject_invalid_scope",
      memory_id: row.id,
      scope: row.scope,
      repo: row.repo,
      path_scope: row.path_scope,
      text: row.text,
      reasons,
    });
  }
  return out;
}

function applyRejectInvalidScope(db: RecallDb, runId: string, plan: RejectInvalidScopePlan) {
  const before = getMemory(db, plan.memory_id);
  if (!before || !["active", "candidate"].includes(before.status)) return;

  const now = new Date().toISOString();
  db.update(memories)
    .set({ status: "rejected", dedupe_key: null, updated_at: now })
    .where(eq(memories.id, plan.memory_id))
    .run();

  const after = getMemory(db, plan.memory_id);
  recordAuditWithSnapshot(
    db,
    plan.memory_id,
    "rejected",
    DEFAULT_ACTOR,
    `cleanup_invalid_scope:${plan.reasons.join(",")}:run:${runId}`,
    before,
    after ?? null,
  );

  db.insert(maintenanceCleanupLog).values({
    id: randomUUID(),
    run_id: runId,
    action: "reject_invalid_scope",
    memory_id: plan.memory_id,
    related_memory_id: null,
    before_snapshot: before as unknown as any,
    after_snapshot: after as unknown as any,
    details: {
      scope: plan.scope,
      repo: plan.repo,
      path_scope: plan.path_scope,
      reasons: plan.reasons,
    } as any,
    reverted: false,
    reverted_at: null,
    created_at: now,
  }).run();
}

// --- promoteRepeatCorrections --------------------------------------------

// Promotion gate: candidate user_corrections only auto-promote on repetition
// signal (≥2 distinct sessions producing the same correction). Shape alone
// (e.g. starting with "always") is NOT enough — that produced false-positive
// active rules from voice-transcript fragments. Promote-by-shape is gone.
// Manual `recall confirm` and `maybePromoteGroupCandidate` (followed-feedback
// from sibling memories) remain the other promotion paths.
export function planPromoteRepeats(db: RecallDb): PromoteRepeatPlan[] {
  const rows = db.select({
    id: memories.id,
    text: memories.text,
    repetition_count: memories.repetition_count,
    source: memories.source,
    status: memories.status,
  })
    .from(memories)
    .where(and(eq(memories.status, "candidate"), eq(memories.source, "user_correction")))
    .all();

  const out: PromoteRepeatPlan[] = [];
  for (const row of rows) {
    const text = row.text.trim();
    // Skip rows that the fragment filter would also match — let it reject them
    // first so we don't flip-flop.
    if (qualityReasons(text).length > 0) continue;
    // Phase F: destructive verbs paired with high-risk targets never
    // auto-promote. They require explicit `recall confirm`.
    if (isDestructiveRisky(text)) continue;

    if (row.repetition_count >= 2) {
      out.push({ kind: "promote_repeat_correction", memory_id: row.id, text, matched_pattern: "repetition" });
    }
  }
  return out;
}

function applyPromoteRepeat(db: RecallDb, runId: string, plan: PromoteRepeatPlan) {
  const before = getMemory(db, plan.memory_id);
  if (!before || before.status !== "candidate") return;

  const now = new Date().toISOString();
  db.update(memories)
    .set({ status: "active", confidence: Math.max(before.confidence, 0.7), updated_at: now, last_validated_at: now })
    .where(eq(memories.id, plan.memory_id))
    .run();

  const after = getMemory(db, plan.memory_id);
  recordAuditWithSnapshot(
    db,
    plan.memory_id,
    "promoted",
    DEFAULT_ACTOR,
    `cleanup_promote:${plan.matched_pattern}:run:${runId}`,
    before,
    after ?? null,
  );

  db.insert(maintenanceCleanupLog).values({
    id: randomUUID(),
    run_id: runId,
    action: "promote_repeat_correction",
    memory_id: plan.memory_id,
    related_memory_id: null,
    before_snapshot: before as unknown as any,
    after_snapshot: after as unknown as any,
    details: { matched_pattern: plan.matched_pattern } as any,
    reverted: false,
    reverted_at: null,
    created_at: now,
  }).run();
}

// --- suppressUnproductiveCommands ----------------------------------------

/**
 * Active command-type memories that have been auto-injected at least
 * SUPPRESS_INJECTION_FLOOR times with zero `followed` outcomes are demoted from
 * the SessionStart auto-inject pool. They remain queryable via MCP. The agent
 * will rediscover the same shell hint from package.json / Makefile, so we
 * stop spending tokens to repeat it every session.
 */
export function planSuppressCommands(db: RecallDb): SuppressCommandPlan[] {
  const candidates = db.select({
    id: memories.id,
    text: memories.text,
    injection_count: memories.injection_count,
  })
    .from(memories)
    .where(and(
      eq(memories.status, "active"),
      eq(memories.type, "command"),
      eq(memories.auto_inject, true),
      gte(memories.injection_count, SUPPRESS_INJECTION_FLOOR),
    ))
    .all();

  const out: SuppressCommandPlan[] = [];
  for (const row of candidates) {
    const followedRow = db.select({ n: sql<number>`count(*)` })
      .from(feedbackEvents)
      .where(and(
        eq(feedbackEvents.memory_id, row.id),
        eq(feedbackEvents.outcome, "followed"),
      ))
      .get();
    const followed = followedRow?.n ?? 0;
    if (followed > 0) continue;
    out.push({
      kind: "suppress_unproductive_command",
      memory_id: row.id,
      text: row.text,
      injection_count: row.injection_count,
      followed_count: followed,
    });
  }
  return out;
}

function applySuppressCommand(db: RecallDb, runId: string, plan: SuppressCommandPlan) {
  const before = getMemory(db, plan.memory_id);
  if (!before || !before.auto_inject) return;

  const now = new Date().toISOString();
  db.update(memories)
    .set({ auto_inject: false, updated_at: now })
    .where(eq(memories.id, plan.memory_id))
    .run();

  const after = getMemory(db, plan.memory_id);
  recordAuditWithSnapshot(
    db,
    plan.memory_id,
    "demoted",
    DEFAULT_ACTOR,
    `cleanup_suppress_command:inj=${plan.injection_count},followed=0:run:${runId}`,
    before,
    after ?? null,
  );

  db.insert(maintenanceCleanupLog).values({
    id: randomUUID(),
    run_id: runId,
    action: "suppress_unproductive_command",
    memory_id: plan.memory_id,
    related_memory_id: null,
    before_snapshot: before as unknown as any,
    after_snapshot: after as unknown as any,
    details: {
      injection_count: plan.injection_count,
      followed_count: plan.followed_count,
    } as any,
    reverted: false,
    reverted_at: null,
    created_at: now,
  }).run();
}

// --- globalizeCrossRepo --------------------------------------------------

/**
 * When the same normalized text exists as an active rule/command across
 * GLOBALIZE_REPO_FLOOR or more distinct repos, promote one row to
 * scope='global' (repo=null) and reject the rest. Reduces duplicate
 * injections of pan-repo guidance like "Use uv for Python".
 */
export function planGlobalizeCrossRepo(db: RecallDb): GlobalizeCrossRepoPlan[] {
  const rows = db.select({
    id: memories.id,
    type: memories.type,
    text: memories.text,
    scope: memories.scope,
    repo: memories.repo,
    injection_count: memories.injection_count,
    confidence: memories.confidence,
    created_at: memories.created_at,
  })
    .from(memories)
    .where(and(eq(memories.status, "active"), inArray(memories.type, ["command", "rule"])))
    .all();

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.scope === "global") continue;
    if (!row.repo) continue;
    const norm = normalizeText(row.text);
    if (!norm) continue;
    const key = `${row.type}::${norm}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  // Pre-load all active rule/command memories once for the cross-repo
  // contradiction check below.
  const allActive = queryMemories(db, { status: "active" })
    .filter((m) => m.type === "rule" || m.type === "command");

  const plans: GlobalizeCrossRepoPlan[] = [];
  for (const list of groups.values()) {
    const repos = new Set(list.map((r) => r.repo!));
    if (repos.size < GLOBALIZE_REPO_FLOOR) continue;

    const sorted = [...list].sort((a, b) => {
      if (a.injection_count !== b.injection_count) return b.injection_count - a.injection_count;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      return a.created_at.localeCompare(b.created_at);
    });
    const winner = sorted[0];

    // Don't globalize when another repo holds an active memory that would
    // contradict this winner. A cluster of "Use pnpm" rows shouldn't promote
    // to global if a sibling repo has "Use bun" — it just creates conflict
    // every session in that repo.
    const winnerMemory = getMemory(db, winner.id);
    if (!winnerMemory) continue;
    const clusterIds = new Set(list.map((r) => r.id));
    const conflict = allActive.find((other) => {
      if (clusterIds.has(other.id)) return false;
      if (!other.repo || repos.has(other.repo)) return false;
      // Pretend the candidate is already global so scopesOverlap will say yes.
      const winnerAsGlobal: typeof winnerMemory = { ...winnerMemory, scope: "global" };
      return checkContradiction(winnerAsGlobal, other) != null;
    });
    if (conflict) continue;

    const losers = sorted.slice(1);
    const total = list.reduce((acc, r) => acc + r.injection_count, 0);

    plans.push({
      kind: "globalize_cross_repo",
      winner_id: winner.id,
      winner_text: winner.text,
      loser_ids: losers.map((l) => l.id),
      repos: [...repos],
      total_injection_count: total,
    });
  }
  return plans;
}

function applyGlobalizeCrossRepo(db: RecallDb, runId: string, plan: GlobalizeCrossRepoPlan) {
  const winner = getMemory(db, plan.winner_id);
  if (!winner) return;

  const now = new Date().toISOString();

  // Promote winner to scope='global', repo=null. Re-point feedback rows from
  // losers since they all represent the same advice.
  const globalDedupeKey = memoryDedupeKey({ ...winner, scope: "global", repo: null });
  const globalDedupeCollision = db.select({ id: memories.id })
    .from(memories)
    .where(eq(memories.dedupe_key, globalDedupeKey))
    .get();
  db.update(memories)
    .set({
      scope: "global" as any,
      repo: null,
      dedupe_key: globalDedupeCollision && globalDedupeCollision.id !== winner.id
        ? null
        : globalDedupeKey,
      updated_at: now,
    })
    .where(eq(memories.id, winner.id))
    .run();

  const after = getMemory(db, winner.id);
  recordAuditWithSnapshot(
    db,
    winner.id,
    "edited",
    DEFAULT_ACTOR,
    `cleanup_globalize:winner:run:${runId}`,
    winner,
    after ?? null,
  );

  db.insert(maintenanceCleanupLog).values({
    id: randomUUID(),
    run_id: runId,
    action: "globalize_cross_repo",
    memory_id: winner.id,
    related_memory_id: null,
    before_snapshot: winner as unknown as any,
    after_snapshot: after as unknown as any,
    details: { role: "winner", repos: plan.repos } as any,
    reverted: false,
    reverted_at: null,
    created_at: now,
  }).run();

  for (const loserId of plan.loser_ids) {
    const loser = getMemory(db, loserId);
    if (!loser || loser.status === "rejected") continue;

    db.update(memories)
      .set({ status: "rejected", supersedes: winner.id, dedupe_key: null, updated_at: now })
      .where(eq(memories.id, loserId))
      .run();

    const afterLoser = getMemory(db, loserId);
    recordAuditWithSnapshot(
      db,
      loserId,
      "rejected",
      DEFAULT_ACTOR,
      `cleanup_globalize:loser:winner=${winner.id}:run:${runId}`,
      loser,
      afterLoser ?? null,
    );

    db.insert(maintenanceCleanupLog).values({
      id: randomUUID(),
      run_id: runId,
      action: "globalize_cross_repo",
      memory_id: loserId,
      related_memory_id: winner.id,
      before_snapshot: loser as unknown as any,
      after_snapshot: afterLoser as unknown as any,
      details: { role: "loser", repo: loser.repo } as any,
      reverted: false,
      reverted_at: null,
      created_at: now,
    }).run();
  }
}

// --- Revert -------------------------------------------------------------

export interface RevertReport {
  run_id: string;
  reverted: number;
  skipped: number;
  reasons: Record<string, number>;
}

interface MemorySnapshot {
  id?: string;
  status?: string;
  text?: string;
  scope?: string;
  path_scope?: string | null;
  repo?: string | null;
  confidence?: number;
  injection_count?: number;
  override_count?: number;
  repetition_count?: number;
  supersedes?: string | null;
  auto_inject?: boolean;
}

/**
 * Revert a cleanup run by restoring `before_snapshot` for every log row in the
 * run that hasn't already been reverted. Memory injections / feedback events
 * re-pointed during dedupe stay where they are — they're cheap to re-collect
 * and reverting them risks unique-key collisions with subsequent traffic.
 */
export function revertCleanupRun(db: RecallDb, runId: string): RevertReport {
  const rows = db.select().from(maintenanceCleanupLog)
    .where(eq(maintenanceCleanupLog.run_id, runId))
    .all();

  if (rows.length === 0) {
    return { run_id: runId, reverted: 0, skipped: 0, reasons: { not_found: 1 } };
  }

  const reasons: Record<string, number> = {};
  let reverted = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    if (row.reverted) {
      skipped += 1;
      reasons.already_reverted = (reasons.already_reverted ?? 0) + 1;
      continue;
    }

    const before = row.before_snapshot as unknown as MemorySnapshot | null;
    if (!before || !before.status) {
      skipped += 1;
      reasons.no_snapshot = (reasons.no_snapshot ?? 0) + 1;
      continue;
    }

    const current = getMemory(db, row.memory_id);
    if (!current) {
      skipped += 1;
      reasons.memory_missing = (reasons.memory_missing ?? 0) + 1;
      continue;
    }

    db.update(memories)
      .set({
        status: before.status as any,
        text: before.text ?? current.text,
        scope: (before.scope as any) ?? current.scope,
        path_scope: before.path_scope ?? current.path_scope,
        repo: before.repo !== undefined ? before.repo : current.repo,
        confidence: before.confidence ?? current.confidence,
        injection_count: before.injection_count ?? current.injection_count,
        override_count: before.override_count ?? current.override_count,
        repetition_count: before.repetition_count ?? current.repetition_count,
        supersedes: before.supersedes ?? null,
        auto_inject: before.auto_inject ?? current.auto_inject,
        updated_at: now,
      })
      .where(eq(memories.id, row.memory_id))
      .run();

    const after = getMemory(db, row.memory_id);
    recordAuditWithSnapshot(
      db,
      row.memory_id,
      "rolled_back",
      DEFAULT_ACTOR,
      `cleanup_revert:run:${runId}:log:${row.id}`,
      current,
      after ?? null,
    );

    db.update(maintenanceCleanupLog)
      .set({ reverted: true, reverted_at: now })
      .where(eq(maintenanceCleanupLog.id, row.id))
      .run();

    reverted += 1;
  }

  return { run_id: runId, reverted, skipped, reasons };
}

export interface CleanupRunSummary {
  run_id: string;
  started_at: string;
  finished_at: string;
  total: number;
  by_action: Record<string, number>;
  reverted: number;
}

export function listCleanupRuns(db: RecallDb, limit = 10): CleanupRunSummary[] {
  const rows = db.select().from(maintenanceCleanupLog).all();
  const byRun = new Map<string, CleanupRunSummary>();
  for (const row of rows) {
    let entry = byRun.get(row.run_id);
    if (!entry) {
      entry = {
        run_id: row.run_id,
        started_at: row.created_at,
        finished_at: row.created_at,
        total: 0,
        by_action: {},
        reverted: 0,
      };
      byRun.set(row.run_id, entry);
    }
    entry.total += 1;
    entry.by_action[row.action] = (entry.by_action[row.action] ?? 0) + 1;
    if (row.reverted) entry.reverted += 1;
    if (row.created_at < entry.started_at) entry.started_at = row.created_at;
    if (row.created_at > entry.finished_at) entry.finished_at = row.created_at;
  }
  return [...byRun.values()]
    .sort((a, b) => b.finished_at.localeCompare(a.finished_at))
    .slice(0, limit);
}

export function formatCleanupReport(report: CleanupReport): string {
  const lines: string[] = [];
  lines.push(`Cleanup ${report.dry_run ? "DRY-RUN" : "APPLY"} run=${report.run_id.slice(0, 8)}`);
  lines.push(`  dedupe_clusters:      ${report.counts.dedupe_clusters}`);
  lines.push(`  dedupe_losers:        ${report.counts.dedupe_losers}`);
  lines.push(`  fragment_rejections:  ${report.counts.fragment_rejections}`);
  lines.push(`  repeat_promotions:    ${report.counts.repeat_promotions}`);
  lines.push(`  command_suppressions: ${report.counts.command_suppressions}`);
  lines.push(`  globalizations:       ${report.counts.globalizations} (losers=${report.counts.globalize_losers})`);
  lines.push(`  test_fixture_rejects: ${report.counts.test_fixture_rejections}`);
  lines.push(`  invalid_scope_rejects:${report.counts.invalid_scope_rejections}`);
  lines.push(`  e2e_artifact_rejects: ${report.counts.e2e_artifact_rejections}`);
  if (report.plan.length === 0) {
    lines.push("  (no actions)");
    return lines.join("\n");
  }
  lines.push("");
  for (const item of report.plan) {
    if (item.kind === "dedupe_exact_merge") {
      lines.push(`  merge: keep ${item.winner_id.slice(0, 8)}  drop ${item.loser_ids.length}  inj=${item.total_injection_count}`);
      lines.push(`         "${truncate(item.winner_text, 80)}"`);
    } else if (item.kind === "reject_fragment_candidate") {
      lines.push(`  reject: ${item.memory_id.slice(0, 8)}  reasons=${item.reasons.join(",")}`);
      lines.push(`          "${truncate(item.text, 80)}"`);
    } else if (item.kind === "promote_repeat_correction") {
      lines.push(`  promote: ${item.memory_id.slice(0, 8)}  via=${item.matched_pattern}`);
      lines.push(`           "${truncate(item.text, 80)}"`);
    } else if (item.kind === "suppress_unproductive_command") {
      lines.push(`  suppress: ${item.memory_id.slice(0, 8)}  inj=${item.injection_count}  followed=${item.followed_count}`);
      lines.push(`            "${truncate(item.text, 80)}"`);
    } else if (item.kind === "globalize_cross_repo") {
      lines.push(`  globalize: keep ${item.winner_id.slice(0, 8)}  drop ${item.loser_ids.length}  repos=[${item.repos.join(",")}]`);
      lines.push(`             "${truncate(item.winner_text, 80)}"`);
    } else if (item.kind === "reject_test_fixture_repo") {
      lines.push(`  reject-test-repo: ${item.memory_id.slice(0, 8)}  repo=${item.repo}`);
      lines.push(`                    "${truncate(item.text, 80)}"`);
    } else {
      lines.push(`  reject-invalid-scope: ${item.memory_id.slice(0, 8)}  scope=${item.scope} repo=${item.repo ?? "-"} path=${item.path_scope ?? "-"} reasons=${item.reasons.join(",")}`);
      lines.push(`                        "${truncate(item.text, 80)}"`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
