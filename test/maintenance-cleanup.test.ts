import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemory } from "../src/models/memory.js";
import {
  listCleanupRuns,
  planDedupeExact,
  planPromoteRepeats,
  planRejectFragments,
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
    });
    const b = createMemory(db, {
      type: "command",
      text: "test:  vitest run.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "config_parse",
      confidence: 0.5,
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
      source: "user_correction", confidence: 0.9,
    });
    const loserId = createMemory(db, {
      type: "rule", text: "Use pnpm.", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.5,
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
});

describe("maintenance cleanup — promoteRepeatCorrections", () => {
  it("promotes rule-shaped candidates with sufficient length", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Always use .agent/config.json as the local main config file",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.5,
    });
    const plan = planPromoteRepeats(db);
    expect(plan).toHaveLength(1);
    expect(plan[0].matched_pattern).toBe("rule_shape");

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
    const idsA = await processCorrection(db, "must stay", { sessionId: "s1", repo: "r" });
    const idsB = await processCorrection(db, "never downtime?", { sessionId: "s2", repo: "r" });
    expect(idsA).toEqual([]);
    expect(idsB).toEqual([]);

    const all = db.select().from(memories).all();
    expect(all).toHaveLength(0);
  });

  it("still captures well-formed corrections", async () => {
    const { processCorrection } = await import("../src/capture/correction.js");
    const db = freshDb();
    const ids = await processCorrection(db, "always use pnpm not npm", {
      sessionId: "s1",
      repo: "r",
    });
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe("maintenance cleanup — suppressUnproductiveCommands", () => {
  it("suppresses high-injection command memories with zero followed feedback", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "command", text: "test: vitest run", scope: "repo", repo: "r",
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
      type: "command", text: "test: vitest run", scope: "repo", repo: "r",
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
      type: "command", text: "test: vitest run", scope: "repo", repo: "r",
      source: "config_parse", confidence: 0.9,
    });
    db.update(memories).set({ injection_count: 10 }).where(eq(memories.id, id)).run();
    expect(runDeterministicCleanup(db, { dryRun: true }).counts.command_suppressions).toBe(0);
  });

  it("revert restores auto_inject=true", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "command", text: "test: vitest run", scope: "repo", repo: "r",
      source: "config_parse", confidence: 0.9,
    });
    db.update(memories).set({ injection_count: 60 }).where(eq(memories.id, id)).run();
    const report = runDeterministicCleanup(db, { dryRun: false });
    expect(getMemory(db, id)?.auto_inject).toBe(false);
    revertCleanupRun(db, report.run_id);
    expect(getMemory(db, id)?.auto_inject).toBe(true);
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
      source: "user_correction", confidence: 0.9,
    });
    const loserId = createMemory(db, {
      type: "rule", text: "use pnpm.", scope: "repo", repo: "r",
      source: "user_correction", confidence: 0.5,
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
