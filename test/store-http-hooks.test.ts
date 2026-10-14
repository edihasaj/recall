import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb, type RecallDb } from "../src/db/client.js";
import { handleAgentHttpHook } from "../src/hooks/http-agent.js";
import { getEmbeddingCacheRoot } from "../src/embeddings/cache.js";
import { listActivityEvents } from "../src/models/activity.js";
import { createMemory } from "../src/models/memory.js";
import { inferRepoSlugFromPath } from "../src/repo/discovery.js";

describe("store HTTP integration", () => {
  let directory: string;
  let db: RecallDb;
  const originalData = process.env.RECALL_DATA_DIR;
  const originalCache = process.env.RECALL_EMBEDDING_CACHE_DIR;
  const originalDistribution = process.env.RECALL_DISTRIBUTION;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "recall-store-hook-"));
    process.env.RECALL_DATA_DIR = directory;
    db = initDb();
  });
  afterEach(() => {
    closeDb();
    if (originalData === undefined) delete process.env.RECALL_DATA_DIR;
    else process.env.RECALL_DATA_DIR = originalData;
    if (originalCache === undefined) delete process.env.RECALL_EMBEDDING_CACHE_DIR;
    else process.env.RECALL_EMBEDDING_CACHE_DIR = originalCache;
    if (originalDistribution === undefined) delete process.env.RECALL_DISTRIBUTION;
    else process.env.RECALL_DISTRIBUTION = originalDistribution;
    rmSync(directory, { recursive: true, force: true });
  });
  it("routes raw session payloads without spawning a CLI", async () => {
    createMemory(db, {
      text: "Use uv for Python dependency commands.", type: "rule",
      source: "user_correction", scope: "global", confidence: 1,
    });
    const result = await handleAgentHttpHook(db, "codex", "SessionStart", {
      session_id: "store-session", cwd: directory, repo: "store-proof/fixture",
    });
    expect(result).toBeTypeOf("object");
    expect((result.hookSpecificOutput as { additionalContext: string }).additionalContext).toContain("uv");
    const events = listActivityEvents(db, { session_id: "store-session" });
    expect(events.some(e => e.event_type === "session_start")).toBe(true);
  });
  it("records a failed tool as a failure", async () => {
    await handleAgentHttpHook(db, "claude-code", "PostToolUseFailure", {
      session_id: "store-failure", cwd: directory, tool_name: "Bash",
      tool_input: { command: "npm run missing" }, error: "Exit code 7",
    });
    const events = listActivityEvents(db, { session_id: "store-failure" });
    expect(events.some(e => (e.result.tool_call as { exit_code?: number } | undefined)?.exit_code === 7)).toBe(true);
  });
  it("rejects malformed agent payloads", async () => {
    await expect(handleAgentHttpHook(db, "codex", "SessionStart", {}))
      .rejects.toThrow("session_id required");
  });
  it("keeps embedding models at the explicit container path", () => {
    process.env.RECALL_EMBEDDING_CACHE_DIR = join(directory, "Models");
    expect(getEmbeddingCacheRoot()).toBe(join(directory, "Models"));
  });
  it("identifies a selected repository from a subfolder without a Git executable", () => {
    process.env.RECALL_DISTRIBUTION = "mac-app-store";
    mkdirSync(join(directory, ".git"));
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, ".git/config"),
      '[remote "origin"]\nurl = git@github.com:store-proof/project.git\n');
    expect(inferRepoSlugFromPath(join(directory, "src"))).toBe("store-proof/project");
  });
});
