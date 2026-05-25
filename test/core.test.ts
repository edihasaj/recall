import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import {
  createMemory,
  getMemory,
  listMemories,
  listRepos,
  queryMemories,
  confirmMemory,
  rejectMemory,
  demoteMemory,
  promoteMemory,
  recordFeedback,
  getMemoryFeedback,
} from "../src/models/memory.js";
import { flushEmbeddingJobs } from "../src/embeddings/embeddings.js";
import { detectCorrections, processCorrection } from "../src/capture/correction.js";
import { compileContext, compileContextHybrid } from "../src/compiler/context.js";
import { createHistorySnippet } from "../src/history/snippets.js";
import { syncHistoryFtsIndex } from "../src/vector/sqlite-fts-history.js";
import { installMockEmbeddingProvider } from "./helpers/mock-embedding-provider.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-test-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

afterEach(async () => {
  await flushEmbeddingJobs();
  vi.restoreAllMocks();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
  delete process.env.RECALL_EMBEDDING_DIMS;
  delete process.env.RECALL_EMBEDDING_VERSION;
});

describe("memory CRUD", () => {
  it("creates and retrieves a memory", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.45,
    });

    const mem = getMemory(db, id);
    expect(mem).toBeDefined();
    expect(mem!.text).toBe("Use pnpm");
    expect(mem!.status).toBe("candidate");
    expect(mem!.confidence).toBe(0.45);
  });

  it("auto-assigns status from confidence", () => {
    const db = freshDb();

    const low = createMemory(db, {
      type: "rule",
      text: "low",
      scope: "repo",
      source: "user_correction",
      confidence: 0.2,
    });
    expect(getMemory(db, low)!.status).toBe("transient");

    const mid = createMemory(db, {
      type: "rule",
      text: "mid",
      scope: "repo",
      source: "user_correction",
      confidence: 0.45,
    });
    expect(getMemory(db, mid)!.status).toBe("candidate");

    const high = createMemory(db, {
      type: "rule",
      text: "high",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });
    expect(getMemory(db, high)!.status).toBe("active");
  });

  it("queries by repo and status", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "a",
      scope: "repo",
      repo: "r1",
      source: "user_correction",
      confidence: 0.45,
    });
    createMemory(db, {
      type: "rule",
      text: "b",
      scope: "repo",
      repo: "r2",
      source: "user_correction",
      confidence: 0.7,
    });

    const r1 = queryMemories(db, { repo: "r1" });
    expect(r1).toHaveLength(1);
    expect(r1[0].text).toBe("a");

    const active = queryMemories(db, { status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe("b");
  });

  it("dedupes direct memory creates by normalized structural key", () => {
    const db = freshDb();
    const first = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "r1",
      source: "user_correction",
      confidence: 0.45,
    });
    const second = createMemory(db, {
      type: "rule",
      text: "use  pnpm.",
      scope: "repo",
      repo: "r1",
      source: "user_correction",
      confidence: 0.45,
    });

    expect(second).toBe(first);
    expect(queryMemories(db, { repo: "r1" })).toHaveLength(1);
  });

  it("supports limit/offset pagination", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "a",
      scope: "repo",
      repo: "r1",
      source: "user_correction",
      confidence: 0.45,
    });
    createMemory(db, {
      type: "rule",
      text: "b",
      scope: "repo",
      repo: "r1",
      source: "user_correction",
      confidence: 0.45,
    });
    createMemory(db, {
      type: "rule",
      text: "c",
      scope: "repo",
      repo: "r1",
      source: "user_correction",
      confidence: 0.45,
    });

    expect(queryMemories(db, { repo: "r1", limit: 2 })).toHaveLength(2);
    expect(queryMemories(db, { repo: "r1", limit: 2, offset: 1 })).toHaveLength(2);
    expect(listMemories(db, "r1", { limit: 1, offset: 1 })).toHaveLength(1);
  });

  it("lists distinct repos", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "a",
      scope: "repo",
      repo: "z/repo",
      source: "user_correction",
      confidence: 0.45,
    });
    createMemory(db, {
      type: "rule",
      text: "b",
      scope: "repo",
      repo: "a/repo",
      source: "user_correction",
      confidence: 0.45,
    });
    createMemory(db, {
      type: "rule",
      text: "c",
      scope: "repo",
      repo: "a/repo",
      source: "user_correction",
      confidence: 0.45,
    });

    expect(listRepos(db)).toEqual(["a/repo", "z/repo"]);
  });
});

describe("state machine", () => {
  it("promotes candidate → active on explicit confirm", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "test rule",
      scope: "repo",
      source: "user_correction",
      confidence: 0.45,
    });

    expect(getMemory(db, id)!.status).toBe("candidate");
    confirmMemory(db, id);
    const mem = getMemory(db, id)!;
    expect(mem.status).toBe("active");
    expect(mem.confidence).toBe(0.8);
  });

  it("demotes active → candidate", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "test",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });

    expect(getMemory(db, id)!.status).toBe("active");
    demoteMemory(db, id, "contradicted");
    const mem = getMemory(db, id)!;
    expect(mem.status).toBe("candidate");
    expect(mem.confidence).toBeCloseTo(0.4);
  });

  it("rejects immediately", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "wrong",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });

    rejectMemory(db, id);
    const mem = getMemory(db, id)!;
    expect(mem.status).toBe("rejected");
    expect(mem.confidence).toBe(0);
  });

  it("cannot promote rejected memory", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "wrong",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });

    rejectMemory(db, id);
    const ok = promoteMemory(db, id, "explicit_confirm");
    expect(ok).toBe(false);
    expect(getMemory(db, id)!.status).toBe("rejected");
  });

  it("increments confidence on repeat correction", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "test",
      scope: "repo",
      source: "user_correction",
      confidence: 0.45,
    });

    promoteMemory(db, id, "repeat_correction");
    expect(getMemory(db, id)!.confidence).toBeCloseTo(0.65);

    promoteMemory(db, id, "repeat_correction");
    expect(getMemory(db, id)!.confidence).toBeCloseTo(0.85);
    expect(getMemory(db, id)!.status).toBe("active");
  });
});

describe("correction detection", () => {
  it("detects negation + replacement", () => {
    const matches = detectCorrections("don't use npm, use pnpm");
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toContain("npm");
    expect(matches[0].text).toContain("pnpm");
    expect(matches[0].type).toBe("rule");
  });

  it("detects explicit rules", () => {
    const matches = detectCorrections("always run tests before pushing");
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toContain("always");
  });

  it("detects review feedback", () => {
    const matches = detectCorrections("review said use error boundaries");
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("review_pattern");
  });

  it("detects soft decisions", () => {
    const matches = detectCorrections("let's use editorconfig defaults for indentation");
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("decision");
    expect(matches[0].text).toContain("editorconfig");
  });

  it("ignores one-off task steering", () => {
    const matches = detectCorrections("let's keep up do 1 now then 2, also in 2 if all pass then we can cleanup those docs");
    expect(matches).toHaveLength(0);
  });

  it("ignores pasted agent transcripts", () => {
    const pasted = `
~/.recall/recall.db (128 MB). Top-line stats below.

  Hook activity (who's calling Recall)

  ┌─────────────┬─────────────┬──────────────────┬───────────────────┐
  │    agent    │ hook calls  │ sessions started │ corrections saved │
  └─────────────┴─────────────┴──────────────────┴───────────────────┘

⏺ Bash(echo "=== TOP REUSED MEMORIES (most injected) ==="
      sqlite3 -header ~/.recall/recall.db <<'SQL'…)
  ⎿  === TOP REUSED MEMORIES (most injected) ===

  - eunify: Helm release name must be eunify-platform with
    meta.helm.sh/release-namespace="eunify" (9)

※ recap: Inspected ~/.recall/recall.db to measure savings.

why do I get duplicates for the same questions still?
${"x".repeat(1_300)}
`;
    expect(detectCorrections(pasted)).toHaveLength(0);
  });

  it("drops incomplete rule fragments", async () => {
    const db = freshDb();
    const { ids } = await processCorrection(db, "must be eunify-platform with", {
      sessionId: "s1",
      repo: "test/repo",
    });
    expect(ids).toEqual([]);
  });

  it("detects soft preferences as decisions", () => {
    const matches = detectCorrections("we prefer tabs over spaces in this repo");
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("decision");
    expect(matches[0].text).toContain("Prefer tabs over spaces");
  });

  it("returns empty for normal text", () => {
    const matches = detectCorrections("can you help me with this file");
    expect(matches).toHaveLength(0);
  });

  it("ignores unresolved questions", () => {
    const matches = detectCorrections("should we use tabs or spaces?");
    expect(matches).toHaveLength(0);
  });

  it("captures whenever-trigger meta-rules", () => {
    const matches = detectCorrections(
      "whenever I say add, please run a backup and update the readme",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("rule");
    expect(matches[0].text).toContain("\"add\"");
    expect(matches[0].text.toLowerCase()).toContain("backup");
  });

  it("ignores descriptive modal clauses (relative-clause narration)", () => {
    // "remove those plugins I never use from settings" should not become a rule
    // about "never use from settings". Same for "things we always do".
    expect(detectCorrections("remove those plugins I never use from settings")).toHaveLength(0);
    expect(detectCorrections("clean up the files we always copy from prod")).toHaveLength(0);
    expect(detectCorrections("delete things you never look at again")).toHaveLength(0);
  });

  it("still captures direct imperatives even with adjacent pronouns elsewhere", () => {
    // The pronoun-modal filter should not over-fire on legitimate rules.
    const matches = detectCorrections("always run pnpm lint before you commit");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("phase D.next — semantic match against rejected exemplars filters paraphrases", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";
    // Bucket vectors so paraphrases of "delete plugins" map to the same vector
    // as the rejected exemplar but lexical Jaccard would miss them.
    installMockEmbeddingProvider((text) => {
      const t = text.toLowerCase();
      if (t.includes("delete") || t.includes("remove")) {
        if (t.includes("plugin") || t.includes("extension") || t.includes("addon")) return [1, 0, 0];
      }
      return [0, 1, 0];
    });

    const { ids: seedIds } = await processCorrection(db, "always remove plugins from settings", {
      sessionId: "s0",
      repo: "r",
    });
    expect(seedIds.length).toBe(1);
    await flushEmbeddingJobs();
    rejectMemory(db, seedIds[0]);
    await flushEmbeddingJobs();

    // Paraphrase: different words, same intent. Lexical Jaccard ~0 (no shared
    // tokens beyond "from"/"the"); semantic vector matches.
    const { ids: paraphraseIds } = await processCorrection(db, "always delete extensions from the config", {
      sessionId: "s1",
      repo: "r",
    });
    expect(paraphraseIds).toEqual([]);
  });

  it("phase E1 — every new candidate enqueues a verify_capture maintenance task", async () => {
    const { memoryMaintenanceTasks } = await import("../src/db/schema.js");
    const db = freshDb();
    const { ids } = await processCorrection(db, "always run pnpm lint before pushing", {
      sessionId: "s1",
      repo: "r",
    });
    expect(ids).toHaveLength(1);
    const tasks = db.select().from(memoryMaintenanceTasks).all()
      .filter((t) => t.kind === "verify_capture");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("pending");
    const payload = tasks[0].payload as Record<string, unknown>;
    expect(payload.memory_id).toBe(ids[0]);
    expect(payload.text).toBe("always run pnpm lint before pushing");
    expect(payload.inferred_scope).toBe("repo");
  });

  it("phase D — does not re-capture text similar to a rejected exemplar", async () => {
    const db = freshDb();
    // Seed a rejected exemplar.
    const rejId = createMemory(db, {
      type: "rule",
      text: "always style the consistently",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0,
    });
    rejectMemory(db, rejId);

    // Near-identical phrasing — Jaccard ≥ 0.7 — should be filtered out.
    const { ids } = await processCorrection(db, "always style consistently the buttons", {
      sessionId: "s1",
      repo: "r",
    });
    expect(ids).toEqual([]);
  });

  it("phase D — still captures unrelated rules with no exemplar overlap", async () => {
    const db = freshDb();
    const rejId = createMemory(db, {
      type: "rule",
      text: "always style the consistently",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0,
    });
    rejectMemory(db, rejId);

    const { ids } = await processCorrection(db, "always run pnpm lint before pushing", {
      sessionId: "s1",
      repo: "r",
    });
    expect(ids.length).toBeGreaterThan(0);
  });

  it("isDestructiveRisky flags destructive verbs targeting user state", async () => {
    const { isDestructiveRisky } = await import("../src/capture/correction.js");
    expect(isDestructiveRisky("always remove plugins from settings")).toBe(true);
    expect(isDestructiveRisky("never delete history without backup")).toBe(true);
    expect(isDestructiveRisky("wipe stale credentials weekly")).toBe(true);
    // Destructive verb without high-risk target — fine.
    expect(isDestructiveRisky("always remove unused imports")).toBe(false);
    // High-risk target without destructive verb — fine.
    expect(isDestructiveRisky("always commit and push the config")).toBe(false);
  });

  it("isTriggerTemplateRule flags rules conditioned on a literal user phrase", async () => {
    const { isTriggerTemplateRule, isHighRiskRule } = await import(
      "../src/capture/correction.js"
    );
    expect(
      isTriggerTemplateRule(
        "When user says \"add\", run a backup and update the readme.",
      ),
    ).toBe(true);
    expect(
      isTriggerTemplateRule("Whenever user asks for X, do Y instead."),
    ).toBe(true);
    expect(isTriggerTemplateRule("When user types 'deploy', run smoke tests")).toBe(true);
    // Plain rules are not trigger templates.
    expect(isTriggerTemplateRule("always run vitest before pushing")).toBe(false);
    expect(isTriggerTemplateRule("when the build fails, check the logs")).toBe(false);
    // Combined gate covers both shapes.
    expect(isHighRiskRule("When user says \"clean\", drop all branches")).toBe(true);
    expect(isHighRiskRule("never delete the .env file")).toBe(true);
    expect(isHighRiskRule("always run vitest before pushing")).toBe(false);
  });

  it("captures soft preferences mentioning conventional/conventions", () => {
    const matches = detectCorrections("we use conventional commits");
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("decision");
    expect(matches[0].text.toLowerCase()).toContain("conventional commits");
  });

  it("captures each-time triggers", () => {
    const matches = detectCorrections(
      "each time I say deploy, we run the smoke tests first",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toContain("\"deploy\"");
  });

  it("processes correction into DB", async () => {
    const db = freshDb();
    const { ids } = await processCorrection(db, "never use any types in this repo", {
      sessionId: "test-session",
      repo: "test/repo",
    });

    expect(ids.length).toBeGreaterThan(0);
    const mem = getMemory(db, ids[0])!;
    expect(mem.status).toBe("candidate");
    expect(mem.repo).toBe("test/repo");
  });

  it("promotes on repeated correction", async () => {
    const db = freshDb();

    await processCorrection(db, "always use strict mode", {
      sessionId: "s1",
      repo: "test/repo",
    });

    // Same correction again → should promote existing
    const { ids: ids2 } = await processCorrection(db, "always use strict mode", {
      sessionId: "s2",
      repo: "test/repo",
    });

    const mem = getMemory(db, ids2[0])!;
    expect(mem.confidence).toBeGreaterThan(0.5);
  });

  it("stores soft decisions as lower-confidence candidates", async () => {
    const db = freshDb();

    const { ids } = await processCorrection(db, "let's use editorconfig defaults for indentation", {
      sessionId: "s1",
      repo: "test/repo",
    });

    const mem = getMemory(db, ids[0])!;
    expect(mem.type).toBe("decision");
    expect(mem.status).toBe("candidate");
    expect(mem.confidence).toBeLessThan(0.5);
  });

  it("uses semantic dedup when embeddings are enabled", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";
    installMockEmbeddingProvider((text) => (
      text.toLowerCase().includes("pnpm") ? [1, 0, 0] : [0, 0, 1]
    ));

    const { ids: ids1 } = await processCorrection(db, "don't use npm, use pnpm", {
      sessionId: "s1",
      repo: "test/repo",
    });
    await flushEmbeddingJobs();

    const { ids: ids2 } = await processCorrection(db, "don't use npm. use pnpm instead", {
      sessionId: "s2",
      repo: "test/repo",
    });

    expect(ids2).toEqual(ids1);
  });
});

describe("compiler", () => {
  it("compiles active memories into text", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "Use TypeScript strict mode",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    createMemory(db, {
      type: "command",
      text: "test: `npm test`",
      scope: "repo",
      repo: "test/repo",
      source: "config_parse",
      confidence: 0.7,
    });

    const result = compileContext(db, { repo: "test/repo" });
    expect(result.text).toContain("TypeScript strict mode");
    expect(result.text).toContain("npm test");
    expect(result.memories_included).toHaveLength(2);
    expect(result.token_estimate).toBeGreaterThan(0);
  });

  it("drops below-threshold memories", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "high confidence",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.8,
    });
    // 0.61 = just above active threshold, but below custom threshold
    createMemory(db, {
      type: "rule",
      text: "borderline confidence",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.61,
    });

    const result = compileContext(db, {
      repo: "r",
      config: { confidence_threshold: 0.7 },
    });
    expect(result.text).toContain("high confidence");
    expect(result.text).not.toContain("borderline confidence");
    expect(result.memories_dropped.length).toBeGreaterThan(0);
  });

  it("returns empty when nothing passes threshold", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "low",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.3,
    });

    const result = compileContext(db, { repo: "r" });
    expect(result.text).toBe("");
    expect(result.memories_included).toHaveLength(0);
  });

  it("includes repo history snippets in the first-touch context pack", () => {
    const db = freshDb();
    createHistorySnippet(db, {
      repo: "r",
      kind: "decision_summary",
      text: "Repo: r\nFrequent user decisions:\n- (1) User direction: do phase 3.",
    });

    const result = compileContext(db, { repo: "r" });
    expect(result.memories_included).toHaveLength(0);
    expect(result.history_included).toHaveLength(1);
    expect(result.text).toContain("## History");
    expect(result.text).toContain("do phase 3");
  });

  it("dedupes a global memory that also has its origin repo set", () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "When user says \"add\", run a backup and update the readme.",
      scope: "global",
      repo: "r", // origin repo retained for audit
      source: "user_correction",
      confidence: 0.9,
    });
    promoteMemory(db, id, "manual_confirm");

    const result = compileContext(db, { repo: "r" });
    expect(result.memories_included.filter((mid) => mid === id)).toHaveLength(1);
  });

  it("dedupes injected memories after stripping pasted Recall headings", () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "Always use local source clones under ../oss for competitor/source",
      scope: "repo",
      repo: "r",
      source: "user_correction",
      confidence: 0.9,
    });
    createMemory(db, {
      type: "rule",
      text: "Always use local source clones under ../oss for competitor/source## Commands- test: `vitest run`",
      scope: "global",
      repo: "r",
      source: "user_correction",
      confidence: 0.8,
    });

    const result = compileContext(db, { repo: "r" });
    expect(result.text.match(/Always use local source clones/g)).toHaveLength(1);
    expect(result.text).not.toContain("## Commands- test");
  });

  it("respects max_commands budget", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      createMemory(db, {
        type: "command",
        text: `cmd ${i}`,
        scope: "repo",
        repo: "r",
        source: "config_parse",
        confidence: 0.8,
      });
    }

    const result = compileContext(db, { repo: "r" });
    // Default max_commands = 3
    expect(result.memories_included).toHaveLength(3);
  });

  it("hybrid compile prefers exact lexical command matches for query text", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";
    installMockEmbeddingProvider((text) => (
      text.toLowerCase().includes("pytest") ? [1, 0, 0] : [0, 0, 1]
    ));

    createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    createMemory(db, {
      type: "decision",
      text: "Use pytest for local test runs.",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });

    await flushEmbeddingJobs();

    const result = await compileContextHybrid(db, {
      repo: "test/repo",
      query_text: "pytest -q",
    });

    expect(result.memories_included.length).toBeGreaterThan(0);
    expect(result.text).toContain("Run pytest -q");
  });

  it("hybrid compile returns only the top two relevant query matches", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";
    installMockEmbeddingProvider((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes("pytest -q")) return [1, 0, 0];
      if (normalized.includes("pytest locally")) return [0.92, 0, 0];
      if (normalized.includes("pytest smoke")) return [0.85, 0, 0];
      return [0, 0, 1];
    });

    createMemory(db, {
      type: "command",
      text: "Run pytest -q",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    createMemory(db, {
      type: "decision",
      text: "Use pytest locally before pushing changes",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    createMemory(db, {
      type: "gotcha",
      text: "Pytest smoke runs miss the slow suite",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.8,
    });
    createMemory(db, {
      type: "rule",
      text: "Use pnpm as package manager",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.99,
    });

    await flushEmbeddingJobs();

    const result = await compileContextHybrid(db, {
      repo: "test/repo",
      query_text: "pytest -q",
    });

    expect(result.memories_included).toHaveLength(2);
    expect(result.text).toContain("Run pytest -q");
    expect(result.text).not.toContain("Use pnpm as package manager");
  });

  it("keeps candidate memories opt-in for hybrid compile", async () => {
    const db = freshDb();
    delete process.env.RECALL_EMBEDDINGS_DISABLED;
    process.env.RECALL_EMBEDDING_DIMS = "3";
    process.env.RECALL_EMBEDDING_VERSION = "test-v1";
    installMockEmbeddingProvider((text) => (
      text.toLowerCase().includes("pnpm") ? [1, 0, 0] : [0, 0, 1]
    ));

    createMemory(db, {
      type: "command",
      text: "pnpm test",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.45,
    });

    await flushEmbeddingJobs();

    const withoutCandidates = await compileContextHybrid(db, {
      repo: "test/repo",
      query_text: "pnpm",
    });
    expect(withoutCandidates.memories_included).toHaveLength(0);

    const withCandidates = await compileContextHybrid(db, {
      repo: "test/repo",
      query_text: "pnpm",
      config: { include_candidates: true },
    });
    expect(withCandidates.memories_included).toHaveLength(1);
  });

  it("hybrid compile can return relevant history without matching memories", async () => {
    const db = freshDb();
    const snippetId = createHistorySnippet(db, {
      repo: "test/repo",
      kind: "decision_summary",
      text: "Repo: test/repo\nFrequent user decisions:\n- (1) User direction: make memory cleanup self healing in the daemon.",
    });
    syncHistoryFtsIndex(db, snippetId);

    const result = await compileContextHybrid(db, {
      repo: "test/repo",
      query_text: "self healing daemon",
      embedding_config: null,
    });

    expect(result.memories_included).toHaveLength(0);
    expect(result.history_included).toEqual([snippetId]);
    expect(result.text).toContain("self healing");
  });
});

describe("feedback tracking", () => {
  it("records and retrieves feedback", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "test",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });

    recordFeedback(db, memId, "session-1", true, "followed");
    const feedback = getMemoryFeedback(db, memId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].outcome).toBe("followed");
  });

  it("auto-promotes on followed feedback", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "test",
      scope: "repo",
      source: "user_correction",
      confidence: 0.65,
    });

    recordFeedback(db, memId, "s1", true, "followed");
    const mem = getMemory(db, memId)!;
    expect(mem.confidence).toBeCloseTo(0.7);
  });

  it("auto-demotes on contradicted feedback", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "test",
      scope: "repo",
      source: "user_correction",
      confidence: 0.7,
    });

    recordFeedback(db, memId, "s1", true, "contradicted");
    const mem = getMemory(db, memId)!;
    expect(mem.confidence).toBeLessThan(0.7);
    expect(mem.status).toBe("candidate");
  });
});
