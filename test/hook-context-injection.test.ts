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

  it("handlePromptHook injects when RECALL_HOOK_INJECT_PROMPT=true", async () => {
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

    expect(result.injection).toBeDefined();
    expect(result.injection!.text).toContain("uv");
    expect(result.injection!.memories_included.length).toBeGreaterThan(0);
    expect(result.injection!.token_estimate).toBeGreaterThan(0);
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

  it("falls back to non-hybrid compile when hybrid returns empty", async () => {
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
    expect(result.injection).toBeDefined();
    expect(result.injection!.text).toContain("conventional commits");
  });
});

describe("formatInjectionContext", () => {
  const surface = {
    text: "# Recall: edihasaj/recall\n\n## Commands\n- dev: tsup --watch\n",
    memories_included: ["a"],
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
