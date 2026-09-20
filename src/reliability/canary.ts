import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initStandaloneDb } from "../db/client.js";
import { createMemory } from "../models/memory.js";
import {
  handleAssistantCompletionHook,
  handleSessionEndHook,
  handleSessionStartHook,
  handleToolHook,
} from "../cli/hook.js";
import { computeReliabilityReport } from "./report.js";
import {
  bootstrapEmbeddings,
  loadEmbeddingConfigFromEnv,
  semanticSearch,
  verifyEmbeddings,
} from "../embeddings/embeddings.js";

export interface ReliabilityCanaryResult {
  ok: boolean;
  duration_ms: number;
  real_embeddings: boolean;
  checks: Record<string, boolean>;
  reliability: ReturnType<typeof computeReliabilityReport>;
  error?: string;
}

export async function runReliabilityCanary(
  options: { real_embeddings?: boolean } = {},
): Promise<ReliabilityCanaryResult> {
  const started = performance.now();
  const root = mkdtempSync(join(tmpdir(), "recall-reliability-canary-"));
  const db = initStandaloneDb(join(root, "recall.db"));
  const priorDisabled = process.env.RECALL_EMBEDDINGS_DISABLED;
  const realEmbeddings = options.real_embeddings === true;
  const checks: Record<string, boolean> = {};
  let reliability = computeReliabilityReport(db, { since: "2000-01-01T00:00:00.000Z" });
  try {
    if (!realEmbeddings) process.env.RECALL_EMBEDDINGS_DISABLED = "true";
    const repo = "recall-canary/reliability";
    const sessionId = `canary-${randomUUID()}`;
    const marker = `recall-canary-${randomUUID().slice(0, 8)}`;
    const memoryId = createMemory(db, {
      type: "rule",
      text: `Use ${marker} for this isolated reliability check.`,
      scope: "repo",
      repo,
      source: "user_correction",
      confidence: 0.99,
    });

    if (realEmbeddings) {
      const configured = loadEmbeddingConfigFromEnv();
      if (!configured) throw new Error("Real embeddings requested but unavailable");
      // The canary checks native ranking and persistence. Product relevance
      // thresholds are measured separately and must not make this probe flaky.
      const config = { ...configured, similarity_threshold: 0 };
      checks.embeddings_bootstrapped = await bootstrapEmbeddings(db, config) === 1;
      const coverage = verifyEmbeddings(db, config, { repo });
      checks.embedding_index_integrity = coverage.stored === 1 && coverage.indexed === 1 && coverage.index_drift === 0;
      const semantic = await semanticSearch(db, `Which marker is used for the isolated reliability check?`, config, { repo, limit: 5 });
      checks.semantic_retrieval = semantic.some((match) => match.memory.id === memoryId);
    }

    const start = await handleSessionStartHook({ session_id: sessionId, agent: "canary", repo }, { db });
    checks.selected_and_emitted = Boolean(
      start.injection?.memories_included.includes(memoryId) && start.injection.text.includes(marker),
    );
    await handleAssistantCompletionHook({
      session_id: sessionId,
      agent: "canary",
      repo,
      text: `Used ${marker} for this isolated reliability check.`,
    }, { db });
    await handleToolHook({
      session_id: sessionId,
      agent: "canary",
      repo,
      name: "reliability check",
      input_summary: `Use ${marker} for this isolated reliability check.`,
      exit_code: 0,
    }, { db });
    await handleSessionEndHook({
      session_id: sessionId,
      agent: "canary",
      repo,
      last_assistant_turn: `Used ${marker} for this isolated reliability check.`,
    }, { db });

    reliability = computeReliabilityReport(db, { since: "2000-01-01T00:00:00.000Z", repo });
    checks.emission_coverage = reliability.emission_coverage === 1;
    checks.outcome_observed = reliability.observed_uses >= 1 && reliability.outcome_coverage === 1;
    checks.database_integrity = db.$client.pragma("quick_check", { simple: true }) === "ok";
    const ok = Object.values(checks).every(Boolean);
    return { ok, duration_ms: Math.round(performance.now() - started), real_embeddings: realEmbeddings, checks, reliability };
  } catch (error) {
    return {
      ok: false,
      duration_ms: Math.round(performance.now() - started),
      real_embeddings: realEmbeddings,
      checks,
      reliability,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.$client.close();
    if (priorDisabled == null) delete process.env.RECALL_EMBEDDINGS_DISABLED;
    else process.env.RECALL_EMBEDDINGS_DISABLED = priorDisabled;
    rmSync(root, { recursive: true, force: true });
  }
}
