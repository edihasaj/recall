import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initStandaloneDb } from "../src/db/client.js";
import { createMemory } from "../src/models/memory.js";
import {
  formatPendingConfirmationsContext,
  handleSessionStartHook,
} from "../src/cli/hook.js";

let dbCounter = 0;
function freshDb() {
  process.env.RECALL_EMBEDDINGS_DISABLED = "true";
  const dir = mkdtempSync(join(tmpdir(), "recall-pending-confirms-"));
  return initStandaloneDb(join(dir, `test-${dbCounter++}.db`));
}

describe("pending high-risk confirmations surface", () => {
  it("omits surface when no risky candidates exist", async () => {
    const db = freshDb();
    createMemory(db, {
      type: "rule",
      text: "Use uv for Python deps",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.4,
    });

    const result = await handleSessionStartHook(
      { session_id: "sess-1", agent: "claude-code", repo: "test/repo" },
      { db },
    );
    expect(result.pending_confirmations).toBeUndefined();
  });

  it("surfaces high-risk candidates (destructive + trigger-template) for the session repo", async () => {
    const db = freshDb();
    const riskyId = createMemory(db, {
      type: "rule",
      text: "remove all plugins from settings",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.4,
    });
    createMemory(db, {
      type: "rule",
      text: "wipe all secrets",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.4,
    });
    const triggerId = createMemory(db, {
      type: "rule",
      text: "When user says \"add\", run a backup and update the readme.",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.4,
    });
    // Other-repo risky: should not surface in this session
    createMemory(db, {
      type: "rule",
      text: "delete the entire database",
      scope: "repo",
      repo: "other/repo",
      source: "user_correction",
      confidence: 0.4,
    });
    // Benign candidate: should not surface
    createMemory(db, {
      type: "rule",
      text: "always run vitest before pushing",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.4,
    });

    const result = await handleSessionStartHook(
      { session_id: "sess-1", agent: "claude-code", repo: "test/repo" },
      { db },
    );
    const surface = result.pending_confirmations!;
    expect(surface).toBeDefined();
    expect(surface.pending_total).toBe(3);
    expect(surface.items.map((i) => i.id)).toContain(riskyId);
    expect(surface.items.map((i) => i.id)).toContain(triggerId);
    expect(surface.items.every((i) => i.repo === "test/repo")).toBe(true);
  });

  it("does not surface candidates that have already been promoted or rejected", async () => {
    const db = freshDb();
    const id = createMemory(db, {
      type: "rule",
      text: "drop all branches",
      scope: "repo",
      repo: "test/repo",
      source: "user_correction",
      confidence: 0.85, // → active, not candidate
    });
    expect(id).toBeTruthy();

    const result = await handleSessionStartHook(
      { session_id: "sess-1", agent: "claude-code", repo: "test/repo" },
      { db },
    );
    expect(result.pending_confirmations).toBeUndefined();
  });

  it("formatPendingConfirmationsContext produces actionable agent prompt", () => {
    const text = formatPendingConfirmationsContext({
      pending_total: 7,
      items: [
        { id: "abcdef12-aaaa-bbbb-cccc-000000000001", text: "remove plugins from settings", scope: "repo", repo: "test/repo" },
        { id: "abcdef34-aaaa-bbbb-cccc-000000000002", text: "When user says \"add\", run a backup", scope: "global", repo: "test/repo" },
      ],
    });
    expect(text).toMatch(/7 high-risk/);
    expect(text).toMatch(/\+5 more/);
    expect(text).toMatch(/recall\.confirm/);
    expect(text).toMatch(/recall\.reject/);
    expect(text).toMatch(/abcdef12/);
    // Each item is tagged with its risk reason so the agent knows why.
    expect(text).toMatch(/destructive\)/);
    expect(text).toMatch(/trigger-template\)/);
  });
});
