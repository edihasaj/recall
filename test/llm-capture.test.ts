import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { isPromptWorthLLM } from "../src/capture/correction.js";
import { applyExtractRulesFromPrompt } from "../src/maintenance/appliers.js";
import { enqueueExtractRulesFromPrompt, peekTasks } from "../src/maintenance/tasks.js";
import { queryMemories } from "../src/models/memory.js";
import type { MaintenanceTask } from "../src/types.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-llm-capture-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("isPromptWorthLLM — multi-language pre-screen", () => {
  it("accepts English imperatives and save verbs", () => {
    expect(isPromptWorthLLM("always use pnpm not npm")).toBe(true);
    expect(isPromptWorthLLM("never commit secrets to the repo")).toBe(true);
    expect(isPromptWorthLLM("remember this — we use Bun")).toBe(true);
    expect(isPromptWorthLLM("don't use yarn here")).toBe(true);
    expect(isPromptWorthLLM("please always rebase, not merge")).toBe(true);
  });

  it("accepts non-English imperatives", () => {
    expect(isPromptWorthLLM("siempre usa pnpm en este repo")).toBe(true); // es
    expect(isPromptWorthLLM("toujours utiliser bun ici")).toBe(true); // fr
    expect(isPromptWorthLLM("immer pnpm verwenden")).toBe(true); // de
    expect(isPromptWorthLLM("sempre usa il typecheck")).toBe(true); // it
    expect(isPromptWorthLLM("всегда используй pnpm")).toBe(true); // ru
    expect(isPromptWorthLLM("gjithmonë përdor pnpm")).toBe(true); // sq
    expect(isPromptWorthLLM("总是使用 pnpm")).toBe(true); // zh
    expect(isPromptWorthLLM("常に bun を使う")).toBe(true); // ja
  });

  it("rejects pure code requests with no rule signal", () => {
    expect(isPromptWorthLLM("fix the bug in src/foo.ts")).toBe(false);
    expect(isPromptWorthLLM("what does this function do?")).toBe(false);
    expect(isPromptWorthLLM("```ts\nconst x = 1;\n```")).toBe(false);
  });

  it("rejects trivially short prompts", () => {
    expect(isPromptWorthLLM("")).toBe(false);
    expect(isPromptWorthLLM("ok")).toBe(false);
    expect(isPromptWorthLLM("hello!")).toBe(false);
  });

  it("forwards long rambles (likely voice transcripts) even without keywords", () => {
    const long = "so we had a conversation earlier ".repeat(40);
    expect(isPromptWorthLLM(long)).toBe(true);
  });
});

describe("enqueueExtractRulesFromPrompt", () => {
  it("creates one pending task per unique prompt_id", () => {
    const db = freshDb();
    const id1 = enqueueExtractRulesFromPrompt(db, {
      prompt_id: "prompt:s1:1",
      raw_prompt: "always use pnpm",
      repo: "test/repo",
      path: null,
      agent: "claude-code",
      session_id: "s1",
    });
    expect(id1).not.toBeNull();

    const pending = peekTasks(db, { kinds: ["extract_rules_from_prompt"] });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("extract_rules_from_prompt");
    expect(pending[0]!.repo).toBe("test/repo");
  });

  it("is idempotent on (kind, target_key)", () => {
    const db = freshDb();
    enqueueExtractRulesFromPrompt(db, {
      prompt_id: "prompt:s1:1",
      raw_prompt: "always use pnpm",
      repo: "test/repo",
      path: null,
      agent: "claude-code",
      session_id: "s1",
    });
    enqueueExtractRulesFromPrompt(db, {
      prompt_id: "prompt:s1:1",
      raw_prompt: "always use pnpm",
      repo: "test/repo",
      path: null,
      agent: "claude-code",
      session_id: "s1",
    });
    expect(peekTasks(db, { kinds: ["extract_rules_from_prompt"] })).toHaveLength(1);
  });
});

describe("applyExtractRulesFromPrompt", () => {
  function fakeTask(payload: Record<string, unknown>): MaintenanceTask {
    return {
      id: "task-1",
      kind: "extract_rules_from_prompt",
      status: "submitted",
      priority: 14,
      repo: (payload.repo as string | null) ?? null,
      target_key: "prompt:test:1",
      payload,
      result: null,
      failure_reason: null,
      claimed_by: "test",
      claimed_at: new Date().toISOString(),
      claim_expires_at: null,
      submitted_at: new Date().toISOString(),
      completed_at: null,
      created_at: new Date().toISOString(),
      attempts: 1,
      max_attempts: 3,
    };
  }

  it("creates one candidate per extracted rule", () => {
    const db = freshDb();
    const task = fakeTask({
      repo: "test/repo",
      path: null,
      session_id: "s1",
      raw_prompt: "always use pnpm and never commit secrets",
    });
    const outcome = applyExtractRulesFromPrompt(db, task, {
      rules: [
        {
          text: "Always use pnpm, never npm",
          type: "rule",
          scope: "repo",
          path_scope: null,
          confidence: 0.95,
        },
        {
          text: "Never commit secrets to the repo",
          type: "rule",
          scope: "repo",
          path_scope: null,
          confidence: 0.95,
        },
      ],
    });
    expect(outcome.changed_fields).toContain("created_memories");

    const memories = queryMemories(db, { repo: "test/repo" });
    expect(memories).toHaveLength(2);
    expect(memories.every((m) => m.status === "candidate")).toBe(true);
  });

  it("returns no-op when LLM returns empty rules list", () => {
    const db = freshDb();
    const task = fakeTask({
      repo: "test/repo",
      path: null,
      session_id: "s1",
      raw_prompt: "fix the bug",
    });
    const outcome = applyExtractRulesFromPrompt(db, task, {
      rules: [],
      dropped_reason: "no durable rule",
    });
    expect(outcome.changed_fields).toEqual([]);
    expect(queryMemories(db, { repo: "test/repo" })).toHaveLength(0);
  });

  it("deduplicates against existing similar memory in the same repo", () => {
    const db = freshDb();
    const task = fakeTask({
      repo: "test/repo",
      path: null,
      session_id: "s1",
      raw_prompt: "always use pnpm in this repo",
    });
    // First extraction creates the memory.
    applyExtractRulesFromPrompt(db, task, {
      rules: [
        {
          text: "Always use pnpm in this repo",
          type: "rule",
          scope: "repo",
          confidence: 0.95,
        },
      ],
    });
    expect(queryMemories(db, { repo: "test/repo" })).toHaveLength(1);

    // Second extraction with same rule should be skipped.
    applyExtractRulesFromPrompt(db, fakeTask({
      repo: "test/repo",
      path: null,
      session_id: "s2",
      raw_prompt: "always use pnpm in this repo",
    }), {
      rules: [
        {
          text: "Always use pnpm in this repo",
          type: "rule",
          scope: "repo",
          confidence: 0.95,
        },
      ],
    });
    expect(queryMemories(db, { repo: "test/repo" })).toHaveLength(1);
  });

  it("keeps destructive-risky rules as candidate even with high confidence", () => {
    const db = freshDb();
    const task = fakeTask({
      repo: "test/repo",
      path: null,
      session_id: "s1",
      raw_prompt: "delete all settings on startup",
    });
    applyExtractRulesFromPrompt(db, task, {
      rules: [
        {
          text: "Delete all settings on startup",
          type: "rule",
          scope: "repo",
          confidence: 0.99,
          is_destructive_risky: true,
        },
      ],
    });
    const memories = queryMemories(db, { repo: "test/repo" });
    expect(memories).toHaveLength(1);
    expect(memories[0]!.status).toBe("candidate");
  });
});
