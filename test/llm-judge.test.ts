import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { compileContextHybrid } from "../src/compiler/context.js";
import { initStandaloneDb } from "../src/db/client.js";
import { isLlmJudgeEnabled, setLlmJudgeForTests } from "../src/embeddings/llm-judge.js";
import { createMemory } from "../src/models/memory.js";

afterEach(() => {
  setLlmJudgeForTests(null);
  vi.unstubAllEnvs();
});

const repo = "fixture/judge";
function setup() {
  vi.stubEnv("RECALL_EMBEDDINGS_DISABLED", "true");
  vi.stubEnv("RECALL_FTS_MODE", "or");
  const db = initStandaloneDb(join(mkdtempSync(join(tmpdir(), "recall-judge-")), "recall.db"));
  const base = { repo, type: "gotcha" as const, scope: "repo" as const, source: "user_correction" as const, confidence: 0.9 };
  const replicas = createMemory(db, { ...base, text: "Staging has no read replicas.", note: "load tests, traffic, benchmarks" });
  const style = createMemory(db, { ...base, text: "Use kebab-case for file names.", note: "naming files, traffic folder names" });
  return { db, replicas, style, request: { repo, session_id: "judge", query_text: "Send load test traffic to staging tonight" } };
}

it("is off unless explicitly enabled", () => {
  setLlmJudgeForTests(async () => new Map());
  expect(isLlmJudgeEnabled()).toBe(false);
  vi.stubEnv("RECALL_RELEVANCE_LLM", "true");
  expect(isLlmJudgeEnabled()).toBe(true);
});

it("when enabled, injects exactly the memories it grades 3 (or the configured minimum)", async () => {
  const { db, replicas, style, request } = setup();
  vi.stubEnv("RECALL_RELEVANCE_LLM", "true");
  const seen: string[][] = [];
  setLlmJudgeForTests(async (_query, memories) => {
    seen.push(memories.map((m) => m.id));
    return new Map(memories.map((m) => [m.id, m.id === replicas ? 3 : 2]));
  });
  const pack = await compileContextHybrid(db, request);
  expect(seen[0]).toEqual(expect.arrayContaining([replicas, style]));
  expect(pack.memories_included).toEqual([replicas]);
  vi.stubEnv("RECALL_RELEVANCE_LLM_MIN_GRADE", "2");
  const looser = await compileContextHybrid(db, { ...request, session_id: "judge-2" });
  expect(new Set(looser.memories_included)).toEqual(new Set([replicas, style]));
});

it("keeps the local decision when the judge gives no answer", async () => {
  const { db, request } = setup();
  const local = await compileContextHybrid(db, { ...request, session_id: "local" });
  vi.stubEnv("RECALL_RELEVANCE_LLM", "true");
  setLlmJudgeForTests(async () => null);
  const fallback = await compileContextHybrid(db, { ...request, session_id: "fallback" });
  expect(fallback.memories_included).toEqual(local.memories_included);
});
