import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { initStandaloneDb } from "../src/db/client.js";
import { historyInjections, historySnippets } from "../src/db/schema.js";
import { createHistorySnippet } from "../src/history/snippets.js";
import { syncHistoryFtsIndex } from "../src/vector/sqlite-fts-history.js";
import { compileContextHybrid } from "../src/compiler/context.js";

afterEach(() => vi.unstubAllEnvs());

describe("history evidence delivery", () => {
  it("delivers a relevant correction after unrelated leading entries with its record date", async () => {
    vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
    const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-history-evidence-")), "test.db"));
    try {
      const id = createHistorySnippet(db, {
        repo: "fixtures/evidence",
        kind: "decision_summary",
        text: [
          "Repo: fixtures/evidence",
          "Prior decisions:",
          ...Array.from({ length: 12 }, (_, i) => `- Keep archived dashboard theme option ${i}.`),
          "- Zephyr workers now run in Helsinki; the Oslo location is obsolete.",
        ].join("\n"),
      });
      db.update(historySnippets).set({ updated_at: "2026-10-01T12:00:00Z" })
        .where(eq(historySnippets.id, id)).run();
      syncHistoryFtsIndex(db, id);
      const result = await compileContextHybrid(db, {
        repo: "fixtures/evidence", query_text: "Zephyr workers location",
      });
      expect(result.history_included).toContain(id);
      expect(result.text).toContain("Zephyr workers now run in Helsinki");
      expect(result.text).toContain("Oslo location is obsolete");
      expect(result.text).toContain("2026-10-01");
    } finally { db.$client.close(); }
  });

  it("keeps another repository's matching history out of the result", async () => {
    vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
    const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-history-scope-")), "test.db"));
    try {
      const foreign = createHistorySnippet(db, {
        repo: "fixtures/foreign", kind: "decision_summary",
        text: "Zephyr workers run in an undisclosed foreign location.",
      });
      syncHistoryFtsIndex(db, foreign);
      const result = await compileContextHybrid(db, {
        repo: "fixtures/evidence", query_text: "Zephyr workers location",
      });
      expect(result.history_included).not.toContain(foreign);
      expect(result.text).not.toContain("undisclosed");
    } finally { db.$client.close(); }
  });

  it("keeps rejected/chosen scope headings attached to quoted options", async () => {
    vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
    const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-history-headings-")), "test.db"));
    try {
      const id = createHistorySnippet(db, {
        repo: "fixtures/evidence", kind: "decision_summary",
        text: [
          "Rejected options:",
          "- Deploy Zephyr workers to Oslo.",
          "Chosen option:",
          "- Deploy Zephyr workers to Helsinki.",
        ].join("\n"),
      });
      syncHistoryFtsIndex(db, id);
      const result = await compileContextHybrid(db, {
        repo: "fixtures/evidence", query_text: "Zephyr workers",
      });
      expect(result.text).toContain("Rejected options:\n- Deploy Zephyr workers to Oslo.");
      expect(result.text).toContain("Chosen option:\n- Deploy Zephyr workers to Helsinki.");
    } finally { db.$client.close(); }
  });

  it("reports omitted oversized evidence without recording a source injection", async () => {
    vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
    const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-history-omission-")), "test.db"));
    try {
      const id = createHistorySnippet(db, {
        repo: "fixtures/evidence", kind: "decision_summary",
        text: "user: I do not agree that " + "for unrelated reasons ".repeat(30)
          + "Zephyr production uses Redis instead of Postgres.",
      });
      syncHistoryFtsIndex(db, id);
      const result = await compileContextHybrid(db, {
        repo: "fixtures/evidence", query_text: "Zephyr production", session_id: "omission-session",
      });
      expect(result.history_included).toEqual([]);
      expect(result.history_omitted).toEqual([id]);
      expect(result.text).not.toContain("Zephyr production uses Redis");
      expect(result.token_estimate).toBe(Math.ceil(result.text.length / 4));
      expect(db.select().from(historyInjections).all()).toHaveLength(0);
    } finally { db.$client.close(); }
  });
});
