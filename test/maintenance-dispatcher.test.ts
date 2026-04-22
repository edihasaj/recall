import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import { insertTaskIdempotent, listTasks } from "../src/maintenance/tasks.js";
import { dispatchPendingTasks } from "../src/maintenance/dispatcher.js";

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-dispatcher-"));
  return initStandaloneDb(join(dir, "dispatch.db"));
}

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PATH = "/nonexistent";
});

afterEach(() => {
  closeDb();
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
});

function stubOpenAi(content: string) {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

describe("dispatcher returns empty report when no key is configured", () => {
  it("provider resolves to null and no tasks are attempted", async () => {
    const db = freshDb();
    insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: "target-1",
      repo: "edihasaj/recall",
      payload: { memory_id: "x", text: "t" },
    });
    const report = await dispatchPendingTasks(db);
    expect(report.provider).toBeNull();
    expect(report.attempted).toBe(0);
  });
});

describe("dispatcher — dry run", () => {
  it("lists pending tasks without calling the LLM", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    const memoryId = createMemory(db, {
      type: "rule",
      text: "candidate memory",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "repo_scan",
      confidence: 0.45,
    });
    insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: memoryId,
      repo: "edihasaj/recall",
      payload: {
        memory_id: memoryId,
        text: "candidate memory",
        current_scope: "repo",
        repo: "edihasaj/recall",
      },
    });

    const report = await dispatchPendingTasks(db, { dryRun: true });
    expect(report.provider).toBe("openai");
    expect(report.attempted).toBe(0); // dry run attempts nothing
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].status).toBe("skipped");
  });
});

describe("dispatcher — refine_candidate end-to-end", () => {
  it("claims, calls LLM, parses JSON, applies the refinement, and completes the task", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    const memoryId = createMemory(db, {
      type: "rule",
      text: "always use pnpm",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "repo_scan",
      confidence: 0.45,
    });
    insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: memoryId,
      repo: "edihasaj/recall",
      payload: {
        memory_id: memoryId,
        text: "always use pnpm",
        current_scope: "repo",
        current_path_scope: null,
        repo: "edihasaj/recall",
        repetition_count: 3,
      },
    });

    stubOpenAi(JSON.stringify({
      refined_text: "always use pnpm (never npm or yarn)",
      scope: "repo",
      path_scope: null,
      rationale: "clarify exclusivity",
    }));

    const report = await dispatchPendingTasks(db, { provider: "openai" });
    expect(report.attempted).toBe(1);
    expect(report.applied).toBe(1);
    expect(report.rejected).toBe(0);
    expect(report.outcomes[0].status).toBe("applied");
    expect(report.outcomes[0].changed_fields).toContain("text");

    const pending = listTasks(db, { status: "pending" });
    expect(pending).toHaveLength(0);
    const completed = listTasks(db, { status: "completed" });
    expect(completed).toHaveLength(1);
  });
});

describe("dispatcher — malformed JSON releases the task", () => {
  it("returns released when the model emits unparseable text", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    const memoryId = createMemory(db, {
      type: "rule",
      text: "a candidate",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "repo_scan",
      confidence: 0.45,
    });
    insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: memoryId,
      repo: "edihasaj/recall",
      payload: { memory_id: memoryId, text: "a candidate", current_scope: "repo", repo: "edihasaj/recall", repetition_count: 3 },
    });

    stubOpenAi("I'm sorry, I cannot respond with JSON right now.");

    const report = await dispatchPendingTasks(db, { provider: "openai" });
    expect(report.released).toBe(1);
    expect(report.applied).toBe(0);
    const pending = listTasks(db, { status: "pending" });
    expect(pending).toHaveLength(1);
  });
});

describe("dispatcher — code-fenced JSON is accepted", () => {
  it("strips markdown fences before parsing", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    const memoryId = createMemory(db, {
      type: "rule",
      text: "fenced",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "repo_scan",
      confidence: 0.45,
    });
    insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: memoryId,
      repo: "edihasaj/recall",
      payload: { memory_id: memoryId, text: "fenced", current_scope: "repo", repo: "edihasaj/recall", repetition_count: 3 },
    });

    stubOpenAi("```json\n" + JSON.stringify({
      refined_text: "fenced memory rewritten",
      scope: "repo",
    }) + "\n```");

    const report = await dispatchPendingTasks(db, { provider: "openai" });
    expect(report.applied).toBe(1);
  });
});
