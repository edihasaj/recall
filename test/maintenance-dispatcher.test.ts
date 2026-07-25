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

describe("dispatcher — malformed JSON counts as a failed attempt", () => {
  it("returns rejected when the model emits unparseable text", async () => {
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
    expect(report.rejected).toBe(1);
    expect(report.applied).toBe(0);
    const pending = listTasks(db, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(1);
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

describe("dispatcher task contracts", () => {
  it("sends merge candidates to the model and applies its selected winner", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    const first = createMemory(db, {
      type: "rule",
      text: "Always use pnpm.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });
    const second = createMemory(db, {
      type: "rule",
      text: "Use pnpm for package commands.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.7,
    });
    insertTaskIdempotent(db, {
      kind: "merge_duplicates",
      target: first,
      repo: "edihasaj/recall",
      payload: {
        repo: "edihasaj/recall",
        candidates: [
          { id: first, text: "Always use pnpm.", scope: "repo", path_scope: null },
          { id: second, text: "Use pnpm for package commands.", scope: "repo", path_scope: null },
        ],
      },
    });
    stubOpenAi(JSON.stringify({
      winner_id: first,
      winner_text: null,
      winner_scope: null,
      winner_path_scope: null,
      rationale: null,
    }));

    const report = await dispatchPendingTasks(db, { provider: "openai" });

    expect(report.applied).toBe(1);
    const request = JSON.parse(fetchSpy!.mock.calls[0][1]!.body as string);
    expect(request.messages[1].content).toContain(first);
    expect(request.messages[1].content).toContain(second);
  });

  it("abandons queued non-user extraction prompts before calling the model", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    insertTaskIdempotent(db, {
      kind: "extract_rules_from_prompt",
      target: "generated-contract",
      repo: "edihasaj/probeport",
      payload: {
        raw_prompt: "# Probeport QA Agent Contract\nGenerated harness instructions.",
        repo: "edihasaj/probeport",
      },
    });
    fetchSpy = vi.spyOn(globalThis, "fetch");

    const report = await dispatchPendingTasks(db, { provider: "openai" });

    expect(report.attempted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listTasks(db, { status: "abandoned" })).toHaveLength(1);
  });

  it("accepts null dropped_reason for an empty extraction result", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    insertTaskIdempotent(db, {
      kind: "extract_rules_from_prompt",
      target: "real-rule",
      repo: "edihasaj/recall",
      payload: {
        raw_prompt: "Always use pnpm for package commands.",
        repo: "edihasaj/recall",
      },
    });
    stubOpenAi(JSON.stringify({ rules: [], dropped_reason: null }));

    const report = await dispatchPendingTasks(db, { provider: "openai" });

    expect(report.applied).toBe(1);
    expect(report.rejected).toBe(0);
  });

  it("abandons a provider-filtered task instead of retrying forever", async () => {
    const db = freshDb();
    process.env.OPENAI_API_KEY = "sk-test";
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Candidate text.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.5,
    });
    insertTaskIdempotent(db, {
      kind: "verify_capture",
      target: memoryId,
      repo: "edihasaj/recall",
      payload: { memory_id: memoryId, text: "Candidate text." },
    });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "content_filter" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    const report = await dispatchPendingTasks(db, { provider: "openai" });

    expect(report.rejected).toBe(1);
    expect(report.outcomes[0].reason).toBe("provider content filter");
    expect(listTasks(db, { status: "pending" })).toHaveLength(0);
    expect(listTasks(db, { status: "abandoned" })).toHaveLength(1);
  });
});
