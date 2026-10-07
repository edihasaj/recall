/**
 * Opt-in LLM relevance judge for query-driven context packs.
 *
 * The local path (notes, embeddings, the small re-ranker) runs on any device
 * and needs no model provider. When the user has connected one and sets
 * RECALL_RELEVANCE_LLM=true, one call per request asks that model which of
 * the top candidates would change what a careful assistant does, the same
 * counterfactual question the local models are trained on. Only memories it
 * grades at least RECALL_RELEVANCE_LLM_MIN_GRADE (default 3) are injected:
 * on the coding benchmark grade 2 also admitted broad conventions (naming,
 * test framework) that the session-start pack already carries, and a false
 * injection on 64% of dev controls against 12% at grade 3.
 *
 * The call has a time budget (RECALL_RELEVANCE_LLM_TIMEOUT_MS, default 8000,
 * inside the 15 s the prompt hook waits for the daemon; with gpt-5-mini a
 * judged request took about 4 s at p50 and 6 s at p95).
 * A timeout, a missing provider or any error returns null, and the caller
 * keeps the local decision. Results are cached in memory per request and
 * candidate set.
 */
import { createHash } from "node:crypto";
import type { RecallDb } from "../db/client.js";
import { callLlm, type LlmProvider } from "../llm/client.js";
import { hasProviderConfigured } from "../credentials/keychain.js";
import { retrievalText } from "../models/retrieval-text.js";
import type { MemoryItem } from "../types.js";

/** How many top candidates the judge grades: RECALL_RELEVANCE_LLM_CANDIDATES, default 8. */
export function llmJudgeCandidates(): number {
  const parsed = Number.parseInt(process.env.RECALL_RELEVANCE_LLM_CANDIDATES ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 32 ? parsed : 8;
}
const CACHE_MAX = 256;
const cache = new Map<string, Map<string, number>>();
type Judge = (query: string, memories: MemoryItem[]) => Promise<Map<string, number> | null>;
let judgeOverride: Judge | null = null;

const SYSTEM = [
  "You decide which remembered facts or rules should change how a careful coding assistant handles a request.",
  "Imagine handling the request twice, once without the memory and once knowing it. Grade each memory:",
  "0 = no difference (irrelevant, or only shares a topic); 1 = at most a passing mention;",
  "2 = it changes some details, steps or caveats; 3 = it changes the plan, prevents a mistake, or makes the naive answer wrong.",
  "Judge each memory independently. Reply with JSON only.",
].join(" ");

function provider(): LlmProvider | null {
  for (const candidate of ["anthropic", "azure-openai", "openai"] as LlmProvider[]) {
    if (hasProviderConfigured(candidate)) return candidate;
  }
  return null;
}

export function llmJudgeMinGrade(): number {
  const parsed = Number.parseInt(process.env.RECALL_RELEVANCE_LLM_MIN_GRADE ?? "", 10);
  return [1, 2, 3].includes(parsed) ? parsed : 3;
}

export function isLlmJudgeEnabled(): boolean {
  return process.env.RECALL_RELEVANCE_LLM === "true" && (judgeOverride !== null || provider() !== null);
}

function timeoutMs(): number {
  const parsed = Number.parseInt(process.env.RECALL_RELEVANCE_LLM_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
}

function parseGrades(text: string, memories: MemoryItem[]): Map<string, number> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { grades?: Array<{ i?: unknown; grade?: unknown }> };
    const grades = new Map<string, number>();
    for (const entry of parsed.grades ?? []) {
      const i = Number(entry.i);
      const grade = Number(entry.grade);
      if (Number.isInteger(i) && i >= 0 && i < memories.length && [0, 1, 2, 3].includes(grade)) {
        grades.set(memories[i].id, grade);
      }
    }
    return grades.size > 0 ? grades : null;
  } catch {
    return null;
  }
}

async function callJudge(db: RecallDb, query: string, memories: MemoryItem[]): Promise<Map<string, number> | null> {
  const chosen = provider();
  if (!chosen) return null;
  const user = [
    `REQUEST: ${JSON.stringify(query)}`,
    "",
    ...memories.map((memory, i) => `${i}. ${JSON.stringify(retrievalText(memory))}`),
    "",
    `Reply as JSON: {"grades": [{"i": <index>, "grade": 0|1|2|3}, ...]} with one entry for each of the ${memories.length} memories.`,
  ].join("\n");
  const call = callLlm(db, {
    provider: chosen,
    system: SYSTEM,
    user,
    max_output_tokens: 1500,
    json_output: true,
    task_kind: "relevance_judge",
  }).then((result) => parseGrades(result.text, memories));
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs()).unref());
  return Promise.race([call.catch(() => null), timeout]);
}

/**
 * Grades (0-3) by memory id for the given candidates, or null when the judge
 * is off, unavailable, slow or fails. Callers then keep their local decision.
 */
export async function judgeRelevance(
  db: RecallDb,
  query: string,
  memories: MemoryItem[],
): Promise<Map<string, number> | null> {
  if (!isLlmJudgeEnabled() || memories.length === 0) return null;
  const candidates = memories.slice(0, llmJudgeCandidates());
  const key = createHash("sha256")
    .update(JSON.stringify([query, candidates.map((m) => [m.id, retrievalText(m)])]))
    .digest("hex");
  const cached = cache.get(key);
  if (cached) return cached;
  const grades = judgeOverride ? await judgeOverride(query, candidates) : await callJudge(db, query, candidates);
  if (grades) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, grades);
  }
  return grades;
}

// Test helper: replace the provider call (null restores it) and clear the cache.
export function setLlmJudgeForTests(judge: Judge | null): void {
  judgeOverride = judge;
  cache.clear();
}
