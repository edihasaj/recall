import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemory, listRepos } from "../src/models/memory.js";
import {
  listCleanupRuns,
  planDedupeExact,
  planPromoteRepeats,
  planRejectGenericScannedTooling,
  planRejectFragments,
  planRejectInvalidScopes,
  revertCleanupRun,
  runDeterministicCleanup,
} from "../src/maintenance/cleanup.js";
import { feedbackEvents, maintenanceCleanupLog, memories, memoryInjections } from "../src/db/schema.js";
import { randomUUID } from "node:crypto";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-cleanup-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("maintenance cleanup — dedupeExact", () => {
  it("merges memories with identical normalized text within scope", () => {
    const db = freshDb();
    const a = createMemory(db, {
      type: "command",
      text: "test: vitest run",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "config_parse",
      confidence: 0.9,
      dedupe: false,
    });
    const b = createMemory(db, {
      type: "command",
      text: "test:  vitest run.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "config_parse",
      confidence: 0.5,
      dedupe: false,
    });

    const plan = planDedupeExact(db);
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe("dedupe_exact_merge");

    const report = runDeterministicCleanup(db, { dryRun: false, only: "dedupe_exact_merge" });
    expect(report.counts.dedupe_clusters).toBe(1);
    expect(report.counts.dedupe_losers).toBe(1);

    const survivors = [getMemory(db, a), getMemory(db, b)];
    const active = survivors.filter((m) => m?.status === "active");
    const rejected = survivors.filter((m) => m?.status === "rejected");
    expect(active).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.supersedes).toBe(active[0]?.id);
  });

  it("does not merge across different repos", () => {
    const db = freshDb();
    createMemory(db, {
      type: "command",
      text: "Use pnpm",
      scope: "repo",
      repo: "repo-a",
      source: "config_parse",
      confidence: 0.9,
    });
    createMemory(db, {
      type: "command",
      text: "Use pnpm",
      scope: "repo",
      repo: "repo-b",
      source: "config_parse",
      confidence: 0.9,
    });
    expect(planDedupeExact(db)).toHaveLength(0);
  });

  it("rolls injection counters into the winner and re-points feedback rows", () => {
    const db = freshDb();
    const winnerId = createMemory(db, {
      type: "rule", text: "Use pnpm", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.9, dedupe: false,
    });
    const loserId = createMemory(db, {
      type: "rule", text: "Use pnpm.", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.5, dedupe: false,
    });

    db.update(memories).set({ injection_count: 10 }).where(eq(memories.id, winnerId)).run();
    db.update(memories).set({ injection_count: 7 }).where(eq(memories.id, loserId)).run();

    db.insert(feedbackEvents).values({
      id: randomUUID(),
      memory_id: loserId,
      session_id: "sess-1",
      injected: true,
      outcome: "followed",
      timestamp: new Date().toISOString(),
    }).run();

    runDeterministicCleanup(db, { dryRun: false, only: "dedupe_exact_merge" });

    const winner = getMemory(db, winnerId);
    expect(winner?.injection_count).toBe(17);
    const fb = db.select().from(feedbackEvents).where(eq(feedbackEvents.memory_id, winnerId)).all();
    expect(fb).toHaveLength(1);
  });
});

describe("maintenance cleanup — rejectFragmentCandidates", () => {
  it("rejects too-short, trailing-question, bare-modal, and verbless candidates", () => {
    const db = freshDb();
    const cases: Array<[string, string[]]> = [
      ["never downtime?", ["trailing_question"]],
      ["must stay", ["too_short", "bare_modal"]],
      ["required scope per endpoint. Drive and the new", ["no_verb"]],
      ["required I guess", ["no_verb"]],
    ];
    for (const [text] of cases) {
      createMemory(db, {
        type: "rule", text, scope: "repo", repo: "r",
        source: "user_correction", confidence: 0.5,
      });
    }
    const plan = planRejectFragments(db);
    expect(plan).toHaveLength(cases.length);
    for (const item of plan) {
      const expected = cases.find(([t]) => t === item.text)![1];
      expect(item.reasons).toEqual(expect.arrayContaining(expected));
    }
  });

  it("does not reject well-formed corrections", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "Always use .agent/config.json as the local main config file; do not use repo-root agent.json",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.5,
    });
    expect(planRejectFragments(db)).toHaveLength(0);
  });

  it("only acts on candidate user_correction memories", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule", text: "must stay", scope: "repo", repo: "r",
      source: "config_parse", confidence: 0.9,
    });
    expect(planRejectFragments(db)).toHaveLength(0);
  });

  it("rejects active vague speech fragments observed in production", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Do not use or whatever but rules. Use this or do that then do this and stuff like that to show more power to it! instead.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.95,
    });

    const plan = planRejectFragments(db);
    expect(plan).toHaveLength(1);
    expect(plan[0].memory_id).toBe(id);
    expect(plan[0].reasons).toContain("vague_speech_fragment");

    runDeterministicCleanup(db, { dryRun: false, only: "reject_fragment_candidate" });
    expect(getMemory(db, id)?.status).toBe("rejected");
  });

  it("does not reject active memories for weak no_verb-only reasons", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "Present the assistant as an eUnifier assistant and do not claim to be an external service.",
      scope: "repo",
      repo: "eunify",
      source: "user_correction",
      confidence: 0.95,
    });

    expect(planRejectFragments(db)).toHaveLength(0);
  });

  it("rejects workspace-only runtime guard spam", () => {
    const db = freshDb();
    for (const text of [
      "Keep all edits inside the current workspace.",
      "Keep all edits inside the workspace at /tmp/oktapod-openclaw-live-qa/task/work.",
      "Keep all edits inside the specified workspace.",
    ]) {
      createMemory(db, {
        type: "rule",
        text,
        scope: "global",
        repo: null,
        source: "user_correction",
        confidence: 0.5,
      });
    }

    const plan = planRejectFragments(db);
    expect(plan).toHaveLength(3);
    expect(plan.every((item) => item.reasons.includes("workspace_only_runtime_rule"))).toBe(true);
  });

  it("rejects old benchmark artifact instructions captured as memory", () => {
    const db = freshDb();
    for (const text of [
      "Build every required file, run the analyzer, verify that data/agent-scorecard.json exists, and then stop.",
      "Use the coding runtime for benchmark tasks.",
      "Keep source labels Oktapod and OpenClaw intact in generated outputs.",
      "Do not compare GitHub repositories and do not add Hermes.",
    ]) {
      createMemory(db, {
        type: "rule",
        text,
        scope: "global",
        repo: null,
        source: "user_correction",
        confidence: 0.5,
      });
    }

    const plan = planRejectFragments(db);
    expect(plan).toHaveLength(4);
    expect(plan.every((item) => item.reasons.includes("benchmark_artifact_rule"))).toBe(true);
  });

  it("rejects task-local browser/devtools embargoes", () => {
    const db = freshDb();
    for (const text of [
      "Do not open browser, screenshot, or devtools tools.",
      "Do not open browser, screenshot, or devtools tools during the task.",
      "Do not open browser, take screenshots, or use devtools tools during the task.",
    ]) {
      createMemory(db, {
        type: "rule",
        text,
        scope: "global",
        repo: null,
        source: "user_correction",
        confidence: 0.5,
      });
    }

    const plan = planRejectFragments(db);
    expect(plan).toHaveLength(3);
    expect(plan.every((item) => item.reasons.includes("tool_embargo_task_rule"))).toBe(true);
  });

  it("rejects explicit Recall e2e smoke-test artifacts without rejecting real verification rules", () => {
    const db = freshDb();
    const artifact = createMemory(db, {
      type: "rule",
      text: "Always use pnpm for Recall e2e verification.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.5,
    });
    createMemory(db, {
      type: "rule",
      text: "Always run end-to-end verification before release.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.5,
    });

    const report = runDeterministicCleanup(db, { dryRun: false, only: "reject_fragment_candidate" });
    expect(report.counts.fragment_rejections).toBe(1);
    expect(report.counts.e2e_artifact_rejections).toBe(1);
    expect(getMemory(db, artifact)?.status).toBe("rejected");
  });
});

describe("maintenance cleanup — promoteRepeatCorrections", () => {
  it("does not auto-promote rule-shaped candidates without repetition", () => {
    // Phase B promotion gate: shape alone is not a signal. Voice-transcript
    // fragments like "always just now remove if we can't fix" used to slip
    // through this path; they no longer can.
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Always use .agent/config.json as the local main config file",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.5,
    });
    expect(planPromoteRepeats(db)).toHaveLength(0);

    runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect(getMemory(db, id)?.status).toBe("candidate");
  });

  it("does not auto-promote destructive-risky candidates even with repetition", () => {
    // Phase F gate: 'always remove plugins from settings' has the textbook
    // verb+target pair that an agent could mis-execute. Even with
    // repetition_count above threshold, it stays candidate.
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "always remove plugins from settings",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.5,
    });
    db.update(memories).set({ repetition_count: 5 }).where(eq(memories.id, id)).run();

    expect(planPromoteRepeats(db)).toHaveLength(0);
    runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect(getMemory(db, id)?.status).toBe("candidate");
  });

  it("promotes when repetition_count crosses threshold (≥2 distinct sessions)", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Always use .agent/config.json as the local main config file",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.5,
    });
    db.update(memories).set({ repetition_count: 2 }).where(eq(memories.id, id)).run();

    const plan = planPromoteRepeats(db);
    expect(plan).toHaveLength(1);
    expect(plan[0].matched_pattern).toBe("repetition");

    runDeterministicCleanup(db, { dryRun: false, only: "promote_repeat_correction" });
    expect(getMemory(db, id)?.status).toBe("active");
  });

  it("skips short rule-shape candidates that the fragment filter would catch", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule", text: "always at pending", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.5,
    });
    expect(planPromoteRepeats(db)).toHaveLength(0);
  });
});

describe("maintenance cleanup — dry-run vs apply", () => {
  it("dry-run reports the plan without mutating", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule", text: "must stay", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.5,
    });

    const dry = runDeterministicCleanup(db, { dryRun: true });
    expect(dry.counts.fragment_rejections).toBe(1);

    const log = db.select().from(maintenanceCleanupLog).all();
    expect(log).toHaveLength(0);

    runDeterministicCleanup(db, { dryRun: false });
    const log2 = db.select().from(maintenanceCleanupLog).all();
    expect(log2).toHaveLength(1);
  });
});

describe("maintenance cleanup — revert", () => {
  it("restores memory state from before-snapshot", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Always use .agent/config.json as the local main config file",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.5,
    });
    db.update(memories).set({ repetition_count: 2 }).where(eq(memories.id, id)).run();

    const report = runDeterministicCleanup(db, { dryRun: false });
    expect(getMemory(db, id)?.status).toBe("active");

    const reverted = revertCleanupRun(db, report.run_id);
    expect(reverted.reverted).toBeGreaterThan(0);
    expect(getMemory(db, id)?.status).toBe("candidate");
  });

  it("is idempotent — second revert does nothing", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule", text: "must stay", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.5,
    });
    const report = runDeterministicCleanup(db, { dryRun: false });
    revertCleanupRun(db, report.run_id);
    const second = revertCleanupRun(db, report.run_id);
    expect(second.reverted).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it("listCleanupRuns reports recent runs newest-first", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule", text: "must stay", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.5,
    });
    runDeterministicCleanup(db, { dryRun: false });
    const runs = listCleanupRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].total).toBeGreaterThan(0);
  });
});

describe("capture-time fragment filter", () => {
  it("does not create candidate memories for low-quality user corrections", async () => {
    const { processCorrection } = await import("../src/capture/correction.js");
    const db = freshDb();

    // Both phrases match detectCorrections (start with always/never) but fail
    // the quality filter — should not enter the candidate queue.
    const { ids: idsA } = await processCorrection(db, "must stay", { sessionId: "s1", repo: "r" });
    const { ids: idsB } = await processCorrection(db, "never downtime?", { sessionId: "s2", repo: "r" });
    expect(idsA).toEqual([]);
    expect(idsB).toEqual([]);

    const all = db.select().from(memories).all();
    expect(all).toHaveLength(0);
  });

  it("still captures well-formed corrections", async () => {
    const { processCorrection } = await import("../src/capture/correction.js");
    const db = freshDb();
    const { ids } = await processCorrection(db, "always use pnpm not npm", {
      sessionId: "s1",
      repo: "r",
    });
    expect(ids.length).toBeGreaterThan(0);
  });

  it("rejects voice-transcript fragments seen in the wild", async () => {
    const { qualityReasons } = await import("../src/maintenance/cleanup.js");
    expect(qualityReasons("never use from settings..")).toContain("trailing_double_dot");
    expect(qualityReasons("always style the")).toContain("dangling_connector");
    expect(qualityReasons("must add to the")).toContain("dangling_connector");
    // Filler-prefix: "always just now …", "never uh …" — speech artifacts.
    expect(qualityReasons("always just now remove if we can't fix")).toContain("filler_prefix");
    expect(qualityReasons("never uh skip the linter")).toContain("filler_prefix");
    // Length cap: voice-transcript rambles past 300 chars.
    const ramble = "always " + "blah ".repeat(80);
    expect(qualityReasons(ramble)).toContain("too_long");
  });

  // Regression: fragments we observed slipping into production memories.
  // The old VERB_HINTS contained the modals themselves, so any rule-shaped
  // fragment that started with always/never/must passed the verb check
  // trivially; the too_short threshold was also too lenient (14).
  it("rejects modal-only and bare-passive fragments observed in production", async () => {
    const { qualityReasons } = await import("../src/maintenance/cleanup.js");
    // "always can you find" — embedded question + no real verb + too short
    expect(qualityReasons("always can you find")).toEqual(
      expect.arrayContaining(["too_short", "embedded_question", "no_verb"]),
    );
    // "always be used." — bare passive, too short to be a real rule
    expect(qualityReasons("always be used.")).toContain("too_short");
    // "never picked up within 60 minutes" — no action verb, just narration
    expect(qualityReasons("never picked up within 60 minutes")).toContain("no_verb");
    // "never sends a banner —" — trailing dash + no_verb
    expect(qualityReasons("never sends a banner —")).toEqual(
      expect.arrayContaining(["trailing_dash", "no_verb"]),
    );
    // "must work end to end doesn't bring files here" — no recognized verb
    expect(qualityReasons("must work end to end doesn't bring files here")).toContain("no_verb");
    // "must be checked not like this" — no real action verb, too short
    expect(qualityReasons("must be checked not like this")).toEqual(
      expect.arrayContaining(["no_verb"]),
    );
  });

  it("keeps well-formed rules with action verbs intact", async () => {
    const { qualityReasons } = await import("../src/maintenance/cleanup.js");
    expect(qualityReasons("Always use pnpm not npm in this repo")).toHaveLength(0);
    expect(qualityReasons("Never commit secrets to the repo")).toHaveLength(0);
    expect(qualityReasons("Run tests for this PR before merging")).toHaveLength(0);
    expect(qualityReasons("Do not set securityContext.privileged=true")).toHaveLength(0);
    expect(qualityReasons(
      "Treat production and application hosts as dedicated to their own apps only; if a proxy or clean-egress path is needed, propose dedicated infrastructure and get approval first.",
    )).toHaveLength(0);
  });
});

describe("maintenance cleanup — suppressUnproductiveCommands", () => {
  it("suppresses high-injection command memories with zero followed feedback", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "command", text: "Use the project deploy helper", scope: "repo", repo: "r",
      source: "config_parse", confidence: 0.9,
    });
    db.update(memories).set({ injection_count: 60 }).where(eq(memories.id, id)).run();

    const report = runDeterministicCleanup(db, { dryRun: false });
    expect(report.counts.command_suppressions).toBe(1);
    const after = getMemory(db, id);
    expect(after?.auto_inject).toBe(false);
    expect(after?.status).toBe("active");
  });

  it("does not suppress when at least one followed event exists", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "command", text: "Use the project deploy helper", scope: "repo", repo: "r",
      source: "config_parse", confidence: 0.9,
    });
    db.update(memories).set({ injection_count: 60 }).where(eq(memories.id, id)).run();
    db.insert(feedbackEvents).values({
      id: randomUUID(), memory_id: id, session_id: "s",
      injected: true, outcome: "followed", timestamp: new Date().toISOString(),
    }).run();

    const report = runDeterministicCleanup(db, { dryRun: false });
    expect(report.counts.command_suppressions).toBe(0);
    expect(getMemory(db, id)?.auto_inject).toBe(true);
  });

  it("does not suppress below the injection floor", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "command", text: "Use the project deploy helper", scope: "repo", repo: "r",
      source: "config_parse", confidence: 0.9,
    });
    db.update(memories).set({ injection_count: 10 }).where(eq(memories.id, id)).run();
    expect(runDeterministicCleanup(db, { dryRun: true }).counts.command_suppressions).toBe(0);
  });

  it("revert restores auto_inject=true", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "command", text: "Use the project deploy helper", scope: "repo", repo: "r",
      source: "config_parse", confidence: 0.9,
    });
    db.update(memories).set({ injection_count: 60 }).where(eq(memories.id, id)).run();
    const report = runDeterministicCleanup(db, { dryRun: false });
    expect(getMemory(db, id)?.auto_inject).toBe(false);
    revertCleanupRun(db, report.run_id);
    expect(getMemory(db, id)?.auto_inject).toBe(true);
  });
});

describe("maintenance cleanup — rejectGenericScannedTooling", () => {
  it("rejects generic package scripts and linting facts from config scans", () => {
    const db = freshDb();
    const build = createMemory(db, {
      type: "command",
      text: "build: `npm run build`",
      scope: "repo",
      repo: "r",
      source: "config_parse",
      confidence: 0.9,
    });
    const typecheck = createMemory(db, {
      type: "command",
      text: "typecheck: `tsc --noEmit`",
      scope: "repo",
      repo: "r",
      source: "config_parse",
      confidence: 0.9,
    });
    const linting = createMemory(db, {
      type: "rule",
      text: "Linting/formatting: ESLint (flat config)",
      scope: "repo",
      repo: "r",
      source: "config_parse",
      confidence: 0.59,
    });
    const packageManager = createMemory(db, {
      type: "command",
      text: "Use pnpm as the package manager",
      scope: "repo",
      repo: "r",
      source: "config_parse",
      confidence: 0.9,
    });

    const plan = planRejectGenericScannedTooling(db);
    expect(plan.map((item) => item.memory_id).sort()).toEqual([build, linting, typecheck].sort());

    const report = runDeterministicCleanup(db, { dryRun: false, only: "reject_generic_scanned_tooling" });
    expect(report.counts.generic_scanned_tooling_rejections).toBe(3);
    expect(getMemory(db, build)?.status).toBe("rejected");
    expect(getMemory(db, typecheck)?.status).toBe("rejected");
    expect(getMemory(db, linting)?.status).toBe("rejected");
    expect(getMemory(db, packageManager)?.status).toBe("active");
  });
});

describe("maintenance cleanup — globalizeCrossRepo", () => {
  it("promotes a winner to scope=global when same text appears in 3+ repos", () => {
    const db = freshDb();
    const ids: string[] = [];
    for (const repo of ["r1", "r2", "r3"]) {
      ids.push(createMemory(db, {
        type: "command",
        text: "Use uv for Python dependency management",
        scope: "repo",
        repo,
        source: "config_parse",
        confidence: 0.9,
      }));
    }
    db.update(memories).set({ injection_count: 50 }).where(eq(memories.id, ids[0])).run();
    db.update(memories).set({ injection_count: 10 }).where(eq(memories.id, ids[1])).run();
    db.update(memories).set({ injection_count: 5 }).where(eq(memories.id, ids[2])).run();

    const report = runDeterministicCleanup(db, { dryRun: false, only: "globalize_cross_repo" });
    expect(report.counts.globalizations).toBe(1);
    expect(report.counts.globalize_losers).toBe(2);

    const winner = getMemory(db, ids[0]);
    expect(winner?.scope).toBe("global");
    expect(winner?.repo).toBeNull();
    expect(getMemory(db, ids[1])?.status).toBe("rejected");
    expect(getMemory(db, ids[2])?.status).toBe("rejected");
  });

  it("does not globalize when another repo holds a contradicting active memory", () => {
    const db = freshDb();
    for (const repo of ["r1", "r2", "r3"]) {
      createMemory(db, {
        type: "rule",
        text: "Use pnpm as the package manager",
        scope: "repo",
        repo,
        source: "user_correction",
        confidence: 0.9,
      });
    }
    // r4 has an active rule that would clash if we globalize "Use pnpm…".
    createMemory(db, {
      type: "rule",
      text: "Use bun as the package manager",
      scope: "repo",
      repo: "r4",
      source: "user_correction",
      confidence: 0.9,
    });
    const report = runDeterministicCleanup(db, { dryRun: true, only: "globalize_cross_repo" });
    expect(report.counts.globalizations).toBe(0);
  });

  it("does not globalize when only 2 repos have the text", () => {
    const db = freshDb();
    for (const repo of ["r1", "r2"]) {
      createMemory(db, {
        type: "command", text: "Use bun", scope: "repo", repo,
        source: "config_parse", confidence: 0.9,
      });
    }
    expect(runDeterministicCleanup(db, { dryRun: true, only: "globalize_cross_repo" }).counts.globalizations).toBe(0);
  });

  it("revert restores winner.scope=repo and loser.status", () => {
    const db = freshDb();
    const ids: string[] = [];
    for (const repo of ["r1", "r2", "r3"]) {
      ids.push(createMemory(db, {
        type: "rule",
        text: "Always use pnpm not npm",
        scope: "repo",
        repo,
        source: "user_correction",
        confidence: 0.9,
      }));
    }
    const report = runDeterministicCleanup(db, { dryRun: false, only: "globalize_cross_repo" });
    revertCleanupRun(db, report.run_id);
    for (const id of ids) {
      const m = getMemory(db, id);
      expect(m?.scope).toBe("repo");
      expect(m?.status).toBe("active");
    }
  });
});

describe("maintenance cleanup — memory_injections re-pointing", () => {
  it("merges injections without violating the (memory_id, session_id) unique constraint", () => {
    const db = freshDb();
    const winnerId = createMemory(db, {
      type: "rule", text: "Use pnpm", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.9, dedupe: false,
    });
    const loserId = createMemory(db, {
      type: "rule", text: "use pnpm.", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.5, dedupe: false,
    });

    // Both rows have an injection for sess-A; only loser has one for sess-B.
    db.insert(memoryInjections).values({
      id: randomUUID(), memory_id: winnerId, session_id: "sess-A", repo: "r",
      injected_at: new Date().toISOString(), outcome: null, outcome_at: null,
    }).run();
    db.insert(memoryInjections).values({
      id: randomUUID(), memory_id: loserId, session_id: "sess-A", repo: "r",
      injected_at: new Date().toISOString(), outcome: null, outcome_at: null,
    }).run();
    db.insert(memoryInjections).values({
      id: randomUUID(), memory_id: loserId, session_id: "sess-B", repo: "r",
      injected_at: new Date().toISOString(), outcome: null, outcome_at: null,
    }).run();

    runDeterministicCleanup(db, { dryRun: false, only: "dedupe_exact_merge" });

    const winnerInj = db.select().from(memoryInjections)
      .where(eq(memoryInjections.memory_id, winnerId)).all();
    expect(winnerInj.map((r) => r.session_id).sort()).toEqual(["sess-A", "sess-B"]);

    const loserInj = db.select().from(memoryInjections)
      .where(eq(memoryInjections.memory_id, loserId)).all();
    expect(loserInj).toHaveLength(0);
  });
});

describe("maintenance cleanup — test fixture repo hygiene", () => {
  it("rejects accidental test fixture repos from the production memory set", () => {
    const db = freshDb();
    const fixture = createMemory(db, {
      type: "rule",
      text: "Always use pnpm not npm",
      scope: "repo",
      repo: "test/recall-codex-phase4-repo-Ab12Cd",
      source: "user_correction",
      confidence: 0.9,
    });
    const real = createMemory(db, {
      type: "rule",
      text: "Always use pnpm not npm",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    const report = runDeterministicCleanup(db, { dryRun: false, only: "reject_test_fixture_repo" });
    expect(report.counts.test_fixture_rejections).toBe(1);
    expect(getMemory(db, fixture)?.status).toBe("rejected");
    expect(getMemory(db, real)?.status).toBe("active");
  });

  it("hides repos that only contain rejected memories", () => {
    const db = freshDb();
    const fixture = createMemory(db, {
      type: "rule",
      text: "Always use pnpm not npm",
      scope: "repo",
      repo: "test/recall-codex-phase4-repo-Ab12Cd",
      source: "user_correction",
      confidence: 0.9,
    });
    createMemory(db, {
      type: "rule",
      text: "Always use uv for Python",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    db.update(memories).set({ status: "rejected" }).where(eq(memories.id, fixture)).run();

    expect(listRepos(db)).toEqual(["edihasaj/recall"]);
  });
});

describe("maintenance cleanup — invalid scope hygiene", () => {
  it("rejects user corrections anchored to temp paths or impossible path scopes", () => {
    const db = freshDb();
    const missingPath = createMemory(db, {
      type: "rule",
      text: "Always use pnpm not npm.",
      scope: "path",
      repo: null,
      source: "user_correction",
      confidence: 0.9,
    });
    const tempPath = createMemory(db, {
      type: "rule",
      text: "Always write deterministic output.",
      scope: "path",
      repo: null,
      path_scope: "/tmp/oktapod-openclaw-live-qa/task/work/file.ts",
      source: "user_correction",
      confidence: 0.9,
    });
    const tempRepoPath = createMemory(db, {
      type: "rule",
      text: "Always verify generated files exist.",
      scope: "repo",
      repo: null,
      path_scope: "/tmp/oktapod-openclaw-live-qa/task/work",
      source: "user_correction",
      confidence: 0.9,
    });
    const workspaceAlias = createMemory(db, {
      type: "rule",
      text: "Always keep app settings auditable.",
      scope: "repo",
      repo: "Projects",
      source: "user_correction",
      confidence: 0.9,
    });
    const realGlobal = createMemory(db, {
      type: "rule",
      text: "Always use uv for Python projects.",
      scope: "global",
      repo: null,
      source: "user_correction",
      confidence: 0.9,
    });
    const realRepo = createMemory(db, {
      type: "rule",
      text: "Always use pnpm not npm.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    const plan = planRejectInvalidScopes(db);
    expect(plan.map((item) => item.memory_id).sort()).toEqual([
      missingPath,
      tempPath,
      tempRepoPath,
      workspaceAlias,
    ].sort());

    const report = runDeterministicCleanup(db, { dryRun: false, only: "reject_invalid_scope" });
    expect(report.counts.invalid_scope_rejections).toBe(4);
    expect(getMemory(db, missingPath)?.status).toBe("rejected");
    expect(getMemory(db, tempPath)?.status).toBe("rejected");
    expect(getMemory(db, tempRepoPath)?.status).toBe("rejected");
    expect(getMemory(db, workspaceAlias)?.status).toBe("rejected");
    expect(getMemory(db, realGlobal)?.status).toBe("active");
    expect(getMemory(db, realRepo)?.status).toBe("active");
  });
});
