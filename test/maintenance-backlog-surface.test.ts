import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { insertTaskIdempotent } from "../src/maintenance/tasks.js";
import {
  formatMaintenanceBacklogContext,
  handleSessionStartHook,
} from "../src/cli/hook.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-backlog-surface-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("phase 6 — maintenance backlog surface on session_started", () => {
  it("omits backlog by default (env flag not set)", async () => {
    delete process.env.RECALL_MAINTENANCE_SURFACE_ON_START;
    const db = freshDb();
    insertTaskIdempotent(db, {
      kind: "summarize_history", target: "s1", repo: "test/repo", payload: {},
    });

    const result = await handleSessionStartHook(
      { session_id: "sess-1", agent: "claude-code", repo: "test/repo" },
      { db },
    );
    expect(result.maintenance_backlog).toBeUndefined();
  });

  it("surfaces pending tasks for the session repo when env flag is set", async () => {
    process.env.RECALL_MAINTENANCE_SURFACE_ON_START = "true";
    const db = freshDb();
    insertTaskIdempotent(db, {
      kind: "summarize_history", target: "s1", repo: "test/repo", payload: {},
    });
    insertTaskIdempotent(db, {
      kind: "refine_candidate", target: "m1", repo: "test/repo", payload: {},
    });
    insertTaskIdempotent(db, {
      kind: "summarize_history", target: "s2", repo: "other/repo", payload: {},
    });

    const result = await handleSessionStartHook(
      { session_id: "sess-1", agent: "claude-code", repo: "test/repo" },
      { db },
    );
    const surface = result.maintenance_backlog!;
    expect(surface.pending_total).toBe(2);
    expect(surface.by_kind.summarize_history).toBe(1);
    expect(surface.by_kind.refine_candidate).toBe(1);
    delete process.env.RECALL_MAINTENANCE_SURFACE_ON_START;
  });

  it("formatMaintenanceBacklogContext produces a single readable line", () => {
    const line = formatMaintenanceBacklogContext({
      pending_total: 3,
      by_kind: { summarize_history: 2, refine_candidate: 1 },
      sample: [
        { id: "12345678-aaaa-bbbb-cccc-deadbeef0000", kind: "summarize_history", repo: "test/repo" },
      ],
    });
    expect(line).toMatch(/3 pending/);
    expect(line).toMatch(/summarize_history|refine_candidate/);
    expect(line).toMatch(/maintenance_peek/);
  });
});
