import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { memoryMaintenanceTasks } from "../src/db/schema.js";
import {
  TaskClaimConflictError,
  claimTask,
  getTask,
  insertTaskIdempotent,
  peekTasks,
  releaseTask,
  submitTask,
  sweepExpiredLeases,
} from "../src/maintenance/tasks.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-mmt-mcp-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function seedTask(db: ReturnType<typeof initStandaloneDb>) {
  return insertTaskIdempotent(db, {
    kind: "summarize_history",
    target: "snip-1",
    repo: "test/repo",
    payload: { snippet_id: "snip-1", current_text: "raw template", kind: "session_summary" },
  })!;
}

describe("tier-2 maintenance tasks — phase 2 (peek / claim / submit / release)", () => {
  it("peek returns pending tasks with truncated payload summary", () => {
    const db = freshDb();
    insertTaskIdempotent(db, {
      kind: "summarize_history",
      target: "snip-1",
      repo: "test/repo",
      payload: { snippet_id: "snip-1", current_text: "x".repeat(400) },
    });

    const tasks = peekTasks(db, { kinds: ["summarize_history"] });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind).toBe("summarize_history");
    expect((tasks[0].payload_summary as any).current_text).toMatch(/\.\.\.$/);
    expect(tasks[0].repo).toBe("test/repo");
  });

  it("peek filters by repo", () => {
    const db = freshDb();
    insertTaskIdempotent(db, { kind: "summarize_history", target: "a", repo: "r1", payload: {} });
    insertTaskIdempotent(db, { kind: "summarize_history", target: "b", repo: "r2", payload: {} });
    expect(peekTasks(db, { repo: "r1" })).toHaveLength(1);
    expect(peekTasks(db, { repo: "r2" })).toHaveLength(1);
  });

  it("peek respects limit and does not return claimed tasks", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      insertTaskIdempotent(db, { kind: "summarize_history", target: `s${i}`, repo: "r", payload: {} });
    }
    const first = peekTasks(db, { limit: 2 });
    expect(first).toHaveLength(2);

    claimTask(db, first[0].id, "agent-x");
    const second = peekTasks(db, { limit: 10 });
    expect(second.some((t) => t.id === first[0].id)).toBe(false);
  });

  it("claim succeeds once; a second claim throws", () => {
    const db = freshDb();
    const id = seedTask(db);

    const result = claimTask(db, id, "claude-code");
    expect(result.task.status).toBe("claimed");
    expect(result.task.claimed_by).toBe("claude-code");
    expect(result.lease_expires_at).toEqual(result.task.claim_expires_at);

    expect(() => claimTask(db, id, "codex"))
      .toThrow(TaskClaimConflictError);
  });

  it("claim on unknown task throws not-found", () => {
    const db = freshDb();
    expect(() => claimTask(db, "00000000-0000-0000-0000-000000000000", "a"))
      .toThrow(/not-found/);
  });

  it("submit applies a valid result and transitions to completed", () => {
    const db = freshDb();
    const id = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: "mem-1",
      repo: "r",
      payload: { memory_id: "mem-1" },
    })!;
    claimTask(db, id, "claude-code");

    const outcome = submitTask(db, id, "claude-code", {
      refined_text: "always run pytest before committing to python/",
      scope: "path",
      path_scope: "python/",
      rationale: "narrows a repo-wide rule to python directory",
    });

    expect(outcome.status).toBe("applied");
    const task = getTask(db, id)!;
    expect(task.status).toBe("completed");
    expect(task.submitted_at).toBeTruthy();
    expect(task.completed_at).toBeTruthy();
    expect((task.result as any).scope).toBe("path");
  });

  it("submit with wrong agent is rejected without side effects", () => {
    const db = freshDb();
    const id = insertTaskIdempotent(db, {
      kind: "summarize_history",
      target: "snip",
      repo: "r",
      payload: {},
    })!;
    claimTask(db, id, "claude-code");

    const outcome = submitTask(db, id, "codex", { summary_text: "hello" });
    expect(outcome.status).toBe("rejected");
    expect((outcome as any).reason).toBe("not-claim-holder");

    const task = getTask(db, id)!;
    expect(task.status).toBe("claimed");
    expect(task.result).toBeNull();
  });

  it("submit with invalid shape bumps attempts and returns to pending", () => {
    const db = freshDb();
    const id = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: "mem-1",
      repo: "r",
      payload: { memory_id: "mem-1" },
    })!;
    claimTask(db, id, "claude-code");

    const outcome = submitTask(db, id, "claude-code", { refined_text: "", scope: "path" });
    expect(outcome.status).toBe("rejected");
    expect((outcome as any).attempts).toBe(1);
    expect((outcome as any).abandoned).toBe(false);

    const task = getTask(db, id)!;
    expect(task.status).toBe("pending");
    expect(task.attempts).toBe(1);
    expect(task.failure_reason).toBeTruthy();
  });

  it("submit abandons after max_attempts", () => {
    const db = freshDb();
    const id = insertTaskIdempotent(db, {
      kind: "refine_candidate",
      target: "mem-1",
      repo: "r",
      payload: { memory_id: "mem-1" },
      max_attempts: 1,
    })!;
    claimTask(db, id, "claude-code");

    const outcome = submitTask(db, id, "claude-code", { refined_text: "", scope: "path" });
    expect(outcome.status).toBe("rejected");
    expect((outcome as any).abandoned).toBe(true);

    const task = getTask(db, id)!;
    expect(task.status).toBe("abandoned");
    expect(task.completed_at).toBeTruthy();
  });

  it("release returns a claimed task to pending", () => {
    const db = freshDb();
    const id = seedTask(db);
    claimTask(db, id, "claude-code");

    expect(releaseTask(db, id, "codex").status).toBe("not-claimed");
    expect(releaseTask(db, id, "claude-code").status).toBe("released");

    const task = getTask(db, id)!;
    expect(task.status).toBe("pending");
    expect(task.claimed_by).toBeNull();
  });

  it("expired lease sweep returns claim to pending with attempts += 1", () => {
    const db = freshDb();
    const id = seedTask(db);
    claimTask(db, id, "claude-code", 1);

    // Force an expired lease.
    const past = new Date(Date.now() - 60_000).toISOString();
    db.update(memoryMaintenanceTasks)
      .set({ claim_expires_at: past })
      .where(eq(memoryMaintenanceTasks.id, id))
      .run();

    expect(sweepExpiredLeases(db)).toBe(1);
    const task = getTask(db, id)!;
    expect(task.status).toBe("pending");
    expect(task.attempts).toBe(1);
  });
});
