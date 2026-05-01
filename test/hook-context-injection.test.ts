import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import {
  formatInjectionContext,
  handlePromptHook,
  handleSessionStartHook,
} from "../src/cli/hook.js";
import { createHistorySnippet } from "../src/history/snippets.js";

let dbCounter = 0;
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-hook-inject-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  delete process.env.RECALL_HOOK_INJECT_CONTEXT;
  delete process.env.RECALL_HOOK_INJECT_PROMPT;
  delete process.env.RECALL_HOOK_INJECT_STYLE;
});

afterEach(() => {
  closeDb();
});

describe("hook context injection", () => {
  it("handlePromptHook is silent by default (no per-turn re-injection)", async () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "always use uv, never pip in this repo",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    const result = await handlePromptHook(
      {
        session_id: "sess-silent",
        repo: "edihasaj/recall",
        text: "how do I add a dependency",
        agent: "claude-code",
      },
      { db },
    );

    expect(result.injection).toBeUndefined();
  });

  it("handlePromptHook stays silent even with RECALL_HOOK_INJECT_PROMPT=true when hybrid can't score the prompt", async () => {
    // With embeddings disabled (as in these tests) hybrid retrieval cannot
    // rank memories against the prompt, so the prompt path returns nothing
    // — by design, since the previous fallback-to-full-compile behavior was
    // the per-turn noise UserPromptSubmit users opted out of. Real enablement
    // requires embeddings to be on; that's covered by the integration tests.
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "always use uv, never pip in this repo",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    process.env.RECALL_HOOK_INJECT_PROMPT = "true";
    const result = await handlePromptHook(
      {
        session_id: "sess-1",
        repo: "edihasaj/recall",
        text: "how do I add a dependency",
        agent: "claude-code",
      },
      { db },
    );

    expect(result.injection).toBeUndefined();
  });

  it("handlePromptHook omits injection when opted in but repo has no active memories", async () => {
    const db = freshDb();
    process.env.RECALL_HOOK_INJECT_PROMPT = "true";
    const result = await handlePromptHook(
      {
        session_id: "sess-1",
        repo: "edihasaj/empty-repo",
        text: "hello",
        agent: "claude-code",
      },
      { db },
    );
    expect(result.injection).toBeUndefined();
  });

  it("handleSessionStartHook still returns injection for repo with memories", async () => {
    const db = freshDb();
    createMemory(db, {
      type: "command",
      text: "pnpm test runs vitest",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "repo_scan",
      confidence: 0.85,
    });

    const result = await handleSessionStartHook(
      {
        session_id: "sess-2",
        agent: "claude-code",
        repo: "edihasaj/recall",
      },
      { db },
    );

    expect(result.injection).toBeDefined();
    expect(result.injection!.text).toContain("pnpm test");
  });

  it("respects RECALL_HOOK_INJECT_CONTEXT=false on session-start", async () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "never commit secrets",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    process.env.RECALL_HOOK_INJECT_CONTEXT = "false";
    const result = await handleSessionStartHook(
      {
        session_id: "sess-3",
        agent: "claude-code",
        repo: "edihasaj/recall",
      },
      { db },
    );
    expect(result.injection).toBeUndefined();
  });

  it("UserPromptSubmit does NOT fall back to a full-repo compile when hybrid is empty", async () => {
    // With embeddings disabled the hybrid path yields no ranked results for a
    // prompt. The collector used to fall through to compileContext (the full
    // repo dump) — that produced re-injection noise on every turn. Now the
    // prompt path just returns undefined so the hook goes silent.
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "use conventional commits",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    process.env.RECALL_HOOK_INJECT_PROMPT = "true";
    const result = await handlePromptHook(
      {
        session_id: "sess-4",
        repo: "edihasaj/recall",
        text: "some unrelated prompt text",
        agent: "claude-code",
      },
      { db },
    );
    expect(result.injection).toBeUndefined();
  });

  it("handleSessionStartHook does fall back to compileContext (first-touch dump)", async () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "use conventional commits",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    const result = await handleSessionStartHook(
      {
        session_id: "sess-4b",
        agent: "claude-code",
        repo: "edihasaj/recall",
      },
      { db },
    );
    expect(result.injection).toBeDefined();
    expect(result.injection!.text).toContain("conventional commits");
  });

  it("handleSessionStartHook can inject repo history even without active memories", async () => {
    const db = freshDb();
    createHistorySnippet(db, {
      repo: "edihasaj/recall",
      kind: "decision_summary",
      text: "Repo: edihasaj/recall\nFrequent user decisions:\n- (1) User direction: do phase 3.",
    });

    const result = await handleSessionStartHook(
      {
        session_id: "sess-history",
        agent: "claude-code",
        repo: "edihasaj/recall",
      },
      { db },
    );

    expect(result.injection).toBeDefined();
    expect(result.injection!.memories_included).toHaveLength(0);
    expect(result.injection!.history_included).toHaveLength(1);
    expect(result.injection!.text).toContain("do phase 3");
  });

  it("per-session dedup: SessionStart fires once, subsequent opt-in prompt hooks skip if all ids already injected", async () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "always use uv, never pip in this repo",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    const sessionId = "sess-dedup";

    // First-touch SessionStart delivers the memory.
    const started = await handleSessionStartHook(
      { session_id: sessionId, agent: "claude-code", repo: "edihasaj/recall" },
      { db },
    );
    expect(started.injection).toBeDefined();

    // Now the user has opted into per-prompt injection. A prompt that
    // semantically matches the same memory should NOT re-emit it because the
    // session has already seen it.
    process.env.RECALL_HOOK_INJECT_PROMPT = "true";
    const prompted = await handlePromptHook(
      {
        session_id: sessionId,
        repo: "edihasaj/recall",
        text: "how do I add a python dependency with uv",
        agent: "claude-code",
      },
      { db },
    );
    expect(prompted.injection).toBeUndefined();
  });
});

describe("formatInjectionContext", () => {
  const surface = {
    text: "# Recall: edihasaj/recall\n\n## Commands\n- dev: tsup --watch\n",
    memories_included: ["a"],
    history_included: [],
    token_estimate: 10,
  };

  it("defaults to minimal style — strips the repo header and boilerplate prefix", () => {
    const line = formatInjectionContext(surface);
    expect(line).not.toMatch(/Recall memory for this repo/);
    expect(line).not.toMatch(/# Recall:/);
    expect(line).toContain("## Commands");
    expect(line).toContain("dev: tsup --watch");
    expect(line.endsWith("\n")).toBe(false);
  });

  it("verbose style keeps the historical prefix + header", () => {
    process.env.RECALL_HOOK_INJECT_STYLE = "verbose";
    const line = formatInjectionContext(surface);
    expect(line).toMatch(/^Recall memory for this repo:/);
    expect(line).toContain("# Recall: edihasaj/recall");
  });
});
