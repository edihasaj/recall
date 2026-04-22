import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { llmUsage } from "../src/db/schema.js";
import { formatUsageReport, summarizeUsage } from "../src/llm/usage.js";

afterEach(() => {
  closeDb();
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-llm-usage-"));
  return initStandaloneDb(join(dir, "usage.db"));
}

function seed(
  db: ReturnType<typeof freshDb>,
  rows: Array<Partial<typeof llmUsage.$inferInsert>>,
) {
  const nowBase = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    db.insert(llmUsage).values({
      id: row.id ?? randomUUID(),
      provider: row.provider ?? "openai",
      model: row.model ?? "gpt-4o-mini",
      task_kind: row.task_kind ?? "dedupe",
      task_id: row.task_id ?? null,
      repo: row.repo ?? null,
      prompt_tokens: row.prompt_tokens ?? 100,
      completion_tokens: row.completion_tokens ?? 50,
      total_tokens: row.total_tokens ?? 150,
      cost_usd: row.cost_usd ?? 0.01,
      duration_ms: row.duration_ms ?? 200,
      ok: row.ok ?? true,
      error: row.error ?? null,
      created_at: row.created_at ?? new Date(nowBase - i * 1000).toISOString(),
    }).run();
  }
}

describe("llm usage summary", () => {
  it("aggregates totals + groups by model", () => {
    const db = freshDb();
    seed(db, [
      { provider: "openai", model: "gpt-4o-mini", prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost_usd: 0.02 },
      { provider: "openai", model: "gpt-4o-mini", prompt_tokens: 200, completion_tokens: 100, total_tokens: 300, cost_usd: 0.04 },
      { provider: "anthropic", model: "claude-haiku-4-5-20251001", prompt_tokens: 80, completion_tokens: 40, total_tokens: 120, cost_usd: 0.015 },
    ]);

    const summary = summarizeUsage(db);
    expect(summary.total_calls).toBe(3);
    expect(summary.ok_calls).toBe(3);
    expect(summary.error_calls).toBe(0);
    expect(summary.total_tokens).toBe(570);
    expect(summary.total_cost_usd).toBeCloseTo(0.075, 5);
    expect(summary.by_model).toHaveLength(2);
    const openaiRow = summary.by_model.find((r) => r.provider === "openai")!;
    expect(openaiRow.calls).toBe(2);
    expect(openaiRow.total_tokens).toBe(450);
  });

  it("counts failures separately and preserves recent ordering", () => {
    const db = freshDb();
    seed(db, [
      { ok: true, created_at: "2026-04-22T10:00:00.000Z" },
      { ok: false, error: "429 rate limit", created_at: "2026-04-22T09:00:00.000Z" },
      { ok: true, created_at: "2026-04-22T08:00:00.000Z" },
    ]);
    const summary = summarizeUsage(db, { recentLimit: 5 });
    expect(summary.ok_calls).toBe(2);
    expect(summary.error_calls).toBe(1);
    expect(summary.recent[0].created_at).toBe("2026-04-22T10:00:00.000Z");
  });

  it("filters by since window", () => {
    const db = freshDb();
    seed(db, [
      { created_at: "2026-04-22T10:00:00.000Z" },
      { created_at: "2026-01-01T00:00:00.000Z" },
    ]);
    const summary = summarizeUsage(db, { sinceIso: "2026-04-01T00:00:00.000Z" });
    expect(summary.total_calls).toBe(1);
  });

  it("formatUsageReport surfaces totals and model rows", () => {
    const report = formatUsageReport({
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
      total_calls: 5,
      ok_calls: 4,
      error_calls: 1,
      total_prompt_tokens: 1_000,
      total_completion_tokens: 400,
      total_tokens: 1_400,
      total_cost_usd: 0.1234,
      by_model: [
        { provider: "openai", model: "gpt-4o-mini", calls: 3, total_tokens: 900, cost_usd: 0.08 },
      ],
      recent: [
        {
          created_at: "2026-01-30T10:00:00.000Z",
          provider: "openai",
          model: "gpt-4o-mini",
          task_kind: "dedupe",
          total_tokens: 300,
          cost_usd: 0.02,
          ok: true,
        },
      ],
    });
    expect(report).toContain("Total calls:   5");
    expect(report).toContain("openai/gpt-4o-mini");
    expect(report).toContain("dedupe");
    expect(report).toContain("$0.0200");
  });
});
