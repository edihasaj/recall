import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory, getMemory, getMemoryFeedback } from "../src/models/memory.js";
import { compileContext } from "../src/compiler/context.js";
import { createHistorySnippet } from "../src/history/snippets.js";
import { computeQualityReport, recordQualitySnapshot } from "../src/maintenance/quality.js";
import { handleAssistantCompletionHook, handlePromptHook, handleToolHook } from "../src/cli/hook.js";
import { computeMemoryValueReport, recordCompletionUseValueEvents } from "../src/models/memory-value.js";

let dbCounter = 0;

function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  process.env.RECALL_LLM_CAPTURE_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-memory-quality-p3-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("memory quality phase 3 outcome-after-injection", () => {
  it("tracks injected memories once per memory/session", () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    const first = compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-1",
    });
    const second = compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-1",
    });

    expect(first.memories_included).toEqual([memoryId]);
    expect(second.memories_included).toEqual([memoryId]);
    const rows = db.$client
      .prepare("select count(*) as count from memory_injections where session_id = ? and memory_id = ?")
      .get("sess-1", memoryId) as { count: number };
    expect(rows.count).toBe(1);

    const valueRows = db.$client
      .prepare("select event_type, injected_tokens_estimate from memory_value_events where session_id = ? and memory_id = ?")
      .all("sess-1", memoryId) as Array<{ event_type: string; injected_tokens_estimate: number }>;
    expect(valueRows).toHaveLength(1);
    expect(valueRows[0].event_type).toBe("injected");
    expect(valueRows[0].injected_tokens_estimate).toBeGreaterThan(0);
  });

  it("tracks injected history snippets once per snippet/session", () => {
    const db = freshDb();
    const snippetId = createHistorySnippet(db, {
      repo: "edihasaj/recall",
      kind: "decision_summary",
      text: "Repo: edihasaj/recall\nFrequent user decisions:\n- (1) User direction: do phase 5.",
    });

    const first = compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-history",
    });
    const second = compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-history",
    });

    expect(first.history_included).toEqual([snippetId]);
    expect(second.history_included).toEqual([snippetId]);
    const rows = db.$client
      .prepare("select count(*) as count from history_injections where session_id = ? and snippet_id = ?")
      .get("sess-history", snippetId) as { count: number };
    expect(rows.count).toBe(1);

    const report = computeQualityReport(db, { sinceIso: new Date(Date.now() - 60_000).toISOString() });
    expect(report.history_injections.total).toBe(1);
    expect(report.history_injections.unique_snippets).toBe(1);

    const snapshot = recordQualitySnapshot(db, report, "history-telemetry");
    expect(snapshot.history_injections_total).toBe(1);
    expect(snapshot.history_snippets_injected).toBe(1);
  });

  it("marks followed when a relevant tool runs after injection", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "path",
      path_scope: "src/**",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      path: "src/cli.ts",
      session_id: "sess-2",
    });

    await handleToolHook(
      {
        session_id: "sess-2",
        repo: "edihasaj/recall",
        name: "Edit",
        path: "src/cli.ts",
        exit_code: 0,
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const feedback = getMemoryFeedback(db, memoryId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].outcome).toBe("followed");
    expect(getMemory(db, memoryId)!.confidence).toBeCloseTo(0.85);

    const report = computeMemoryValueReport(db, { sinceIso: new Date(Date.now() - 60_000).toISOString() });
    expect(report.outcomes.followed).toBe(1);
    expect(report.injected_tokens_estimate).toBeGreaterThan(0);
    expect(report.saved_tokens_estimate).toBeGreaterThan(0);
    expect(report.net_tokens_estimate).toBe(report.saved_tokens_estimate - report.injected_tokens_estimate);
    expect(report.net_tokens_estimate).toBe(0);
    expect(report.top_savers[0].memory_id).toBe(memoryId);
  });

  it("records completion-use evidence for injected memories without changing confidence", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm for package commands.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });
    const notInjected = createMemory(db, {
      type: "rule",
      text: "Use uv for Python commands.",
      scope: "path",
      path_scope: "python/**",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-used",
      config: { max_lines: 1, max_commands: 0, max_gotchas: 0 },
    });

    const result = recordCompletionUseValueEvents(db, {
      session_id: "sess-used",
      repo: "edihasaj/recall",
      completion_text: "Use pnpm for package commands. I kept the lockfile in sync.",
      source: "cli",
    });

    expect(result.recorded).toBe(1);
    expect(result.memory_ids).toEqual([memoryId]);
    expect(getMemory(db, memoryId)!.confidence).toBeCloseTo(0.8);

    const explicit = recordCompletionUseValueEvents(db, {
      session_id: "sess-used",
      repo: "edihasaj/recall",
      completion_text: "I explicitly used it again.",
      memory_ids: [memoryId, notInjected],
      source: "cli",
    });
    expect(explicit.recorded).toBe(0);
    expect(explicit.memory_ids).toEqual([memoryId]);

    const rows = db.$client
      .prepare("select event_type, saved_tokens_estimate, evidence from memory_value_events where session_id = ? and event_type = 'used'")
      .all("sess-used") as Array<{ event_type: string; saved_tokens_estimate: number; evidence: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].saved_tokens_estimate).toBeGreaterThan(0);
    expect(JSON.parse(rows[0].evidence).completion_excerpt).toContain("pnpm");

    const report = computeMemoryValueReport(db, { sinceIso: new Date(Date.now() - 60_000).toISOString() });
    expect(report.used).toBe(1);
    expect(report.saved_tokens_estimate).toBeGreaterThan(0);
    expect(report.top_savers[0]).toMatchObject({ memory_id: memoryId, used: 1, followed: 0 });
  });

  it("infers completion-use evidence from paraphrased assistant text", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm for package commands.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-used-paraphrase",
    });

    const result = recordCompletionUseValueEvents(db, {
      session_id: "sess-used-paraphrase",
      repo: "edihasaj/recall",
      completion_text: "I ran the package command with pnpm and kept the lockfile in sync.",
      source: "cli",
    });

    expect(result).toMatchObject({ recorded: 1, memory_ids: [memoryId] });
  });

  it("does not infer completion-use from one shared low-information token", async () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "Do not use npm. Use pnpm instead.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-used-short-overlap",
    });

    const result = recordCompletionUseValueEvents(db, {
      session_id: "sess-used-short-overlap",
      repo: "edihasaj/recall",
      completion_text: "I used npm for this one command.",
      source: "cli",
    });

    expect(result).toEqual({ recorded: 0, memory_ids: [] });
  });

  it("hook assistant records completion-use evidence", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm for package commands.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-assistant-hook",
    });

    await handleAssistantCompletionHook(
      {
        session_id: "sess-assistant-hook",
        repo: "edihasaj/recall",
        text: "Used pnpm for package commands and committed the lockfile.",
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const rows = db.$client
      .prepare("select event_type, source from memory_value_events where session_id = ? and memory_id = ? and event_type = 'used'")
      .all("sess-assistant-hook", memoryId) as Array<{ event_type: string; source: string }>;
    expect(rows).toEqual([{ event_type: "used", source: "hook:codex" }]);
  });

  it("leaves outcome unresolved when the next prompt has no relevant tool activity", async () => {
    // Honest signaling (Phase 2.3): we don't know whether a non-applicable
    // prompt means the memory was ignored or simply wasn't relevant, so leave
    // it unresolved instead of writing a misleading "ignored".
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Use pnpm",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-3",
    });

    await handlePromptHook(
      {
        session_id: "sess-3",
        repo: "edihasaj/recall",
        text: "thanks, keep going",
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const feedback = getMemoryFeedback(db, memoryId);
    expect(feedback).toHaveLength(0);
    expect(getMemory(db, memoryId)!.confidence).toBeCloseTo(0.8);
  });

  it("marks contradicted when the next prompt repeats the same correction", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Do not use npm. Use pnpm instead.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-4",
    });

    await handlePromptHook(
      {
        session_id: "sess-4",
        repo: "edihasaj/recall",
        text: "don't use npm, use pnpm",
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const feedback = getMemoryFeedback(db, memoryId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].outcome).toBe("contradicted");
    expect(getMemory(db, memoryId)!.confidence).toBeCloseTo(0.55);
  });

  it("marks contradicted when the next prompt paraphrases the stored correction", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Do not use npm. Use pnpm instead.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    compileContext(db, {
      repo: "edihasaj/recall",
      session_id: "sess-contradicted-paraphrase",
    });

    await handlePromptHook(
      {
        session_id: "sess-contradicted-paraphrase",
        repo: "edihasaj/recall",
        text: "stop using npm; pnpm only",
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const feedback = getMemoryFeedback(db, memoryId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].outcome).toBe("contradicted");
  });

  it("records a retrieval miss when a repeated correction matched memory was not injected", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Always use pnpm for package commands.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    await handlePromptHook(
      {
        session_id: "sess-miss",
        repo: "edihasaj/recall",
        text: "Always use pnpm for package commands.",
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const rows = db.$client
      .prepare("select event_type, memory_id, saved_tokens_estimate, evidence from memory_value_events where session_id = ? and event_type = 'retrieval_miss'")
      .all("sess-miss") as Array<{ event_type: string; memory_id: string; saved_tokens_estimate: number; evidence: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].memory_id).toBe(memoryId);
    expect(rows[0].saved_tokens_estimate).toBe(0);
    expect(JSON.parse(rows[0].evidence).correction_text).toContain("Always use pnpm");
  });

  it("records a retrieval miss when a repeated correction is paraphrased", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Do not use npm. Use pnpm instead.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.8,
    });

    await handlePromptHook(
      {
        session_id: "sess-miss-paraphrase",
        repo: "edihasaj/recall",
        text: "stop using npm; pnpm only",
        agent: "codex",
      },
      { db, source: "cli" },
    );

    const rows = db.$client
      .prepare("select event_type, memory_id from memory_value_events where session_id = ? and event_type = 'retrieval_miss'")
      .all("sess-miss-paraphrase") as Array<{ event_type: string; memory_id: string }>;
    expect(rows).toEqual([{ event_type: "retrieval_miss", memory_id: memoryId }]);
  });

  it("promotes a candidate memory when a missed matching correction repeats", async () => {
    const db = freshDb();
    const memoryId = createMemory(db, {
      type: "rule",
      text: "Always run the full gate before handoff.",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.45,
    });
    expect(getMemory(db, memoryId)!.status).toBe("candidate");

    await handlePromptHook(
      {
        session_id: "sess-miss-promote",
        repo: "edihasaj/recall",
        text: "Always run the full gate before handoff.",
        agent: "codex",
      },
      { db, source: "cli" },
    );

    expect(getMemory(db, memoryId)!.status).toBe("active");
    const evidence = db.$client
      .prepare("select evidence from memory_value_events where session_id = ? and event_type = 'retrieval_miss'")
      .get("sess-miss-promote") as { evidence: string };
    expect(JSON.parse(evidence.evidence).reason).toContain("promoted");
  });
});
