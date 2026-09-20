import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import {
  handleAssistantCompletionHook,
  handleSessionStartHook,
  handleToolHook,
} from "../src/cli/hook.js";
import { computeReliabilityReport, formatReliabilityReport } from "../src/reliability/report.js";
import { createActivityEvent } from "../src/models/activity.js";

function freshDb() {
  return initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-reliability-")), "recall.db"));
}

beforeEach(() => { process.env.RECALL_EMBEDDINGS_DISABLED = "true"; });
afterEach(() => {
  closeDb();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
});

describe("reliability report", () => {
  it("separates selection, emission, observed use, and resolved outcome", async () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "Use pnpm for package commands.",
      scope: "repo",
      repo: "fixture/reliability",
      source: "user_correction",
      confidence: 0.9,
    });

    const start = await handleSessionStartHook({
      session_id: "session-1",
      agent: "codex",
      repo: "fixture/reliability",
    }, { db });
    expect(start.injection?.memories_included).toHaveLength(1);

    await handleAssistantCompletionHook({
      session_id: "session-1",
      agent: "codex",
      repo: "fixture/reliability",
      text: "Used pnpm for package commands.",
    }, { db });
    await handleToolHook({
      session_id: "session-1",
      agent: "codex",
      repo: "fixture/reliability",
      name: "pnpm package command",
      input_summary: "Use pnpm for package commands.",
      exit_code: 0,
    }, { db });

    const report = computeReliabilityReport(db, { since: "2000-01-01T00:00:00.000Z" });
    expect(report.sessions).toBe(1);
    expect(report.repo_attribution_rate).toBe(1);
    expect(report.selected_injections).toBe(1);
    expect(report.emitted_injections).toBe(1);
    expect(report.emission_coverage).toBe(1);
    expect(report.observed_uses).toBe(1);
    expect(report.resolved_outcomes).toBe(1);
    expect(report.outcome_coverage).toBe(1);
    expect(formatReliabilityReport(report)).toContain("1 selected, 1 emitted (100.0%)");
  });

  it("reports missing repo attribution and absent evidence as uncertainty", () => {
    const db = freshDb();
    createActivityEvent(db, {
      session_id: "session-without-repo",
      repo: null,
      source: "hook:codex",
      event_type: "session_start",
      request: { repo_path: "/Users/test/Projects/unresolved-repo" },
    });
    const report = computeReliabilityReport(db, { since: "2000-01-01T00:00:00.000Z" });
    expect(report.repo_attribution_rate).toBe(0);
    expect(report.checks.find((check) => check.name === "repo_attribution")?.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "emission_coverage")?.status).toBe("warn");
    expect(report.overall).toBe("fail");
  });
});
