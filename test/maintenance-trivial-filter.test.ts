import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { createHistorySnippet } from "../src/history/snippets.js";
import {
  produceSummarizeHistoryTasks,
  snippetHasMeaningfulContent,
  listTasks,
} from "../src/maintenance/tasks.js";

afterEach(() => closeDb());

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-trivial-filter-"));
  return initStandaloneDb(join(dir, "trivial.db"));
}

describe("snippetHasMeaningfulContent", () => {
  it("rejects the deterministic event-type stub", () => {
    expect(snippetHasMeaningfulContent(
      "Repo: edihasaj/recall\nEvent types: scan, session_start, session_event, session_end",
    )).toBe(false);
  });

  it("accepts snippets containing corrections", () => {
    expect(snippetHasMeaningfulContent(
      "Repo: edihasaj/recall\nEvent types: session_end\nCorrections: don't use npm, use pnpm",
    )).toBe(true);
  });

  it("accepts snippets containing review feedback", () => {
    expect(snippetHasMeaningfulContent(
      "Repo: x\nReviews: missing test for retry path",
    )).toBe(true);
  });

  it("accepts snippets with a compile marker", () => {
    expect(snippetHasMeaningfulContent(
      "Repo: x\nEvent types: compile\nLatest compile included 4 memories.",
    )).toBe(true);
  });
});

describe("produceSummarizeHistoryTasks — trivial-filter", () => {
  it("does not enqueue a task for a Repo/Event-types-only snippet", () => {
    const db = freshDb();
    createHistorySnippet(db, {
      repo: "edihasaj/recall",
      session_id: "sess-trivial",
      kind: "session_summary",
      text: "Repo: edihasaj/recall\nEvent types: scan, session_start, session_event, session_end",
      source_activity_ids: [],
    });

    const enqueued = produceSummarizeHistoryTasks(db, { summary_max_age_days: 30 });
    expect(enqueued).toBe(0);
    expect(listTasks(db, { status: "pending" })).toHaveLength(0);
  });

  it("enqueues a task for a snippet with corrections", () => {
    const db = freshDb();
    createHistorySnippet(db, {
      repo: "edihasaj/recall",
      session_id: "sess-real",
      kind: "session_summary",
      text: "Repo: edihasaj/recall\nEvent types: session_end\nCorrections: always use pnpm",
      source_activity_ids: [],
    });

    const enqueued = produceSummarizeHistoryTasks(db, { summary_max_age_days: 30 });
    expect(enqueued).toBe(1);
  });
});
