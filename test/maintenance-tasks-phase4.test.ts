import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { initStandaloneDb } from "../src/db/client.js";
import {
  activityEvents,
  historySnippets,
  memories,
} from "../src/db/schema.js";
import { createMemory, getMemory } from "../src/models/memory.js";
import {
  DEFAULT_ENQUEUE_CONFIG,
  claimTask,
  insertTaskIdempotent,
  listTasks,
  produceSummarizeSessionTasks,
  produceSynthesizeRepoTasks,
  submitTask,
} from "../src/maintenance/tasks.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-mmt-p4-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

function seedSessionEvents(
  db: ReturnType<typeof initStandaloneDb>,
  sessionId: string,
  repo: string,
  count: number,
) {
  const now = new Date().toISOString();
  for (let i = 0; i < count - 1; i++) {
    db.insert(activityEvents).values({
      id: randomUUID(),
      session_id: sessionId,
      repo,
      path: null,
      source: "mcp",
      event_type: "query",
      memory_ids: [] as any,
      request: {} as any,
      result: {} as any,
      created_at: now,
    }).run();
  }
  db.insert(activityEvents).values({
    id: randomUUID(),
    session_id: sessionId,
    repo,
    path: null,
    source: "mcp",
    event_type: "session_end",
    memory_ids: [] as any,
    request: {} as any,
    result: {} as any,
    created_at: now,
  }).run();
}

describe("tier-2 maintenance tasks — phase 4 (merge / session / repo)", () => {
  it("produceSummarizeSessionTasks enqueues sessions above event threshold", () => {
    const db = freshDb();
    seedSessionEvents(db, "sess-hot", "repo-a", 6);
    seedSessionEvents(db, "sess-cold", "repo-a", 2);

    const enqueued = produceSummarizeSessionTasks(db, {
      session_min_activity_events: DEFAULT_ENQUEUE_CONFIG.session_min_activity_events,
      summary_max_age_days: DEFAULT_ENQUEUE_CONFIG.summary_max_age_days,
    });
    expect(enqueued).toBe(1);

    const tasks = listTasks(db, { kinds: ["summarize_session"] });
    expect(tasks).toHaveLength(1);
    expect((tasks[0].payload as any).session_id).toBe("sess-hot");
    expect((tasks[0].payload as any).event_count).toBe(6);
  });

  it("produceSummarizeSessionTasks skips sessions that already have a summary", () => {
    const db = freshDb();
    seedSessionEvents(db, "sess-1", "repo-a", 6);
    const now = new Date().toISOString();
    db.insert(historySnippets).values({
      id: randomUUID(),
      repo: "repo-a",
      session_id: "sess-1",
      kind: "session_summary",
      text: "already rolled up",
      source_activity_ids: [] as any,
      created_at: now,
      updated_at: now,
    }).run();

    const enqueued = produceSummarizeSessionTasks(db, {
      session_min_activity_events: 5,
      summary_max_age_days: 7,
    });
    expect(enqueued).toBe(0);
  });

  it("summarize_session applier creates a new session_summary snippet", () => {
    const db = freshDb();
    seedSessionEvents(db, "sess-apply", "repo-a", 6);
    const enqueued = produceSummarizeSessionTasks(db, {
      session_min_activity_events: 5,
      summary_max_age_days: 7,
    });
    expect(enqueued).toBe(1);

    const task = listTasks(db, { kinds: ["summarize_session"] })[0];
    claimTask(db, task.id, "claude-code");
    const outcome = submitTask(db, task.id, "claude-code", {
      summary_text: "Session hit python test failures; agent suggested pytest migration.",
    });
    expect(outcome.status).toBe("applied");

    const snippet = db.select().from(historySnippets)
      .where(and(
        eq(historySnippets.session_id, "sess-apply"),
        eq(historySnippets.kind, "session_summary"),
      ))
      .get()!;
    expect(snippet.text).toMatch(/pytest migration/);
  });

  it("produceSynthesizeRepoTasks enqueues repos above memory threshold without recent synthesis", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      const id = createMemory(db, {
        type: "rule",
        text: `rule ${i}`,
        scope: "repo",
        path_scope: null,
        repo: "busy/repo",
        source: "user_correction",
        confidence: 0.9,
      });
      db.update(memories).set({ status: "active" }).where(eq(memories.id, id)).run();
    }

    const enqueued = produceSynthesizeRepoTasks(db, {
      repo_synthesis_min_memories: 3,
      repo_synthesis_refresh_days: 30,
    });
    expect(enqueued).toBe(1);

    const tasks = listTasks(db, { kinds: ["synthesize_repo"] });
    expect(tasks).toHaveLength(1);
    expect((tasks[0].payload as any).repo).toBe("busy/repo");
    expect((tasks[0].payload as any).top_memories.length).toBe(5);
  });

  it("produceSynthesizeRepoTasks skips repos with recent synthesis snippet", () => {
    const db = freshDb();
    for (let i = 0; i < 4; i++) {
      const id = createMemory(db, {
        type: "rule",
        text: `r ${i}`,
        scope: "repo",
        path_scope: null,
        repo: "already/done",
        source: "user_correction",
        confidence: 0.9,
      });
      db.update(memories).set({ status: "active" }).where(eq(memories.id, id)).run();
    }
    const now = new Date().toISOString();
    db.insert(historySnippets).values({
      id: randomUUID(),
      repo: "already/done",
      session_id: null,
      kind: "repo_synthesis",
      text: "recent synthesis",
      source_activity_ids: [] as any,
      created_at: now,
      updated_at: now,
    }).run();

    const enqueued = produceSynthesizeRepoTasks(db, {
      repo_synthesis_min_memories: 3,
      repo_synthesis_refresh_days: 30,
    });
    expect(enqueued).toBe(0);
  });

  it("synthesize_repo applier creates a repo_synthesis snippet", () => {
    const db = freshDb();
    for (let i = 0; i < 4; i++) {
      const id = createMemory(db, {
        type: "rule",
        text: `r ${i}`,
        scope: "repo",
        path_scope: null,
        repo: "synth/me",
        source: "user_correction",
        confidence: 0.9,
      });
      db.update(memories).set({ status: "active" }).where(eq(memories.id, id)).run();
    }
    produceSynthesizeRepoTasks(db, {
      repo_synthesis_min_memories: 3,
      repo_synthesis_refresh_days: 30,
    });
    const task = listTasks(db, { kinds: ["synthesize_repo"] })[0];
    claimTask(db, task.id, "claude-code");
    const outcome = submitTask(db, task.id, "claude-code", {
      summary_text: "synth/me: strong preferences around uv + pytest; avoid pip.",
    });
    expect(outcome.status).toBe("applied");

    const snippet = db.select().from(historySnippets)
      .where(and(
        eq(historySnippets.repo, "synth/me"),
        eq(historySnippets.kind, "repo_synthesis"),
      ))
      .get()!;
    expect(snippet.text).toMatch(/uv \+ pytest/);
  });

  it("merge_duplicates applier rejects losers, supersedes to winner, updates winner", () => {
    const db = freshDb();
    const w = createMemory(db, {
      type: "rule",
      text: "always use uv",
      scope: "repo",
      path_scope: null,
      repo: "merge/test",
      source: "user_correction",
      confidence: 0.9,
    });
    const l1 = createMemory(db, {
      type: "rule",
      text: "always uv",
      scope: "repo",
      path_scope: null,
      repo: "merge/test",
      source: "user_correction",
      confidence: 0.5,
    });
    const l2 = createMemory(db, {
      type: "rule",
      text: "prefer uv",
      scope: "repo",
      path_scope: null,
      repo: "merge/test",
      source: "user_correction",
      confidence: 0.4,
    });
    db.update(memories).set({ status: "active" })
      .where(eq(memories.id, w)).run();

    const taskId = insertTaskIdempotent(db, {
      kind: "merge_duplicates",
      target: [w, l1, l2].sort()[0],
      repo: "merge/test",
      payload: {
        repo: "merge/test",
        type: "rule",
        candidates: [w, l1, l2].map((id) => ({
          id,
          text: `text-${id}`,
          scope: "repo",
          path_scope: null,
        })),
      },
    })!;

    claimTask(db, taskId, "claude-code");
    const outcome = submitTask(db, taskId, "claude-code", {
      winner_id: w,
      winner_text: "always use uv, never pip",
      winner_scope: "repo",
      rationale: "consolidated phrasing",
    });
    expect(outcome.status).toBe("applied");

    const winner = getMemory(db, w)!;
    expect(winner.text).toBe("always use uv, never pip");
    expect(winner.status).not.toBe("rejected");

    const loser1 = getMemory(db, l1)!;
    expect(loser1.status).toBe("rejected");
    expect(loser1.supersedes).toBe(w);

    const loser2 = getMemory(db, l2)!;
    expect(loser2.status).toBe("rejected");
    expect(loser2.supersedes).toBe(w);
  });

  it("merge_duplicates rejects when winner_id is not in candidates", () => {
    const db = freshDb();
    const a = createMemory(db, {
      type: "rule", text: "a", scope: "repo", path_scope: null,
      repo: "merge/test", source: "user_correction", confidence: 0.5,
    });
    const b = createMemory(db, {
      type: "rule", text: "b", scope: "repo", path_scope: null,
      repo: "merge/test", source: "user_correction", confidence: 0.5,
    });
    const taskId = insertTaskIdempotent(db, {
      kind: "merge_duplicates",
      target: [a, b].sort()[0],
      repo: "merge/test",
      payload: {
        repo: "merge/test",
        type: "rule",
        candidates: [a, b].map((id) => ({ id, text: "x", scope: "repo", path_scope: null })),
      },
    })!;
    claimTask(db, taskId, "claude-code");

    const bogus = randomUUID();
    const outcome = submitTask(db, taskId, "claude-code", {
      winner_id: bogus,
    });
    expect(outcome.status).toBe("rejected");
    expect((outcome as any).abandoned).toBe(true);
  });
});
