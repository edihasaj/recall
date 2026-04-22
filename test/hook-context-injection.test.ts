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

let dbCounter = 0;
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "recall-hook-inject-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

beforeEach(() => {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  delete process.env.RECALL_HOOK_INJECT_CONTEXT;
});

afterEach(() => {
  closeDb();
});

describe("hook context injection", () => {
  it("handlePromptHook returns injection when repo has active memories", async () => {
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
        session_id: "sess-1",
        repo: "edihasaj/recall",
        text: "how do I add a dependency",
        agent: "claude-code",
      },
      { db },
    );

    expect(result.injection).toBeDefined();
    expect(result.injection!.text).toContain("uv");
    expect(result.injection!.memories_included.length).toBeGreaterThan(0);
    expect(result.injection!.token_estimate).toBeGreaterThan(0);
  });

  it("handlePromptHook omits injection when repo has no active memories", async () => {
    const db = freshDb();
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

  it("handleSessionStartHook returns injection for repo with memories", async () => {
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

  it("respects RECALL_HOOK_INJECT_CONTEXT=false", async () => {
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
    const result = await handlePromptHook(
      {
        session_id: "sess-3",
        repo: "edihasaj/recall",
        text: "anything",
        agent: "claude-code",
      },
      { db },
    );
    expect(result.injection).toBeUndefined();
  });

  it("falls back to non-hybrid compile when hybrid returns empty", async () => {
    // With embeddings disabled and a query_text, hybrid yields no ranked results,
    // so the collector must fall back to plain compileContext.
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "use conventional commits",
      scope: "repo",
      repo: "edihasaj/recall",
      source: "user_correction",
      confidence: 0.9,
    });

    const result = await handlePromptHook(
      {
        session_id: "sess-4",
        repo: "edihasaj/recall",
        text: "some unrelated prompt text",
        agent: "claude-code",
      },
      { db },
    );
    expect(result.injection).toBeDefined();
    expect(result.injection!.text).toContain("conventional commits");
  });

  it("formatInjectionContext prefixes with repo memory header", () => {
    const line = formatInjectionContext({
      text: "- rule: use pnpm\n- command: pnpm test",
      memories_included: ["a", "b"],
      token_estimate: 10,
    });
    expect(line).toMatch(/Recall memory for this repo/);
    expect(line).toContain("pnpm");
  });
});
