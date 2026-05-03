import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { initStandaloneDb } from "../src/db/client.js";
import { historySnippets, memoryMaintenanceTasks } from "../src/db/schema.js";
import { createMemory, getMemory } from "../src/models/memory.js";
import {
  claimTask,
  getTask,
  insertTaskIdempotent,
  submitTask,
} from "../src/maintenance/tasks.js";
import { getAuditTrail, rollbackMemory } from "../src/audit/trail.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-mmt-apply-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function seedSnippet(db: ReturnType<typeof initStandaloneDb>, repo: string, text = "raw template text") {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(historySnippets).values({
    id,
    repo,
    session_id: `sess-${id}`,
    kind: "session_summary",
    text,
    source_activity_ids: [] as any,
    created_at: now,
    updated_at: now,
  }).run();
  return id;
}

describe("tier-2 maintenance tasks — phase 3 (effect appliers)", () => {
  it("refine_candidate applier updates memory text/scope and writes an audit row", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "use uv not pip",
      scope: "repo",
      path_scope: null,
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });

    const taskId = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: memId,
      repo: "test/repo",
      payload: { memory_id: memId, text: "use uv not pip", current_scope: "repo" },
    })!;
    claimTask(db, taskId, "claude-code");

    const outcome = submitTask(db, taskId, "claude-code", {
      refined_text: "use uv for new python dependencies under services/*/pyproject.toml",
      scope: "path",
      path_scope: "services/",
      rationale: "narrow to python services only",
    });

    expect(outcome.status).toBe("applied");
    const asApplied = outcome as Extract<typeof outcome, { status: "applied" }>;
    expect(asApplied.target_id).toBe(memId);
    expect(asApplied.changed_fields.sort()).toEqual(["path_scope", "scope", "text"]);
    expect(asApplied.audit_entry_id).toBeTruthy();

    const mem = getMemory(db, memId)!;
    expect(mem.text).toMatch(/services/);
    expect(mem.scope).toBe("path");
    expect(mem.path_scope).toBe("services/");

    const audit = getAuditTrail(db, memId);
    const refinedEntry = audit.find((e) => e.reason?.startsWith("refined:"));
    expect(refinedEntry).toBeTruthy();
    expect(refinedEntry!.actor).toBe("maintenance:claude-code");
    expect(refinedEntry!.action).toBe("edited");
  });

  it("rollbackMemory reverts a refine_candidate mutation", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "original text",
      scope: "repo",
      path_scope: null,
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });

    const taskId = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: memId,
      repo: "test/repo",
      payload: { memory_id: memId },
    })!;
    claimTask(db, taskId, "claude-code");
    const submitOutcome = submitTask(db, taskId, "claude-code", {
      refined_text: "refined text scoped",
      scope: "path",
      path_scope: "x/",
    }) as Extract<ReturnType<typeof submitTask>, { status: "applied" }>;

    expect(submitOutcome.audit_entry_id).toBeTruthy();
    const rolled = rollbackMemory(db, memId, submitOutcome.audit_entry_id!, "test-user");
    expect(rolled).toBe(true);

    const mem = getMemory(db, memId)!;
    expect(mem.text).toBe("original text");
    expect(mem.scope).toBe("repo");
    expect(mem.path_scope).toBeNull();
  });

  it("verify_capture applier rewrites text/scope when verdict is rewrite", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "always uh use uv not pip",
      scope: "repo",
      path_scope: null,
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });
    const taskId = insertTaskIdempotent(db, {
      kind: "verify_capture",
      target: memId,
      repo: "test/repo",
      payload: { memory_id: memId, text: "always uh use uv not pip", inferred_scope: "repo" },
    })!;
    claimTask(db, taskId, "claude-code");
    const outcome = submitTask(db, taskId, "claude-code", {
      verdict: "rewrite",
      cleaned_text: "Always use uv for Python dependencies, not pip.",
      scope: "global",
      reason: "speech filler removed; cross-language convention",
    });

    expect(outcome.status).toBe("applied");
    const mem = getMemory(db, memId)!;
    expect(mem.text).toBe("Always use uv for Python dependencies, not pip.");
    expect(mem.scope).toBe("global");
    expect(mem.status).toBe("candidate"); // never auto-promotes

    const audit = getAuditTrail(db, memId);
    expect(audit.find((e) => e.reason?.startsWith("verify:rewrite:"))).toBeTruthy();
  });

  it("verify_capture applier rejects fragment when verdict is reject", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "always style the",
      scope: "repo",
      path_scope: null,
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });
    const taskId = insertTaskIdempotent(db, {
      kind: "verify_capture",
      target: memId,
      repo: "test/repo",
      payload: { memory_id: memId, text: "always style the", inferred_scope: "repo" },
    })!;
    claimTask(db, taskId, "claude-code");
    const outcome = submitTask(db, taskId, "claude-code", {
      verdict: "reject",
      reason: "incomplete sentence; voice transcript fragment",
    });

    expect(outcome.status).toBe("applied");
    const mem = getMemory(db, memId)!;
    expect(mem.status).toBe("rejected");

    const audit = getAuditTrail(db, memId);
    const rejected = audit.find((e) => e.action === "rejected");
    expect(rejected).toBeTruthy();
    expect(rejected!.reason).toMatch(/verify_capture:reject/);
  });

  it("verify_capture applier no-ops when verdict is save", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "Always run pnpm lint before pushing.",
      scope: "repo",
      path_scope: null,
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });
    const before = getMemory(db, memId)!;
    const taskId = insertTaskIdempotent(db, {
      kind: "verify_capture",
      target: memId,
      repo: "test/repo",
      payload: { memory_id: memId, text: before.text, inferred_scope: "repo" },
    })!;
    claimTask(db, taskId, "claude-code");
    const outcome = submitTask(db, taskId, "claude-code", { verdict: "save" });

    expect(outcome.status).toBe("applied");
    const after = getMemory(db, memId)!;
    expect(after.text).toBe(before.text);
    expect(after.scope).toBe(before.scope);
    expect(after.status).toBe(before.status);
  });

  it("refine_candidate applier honors verdict=reject when LLM extends contract", () => {
    const db = freshDb();
    const memId = createMemory(db, {
      type: "rule",
      text: "noisy candidate that re-captured itself",
      scope: "repo",
      path_scope: null,
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.5,
    });
    const taskId = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: memId,
      repo: "test/repo",
      payload: { memory_id: memId, text: "noisy candidate", current_scope: "repo" },
    })!;
    claimTask(db, taskId, "claude-code");
    const outcome = submitTask(db, taskId, "claude-code", {
      refined_text: "noisy candidate",
      scope: "repo",
      verdict: "reject",
      rationale: "still nonsense after re-eval",
    });
    expect(outcome.status).toBe("applied");
    expect(getMemory(db, memId)!.status).toBe("rejected");
  });

  it("refine_candidate applier abandons when memory is missing", () => {
    const db = freshDb();
    const missingId = randomUUID();
    const taskId = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: missingId,
      repo: "test/repo",
      payload: { memory_id: missingId },
    })!;
    claimTask(db, taskId, "claude-code");

    const outcome = submitTask(db, taskId, "claude-code", {
      refined_text: "something",
      scope: "repo",
    });

    expect(outcome.status).toBe("rejected");
    expect((outcome as any).abandoned).toBe(true);

    const task = getTask(db, taskId)!;
    expect(task.status).toBe("abandoned");
    expect(task.failure_reason).toMatch(/not found/);
  });

  it("summarize_history applier replaces snippet text", () => {
    const db = freshDb();
    const snipId = seedSnippet(db, "test/repo");

    const taskId = insertTaskIdempotent(db, {
      kind: "summarize_history",
      target: snipId,
      repo: "test/repo",
      payload: { snippet_id: snipId, current_text: "raw template text", kind: "session_summary" },
    })!;
    claimTask(db, taskId, "claude-code");

    const outcome = submitTask(db, taskId, "claude-code", {
      summary_text: "Session covered python test failures; agent suggested pytest over unittest.",
      tags: ["python", "pytest"],
    });

    expect(outcome.status).toBe("applied");
    const asApplied = outcome as Extract<typeof outcome, { status: "applied" }>;
    expect(asApplied.target_id).toBe(snipId);
    expect(asApplied.changed_fields).toContain("text");
    expect(asApplied.audit_entry_id).toBeNull();

    const row = db.select().from(historySnippets)
      .where(eq(historySnippets.id, snipId)).get()!;
    expect(row.text).toMatch(/python test failures/);
  });

  it("applier result is persisted on the task row", () => {
    const db = freshDb();
    const snipId = seedSnippet(db, "test/repo");
    const taskId = insertTaskIdempotent(db, {
      kind: "summarize_history",
      target: snipId,
      repo: "test/repo",
      payload: { snippet_id: snipId, current_text: "x", kind: "session_summary" },
    })!;
    claimTask(db, taskId, "claude-code");
    submitTask(db, taskId, "claude-code", { summary_text: "summary" });

    const row = db.select().from(memoryMaintenanceTasks)
      .where(eq(memoryMaintenanceTasks.id, taskId)).get()!;
    expect((row.result as any).summary_text).toBe("summary");
  });
});
