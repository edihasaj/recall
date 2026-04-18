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

  it("processes correction into DB", async () => {
    const db = freshDb();
    const ids = await processCorrection(db, "never use any types in this repo", {
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
    const ids2 = await processCorrection(db, "always use strict mode", {
      sessionId: "s2",
      repo: "test/repo",
    });

    const mem = getMemory(db, ids2[0])!;
    expect(mem.confidence).toBeGreaterThan(0.5);
  });

  it("stores soft decisions as lower-confidence candidates", async () => {
    const db = freshDb();

    const ids = await processCorrection(db, "let's use editorconfig defaults for indentation", {
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

    const ids1 = await processCorrection(db, "don't use npm, use pnpm", {
      sessionId: "s1",
      repo: "test/repo",
    });
    await flushEmbeddingJobs();

    const ids2 = await processCorrection(db, "don't use npm. use pnpm instead", {
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
