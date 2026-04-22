import { and, desc, gte, sql } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { llmUsage } from "../db/schema.js";

export interface UsageSummary {
  since: string;
  until: string;
  total_calls: number;
  ok_calls: number;
  error_calls: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  by_model: Array<{
    provider: string;
    model: string;
    calls: number;
    total_tokens: number;
    cost_usd: number;
  }>;
  recent: Array<{
    created_at: string;
    provider: string;
    model: string;
    task_kind: string;
    total_tokens: number;
    cost_usd: number | null;
    ok: boolean;
  }>;
}

export function summarizeUsage(
  db: RecallDb,
  opts: { sinceIso?: string; recentLimit?: number } = {},
): UsageSummary {
  const sinceIso = opts.sinceIso ?? defaultSinceIso();
  const untilIso = new Date().toISOString();

  const whereClause = gte(llmUsage.created_at, sinceIso);

  const [totals] = db
    .select({
      total_calls: sql<number>`count(*)`.as("total_calls"),
      ok_calls: sql<number>`sum(case when ${llmUsage.ok} = 1 then 1 else 0 end)`.as("ok_calls"),
      error_calls: sql<number>`sum(case when ${llmUsage.ok} = 0 then 1 else 0 end)`.as("error_calls"),
      total_prompt_tokens: sql<number>`coalesce(sum(${llmUsage.prompt_tokens}), 0)`.as("total_prompt_tokens"),
      total_completion_tokens: sql<number>`coalesce(sum(${llmUsage.completion_tokens}), 0)`.as("total_completion_tokens"),
      total_tokens: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)`.as("total_tokens"),
      total_cost_usd: sql<number>`coalesce(sum(${llmUsage.cost_usd}), 0)`.as("total_cost_usd"),
    })
    .from(llmUsage)
    .where(whereClause)
    .all();

  const byModel = db
    .select({
      provider: llmUsage.provider,
      model: llmUsage.model,
      calls: sql<number>`count(*)`.as("calls"),
      total_tokens: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)`.as("total_tokens"),
      cost_usd: sql<number>`coalesce(sum(${llmUsage.cost_usd}), 0)`.as("cost_usd"),
    })
    .from(llmUsage)
    .where(whereClause)
    .groupBy(llmUsage.provider, llmUsage.model)
    .orderBy(desc(sql`count(*)`))
    .all();

  const recent = db
    .select({
      created_at: llmUsage.created_at,
      provider: llmUsage.provider,
      model: llmUsage.model,
      task_kind: llmUsage.task_kind,
      total_tokens: llmUsage.total_tokens,
      cost_usd: llmUsage.cost_usd,
      ok: llmUsage.ok,
    })
    .from(llmUsage)
    .where(whereClause)
    .orderBy(desc(llmUsage.created_at))
    .limit(opts.recentLimit ?? 10)
    .all();

  return {
    since: sinceIso,
    until: untilIso,
    total_calls: totals?.total_calls ?? 0,
    ok_calls: totals?.ok_calls ?? 0,
    error_calls: totals?.error_calls ?? 0,
    total_prompt_tokens: totals?.total_prompt_tokens ?? 0,
    total_completion_tokens: totals?.total_completion_tokens ?? 0,
    total_tokens: totals?.total_tokens ?? 0,
    total_cost_usd: totals?.total_cost_usd ?? 0,
    by_model: byModel.map((row) => ({
      provider: row.provider,
      model: row.model,
      calls: row.calls,
      total_tokens: row.total_tokens,
      cost_usd: row.cost_usd,
    })),
    recent: recent.map((row) => ({
      created_at: row.created_at,
      provider: row.provider,
      model: row.model,
      task_kind: row.task_kind,
      total_tokens: row.total_tokens,
      cost_usd: row.cost_usd,
      ok: row.ok,
    })),
  };
}

export function formatUsageReport(summary: UsageSummary): string {
  const lines: string[] = [
    "# Recall LLM Usage",
    `Window:        ${summary.since} → ${summary.until}`,
    `Total calls:   ${summary.total_calls} (ok=${summary.ok_calls} err=${summary.error_calls})`,
    `Total tokens:  ${summary.total_tokens.toLocaleString()} (in=${summary.total_prompt_tokens.toLocaleString()} out=${summary.total_completion_tokens.toLocaleString()})`,
    `Total cost:    $${summary.total_cost_usd.toFixed(4)}`,
  ];

  if (summary.by_model.length > 0) {
    lines.push("", "## By model");
    for (const row of summary.by_model) {
      lines.push(
        `  ${row.provider}/${row.model}  calls=${row.calls}  tokens=${row.total_tokens.toLocaleString()}  cost=$${row.cost_usd.toFixed(4)}`,
      );
    }
  }

  if (summary.recent.length > 0) {
    lines.push("", "## Recent calls");
    for (const row of summary.recent) {
      const cost = row.cost_usd != null ? `$${row.cost_usd.toFixed(4)}` : "—";
      lines.push(
        `  ${row.created_at}  ${row.ok ? "ok " : "ERR"}  ${row.provider}/${row.model}  ${row.task_kind}  tokens=${row.total_tokens}  ${cost}`,
      );
    }
  }

  return lines.join("\n");
}

function defaultSinceIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString();
}
